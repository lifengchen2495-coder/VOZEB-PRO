"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { App, Button, Image, Input, Segmented, Tag, Tooltip } from "antd";
import { Check, Copy, Download, FileAudio, FileText, LoaderCircle, Play, RefreshCw, Sparkles, Video, VolumeX } from "lucide-react";

import { ModelPicker } from "@/components/model-picker";
import { browserReadableMediaUrl } from "@/lib/browser-media-url";
import { mediaDownloadFileName } from "@/lib/media-file";
import { imagePreviewUrl, originalMediaDownloadUrl } from "@/lib/media-image-url";
import { createServerVideoGenerationTask, recoverVideoGenerationTask, storeGeneratedVideo, waitForVideoGenerationTask } from "@/services/api/video";
import { isGenerationTaskNeedsReviewError } from "@/services/api/generation-task-state";
import type { VideoGenerationTask } from "@/services/api/video-types";
import type { UploadedFile } from "@/services/file-storage";
import { useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";

import { isRemakeNoNarrationCopy, type RemakeMediaAsset, type RemakeProject, type RemakeRangeGroup, type RemakeVoice } from "../remake-contract";
import { downloadRemakeProductionBundle } from "./remake-production-export";
import { remakeImagesReady, remakeProductionReady, remakeVideoAudioReferences, remakeVideoReferenceImages, remakeVideosReady } from "./remake-production-utils";
import type { RemakeGroupPatch } from "./remake-image-stage";
import { isRemakeCopyPlanReady } from "./remake-workspace-state";

export function RemakeProductionStage({
    project,
    getCurrentProject,
    building,
    buildingGroupIds = [],
    onVoiceChange,
    onPromptModelChange,
    onVideoModelChange,
    onGroupChange,
    onFlush,
    onBuild,
}: {
    project: RemakeProject;
    getCurrentProject?: () => RemakeProject;
    building: boolean;
    buildingGroupIds?: string[];
    onVoiceChange: (voice: RemakeVoice) => void;
    onPromptModelChange: (model: string) => void;
    onVideoModelChange: (model: string) => void;
    onGroupChange: (groupId: string, patch: RemakeGroupPatch) => void;
    onFlush: () => Promise<boolean>;
    onBuild: (groupId?: string) => void | Promise<void>;
}) {
    const { message } = App.useApp();
    const config = useEffectiveConfig();
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const selectedPromptModel = project.modelSelection.prompt || config.textModel || config.model;
    const selectedVideoModel = project.modelSelection.video || config.videoModel || config.model;
    const videoConfig = useMemo(
        () => ({
            ...config,
            model: selectedVideoModel,
            videoModel: selectedVideoModel,
            size: "9:16",
            videoSeconds: "15",
            vquality: "480",
            videoGenerateAudio: "true",
            videoWatermark: "false",
        }),
        [config, selectedVideoModel],
    );
    const latestProjectRef = useRef(project);
    latestProjectRef.current = project;
    const activeTasksRef = useRef(new Map<string, AbortController>());
    const promptBuildPendingRef = useRef(new Set<string>());
    const batchPromptBuildPendingRef = useRef(false);
    const batchVideoStartingRef = useRef(false);
    const startingGroupsRef = useRef(new Set<string>());
    const deferredGroupsRef = useRef(new Set<string>());
    const resumeTimersRef = useRef(new Set<number>());
    const [batchStarting, setBatchStarting] = useState(false);
    const [exporting, setExporting] = useState(false);
    const [resumeNonce, setResumeNonce] = useState(0);
    const noNarration = isRemakeNoNarrationCopy(project.sourceCopy);
    const prerequisites = productionPrerequisites(project);
    const promptsReady = project.groups.length === 4 && project.groups.every((group) => group.videoPrompt.trim());
    const reportReady = project.copy.status === "completed" && Boolean(project.copy.rawReport.trim());
    const videosReady = remakeVideosReady(project);
    const productionReady = remakeProductionReady(project);
    const videoActive = project.groups.some((group) => isVideoActive(group)) || startingGroupsRef.current.size > 0;
    const sharedBusy = building || buildingGroupIds.length > 0 || promptBuildPendingRef.current.size > 0 || batchPromptBuildPendingRef.current || videoActive;
    const isPromptBuilding = useCallback((groupId: string) => building || batchPromptBuildPendingRef.current || buildingGroupIds.includes(groupId) || promptBuildPendingRef.current.has(groupId), [building, buildingGroupIds]);
    const canStartGroupVideo = (group: RemakeRangeGroup) => Boolean(
        group.videoPrompt.trim() &&
        group.imageGeneration.status === "completed" &&
        group.imageGeneration.result?.url &&
        latestProjectRef.current.references.product?.url &&
        group.videoGeneration.status !== "completed" &&
        !isVideoActive(group) &&
        !isPromptBuilding(group.id) &&
        !startingGroupsRef.current.has(group.id) &&
        !deferredGroupsRef.current.has(group.id),
    );
    const videoCandidateCount = project.groups.filter(canStartGroupVideo).length;

    const emitGroupChange = useCallback(
        (groupId: string, patch: RemakeGroupPatch) => {
            const current = latestProjectRef.current;
            latestProjectRef.current = {
                ...current,
                groups: current.groups.map((group) =>
                    group.id === groupId
                        ? {
                              ...group,
                              ...patch,
                              replacementGeneration: patch.replacementGeneration ? { ...group.replacementGeneration, ...patch.replacementGeneration } : group.replacementGeneration,
                              imageGeneration: patch.imageGeneration ? { ...group.imageGeneration, ...patch.imageGeneration } : group.imageGeneration,
                              videoGeneration: patch.videoGeneration ? { ...group.videoGeneration, ...patch.videoGeneration } : group.videoGeneration,
                          }
                        : group,
                ),
            };
            onGroupChange(groupId, patch);
        },
        [onGroupChange],
    );

    const emitModelChange = useCallback(
        (kind: "prompt" | "video", model: string) => {
            latestProjectRef.current = {
                ...latestProjectRef.current,
                modelSelection: { ...latestProjectRef.current.modelSelection, [kind]: model },
            };
            if (kind === "prompt") onPromptModelChange(model);
            else onVideoModelChange(model);
        },
        [onPromptModelChange, onVideoModelChange],
    );

    const scheduleResume = useCallback((groupId: string) => {
        deferredGroupsRef.current.add(groupId);
        const timer = window.setTimeout(() => {
            resumeTimersRef.current.delete(timer);
            deferredGroupsRef.current.delete(groupId);
            setResumeNonce((current) => current + 1);
        }, 3000);
        resumeTimersRef.current.add(timer);
    }, []);

    const saveVideoState = useCallback(async (detail: string) => {
        try {
            if (await onFlush()) return true;
        } catch {
            // 保存失败不能覆盖已取得的视频结果，也不能被当作上游任务失败。
        }
        message.error(detail);
        return false;
    }, [message, onFlush]);

    const waitForGroupVideo = useCallback(
        async (groupId: string, prompt: string, task: VideoGenerationTask, announce = false, checkStatus = false) => {
            const current = latestProjectRef.current.groups.find((group) => group.id === groupId);
            if (!current || current.videoGeneration.taskId !== task.id || current.videoPrompt !== prompt) return;
            if (current.videoGeneration.needsReview && !checkStatus) return;
            if (activeTasksRef.current.has(task.id)) return;
            const controller = new AbortController();
            activeTasksRef.current.set(task.id, controller);
            try {
                if (checkStatus) {
                    await recoverVideoGenerationTask(task, { signal: controller.signal });
                    emitGroupChange(groupId, { videoGeneration: { status: "running", needsReview: false, error: null } });
                    await saveVideoState(`分镜 ${groupId} 的任务状态尚未保存，请重试保存`);
                }
                const generationConfig = { ...videoConfig, model: task.model, videoModel: task.model };
                const stored = await storeGeneratedVideo(await waitForVideoGenerationTask(generationConfig, task, { signal: controller.signal, source: "video-workbench", projectId: latestProjectRef.current.id }));
                const latest = latestProjectRef.current.groups.find((group) => group.id === groupId);
                if (controller.signal.aborted || latest?.videoGeneration.taskId !== task.id || latest.videoPrompt !== prompt) return;
                emitGroupChange(groupId, { videoGeneration: { status: "completed", taskId: task.id, model: task.model, needsReview: false, result: videoAsset(stored, groupId), error: null } });
                const saved = await saveVideoState(`分镜 ${groupId} 的视频已生成，但项目尚未保存，请重试保存`);
                if (announce && saved) message.success(`分镜 ${groupId} 的 15 秒视频已生成`);
            } catch (reason) {
                if (controller.signal.aborted) return;
                const latest = latestProjectRef.current.groups.find((group) => group.id === groupId);
                if (latest?.videoGeneration.taskId !== task.id || latest.videoPrompt !== prompt) return;
                const detail = reason instanceof Error ? reason.message : "视频生成失败";
                if (isGenerationTaskNeedsReviewError(reason)) {
                    emitGroupChange(groupId, { videoGeneration: { status: "running", taskId: task.id, model: task.model, needsReview: true, error: detail } });
                    await saveVideoState(`分镜 ${groupId} 的待确认状态尚未保存，请重试保存`);
                    message.warning(`分镜 ${groupId}：${detail}`);
                    return;
                }
                if (isDeferredVideoError(reason)) {
                    message.info(`分镜 ${groupId}：${detail}`);
                    scheduleResume(groupId);
                    return;
                }
                emitGroupChange(groupId, { videoGeneration: { status: "error", taskId: task.id, model: task.model, needsReview: false, result: null, error: detail } });
                await saveVideoState(`分镜 ${groupId} 的失败状态尚未保存，请重试保存`);
                message.error(`分镜 ${groupId}：${detail}`);
            } finally {
                if (activeTasksRef.current.get(task.id) === controller) activeTasksRef.current.delete(task.id);
            }
        },
        [emitGroupChange, message, saveVideoState, scheduleResume, videoConfig],
    );

    const startGroupVideo = useCallback(
        async (groupId: string, announce = true) => {
            if (isPromptBuilding(groupId)) return;
            const current = latestProjectRef.current;
            const group = current.groups.find((item) => item.id === groupId);
            if (!group || startingGroupsRef.current.has(groupId) || deferredGroupsRef.current.has(groupId)) return;
            if (group.videoGeneration.needsReview && group.videoGeneration.taskId && group.videoGeneration.model) {
                return waitForGroupVideo(groupId, group.videoPrompt, { id: group.videoGeneration.taskId, serverTaskId: group.videoGeneration.taskId, provider: "generation", pollPath: "server", model: group.videoGeneration.model, durationSeconds: 15 }, announce, true);
            }
            const awaitingCreation = isVideoActive(group) && !group.videoGeneration.taskId;
            if (isVideoActive(group) && !awaitingCreation) return;
            if (!group.videoPrompt.trim()) return message.warning(`分镜 ${group.id} 的视频 Prompt 尚未生成`);
            if (group.imageGeneration.status !== "completed" || !group.imageGeneration.result?.url || !current.references.product?.url) return message.warning(`分镜 ${group.id} 的最终十二宫格或产品图缺失`);
            const model = current.modelSelection.video || selectedVideoModel;
            const generationConfig = { ...videoConfig, model, videoModel: model };
            if (!model || !isAiConfigReady(generationConfig, model)) {
                openConfigDialog(true);
                return message.warning("请先配置可用的视频模型");
            }
            if (!current.modelSelection.video) emitModelChange("video", model);
            const prompt = group.videoPrompt;
            const clientRequestId = remakeVideoClientRequestId(current, group, model);
            const previousAttempt = group.videoGeneration.attemptNo;
            // 旧请求未传次数时由服务端按 0 去重，恢复时必须保留该身份。
            const attemptNo = awaitingCreation ? previousAttempt : group.videoGeneration.status === "error" || group.videoGeneration.status === "completed" ? (previousAttempt ?? 1) + 1 : previousAttempt ?? 1;
            startingGroupsRef.current.add(groupId);
            emitGroupChange(groupId, { videoGeneration: { status: "queued", taskId: null, attemptNo, model, needsReview: false, result: null, error: null } });
            try {
                const saveError = `分镜 ${group.id} 的项目保存失败，尚未提交视频任务，请保存后重试`;
                if (!await saveVideoState(saveError)) {
                    emitGroupChange(groupId, { videoGeneration: { status: "error", error: saveError } });
                    return;
                }
                // 保存可能合并其他页面的更新；只提交仍属于本次尝试的当前分组。
                const savedProject = getCurrentProject?.() || latestProjectRef.current;
                latestProjectRef.current = savedProject;
                const savedGroup = savedProject.groups.find((item) => item.id === groupId);
                if (
                    !savedGroup ||
                    savedGroup.videoPrompt !== prompt ||
                    (savedGroup.videoGeneration.status !== "queued" && savedGroup.videoGeneration.status !== "running") ||
                    savedGroup.videoGeneration.taskId ||
                    savedGroup.videoGeneration.needsReview ||
                    savedGroup.videoGeneration.attemptNo !== attemptNo ||
                    savedGroup.videoGeneration.model !== model ||
                    (savedProject.modelSelection.video || selectedVideoModel) !== model ||
                    savedGroup.imageGeneration.status !== "completed" ||
                    !savedGroup.imageGeneration.result?.url ||
                    !savedProject.references.product?.url ||
                    isRemakeNoNarrationCopy(savedProject.sourceCopy) !== isRemakeNoNarrationCopy(current.sourceCopy) ||
                    remakeVideoClientRequestId(savedProject, savedGroup, model) !== clientRequestId
                ) return;
                const task = await createServerVideoGenerationTask(generationConfig, prompt, remakeVideoReferenceImages(group, current.references), [], remakeVideoAudioReferences(current), {
                    source: "video-workbench",
                    projectId: current.id,
                    clientRequestId,
                    attemptNo,
                    generationSlotId: `remake-video:${group.id}`,
                });
                const latest = latestProjectRef.current.groups.find((item) => item.id === groupId);
                if (!latest || latest.videoPrompt !== prompt || (latest.videoGeneration.taskId && latest.videoGeneration.taskId !== task.id)) return;
                emitGroupChange(groupId, { videoGeneration: { status: "running", taskId: task.id, model: task.model || model, result: null, error: null } });
                await saveVideoState(`分镜 ${group.id} 的视频任务已提交，但项目尚未保存，请重试保存`);
                void waitForGroupVideo(groupId, prompt, task, announce);
            } catch (reason) {
                const latest = latestProjectRef.current.groups.find((item) => item.id === groupId);
                if (!latest || latest.videoPrompt !== prompt) return;
                const detail = reason instanceof Error ? reason.message : "视频任务创建失败";
                if (isDeferredVideoError(reason)) {
                    message.info(`分镜 ${group.id}：任务创建结果待确认，正在恢复原请求`);
                    scheduleResume(groupId);
                    return;
                }
                emitGroupChange(groupId, { videoGeneration: { status: "error", taskId: null, model, result: null, error: detail } });
                await saveVideoState(`分镜 ${group.id} 的失败状态尚未保存，请重试保存`);
                message.error(`分镜 ${group.id}：${detail}`);
            } finally {
                startingGroupsRef.current.delete(groupId);
            }
        },
        [emitGroupChange, emitModelChange, getCurrentProject, isAiConfigReady, isPromptBuilding, message, saveVideoState, openConfigDialog, scheduleResume, selectedVideoModel, videoConfig, waitForGroupVideo],
    );

    useEffect(() => {
        for (const group of project.groups) {
            const generation = group.videoGeneration;
            if (generation.needsReview) continue;
            if ((generation.status === "queued" || generation.status === "running") && generation.taskId && generation.model) {
                void waitForGroupVideo(
                    group.id,
                    group.videoPrompt,
                    { id: generation.taskId, serverTaskId: generation.taskId, provider: "generation", pollPath: "server", model: generation.model, durationSeconds: 15 },
                    false,
                );
            } else if ((generation.status === "queued" || generation.status === "running") && !deferredGroupsRef.current.has(group.id)) {
                void startGroupVideo(group.id, false);
            }
        }
    }, [project.groups, resumeNonce, startGroupVideo, waitForGroupVideo]);

    useEffect(
        () => () => {
            for (const controller of activeTasksRef.current.values()) controller.abort();
            for (const timer of resumeTimersRef.current) window.clearTimeout(timer);
            activeTasksRef.current.clear();
            deferredGroupsRef.current.clear();
            resumeTimersRef.current.clear();
            // StrictMode 会重放清理与恢复；创建锁由请求的 finally 释放。
        },
        [],
    );

    const startAllVideos = async () => {
        if (building || batchPromptBuildPendingRef.current || batchVideoStartingRef.current) return;
        const candidates = latestProjectRef.current.groups.filter(canStartGroupVideo);
        if (!candidates.length) return message.info(videosReady ? "4 条独立视频已经全部生成" : "当前没有可启动的视频任务");
        batchVideoStartingRef.current = true;
        setBatchStarting(true);
        try {
            await Promise.all(candidates.map((group) => startGroupVideo(group.id)));
        } finally {
            batchVideoStartingRef.current = false;
            setBatchStarting(false);
        }
    };

    const buildPrompts = async (groupId?: string) => {
        if (building || batchPromptBuildPendingRef.current) return;
        if (!productionPrerequisites(latestProjectRef.current).ready) return;
        if (groupId) {
            const group = latestProjectRef.current.groups.find((item) => item.id === groupId);
            if (!group || isPromptBuilding(groupId) || isVideoActive(group) || startingGroupsRef.current.has(groupId) || deferredGroupsRef.current.has(groupId)) return;
            promptBuildPendingRef.current.add(groupId);
        } else {
            if (buildingGroupIds.length || promptBuildPendingRef.current.size || startingGroupsRef.current.size || latestProjectRef.current.groups.some(isVideoActive)) return;
            batchPromptBuildPendingRef.current = true;
        }
        try {
            await onBuild(groupId);
        } finally {
            if (groupId) promptBuildPendingRef.current.delete(groupId);
            else batchPromptBuildPendingRef.current = false;
        }
    };

    const copyPrompt = async (text: string, success: string) => {
        await copyText(text);
        message.success(success);
    };

    const exportBundle = async () => {
        setExporting(true);
        try {
            await downloadRemakeProductionBundle(project);
            message.success("飞书复刻生产包已下载");
        } catch (reason) {
            message.error(reason instanceof Error ? reason.message : "生产包下载失败");
        } finally {
            setExporting(false);
        }
    };

    return (
        <section className="h-full min-h-0 overflow-y-auto bg-background" aria-label="生产内容">
            <div className="mx-auto w-full max-w-[1480px] px-3 py-4 sm:px-5 sm:py-5">
                <div className="flex min-w-0 flex-col gap-3 border-b border-border pb-4 lg:flex-row lg:items-end lg:justify-between">
                    <div className="min-w-0">
                        <div className="text-xs font-medium text-muted-foreground">阶段 03</div>
                        <h2 className="mt-1 text-lg font-semibold">Prompt 与独立视频</h2>
                        <p className="mt-1 text-sm text-muted-foreground">4 组分镜 · 每组 12 个镜头 · 15 秒竖屏视频</p>
                    </div>
                    <div className="flex shrink-0 flex-wrap items-end gap-2">
                        <ModelControl label="Prompt 文本模型">
                            <ModelPicker config={config} capability="text" value={selectedPromptModel} onChange={(model) => emitModelChange("prompt", model)} onMissingConfig={() => openConfigDialog(true)} className={sharedBusy ? "pointer-events-none opacity-60" : ""} placeholder="选择文本模型" />
                        </ModelControl>
                        <ModelControl label="视频模型">
                            <ModelPicker config={config} capability="video" value={selectedVideoModel} onChange={(model) => emitModelChange("video", model)} onMissingConfig={() => openConfigDialog(true)} className={sharedBusy ? "pointer-events-none opacity-60" : ""} placeholder="选择视频模型" />
                        </ModelControl>
                        <Button icon={<Download className="size-4" />} loading={exporting} disabled={!productionReady} onClick={() => void exportBundle()}>
                            下载生产包
                        </Button>
                        <Button type="primary" icon={<Sparkles className="size-4" />} loading={building} disabled={sharedBusy || !prerequisites.ready} onClick={() => void buildPrompts()}>
                            {promptsReady ? "重新生成全部 Prompt" : "生成 4 条 Prompt"}
                        </Button>
                    </div>
                </div>

                <div className="grid gap-4 border-b border-border py-4 lg:grid-cols-[minmax(0,1fr)_360px]">
                    <div className="min-w-0">
                        <div className="flex items-center gap-2 text-sm font-semibold">
                            {noNarration ? <VolumeX className="size-4 text-muted-foreground" /> : <FileAudio className="size-4 text-muted-foreground" />}
                            {noNarration ? "口播设置" : "配音选择"}
                        </div>
                        {noNarration ? (
                            <>
                                <Tag className="!mt-2">不需要人物口播</Tag>
                                <p className="mt-2 text-xs leading-5 text-muted-foreground">视频 Prompt 只保留 12 个连续分镜动作，不添加口播、配音或音频引用。</p>
                            </>
                        ) : (
                            <>
                                <Segmented
                                    className="!mt-2 !w-full sm:!w-auto"
                                    disabled={sharedBusy}
                                    value={project.voice === "male" ? "male" : project.voice === "female" ? "female" : undefined}
                                    options={[{ label: "女性配音", value: "female" }, { label: "男性配音", value: "male" }]}
                                    onChange={(value) => onVoiceChange(value === "male" ? "male" : "female")}
                                />
                                <p className="mt-2 text-xs leading-5 text-muted-foreground">视频生成时会把原视频音频作为参考音频传入所选视频模型。</p>
                            </>
                        )}
                    </div>
                    <div className="flex min-w-0 items-center gap-3 rounded-lg border border-border bg-card p-3">
                        <div className="grid size-10 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">{noNarration ? <VolumeX className="size-4.5" /> : <FileAudio className="size-4.5" />}</div>
                        <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-medium">{noNarration ? "音频引用" : "原视频音频"}</div>
                            <div className="mt-0.5 truncate text-xs text-muted-foreground">{noNarration ? "当前流程无需参考音频" : project.references.audio?.originalName || (project.references.audio ? "已由视频理解提取" : "尚未提取")}</div>
                        </div>
                        <Tag color={noNarration || project.references.audio ? "success" : "warning"} className="!m-0">{noNarration ? "无需" : project.references.audio ? "就绪" : "缺失"}</Tag>
                    </div>
                </div>

                {!prerequisites.ready ? <div className="border-b border-amber-300/70 bg-amber-50 px-3 py-2.5 text-xs leading-5 text-amber-800 dark:border-amber-800/70 dark:bg-amber-950/20 dark:text-amber-200">尚缺：{prerequisites.missing.join("、")}。补齐后才能按飞书流程生成 Prompt。</div> : null}

                <div className="grid min-w-0 gap-4 py-4 xl:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
                    <section className="min-w-0 rounded-lg border border-border bg-card" aria-label="文案预处理报告">
                        <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2.5">
                            <div className="flex min-w-0 items-center gap-2 text-sm font-semibold"><FileText className="size-4 text-muted-foreground" />文案预处理</div>
                            <div className="flex shrink-0 items-center gap-1.5">
                                <Tag color={reportReady ? "success" : "default"} className="!m-0">{reportReady ? "已生成" : "待生成"}</Tag>
                                <Tooltip title="复制完整输出">
                                    <Button type="text" size="small" className="!size-7 !min-w-0 !p-0" icon={<Copy className="size-3.5" />} disabled={!reportReady} aria-label="复制文案预处理输出" onClick={() => void copyPrompt(project.copy.rawReport, "文案预处理完整输出已复制")} />
                                </Tooltip>
                            </div>
                        </div>
                        <div className="p-3">{building && !reportReady ? <ProductionLoading text="正在生成文案预处理输出" /> : <Input.TextArea readOnly value={project.copy.rawReport} placeholder="生成后显示飞书同字段的完整输出。" autoSize={{ minRows: 24, maxRows: 42 }} />}</div>
                    </section>

                    <section className="min-w-0" aria-label="Seedance 视频提示词与视频">
                        <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
                            <div className="flex min-w-0 items-center gap-2 text-sm font-semibold"><Video className="size-4 text-muted-foreground" />4 条 Seedance Prompt 与独立视频</div>
                            <div className="flex flex-wrap items-center gap-2">
                                <Button size="small" icon={<Copy className="size-3.5" />} disabled={!promptsReady} onClick={() => void copyPrompt(project.groups.map((group) => `=== 分镜 ${group.id} ===\n\n${group.videoPrompt}`).join("\n\n"), "4 条完整视频 Prompt 已复制")}>复制全部 Prompt</Button>
                                <Button type="primary" size="small" icon={<Play className="size-3.5" />} loading={batchStarting} disabled={videoCandidateCount === 0} aria-label="批量生成视频" onClick={() => void startAllVideos()}>{videoCandidateCount === 4 ? "生成全部 4 条" : videoCandidateCount ? `生成剩余 ${videoCandidateCount} 条` : "生成剩余视频"}</Button>
                            </div>
                        </div>
                        <div className="grid gap-3">
                            {project.groups.map((group) => (
                                <VideoGroupCard
                                    key={group.id}
                                    group={group}
                                    building={isPromptBuilding(group.id)}
                                    promptDisabled={isPromptBuilding(group.id) || !prerequisites.ready || isVideoActive(group) || startingGroupsRef.current.has(group.id)}
                                    disabled={!group.videoPrompt.trim() || group.imageGeneration.status !== "completed" || !group.imageGeneration.result?.url || !project.references.product?.url || startingGroupsRef.current.has(group.id)}
                                    onBuild={() => void buildPrompts(group.id)}
                                    onGenerate={() => void startGroupVideo(group.id)}
                                    onCopy={(text) => void copyPrompt(text, `分镜 ${group.id} 完整视频 Prompt 已复制`)}
                                />
                            ))}
                        </div>
                    </section>
                </div>

                <div className="flex items-center gap-2 border-t border-border pt-4 text-xs text-muted-foreground">
                    {productionReady ? <Check className="size-4 text-emerald-600" /> : <Sparkles className="size-4" />}
                    {productionReady ? "文案、4 条 Prompt 和 4 条独立 15 秒视频已就绪；未执行视频拼接" : "生成结果按 4 条独立视频保存，用户可自行剪辑"}
                </div>
            </div>
        </section>
    );
}

function ModelControl({ label, children }: { label: string; children: React.ReactNode }) {
    return <label className="grid min-w-0 gap-1 text-[11px] text-muted-foreground"><span>{label}</span>{children}</label>;
}

function VideoGroupCard({ group, building, promptDisabled, disabled, onBuild, onGenerate, onCopy }: { group: RemakeRangeGroup; building: boolean; promptDisabled: boolean; disabled: boolean; onBuild: () => void; onGenerate: () => void; onCopy: (text: string) => void }) {
    const generation = group.videoGeneration;
    const active = isVideoActive(group) && !generation.needsReview;
    const videoUrl = generation.result?.url ? browserReadableMediaUrl(generation.result.url) : "";
    return (
        <article className="min-w-0 overflow-hidden rounded-lg border border-border bg-card">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2.5">
                <div className="min-w-0">
                    <h3 className="truncate text-sm font-semibold">第 {group.ordinal} 条 · 分镜 {group.id}</h3>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">15 秒 · 12 个连续镜头 · 9:16 · 独立文件</p>
                </div>
                <div className="flex max-w-full flex-wrap items-center gap-1.5">
                    <VideoGenerationTag generation={generation} />
                    <Tooltip title="复制完整视频 Prompt">
                        <Button type="text" size="small" className="!size-7 !min-w-0 !p-0" icon={<Copy className="size-3.5" />} disabled={!group.videoPrompt} aria-label={`复制分镜 ${group.id} 视频 Prompt`} onClick={() => onCopy(group.videoPrompt)} />
                    </Tooltip>
                    <Tooltip title={`${group.videoPrompt ? "重新生成" : "生成"}分镜 ${group.id} 的 Prompt`}>
                        <Button size="small" loading={building} disabled={promptDisabled} icon={group.videoPrompt ? <RefreshCw className="size-3.5" /> : <Sparkles className="size-3.5" />} aria-label={`${group.videoPrompt ? "重新生成" : "生成"}分镜 ${group.id} Prompt`} onClick={onBuild}>
                            {group.videoPrompt ? "重新生成 Prompt" : "生成 Prompt"}
                        </Button>
                    </Tooltip>
                    <Button size="small" type={generation.status === "completed" ? "default" : "primary"} loading={active} disabled={building || (!generation.needsReview && (disabled || active))} aria-label={`${generation.needsReview ? "检查" : "生成"}分镜 ${group.id} 视频${generation.needsReview ? "状态" : ""}`} icon={generation.needsReview || generation.status === "completed" || generation.status === "error" ? <RefreshCw className="size-3.5" /> : <Play className="size-3.5" />} onClick={onGenerate}>
                        {generation.needsReview ? "检查状态" : generation.status === "completed" ? "重新生成" : generation.status === "error" ? "重试" : "生成视频"}
                    </Button>
                </div>
            </div>
            <div className="grid min-w-0 gap-3 p-3 sm:grid-cols-[110px_minmax(0,1fr)]">
                <div className="relative aspect-[9/16] w-[110px] overflow-hidden rounded-md border border-border bg-[#15181c]">
                    {group.imageGeneration.result?.url ? <Image className="!size-full !object-contain" src={imagePreviewUrl(group.imageGeneration.result.url, 700)} alt={`分镜 ${group.id} 最终十二宫格`} preview={{ src: imagePreviewUrl(group.imageGeneration.result.url, 1800) }} /> : null}
                </div>
                {building && !group.videoPrompt ? <ProductionLoading text={`正在生成分镜 ${group.id} Prompt`} /> : <Input.TextArea readOnly value={group.videoPrompt} placeholder="生成后显示飞书同字段的完整视频 Prompt。" autoSize={{ minRows: 9, maxRows: 20 }} />}
            </div>
            {generation.error ? <div className="border-t border-rose-200 bg-rose-50 px-3 py-2 text-xs leading-5 text-rose-700 dark:border-rose-900 dark:bg-rose-950/20 dark:text-rose-300">{generation.error}</div> : null}
            {active ? <div className="border-t border-border px-3 py-3"><ProductionLoading text="视频正在后台生成，刷新页面会继续恢复原任务" /></div> : null}
            {videoUrl ? (
                <div className="border-t border-border p-3">
                    <video className="max-h-[520px] w-full rounded-md bg-black" src={videoUrl} controls playsInline preload="metadata" />
                    <a className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-blue-600 hover:underline dark:text-cyan-300" href={originalMediaDownloadUrl(generation.result!.url)} download={mediaDownloadFileName(`remake-${group.id}-15s`, generation.result?.mimeType || "video/mp4", generation.result!.url)}>
                        <Download className="size-4" />下载第 {group.ordinal} 条视频
                    </a>
                </div>
            ) : null}
        </article>
    );
}

function VideoGenerationTag({ generation }: { generation: RemakeRangeGroup["videoGeneration"] }) {
    const status = generation.status;
    const color = generation.needsReview ? "warning" : status === "completed" ? "success" : status === "error" ? "error" : status === "queued" || status === "running" ? "processing" : "default";
    const label = generation.needsReview ? "待确认" : status === "completed" ? "视频完成" : status === "error" ? "视频失败" : status === "queued" ? "视频排队" : status === "running" ? "视频生成中" : "视频未生成";
    return <Tag color={color} className="!m-0">{label}</Tag>;
}

function ProductionLoading({ text }: { text: string }) {
    return (
        <div className="grid min-h-24 place-items-center rounded-md border border-dashed border-border bg-muted/15 px-4 text-center">
            <div><LoaderCircle className="mx-auto size-5 animate-spin text-muted-foreground" /><p className="mt-2 text-xs text-muted-foreground">{text}</p></div>
        </div>
    );
}

function productionPrerequisites(project: RemakeProject) {
    const missing: string[] = [];
    const noNarration = isRemakeNoNarrationCopy(project.sourceCopy);
    if (!project.sourceVideo?.url || project.analysis.status !== "completed" || project.analysis.mode !== "video" || project.frames.length !== 48 || project.frames.some((frame) => frame.analysisStatus !== "available" || !frame.frameUrl)) missing.push("完整视频理解与 48 镜头解析");
    if (!isRemakeCopyPlanReady(project)) missing.push(noNarration ? "无口播分镜预处理" : "16 个语义文案区间");
    if (!project.references.product) missing.push("新产品图");
    if (!noNarration && !project.references.audio) missing.push("原视频音频");
    if (!remakeImagesReady(project)) missing.push("4 组两步换品十二宫格");
    if (!noNarration && project.voice !== "female" && project.voice !== "male") missing.push("配音声线");
    return { ready: missing.length === 0, missing };
}

function isVideoActive(group: RemakeRangeGroup) {
    return group.videoGeneration.status === "queued" || group.videoGeneration.status === "running" || Boolean(group.videoGeneration.needsReview);
}

function videoAsset(stored: UploadedFile, groupId: string): RemakeMediaAsset {
    return {
        url: stored.serverUrl || stored.url,
        storageKey: stored.storageKey,
        mimeType: stored.mimeType || "video/mp4",
        originalName: `remake-${groupId}-15s.mp4`,
        bytes: stored.bytes,
        width: stored.width,
        height: stored.height,
        durationMs: stored.durationMs,
        remoteUrl: stored.remoteUrl,
    };
}

function remakeVideoClientRequestId(project: RemakeProject, group: RemakeRangeGroup, model: string) {
    const input = [project.id, group.id, model, group.videoPrompt, group.imageGeneration.result?.storageKey || group.imageGeneration.result?.url, project.references.product?.storageKey || project.references.product?.url, project.references.character?.storageKey || project.references.character?.url, project.references.audio?.storageKey || project.references.audio?.url].join("\n");
    return `remake-video:${group.id}:${stableTextHash(input)}`;
}

function stableTextHash(value: string) {
    let hash = 0x811c9dc5;
    for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193);
    return (hash >>> 0).toString(36);
}

function isDeferredVideoError(reason: unknown) {
    const error = reason && typeof reason === "object" ? (reason as { name?: unknown; status?: unknown; message?: unknown }) : {};
    if (error.name === "AbortError") return false;
    if (error.name === "VideoGenerationWaitTimeoutError" || error.name === "TimeoutError") return true;
    const status = Number(error.status);
    if (Number.isFinite(status)) return status === 408 || status === 425 || status === 429 || status >= 500;
    const detail = typeof error.message === "string" ? error.message : "";
    return error.name === "TypeError" || /network|failed to fetch|timed?\s*out|timeout|网络|后台生成/i.test(detail);
}

async function copyText(value: string) {
    if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(value);
    const input = document.createElement("textarea");
    input.value = value;
    input.style.position = "fixed";
    input.style.opacity = "0";
    document.body.appendChild(input);
    input.select();
    document.execCommand("copy");
    input.remove();
}
