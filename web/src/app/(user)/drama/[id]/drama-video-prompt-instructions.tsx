"use client";

import { useEffect, useRef, useState } from "react";
import { App } from "antd";
import { nanoid } from "nanoid";

import { VideoPromptInstructionEditor } from "@/components/video-prompt-instruction-editor";
import type { DramaEpisode, DramaProject, DramaVideoPromptAnalysis } from "@/lib/drama-project-contract";
import { DRAMA_DEFAULT_VIDEO_PROMPT_INSTRUCTIONS, dramaEpisodeHasActiveMedia, dramaVideoPromptInput } from "@/lib/drama-video-prompt-instructions";
import { requestDramaAnalysis } from "@/services/api/drama-analysis";
import { useDramaStore } from "../stores/use-drama-store";
import { dramaCreationContext } from "./drama-creation-context";

export function DramaVideoPromptInstructions({
    project,
    episode,
    textModel,
    textModelReady = true,
    disabled,
    onBusyChange,
}: {
    project: DramaProject;
    episode: DramaEpisode;
    textModel?: string;
    textModelReady?: boolean;
    disabled?: boolean;
    onBusyChange: (busy: boolean) => void;
}) {
    const { message } = App.useApp();
    const [draft, setDraft] = useState<string>();
    const [busy, setBusy] = useState(false);
    const busyRef = useRef(false);
    const requestRef = useRef<AbortController | null>(null);
    const value = draft ?? project.videoPromptInstructions ?? "";
    const dirty = value.trim() !== (project.videoPromptInstructions || "").trim();
    const hasActiveMedia = dramaEpisodeHasActiveMedia(episode);
    const saveError = useDramaStore((state) => state.saveStateByProject[project.id]?.status === "error");

    useEffect(() => () => requestRef.current?.abort(), []);

    const save = async () => {
        if (value.length > 50_000) throw new Error("生成指令不能超过 50,000 字");
        const store = useDramaStore.getState();
        store.updateProject(project.id, { videoPromptInstructions: value.trim() });
        const saved = await store.flushProjectSave(project.id);
        if ((saved.videoPromptInstructions || "") !== value.trim()) throw new Error("项目已在其他位置修改，请检查最新生成指令后重试");
        setDraft(undefined);
        return saved;
    };

    const run = async (generate: boolean) => {
        if (busyRef.current || disabled) return;
        if (generate && !textModelReady) throw new Error("请先选择可用的文本模型");
        busyRef.current = true;
        setBusy(true);
        onBusyChange(true);
        try {
            const saved = await save();
            if (!generate) {
                message.success("生成指令已保存，重新生成视频提示词后生效");
                return;
            }
            const currentEpisode = saved.episodes.find((item) => item.id === episode.id);
            if (!currentEpisode || currentEpisode.reviewStatus !== "visual_ready" || !currentEpisode.shots.length) throw new Error("请先完成内容审核与视觉方案生成");
            if (dramaEpisodeHasActiveMedia(currentEpisode)) throw new Error("请等待当前图像、视频或配音任务完成后再重新生成提示词");
            const input = dramaVideoPromptInput(saved, currentEpisode);
            const expectedInput = JSON.stringify(input);
            const controller = new AbortController();
            requestRef.current = controller;
            const data = await requestDramaAnalysis<DramaVideoPromptAnalysis>(
                "/api/drama/analyze",
                { ...input, creativeContext: dramaCreationContext(saved, episode.id), ratio: saved.ratio, textModel, projectId: project.id, phase: "video-prompts", requestId: `drama-video-prompts:${project.id}:${episode.id}:${nanoid()}` },
                { signal: controller.signal },
            );
            const store = useDramaStore.getState();
            const latest = store.projects.find((item) => item.id === project.id);
            if (!latest || controller.signal.aborted) return;
            await store.createVersion(latest, "视频提示词重新生成前");
            if (controller.signal.aborted) return;
            store.applyVideoPromptAnalysis(project.id, episode.id, data, expectedInput);
            await store.flushProjectSave(project.id);
            message.success("本集视频提示词已更新，分镜图和人物场景资产已保留");
        } finally {
            requestRef.current = null;
            busyRef.current = false;
            setBusy(false);
            onBusyChange(false);
        }
    };

    return (
        <div className="mb-4 space-y-2">
            <VideoPromptInstructionEditor
                defaultText={DRAMA_DEFAULT_VIDEO_PROMPT_INSTRUCTIONS}
                value={value}
                dirty={dirty || saveError}
                disabled={disabled || busy}
                hasOutput={episode.shots.some((shot) => Boolean(shot.videoPrompt))}
                onChange={setDraft}
                onSave={() => run(false)}
                onGenerate={() => run(true)}
                generationDisabled={!textModelReady || hasActiveMedia || episode.reviewStatus !== "visual_ready" || !episode.shots.length}
            />
            <p className="text-xs leading-6 text-muted-foreground">
                指令用于当前项目所有剧集，重新生成仅更新当前集。人物、场景及分镜图会保留，旧视频和合成结果需重新生成。{hasActiveMedia ? "当前有媒体任务进行中，完成后可重新生成提示词。" : dirty ? "当前显示的镜头提示词仍来自之前的指令。" : ""}
            </p>
        </div>
    );
}
