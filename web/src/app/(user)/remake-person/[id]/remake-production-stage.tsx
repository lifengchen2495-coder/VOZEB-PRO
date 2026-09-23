"use client";

import { remakePersonGroupTiming, remakePersonTimings, remakePersonSeconds, remakePersonTimingKey, remakePersonPromptDurationError, remakePersonResultMatches, type RemakePersonTiming } from "@/lib/remake-person-timing";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { App, Button, Image, Input, Segmented, Select, Switch, Tag, Tooltip } from "antd";
import { Check, Copy, Download, FileAudio, FileText, LoaderCircle, Play, RefreshCw, Save, Sparkles, Video, VolumeX } from "lucide-react";

import { normalizeRemakeVideoSettings, remakeVideoQualityLabel, remakeVideoRequestConfig, remakeVideoSettingsKey, type RemakeVideoSettings } from "@/lib/remake-person-video-settings";
import { remakeVideoResolutionOptions, remakeVideoSettingsForModel } from "@/lib/remake-person-video-capabilities";
import { ModelPicker } from "@/components/model-picker";
import { remakeVideoPromptSystemInstructions } from "@/lib/remake-person-video-prompt-instructions";
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
import { remakeImagesReady, remakeProductionReady, remakeVideoAudioReferences, remakeVideoReferenceImages } from "./remake-production-utils";
import type { RemakeGroupPatch } from "./remake-image-stage";
import { mergeRemakeVideos } from "../remake-api";
import { isRemakeCopyPlanReady } from "./remake-workspace-state";

type PromptBuildError = { message: string; model: string };

export function RemakeProductionStage({
    project,
    getCurrentProject,
    building,
    buildingGroupIds = [],
    onVoiceChange,
    onPromptModelChange,
    onVideoModelChange,
    onVideoSettingsChange,
    onGroupChange,
    onFlush,
    onBuild,
    onMerged,
    onMergingChange,
}: {
    project: RemakeProject;
    getCurrentProject?: () => RemakeProject;
    building: boolean;
    buildingGroupIds?: string[];
    onVoiceChange: (voice: RemakeVoice) => void;
    onPromptModelChange: (model: string) => void;
    onVideoModelChange: (model: string) => void;
    onVideoSettingsChange: (settings: RemakeVideoSettings) => void;
    onGroupChange: (groupId: string, patch: RemakeGroupPatch) => void;
    onFlush: () => Promise<boolean>;
    onBuild: (groupId?: string) => void | Promise<void>;
    onMerged: (project: RemakeProject) => void;
    onMergingChange: (merging: boolean) => void;
}) {
    const { message } = App.useApp();
    const config = useEffectiveConfig();
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const selectedPromptModel = project.modelSelection.prompt || config.textModel || config.model;
    const selectedVideoModel = project.modelSelection.video || config.videoModel || config.model;
    const videoSettings = normalizeRemakeVideoSettings(project.videoSettings);
    const resolutionOptions = remakeVideoResolutionOptions(config, selectedVideoModel);
    const resolutionSupported = resolutionOptions.some((option) => option.value === videoSettings.vquality);
    const videoConfig = useMemo(
        () => ({ ...config, ...normalizeRemakeVideoSettings(project.videoSettings), model: selectedVideoModel, videoModel: selectedVideoModel, size: "9:16" }),
        [config, project.videoSettings, selectedVideoModel],
    );
    const timings = remakePersonTimings(project);
    const sourceDuration = project.sourceVideo?.durationMs || timings[0]?.sourceDurationMs || 0;
    const durationLabel = sourceDuration ? `${remakePersonSeconds(sourceDuration)} 秒` : "待解析";
    const mergedReady = Boolean(project.mergedVideo?.url && sourceDuration && Math.abs((project.mergedVideo.durationMs || 0) - sourceDuration) < 70);
    const latestProjectRef = useRef(project);
    latestProjectRef.current = project;
    const activeTasksRef = useRef(new Map<string, AbortController>());
    const promptBuildPendingRef = useRef(new Set<string>());
    const batchPromptBuildPendingRef = useRef(false);
    const [pendingPromptGroupIds, setPendingPromptGroupIds] = useState<string[]>([]);
    const [batchPromptBuildPending, setBatchPromptBuildPending] = useState(false);
    const [promptErrors, setPromptErrors] = useState<Record<string, PromptBuildError>>({});
    const startingGroupsRef = useRef(new Set<string>());
    const deferredGroupsRef = useRef(new Set<string>());
    const resumeTimersRef = useRef(new Set<number>());
    const [merging, setMerging] = useState(false);
    const mergingRef = useRef(false);
    const [exporting, setExporting] = useState(false);
    const [instructionDrafts, setInstructionDrafts] = useState<Record<string, string>>({});
    const instructionDraftsRef = useRef(instructionDrafts);
    instructionDraftsRef.current = instructionDrafts;
    const [savingInstructions, setSavingInstructions] = useState(false);
    const hasInstructionChanges = (group: RemakeRangeGroup) => instructionDrafts[group.id] !== undefined && instructionDrafts[group.id].trim() !== (group.videoPromptInstructions || "");
    const [resumeNonce, setResumeNonce] = useState(0);
    const noNarration = isRemakeNoNarrationCopy(project.sourceCopy);
    const prerequisites = productionPrerequisites(project);
    const promptsReady = project.groups.length > 0 && project.groups.every((group) => group.videoPrompt.trim() && !hasInstructionChanges(group));
    const reportReady = project.copy.status === "completed" && Boolean(project.copy.rawReport.trim());
    const productionReady = remakeProductionReady(project) && !project.groups.some(hasInstructionChanges);
    const videoActive = project.groups.some((group) => isVideoActive(group)) || startingGroupsRef.current.size > 0;
    const sharedBusy = savingInstructions || merging || building || buildingGroupIds.length > 0 || pendingPromptGroupIds.length > 0 || batchPromptBuildPending || videoActive;
    const isPromptBuilding = useCallback((groupId: string) => building || batchPromptBuildPending || buildingGroupIds.includes(groupId) || pendingPromptGroupIds.includes(groupId), [building, buildingGroupIds, batchPromptBuildPending, pendingPromptGroupIds]);
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

    const changeVideoSettings = (patch: Partial<RemakeVideoSettings>) => {
        if (sharedBusy) return;
        const current = latestProjectRef.current;
        const next = normalizeRemakeVideoSettings({ ...normalizeRemakeVideoSettings(current.videoSettings), ...patch });
        latestProjectRef.current = { ...current, videoSettings: next, groups: current.groups.map((group) => ({ ...group, videoGeneration: { status: "idle" as const } })) };
        onVideoSettingsChange(next);
    };

    const savePrompt = async (groupId: string) => {
        try {
            if (!await onFlush()) {
                message.error("视频 Prompt 保存失败，请处理保存冲突后重试");
                return;
            }
            message.success(`分镜 ${groupId} 的视频 Prompt 已保存`);
        } catch (reason) {
            message.error(reason instanceof Error ? reason.message : "视频 Prompt 保存失败");
        }
    };

    const saveInstructions = async (groupId?: string) => {
        const drafts = { ...instructionDraftsRef.current };
        const targets = latestProjectRef.current.groups.filter((group) => !groupId || group.id === groupId);
        setSavingInstructions(true);
        try {
            for (const group of targets) {
                const draft = drafts[group.id];
                if (draft === undefined || draft.trim() === (group.videoPromptInstructions || "")) continue;
                emitGroupChange(group.id, { videoPromptInstructions: draft.trim(), videoPrompt: "", videoGeneration: { status: "idle", taskId: null, model: undefined, result: null, error: null, needsReview: false } });
            }
            if (!await onFlush()) throw new Error("生成指令保存失败，请处理保存冲突后重试");
            latestProjectRef.current = getCurrentProject?.() || latestProjectRef.current;
            setInstructionDrafts((current) => {
                const remaining = { ...current };
                for (const group of targets) {
                    if (current[group.id] === drafts[group.id]) delete remaining[group.id];
                }
                instructionDraftsRef.current = remaining;
                return remaining;
            });
        } finally {
            setSavingInstructions(false);
        }
    };

    const emitModelChange = useCallback(
        (kind: "prompt" | "video", model: string) => {
            latestProjectRef.current = {
                ...latestProjectRef.current,
                modelSelection: { ...latestProjectRef.current.modelSelection, [kind]: model },
            };
            if (kind === "prompt") onPromptModelChange(model);
            else {
                onVideoModelChange(model);
                const current = latestProjectRef.current;
                const next = remakeVideoSettingsForModel(config, current.videoSettings, model);
                if (remakeVideoSettingsKey(next) !== remakeVideoSettingsKey(current.videoSettings)) {
                    latestProjectRef.current = { ...current, videoSettings: next };
                    onVideoSettingsChange(next);
                }
            }
        },
        [config, onPromptModelChange, onVideoModelChange, onVideoSettingsChange],
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
                if (announce && saved) message.success(`分镜 ${groupId} 的视频已生成`);
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
            if (mergingRef.current || isPromptBuilding(groupId)) return;
            if (startingGroupsRef.current.has(groupId)) return;
            startingGroupsRef.current.add(groupId);
            try {
                // 先保存编辑内容和参数，再创建任务状态，避免与下游失效重置合并。
                const selected = latestProjectRef.current.modelSelection.video || selectedVideoModel;
                const existingGroup = latestProjectRef.current.groups.find((item) => item.id === groupId);
                if (selected && !latestProjectRef.current.modelSelection.video && existingGroup && !isVideoActive(existingGroup)) emitModelChange("video", selected);
                if (!await saveVideoState("视频 Prompt 或设置尚未保存，请保存后重试")) return;
            } finally {
                startingGroupsRef.current.delete(groupId);
            }
            const current = getCurrentProject?.() || latestProjectRef.current;
            latestProjectRef.current = current;
            const group = current.groups.find((item) => item.id === groupId);
            if (!group || startingGroupsRef.current.has(groupId) || deferredGroupsRef.current.has(groupId)) return;
            const draft = instructionDraftsRef.current[groupId];
            if (draft !== undefined && draft.trim() !== (group.videoPromptInstructions || "")) return message.warning("请先保存生成指令并重新生成本组视频提示词");
            if (group.videoGeneration.needsReview && group.videoGeneration.taskId && group.videoGeneration.model) {
                return waitForGroupVideo(groupId, group.videoPrompt, { id: group.videoGeneration.taskId, serverTaskId: group.videoGeneration.taskId, provider: "generation", pollPath: "server", model: group.videoGeneration.model, durationSeconds: remakePersonGroupTiming(current, groupId)?.requestSeconds }, announce, true);
            }
            const awaitingCreation = isVideoActive(group) && !group.videoGeneration.taskId;
            if (isVideoActive(group) && !awaitingCreation) return;
            if (!group.videoPrompt.trim()) return message.warning(`分镜 ${group.id} 的视频 Prompt 尚未生成`);
            if (group.imageGeneration.status !== "completed" || !group.imageGeneration.result?.url || !current.references.background?.url) return message.warning(`分镜 ${group.id} 的最终分镜拼图或背景图缺失`);
            const model = current.modelSelection.video || selectedVideoModel;
            const timing = remakePersonGroupTiming(current, groupId);
            const timingError = remakePersonPromptDurationError(group.videoPrompt, timing);
            if (!timing || timingError) return message.warning(timingError);
            const generationConfig = remakeVideoRequestConfig(config, current.videoSettings, model, timing.requestSeconds);
            if (!remakeVideoResolutionOptions(config, model).some((option) => option.value === generationConfig.vquality)) return message.warning("当前模型不支持已保存的分辨率，请在视频设置中重新选择");
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
                    !savedProject.references.background?.url ||
                    isRemakeNoNarrationCopy(savedProject.sourceCopy) !== isRemakeNoNarrationCopy(current.sourceCopy) ||
                    remakeVideoClientRequestId(savedProject, savedGroup, model) !== clientRequestId
                ) return;
                const task = await createServerVideoGenerationTask(generationConfig, prompt, remakeVideoReferenceImages(group, current.references), [], remakeVideoAudioReferences(current), {
                    source: "video-workbench",
                    projectId: current.id,
                    clientRequestId,
                    attemptNo,
                    generationSlotId: `remake-person-video:${group.id}`,
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
        [config, emitGroupChange, emitModelChange, getCurrentProject, isAiConfigReady, isPromptBuilding, message, saveVideoState, openConfigDialog, scheduleResume, selectedVideoModel, waitForGroupVideo],
    );

    useEffect(() => {
        for (const group of project.groups) {
            const generation = group.videoGeneration;
            if (generation.needsReview) continue;
            if ((generation.status === "queued" || generation.status === "running") && generation.taskId && generation.model) {
                void waitForGroupVideo(
                    group.id,
                    group.videoPrompt,
                    { id: generation.taskId, serverTaskId: generation.taskId, provider: "generation", pollPath: "server", model: generation.model, durationSeconds: remakePersonGroupTiming(latestProjectRef.current, group.id)?.requestSeconds },
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

    const buildPrompts = async (groupId?: string) => {
        if (mergingRef.current || building || batchPromptBuildPendingRef.current) return;
        if (!productionPrerequisites(latestProjectRef.current).ready) return;
        if (groupId) {
            const group = latestProjectRef.current.groups.find((item) => item.id === groupId);
            if (!group || promptBuildPendingRef.current.has(groupId) || isPromptBuilding(groupId) || isVideoActive(group) || startingGroupsRef.current.has(groupId) || deferredGroupsRef.current.has(groupId)) return;
            promptBuildPendingRef.current.add(groupId);
            setPendingPromptGroupIds([...promptBuildPendingRef.current]);
        } else {
            if (buildingGroupIds.length || promptBuildPendingRef.current.size || startingGroupsRef.current.size || latestProjectRef.current.groups.some(isVideoActive)) return;
            batchPromptBuildPendingRef.current = true;
            setBatchPromptBuildPending(true);
        }
        const targetIds: string[] = latestProjectRef.current.groups.filter((group) => !groupId || group.id === groupId).map((group) => group.id);
        setPromptErrors((current) => Object.fromEntries(Object.entries(current).filter(([id]) => !targetIds.includes(id))));
        try {
            if (!selectedPromptModel) throw new Error("请先选择可用的 Prompt 文本模型");
            // 把页面显示的默认模型保存到项目，避免后台另用系统默认模型。
            if (!latestProjectRef.current.modelSelection.prompt) emitModelChange("prompt", selectedPromptModel);
            await saveInstructions(groupId);
            await onBuild(groupId);
        } catch (reason) {
            const detail = reason instanceof Error ? reason.message : "视频 Prompt 生成失败，请重试";
            setPromptErrors((current) => ({ ...current, ...Object.fromEntries(targetIds.map((id) => [id, { message: detail, model: selectedPromptModel }])) }));
            message.error(detail);
        } finally {
            if (groupId) {
                promptBuildPendingRef.current.delete(groupId);
                setPendingPromptGroupIds([...promptBuildPendingRef.current]);
            } else {
                batchPromptBuildPendingRef.current = false;
                setBatchPromptBuildPending(false);
            }
        }
    };

    const copyPrompt = async (text: string, success: string) => {
        await copyText(text);
        message.success(success);
    };

    async function mergeVideos() {
        if (mergingRef.current || sharedBusy || !productionReady) return;
        mergingRef.current = true;
        setMerging(true);
        onMergingChange(true);
        try {
            if (!(await onFlush())) return;
            const current = getCurrentProject?.() || latestProjectRef.current;
            const saved = await mergeRemakeVideos(current.id, current.revision);
            onMerged(saved);
            message.success("全部分组视频已按原视频时长合并");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "视频合并失败");
        } finally {
            mergingRef.current = false;
            setMerging(false);
            onMergingChange(false);
        }
    }

    const exportBundle = async () => {
        setExporting(true);
        try {
            await saveInstructions();
            await downloadRemakeProductionBundle(getCurrentProject?.() || latestProjectRef.current);
            message.success("换人不换品生产包已下载");
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
                        <p className="mt-1 text-sm text-muted-foreground">{project.frames.length} 个分镜 · {project.groups.length} 组竖屏视频 · 总时长 {durationLabel}</p>
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
                        <Button loading={merging} disabled={!productionReady || sharedBusy} onClick={() => void mergeVideos()}>合并视频</Button>
                        {mergedReady ? <Button href={`/api/remake-person/projects/${encodeURIComponent(project.id)}/merge`} icon={<Download className="size-4" />}>下载成片</Button> : null}
                        <Button type="primary" icon={<Sparkles className="size-4" />} loading={building} disabled={sharedBusy || !prerequisites.ready} onClick={() => void buildPrompts()}>
                            {promptsReady ? "重新生成视频 Prompt" : "生成视频 Prompt"}
                        </Button>
                    </div>
                </div>

                <section className="space-y-3 border-b border-border py-4" aria-label="视频设置">
                    <div className="text-sm font-semibold">视频设置</div>
                    <div className="flex flex-wrap items-end gap-5">
                        <ModelControl label="分辨率">
                            <Select aria-label="视频分辨率" className="min-w-32" disabled={sharedBusy} value={resolutionSupported ? videoSettings.vquality : undefined} placeholder="请选择分辨率" status={resolutionSupported ? undefined : "error"} options={resolutionOptions} onChange={(vquality) => changeVideoSettings({ vquality })} />
                        </ModelControl>
                        <ModelControl label="每段时长"><Input className="!w-28" value="按原分镜时间" readOnly aria-label="每段视频时长" /></ModelControl>
                        <ModelControl label="画面比例"><Input className="!w-32" value="9:16 竖屏（固定）" readOnly aria-label="视频画面比例" /></ModelControl>
                        <label className="flex h-8 items-center gap-2 text-sm"><Switch aria-label="生成声音" disabled={sharedBusy} checked={videoSettings.videoGenerateAudio === "true"} onChange={(checked) => changeVideoSettings({ videoGenerateAudio: checked ? "true" : "false" })} />生成声音</label>
                        <label className="flex h-8 items-center gap-2 text-sm"><Switch aria-label="添加水印" disabled={sharedBusy} checked={videoSettings.videoWatermark === "true"} onChange={(checked) => changeVideoSettings({ videoWatermark: checked ? "true" : "false" })} />添加水印</label>
                    </div>
                    {!resolutionSupported ? <p role="alert" className="text-xs text-amber-700 dark:text-amber-400">已保存的 {remakeVideoQualityLabel(videoSettings.vquality)} 不适用于当前模型，请重新选择分辨率。</p> : null}
                    <p className="text-xs leading-5 text-muted-foreground">设置自动保存，修改后需重新生成全部分组视频。每组时长按原分镜时间计算，总时长与原视频一致，比例 9:16；合并视频使用所选分辨率。声音、水印及分辨率支持范围以所选模型为准。</p>
                </section>

                <div className="grid gap-4 border-b border-border py-4 lg:grid-cols-[minmax(0,1fr)_360px]">
                    <div className="min-w-0">
                        <div className="flex items-center gap-2 text-sm font-semibold">
                            {noNarration ? <VolumeX className="size-4 text-muted-foreground" /> : <FileAudio className="size-4 text-muted-foreground" />}
                            {noNarration ? "口播设置" : "配音选择"}
                        </div>
                        {noNarration ? (
                            <>
                                <Tag className="!mt-2">不需要人物口播</Tag>
                                <p className="mt-2 text-xs leading-5 text-muted-foreground">视频 Prompt 只保留本组实际分镜动作，不添加口播、配音或音频引用。</p>
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

                {!prerequisites.ready ? <div className="border-b border-amber-300/70 bg-amber-50 px-3 py-2.5 text-xs leading-5 text-amber-800 dark:border-amber-800/70 dark:bg-amber-950/20 dark:text-amber-200">尚缺：{prerequisites.missing.join("、")}。补齐后即可生成视频 Prompt。</div> : null}

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
                        <div className="p-3">{building && !reportReady ? <ProductionLoading text="正在生成文案预处理输出" /> : <Input.TextArea readOnly value={project.copy.rawReport} placeholder="生成后显示完整文案预处理报告。" autoSize={{ minRows: 24, maxRows: 42 }} />}</div>
                    </section>

                    <section className="min-w-0" aria-label="Seedance 视频提示词与视频">
                        <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
                            <div className="flex min-w-0 items-center gap-2 text-sm font-semibold"><Video className="size-4 text-muted-foreground" />分组视频提示词与成片</div>
                            <div className="flex flex-wrap items-center gap-2">
                                <Button size="small" icon={<Copy className="size-3.5" />} disabled={!promptsReady} onClick={() => void copyPrompt(project.groups.map((group) => `=== 分镜 ${group.id} ===\n\n${group.videoPrompt}`).join("\n\n"), "视频 Prompt 已复制")}>复制视频 Prompt</Button>
                            </div>
                        </div>
                        <div className="grid gap-3">
                            {project.groups.map((group) => (
                                <VideoGroupCard
                                    key={group.id}
                                    group={group}
                                    resolution={videoSettings.vquality}
                                    timing={remakePersonGroupTiming(project, group.id)}
                                    editingDisabled={sharedBusy || group.imageGeneration.status !== "completed" || !group.imageGeneration.result?.url}
                                    onPromptChange={(videoPrompt) => {
                                        if (sharedBusy) return;
                                        emitGroupChange(group.id, { videoPrompt, videoGeneration: { status: "idle", taskId: null, attemptNo: undefined, model: null, result: null, error: null, needsReview: false } });
                                    }}
                                    onSavePrompt={() => savePrompt(group.id)}
                                    building={isPromptBuilding(group.id)}
                                    promptError={promptErrors[group.id]}
                                    promptModel={selectedPromptModel}
                                    promptDisabled={isPromptBuilding(group.id) || !prerequisites.ready || isVideoActive(group) || startingGroupsRef.current.has(group.id)}
                                    disabled={hasInstructionChanges(group) || !group.videoPrompt.trim() || group.imageGeneration.status !== "completed" || !group.imageGeneration.result?.url || !project.references.background?.url || startingGroupsRef.current.has(group.id)}
                                    instructionValue={remakeVideoPromptSystemInstructions(group.id, undefined, !isRemakeNoNarrationCopy(project.sourceCopy), project.voice === "male" ? "male" : "female", remakePersonGroupTiming(project, group.id))}
                                    instructionsDirty={hasInstructionChanges(group)}
                                    instructionsDisabled={sharedBusy}
                                    onInstructionsChange={(value) => {
                                        if (sharedBusy) return;
                                        const next = { ...instructionDraftsRef.current, [group.id]: value };
                                        instructionDraftsRef.current = next;
                                        setInstructionDrafts(next);
                                    }}
                                    onSaveInstructions={async () => {
                                        await saveInstructions(group.id);
                                        message.success(`分镜 ${group.id} 的生成指令已保存`);
                                    }}
                                    onBuild={() => buildPrompts(group.id)}
                                    onGenerate={() => void startGroupVideo(group.id)}
                                    onCopy={(text) => void copyPrompt(text, `分镜 ${group.id} 完整视频 Prompt 已复制`)}
                                />
                            ))}
                        </div>
                    </section>
                </div>

                {mergedReady ? <section className="mb-4 rounded-lg border border-border p-3" aria-label="换人不换品成片"><h3 className="mb-3 text-sm font-semibold">换人不换品成片</h3><video className="mx-auto max-h-[560px] max-w-full rounded-md bg-black" src={browserReadableMediaUrl(project.mergedVideo!.url)} controls playsInline preload="metadata" /></section> : null}
                <div className="flex items-center gap-2 border-t border-border pt-4 text-xs text-muted-foreground">
                    {productionReady ? <Check className="size-4 text-emerald-600" /> : <Sparkles className="size-4" />}
                    {productionReady ? `全部 ${project.groups.length} 条视频及生产素材已就绪` : `按原片时长生成 ${project.groups.length} 组视频后，可下载视频及完整生产包`}
                </div>
            </div>
        </section>
    );
}

function ModelControl({ label, children }: { label: string; children: React.ReactNode }) {
    return <label className="grid min-w-0 gap-1 text-[11px] text-muted-foreground"><span>{label}</span>{children}</label>;
}

function VideoGroupCard({ group, resolution, timing, instructionValue, editingDisabled, onPromptChange, onSavePrompt, building, promptError, promptModel, promptDisabled, disabled, onBuild, onGenerate, onCopy }: {
    group: RemakeRangeGroup;
    resolution: string;
    timing?: RemakePersonTiming;
    editingDisabled: boolean;
    onPromptChange: (prompt: string) => void;
    onSavePrompt: () => Promise<void>;
    building: boolean;
    promptError?: PromptBuildError;
    promptModel: string;
    promptDisabled: boolean;
    disabled: boolean;
    instructionValue?: string;
    instructionsDirty: boolean;
    instructionsDisabled: boolean;
    onInstructionsChange: (value: string) => void;
    onSaveInstructions: () => Promise<void>;
    onBuild: () => void | Promise<void>;
    onGenerate: () => void;
    onCopy: (text: string) => void;
}) {
    const generation = group.videoGeneration;
    const timingError = group.videoPrompt ? remakePersonPromptDurationError(group.videoPrompt, timing) : "";
    const staleVideo = generation.status === "completed" && !remakePersonResultMatches(timing, generation.result);
    const active = isVideoActive(group) && !generation.needsReview;
    const videoUrl = generation.result?.url ? browserReadableMediaUrl(generation.result.url) : "";
    return (
        <article className="min-w-0 overflow-hidden rounded-lg border border-border bg-card">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2.5">
                <div className="min-w-0">
                    <h3 className="truncate text-sm font-semibold">第 {group.ordinal} 条 · 分镜 {group.id}</h3>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">{timing ? `${remakePersonSeconds(timing.durationMs)} 秒 · 原片 ${remakePersonSeconds(timing.startMs)}–${remakePersonSeconds(timing.endMs)} 秒` : "时间轴待解析"} · {group.frameOrdinals.length} 个连续镜头 · 9:16 · {remakeVideoQualityLabel(resolution)} · 独立文件</p>
                </div>
                <div className="flex max-w-full flex-wrap items-center gap-1.5">
                    <VideoGenerationTag generation={generation} />
                    <Tooltip title="复制完整视频 Prompt">
                        <Button type="text" size="small" className="!size-7 !min-w-0 !p-0" icon={<Copy className="size-3.5" />} disabled={!group.videoPrompt} aria-label={`复制分镜 ${group.id} 视频 Prompt`} onClick={() => onCopy(group.videoPrompt)} />
                    </Tooltip>
                    <Tooltip title={`${group.videoPrompt ? "重新生成" : "生成"}分镜 ${group.id} 的 Prompt`}>
                        <Button size="small" loading={building} disabled={promptDisabled} icon={group.videoPrompt ? <RefreshCw className="size-3.5" /> : <Sparkles className="size-3.5" />} aria-label={`${group.videoPrompt ? "重新生成" : "生成"}分镜 ${group.id} Prompt`} onClick={onBuild}>
                            {promptError ? "重试 Prompt" : group.videoPrompt ? "重新生成 Prompt" : "生成 Prompt"}
                        </Button>
                    </Tooltip>
                    <Button size="small" type={generation.status === "completed" ? "default" : "primary"} loading={active} disabled={building || (!generation.needsReview && (disabled || active))} aria-label={`${generation.needsReview ? "检查" : "生成"}分镜 ${group.id} 视频${generation.needsReview ? "状态" : ""}`} icon={generation.needsReview || generation.status === "completed" || generation.status === "error" ? <RefreshCw className="size-3.5" /> : <Play className="size-3.5" />} onClick={onGenerate}>
                        {generation.needsReview ? "检查状态" : generation.status === "completed" ? "重新生成" : generation.status === "error" ? "重试" : "生成视频"}
                    </Button>
                </div>
            </div>
            {building ? <PromptBuildStatus model={promptModel} /> : null}
            {!building && promptError ? <div role="alert" className="border-b border-rose-200 bg-rose-50 px-3 py-2 text-xs leading-5 text-rose-700 dark:border-rose-900 dark:bg-rose-950/20 dark:text-rose-300">{promptError.message}<div className="mt-1">本次 Prompt 模型：{promptError.model || "未选择"}。可点击“重试 Prompt”，或在上方切换 Prompt 模型后重试。</div></div> : null}
            <div className="p-3">
                <details>
                    <summary className="cursor-pointer text-xs font-medium">分镜 {group.id} 视频提示词生成指令（本组实际发送内容）</summary>
                    <Input.TextArea readOnly value={instructionValue} autoSize={{ minRows: 9, maxRows: 20 }} />
                </details>
            </div>
            <div className="grid min-w-0 gap-3 p-3 sm:grid-cols-[110px_minmax(0,1fr)]">
                <div className="relative aspect-[9/16] w-[110px] overflow-hidden rounded-md border border-border bg-[#15181c]">
                    {group.imageGeneration.result?.url ? <Image className="!size-full !object-contain" src={imagePreviewUrl(group.imageGeneration.result.url, 700)} alt={`分镜 ${group.id} 最终分镜拼图`} preview={{ src: imagePreviewUrl(group.imageGeneration.result.url, 1800) }} /> : null}
                </div>
                {building && !group.videoPrompt ? <ProductionLoading text={`正在生成分镜 ${group.id} Prompt`} /> : (
                    <div className="min-w-0 space-y-2">
                        <Input.TextArea aria-label={`分镜 ${group.id} 视频 Prompt`} disabled={editingDisabled} value={group.videoPrompt} onChange={(event) => onPromptChange(event.target.value)} maxLength={100_000} placeholder="可直接编辑或粘贴完整的视频提示词，时长须与本组原分镜一致。" autoSize={{ minRows: 9, maxRows: 20 }} />
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="text-xs text-muted-foreground">可直接编辑，修改自动保存；生成视频使用已保存内容。</span>
                            <Button size="small" icon={<Save className="size-3.5" />} disabled={editingDisabled || !group.videoPrompt.trim()} onClick={() => void onSavePrompt()}>保存 Prompt</Button>
                        </div>
                    </div>
                )}
            </div>
            {timingError || staleVideo ? <div role="alert" className="border-t border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">{timingError || "此视频使用了旧时长，请重新生成本组视频。"}</div> : null}
            {generation.error ? <VideoGenerationError error={generation.error} model={generation.model} /> : null}
            {active ? <div className="border-t border-border px-3 py-3"><ProductionLoading text="视频正在后台生成，刷新页面会继续恢复原任务" /></div> : null}
            {videoUrl ? (
                <div className="border-t border-border p-3">
                    <video className="max-h-[520px] w-full rounded-md bg-black" src={videoUrl} controls playsInline preload="metadata" />
                    <a className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-blue-600 hover:underline dark:text-cyan-300" href={originalMediaDownloadUrl(generation.result!.url)} download={mediaDownloadFileName(`remake-${group.id}-${remakePersonSeconds(timing?.durationMs || generation.result?.durationMs || 0)}s`, generation.result?.mimeType || "video/mp4", generation.result!.url)}>
                        <Download className="size-4" />下载第 {group.ordinal} 条视频
                    </a>
                </div>
            ) : null}
        </article>
    );
}

function VideoGenerationError({ error, model }: { error: string; model?: string | null }) {
    const realPersonRejected = /input image[\s\S]*may contain (?:a )?real person/i.test(error);
    return (
        <div role="alert" className="border-t border-rose-200 bg-rose-50 px-3 py-2 text-xs leading-5 text-rose-700 dark:border-rose-900 dark:bg-rose-950/20 dark:text-rose-300">
            {realPersonRejected ? (
                <>
                    <p>视频渠道判定输入图片可能包含真人，已拒绝生成。</p>
                    <p className="mt-1">请检查本组分镜拼图和人物参考图是否符合所选渠道的素材要求。即使人物由 AI 生成，也可能被识别为真人。若确认素材符合要求，请联系渠道方复核；直接重试相同素材仍可能失败。</p>
                    {model ? <p className="mt-1">本次视频模型：{model}</p> : null}
                    <details className="mt-1">
                        <summary className="cursor-pointer">原始错误与请求编号（供渠道方排查）</summary>
                        <p className="mt-1 break-words">{error}</p>
                    </details>
                </>
            ) : error}
        </div>
    );
}

function VideoGenerationTag({ generation }: { generation: RemakeRangeGroup["videoGeneration"] }) {
    const status = generation.status;
    const color = generation.needsReview ? "warning" : status === "completed" ? "success" : status === "error" ? "error" : status === "queued" || status === "running" ? "processing" : "default";
    const label = generation.needsReview ? "待确认" : status === "completed" ? "视频完成" : status === "error" ? "视频失败" : status === "queued" ? "视频排队" : status === "running" ? "视频生成中" : "视频未生成";
    return <Tag color={color} className="!m-0">{label}</Tag>;
}

function PromptBuildStatus({ model }: { model: string }) {
    const [elapsed, setElapsed] = useState(0);
    useEffect(() => {
        const startedAt = Date.now();
        const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);
        return () => window.clearInterval(timer);
    }, []);
    return <div role="status" className="border-b border-border px-3 py-2 text-xs leading-5 text-muted-foreground">正在生成 Prompt · {model} · 已等待 {elapsed} 秒。完成后会自动填入下方，失败原因会显示在本组。</div>;
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
    if (!project.sourceVideo?.url || project.analysis.status !== "completed" || project.analysis.mode !== "video" || !project.frames.length || project.frames.some((frame) => frame.analysisStatus !== "available" || !frame.frameUrl)) missing.push("完整视频理解与 镜头解析");
    if (!remakePersonTimings(project).length) missing.push("连续完整的原视频时间轴");
    if (!isRemakeCopyPlanReady(project)) missing.push(noNarration ? "无口播分镜预处理" : "全部语义文案区间");
    if (!project.references.background) missing.push("背景图");
    if (!noNarration && !project.references.audio) missing.push("原视频音频");
    if (!remakeImagesReady(project)) missing.push("全部分组分镜图");
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
        originalName: `remake-${groupId}-${remakePersonSeconds(stored.durationMs || 0)}s.mp4`,
        bytes: stored.bytes,
        width: stored.width,
        height: stored.height,
        durationMs: stored.durationMs,
        remoteUrl: stored.remoteUrl,
    };
}

function remakeVideoClientRequestId(project: RemakeProject, group: RemakeRangeGroup, model: string) {
    const input = [project.id, group.id, remakePersonTimingKey(remakePersonGroupTiming(project, group.id)), group.videoPromptInstructions || "", model, group.videoPrompt, group.imageGeneration.result?.storageKey || group.imageGeneration.result?.url, project.references.background?.storageKey || project.references.background?.url, project.references.character?.storageKey || project.references.character?.url, project.references.audio?.storageKey || project.references.audio?.url, project.references.product?.storageKey || project.references.product?.url].join("\n");
    const settings = remakeVideoSettingsKey(project.videoSettings);
    return `remake-person-video:${group.id}:${stableTextHash(settings ? `${input}\n${settings}` : input)}`;
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
