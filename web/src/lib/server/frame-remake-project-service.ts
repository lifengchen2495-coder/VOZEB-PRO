import { frameRemakeHasNarration } from "@/lib/frame-remake-contract";
import { normalizeRemakeVideoPromptInstructions } from "@/lib/remake15-video-prompt-instructions";
import { randomUUID } from "node:crypto";
import { getAuthSettings } from "@/lib/auth/store";
import {
    assertFrameRemakeTimeline,
    FRAME_REMAKE_ANALYSIS_STAGES,
    FRAME_REMAKE_ANALYSIS_LABELS,
    frameRemakeAnalysisResult,
    nextFrameRemakeAnalysisStage,
    resetFrameRemakeAnalysisFrom,
    type FrameRemakeAnalysisStage,
    type FrameRemakeOperationKind,
    frameRemakeAspectRatio,
    frameRemakeBusy,
    frameRemakeImageReferences,
    frameRemakeSeconds,
    frameRemakeVideoReferences,
    idleFrameRemakeTask,
    newFrameRemakeProject,
    type FrameRemakeGenerationKind,
    type FrameRemakeMedia,
    type FrameRemakeProject,
    type FrameRemakeTask,
} from "@/lib/frame-remake-contract";
import { renderFrameRemakeCopy, renderFrameRemakeSourceAnalysis } from "@/lib/frame-remake-source";
import { frameRemakeImagePrompt, frameRemakeVideoPrompt } from "@/lib/frame-remake-prompts";
import { createFrameRemakeProject, deleteFrameRemakeProject, getFrameRemakeProject, listFrameRemakeProjects, mutateFrameRemakeProject } from "./frame-remake-project-store";
import { getLocalMediaRegistration, isLocalMediaRegistrationExpired } from "./local-media-registry";
import { collectLocalMediaStorageKeys, localMediaStorageKeyFromValue } from "./local-media-references";
import { deleteUserLocalMediaAssets } from "./local-media-storage";
import { getStoredGenerationTaskByRequest, getStoredGenerationTaskRecord, withGenerationConcurrencyLimit } from "./generation-task-store";
import type { ImageTask } from "./image-task-store";
import type { VideoTask } from "./video-task-store";
import { resolveLogicalModelCandidates } from "./logical-model-router";
import { toSystemGenerationChannel } from "./generation-channel";
import { assertCapabilityConstraints } from "./capability-constraints";
import { resolveUpstreamVideoDuration } from "./video-task-config";
import { normalizeGeminiVideoDuration } from "./gemini-video-provider";
import { fetchInternalApi } from "./internal-origin";
import { maintenanceWorkerContextHeaders } from "./maintenance-auth";

export class FrameRemakeError extends Error {
    constructor(
        message: string,
        readonly status = 400,
    ) {
        super(message);
        this.name = "FrameRemakeError";
    }
}
export const listFrameRemakeProjectsForUser = listFrameRemakeProjects;
export async function createFrameRemakeProjectForUser(userId: string, title: string) {
    return createFrameRemakeProject(userId, newFrameRemakeProject(`frame-remake-${randomUUID()}`, text(title, 160)));
}
export function changedFrameRemake(project: FrameRemakeProject): FrameRemakeProject {
    return { ...project, revision: project.revision + 1, updatedAt: new Date().toISOString() };
}
export async function mutateFrameRemake(userId: string, id: string, fn: (project: FrameRemakeProject) => FrameRemakeProject) {
    const project = await mutateFrameRemakeProject(userId, id, fn);
    if (!project) throw new FrameRemakeError("拆帧复刻项目不存在", 404);
    return project;
}
export function assertFrameRemakeRevision(project: FrameRemakeProject, revision: number) {
    if (project.revision !== revision) throw new FrameRemakeError("项目已在其他页面更新，请刷新后重试", 409);
}
export function assertFrameRemakeIdle(project: FrameRemakeProject, automationLeaseId?: string) {
    if (
        (automationLeaseId && (project.automation?.status !== "running" || project.automation.leaseId !== automationLeaseId)) ||
        frameRemakeBusy(project) ||
        (project.automation?.status === "running" && (!automationLeaseId || project.automation.leaseId !== automationLeaseId))
    )
        throw new FrameRemakeError("请等待当前处理完成，或暂停自动流程", 409);
}
export async function ownedFrameRemakeMedia(userId: string, value: unknown, type: "image" | "video" | "audio"): Promise<FrameRemakeMedia> {
    const url = text(object(value).url, 3000);
    const key = localMediaStorageKeyFromValue(url);
    const media = key ? await getLocalMediaRegistration(key) : null;
    if (!media || media.ownerUserId !== userId || media.type !== type || isLocalMediaRegistrationExpired(media)) throw new FrameRemakeError("素材不存在、已过期或无权访问", 403);
    return {
        url: `/api/${media.scope === "reference" ? "reference-assets" : "generation-log-assets"}/${media.storageKey.split("/").map(encodeURIComponent).join("/")}`,
        storageKey: media.storageKey,
        mimeType: media.mimeType,
        originalName: media.originalName,
        bytes: media.bytes,
    };
}
export async function getFrameRemakeProjectForUser(userId: string, id: string) {
    if (!/^frame-remake-[a-zA-Z0-9_-]+$/.test(id)) throw new FrameRemakeError("项目标识无效", 404);
    let project = await getFrameRemakeProject(id, userId);
    if (!project) throw new FrameRemakeError("拆帧复刻项目不存在", 404);
    if (project.operation && Date.now() - Date.parse(project.operation.updatedAt) > 30 * 60_000) {
        const operationId = project.operation.id;
        project = await mutateFrameRemake(userId, id, (current) => (current.operation?.id === operationId ? changedFrameRemake({ ...current, operation: undefined, error: "上次处理已中断，已完成的分组保留，可继续处理" }) : current));
    }
    for (const group of project.groups)
        for (const kind of ["template", "image", "video"] as const) {
            const pending = group[kind];
            if (!pending.clientRequestId || !["queued", "running"].includes(pending.status)) continue;
            const task = await getStoredGenerationTaskByRequest<ImageTask | VideoTask>(kind === "template" ? "image" : kind, userId, pending.clientRequestId, pending.attemptNo);
            if (
                !task ||
                task.userId !== userId ||
                task.projectId !== id ||
                task.generationSlotId !== `frame-remake-${kind}:${group.id}` ||
                task.prompt !== pending.prompt ||
                task.clientRequestId !== pending.clientRequestId ||
                task.attemptNo !== pending.attemptNo
            )
                continue;
            const record = await getStoredGenerationTaskRecord(kind === "template" ? "image" : kind, task.id);
            let next: FrameRemakeTask = { ...pending, status: "running", taskId: task.id, error: record?.executionPhase === "needs_review" ? "任务需要检查，请在生成任务中查询原任务" : undefined };
            if (task.status === "success") {
                try {
                    const result = kind !== "video" ? (task as ImageTask).result : undefined;
                    const media = await ownedFrameRemakeMedia(userId, { url: kind !== "video" ? result?.serverUrl || result?.dataUrl : (task as VideoTask).result?.url }, kind === "template" ? "image" : kind);
                    next = { ...next, status: "completed", error: undefined, result: { ...media, ...(result ? { width: result.width, height: result.height } : {}) } };
                } catch {
                    next = { ...next, status: "error", error: "生成结果尚未保存为可读取素材，请检查原任务" };
                }
            } else if (task.status === "error" || task.status === "cancelled") next = { ...next, status: "error", error: task.error || "生成已取消" };
            if (JSON.stringify(next) === JSON.stringify(pending)) continue;
            project = await mutateFrameRemake(userId, id, (current) => {
                const latest = current.groups.find((item) => item.id === group.id)?.[kind];
                if (!latest || latest.clientRequestId !== pending.clientRequestId || latest.attemptNo !== pending.attemptNo || !["queued", "running"].includes(latest.status)) return current;
                return changedFrameRemake({
                    ...current,
                    mergedVideo: next.status === "completed" ? undefined : current.mergedVideo,
                    groups: current.groups.map((item) =>
                        item.id !== group.id
                            ? item
                            : {
                                  ...item,
                                  [kind]: next,
                                  ...(kind !== "video" && next.status === "completed"
                                      ? { ...resetFrameRemakeAnalysisFrom(item, "videoPrompt"), [kind]: next, ...(kind === "template" ? { image: idleFrameRemakeTask(item.image.attemptNo) } : {}), video: idleFrameRemakeTask(item.video.attemptNo) }
                                      : {}),
                              },
                    ),
                });
            });
        }
    return project;
}
export async function saveFrameRemakeProjectForUser(userId: string, id: string, revision: number, raw: unknown) {
    const value = object(raw);
    const before = await getFrameRemakeProjectForUser(userId, id);
    assertFrameRemakeRevision(before, revision);
    assertFrameRemakeIdle(before);
    const patch: Partial<FrameRemakeProject> = {};
    for (const key of ["title", "instructions", "sourceCopy", "productInfo"] as const) if (value[key] !== undefined) patch[key] = requiredText(value[key], key === "title" ? 160 : 20000);
    if (value.voice !== undefined) {
        if (value.voice !== "female" && value.voice !== "male") throw new FrameRemakeError("配音声线不正确");
        patch.voice = value.voice;
    }
    if (value.audioMode !== undefined) {
        if (!["source", "generated", "silent"].includes(String(value.audioMode))) throw new FrameRemakeError("音频方式不正确");
        patch.audioMode = value.audioMode as FrameRemakeProject["audioMode"];
    }
    if (value.maxSegmentSeconds !== undefined) {
        if (!Number.isInteger(value.maxSegmentSeconds) || Number(value.maxSegmentSeconds) < 4 || Number(value.maxSegmentSeconds) > 15) throw new FrameRemakeError("每组时长需在 4–15 秒之间");
        patch.maxSegmentSeconds = Number(value.maxSegmentSeconds);
    }
    if (value.sourceVideo !== undefined) patch.sourceVideo = value.sourceVideo === null ? undefined : await ownedFrameRemakeMedia(userId, value.sourceVideo, "video");
    if (value.modelSelection !== undefined) {
        const models = object(value.modelSelection);
        patch.modelSelection = { analysis: text(models.analysis, 200), image: text(models.image, 200), video: text(models.video, 200) };
    }
    if (value.references !== undefined) {
        const refs = object(value.references);
        patch.references = { product: [], character: [], background: [] };
        for (const role of ["product", "character", "background"] as const) {
            if (!Array.isArray(refs[role]) || refs[role].length > 2) throw new FrameRemakeError("每类参考图最多 2 张");
            patch.references[role] = await Promise.all(refs[role].map((media: unknown) => ownedFrameRemakeMedia(userId, media, "image")));
        }
    }
    return mutateFrameRemake(userId, id, (current) => {
        assertFrameRemakeRevision(current, revision);
        assertFrameRemakeIdle(current);
        let next = { ...current, ...patch };
        if (patch.sourceVideo && patch.sourceVideo.url === current.sourceVideo?.url) next.sourceVideo = { ...current.sourceVideo, ...patch.sourceVideo };
        const sourceChanged = (value.sourceVideo !== undefined && current.sourceVideo?.url !== next.sourceVideo?.url) || current.maxSegmentSeconds !== next.maxSegmentSeconds;
        const referencesChanged = JSON.stringify(current.references) !== JSON.stringify(next.references);
        const instructionsChanged = current.instructions !== next.instructions || current.sourceCopy !== next.sourceCopy;
        const targetsChanged = referencesChanged || instructionsChanged || current.productInfo !== next.productInfo;
        if (sourceChanged) next = { ...next, sourceVideo: patch.sourceVideo ?? (value.sourceVideo === null ? undefined : current.sourceVideo), durationMs: 0, groups: [], mergedVideo: undefined };
        else if (targetsChanged)
            next = {
                ...next,
                groups: next.groups.map((group) => resetFrameRemakeAnalysisFrom(group, instructionsChanged ? "analysis" : "productScript")),
                mergedVideo: undefined,
            };
        else if (current.audioMode !== next.audioMode || current.voice !== next.voice) {
            next.mergedVideo = undefined;
            if (next.audioMode === "generated" || current.audioMode === "generated" || current.voice !== next.voice) next.groups = next.groups.map((group) => resetFrameRemakeAnalysisFrom(group, "videoPrompt"));
        }
        if (!sourceChanged && !targetsChanged && current.modelSelection.image !== next.modelSelection.image) {
            next = { ...next, mergedVideo: undefined, groups: next.groups.map((g) => ({ ...resetFrameRemakeAnalysisFrom(g, "videoPrompt"), template: idleFrameRemakeTask(g.template.attemptNo), image: idleFrameRemakeTask(g.image.attemptNo) })) };
        } else if (current.modelSelection.video !== next.modelSelection.video) {
            next = { ...next, mergedVideo: undefined, groups: next.groups.map((g) => ({ ...g, video: idleFrameRemakeTask(g.video.attemptNo) })) };
        }
        if (value.group !== undefined) {
            if (sourceChanged || targetsChanged) throw new FrameRemakeError("请先保存素材变化，再编辑分组", 409);
            const edit = object(value.group);
            const target = next.groups.find((group) => group.id === edit.id);
            if (!target) throw new FrameRemakeError("分组不存在", 404);
            const instructions = edit.videoPromptInstructions === undefined ? target.videoPromptInstructions : normalizeRemakeVideoPromptInstructions(edit.videoPromptInstructions);
            if (instructions !== target.videoPromptInstructions) {
                next = { ...next, mergedVideo: undefined, groups: next.groups.map((g) => (g.id === target.id ? { ...resetFrameRemakeAnalysisFrom(g, "videoPrompt"), videoPromptInstructions: instructions } : g)) };
            }
            const values = {
                analysis: edit.analysis === undefined ? target.analysis : requiredText(edit.analysis, 30000),
                copy: edit.copy === undefined ? frameRemakeAnalysisResult(target, "copy") : requiredText(edit.copy, 30000),
                productScript: edit.productScript === undefined ? frameRemakeAnalysisResult(target, "productScript") : requiredText(edit.productScript, 30000),
                imagePrompt: edit.imagePrompt === undefined ? target.imagePrompt : requiredText(edit.imagePrompt, 30000),
                videoPrompt: edit.videoPrompt === undefined ? target.videoPrompt : requiredText(edit.videoPrompt, 30000),
            };
            const changed = FRAME_REMAKE_ANALYSIS_STAGES.find((stage) => values[stage] !== frameRemakeAnalysisResult(target, stage));
            if (changed) {
                const reset = { ...resetFrameRemakeAnalysisFrom(target, changed), videoPromptInstructions: instructions };
                for (const stage of FRAME_REMAKE_ANALYSIS_STAGES) if (values[stage] !== frameRemakeAnalysisResult(target, stage)) reset[stage] = values[stage];
                next = { ...next, mergedVideo: undefined, groups: next.groups.map((group) => (group.id === target.id ? reset : group)) };
            }
        }
        if (value.frame !== undefined && value.copyBlock !== undefined) throw new FrameRemakeError("请每次保存一个校对单元");
        if (value.frame !== undefined || value.copyBlock !== undefined) {
            if (sourceChanged || targetsChanged || value.group !== undefined) throw new FrameRemakeError("请先保存素材或脚本变化，再校对单元", 409);
            const edit = object(value.frame ?? value.copyBlock);
            const target = next.groups.find((g) => g.id === edit.groupId);
            if (!target) throw new FrameRemakeError("分组不存在", 404);
            const updated = resetFrameRemakeAnalysisFrom(target, "productScript");
            if (value.frame !== undefined) {
                if (!target.frames.some((f) => f.number === edit.number)) throw new FrameRemakeError("镜头不存在", 404);
                const raw = object(edit.detail);
                if (typeof raw.hasFace !== "boolean") throw new FrameRemakeError("人脸标注不正确");
                const detail = {
                    subtitle: requiredText(raw.subtitle, 2000),
                    sellingPoint: requiredText(raw.sellingPoint, 2000),
                    shotType: requiredText(raw.shotType, 200),
                    description: requiredText(raw.description, 4000),
                    subjectRatio: requiredText(raw.subjectRatio, 200),
                    hasFace: raw.hasFace,
                };
                updated.frames = target.frames.map((f) => (f.number === edit.number ? { ...f, detail } : f));
                updated.analysis = renderFrameRemakeSourceAnalysis(updated.frames);
            } else {
                if (!target.copyBlocks?.some((b) => b.number === edit.number)) throw new FrameRemakeError("文案区间不存在", 404);
                updated.copyBlocks = target.copyBlocks.map((b) => (b.number === edit.number ? { ...b, text: requiredText(edit.text, 20000) } : b));
                updated.copy = renderFrameRemakeCopy(updated.copyBlocks);
            }
            next = { ...next, mergedVideo: undefined, groups: next.groups.map((g) => (g.id === target.id ? updated : g)) };
        }
        return changedFrameRemake({ ...next, error: undefined });
    });
}
export async function deleteFrameRemakeProjectForUser(userId: string, id: string) {
    const project = await getFrameRemakeProjectForUser(userId, id);
    assertFrameRemakeIdle(project);
    await deleteFrameRemakeProject(userId, id);
    const keys = collectLocalMediaStorageKeys(project);
    if (keys.length) await deleteUserLocalMediaAssets(userId, keys);
}

export async function startFrameRemakeOperation(userId: string, id: string, revision: number, kind: FrameRemakeOperationKind, groupId?: string, automationLeaseId?: string, analysisStage?: FrameRemakeAnalysisStage) {
    return mutateFrameRemake(userId, id, (current) => {
        assertFrameRemakeRevision(current, revision);
        assertFrameRemakeIdle(current, automationLeaseId);
        if (!current.sourceVideo) throw new FrameRemakeError("请先上传原视频");
        // 兼容旧页面的“拆帧”入口：首次只读取信息，后续调用每次只拆一组。
        const resolvedKind = kind === "extract" && !current.groups.length ? "inspect" : kind;
        if (resolvedKind !== "inspect") assertFrameRemakeTimeline(current);
        if (groupId && !current.groups.some((group) => group.id === groupId)) throw new FrameRemakeError("分组不存在", 404);
        let group = groupId ? current.groups.find((group) => group.id === groupId) : undefined;
        let stage: FrameRemakeAnalysisStage | undefined;
        if (resolvedKind === "extract") {
            group ??= current.groups.find((group) => !group.contactSheet || group.frames.some((frame) => !frame.media));
            if (!group) throw new FrameRemakeError("全部分组已拆帧");
        }
        if (resolvedKind === "analyze") {
            group ??= current.groups.find((group) => nextFrameRemakeAnalysisStage(group));
            if (!group) throw new FrameRemakeError("全部分析步骤已完成");
            stage = analysisStage ?? nextFrameRemakeAnalysisStage(group) ?? "analysis";
            if ((stage === "productScript" || stage === "imagePrompt") && (!current.references.product.length || !current.productInfo?.trim())) throw new FrameRemakeError("请先填写新产品信息并上传产品图");
            if (stage === "videoPrompt" && (group.image.status !== "completed" || !group.image.result)) throw new FrameRemakeError("请先完成本组最终分镜图");
            if (stage !== "analysis" && (!group.contactSheet || group.frames.some((frame) => !frame.media))) throw new FrameRemakeError("请先完成本组拆帧");
            if (FRAME_REMAKE_ANALYSIS_STAGES.slice(0, FRAME_REMAKE_ANALYSIS_STAGES.indexOf(stage)).some((key) => !frameRemakeAnalysisResult(group!, key))) throw new FrameRemakeError("请先完成前序分析步骤");
        }
        if (resolvedKind === "merge" && current.groups.some((group) => group.video.status !== "completed" || !group.video.result)) throw new FrameRemakeError("请先完成全部分组视频");
        const now = new Date().toISOString();
        return changedFrameRemake({
            ...current,
            groups: stage ? current.groups.map((item) => (item.id === group!.id ? resetFrameRemakeAnalysisFrom(item, stage!) : item)) : current.groups,
            mergedVideo: resolvedKind === "analyze" ? undefined : current.mergedVideo,
            operation: {
                id: randomUUID(),
                kind: resolvedKind,
                groupId: group?.id,
                analysisStage: stage,
                startedAt: now,
                updatedAt: now,
                progress: stage ? `第 ${group!.number} 组：${FRAME_REMAKE_ANALYSIS_LABELS[stage]}` : resolvedKind === "extract" ? `第 ${group!.number} 组：准备拆帧` : "准备处理",
            },
            error: undefined,
        });
    });
}

async function reserveGeneration(userId: string, id: string, revision: number, groupId: string, kind: FrameRemakeGenerationKind, automationLeaseId?: string) {
    const before = await getFrameRemakeProjectForUser(userId, id);
    const target = before.groups.find((group) => group.id === groupId);
    if (!target) throw new FrameRemakeError("分组不存在", 404);
    if (target[kind].status === "queued") {
        assertFrameRemakeRevision(before, revision);
        return before;
    }
    assertFrameRemakeIdle(before, automationLeaseId);
    assertFrameRemakeTimeline(before);
    if (kind !== "video" && (!target.contactSheet || !target.imagePrompt)) throw new FrameRemakeError("请先拆帧并生成本组复刻提示词");
    if (kind === "image" && (target.template.status !== "completed" || !target.template.result)) throw new FrameRemakeError("请先完成本组清理模板图");
    if (kind === "video" && (target.image.status !== "completed" || !target.image.result || !target.videoPrompt)) throw new FrameRemakeError("请先完成本组分镜图及视频提示词");
    const settings = await getAuthSettings();
    const model = before.modelSelection[kind === "template" ? "image" : kind] || (kind !== "video" ? settings.defaultModels.imageModel : settings.defaultModels.videoModel);
    const candidates = resolveLogicalModelCandidates(settings, kind === "template" ? "image" : kind, model);
    if (!model || !candidates.length) throw new FrameRemakeError(`请选择可用的${kind === "image" ? "生图" : "视频"}模型`);
    const references = kind !== "video" ? frameRemakeImageReferences(before, target, kind) : frameRemakeVideoReferences(before, target);
    for (const media of references) await ownedFrameRemakeMedia(userId, media, "image");
    const audio = kind === "video" && before.audioMode === "generated" && frameRemakeHasNarration(before, target) ? target.sourceAudio : undefined;
    if (kind === "video" && before.audioMode === "generated" && frameRemakeHasNarration(before, target) && !audio) throw new FrameRemakeError("请重新生成视频 Prompt，以提取本组参考音频");
    if (audio) await ownedFrameRemakeMedia(userId, audio, "audio");
    let seconds: number | undefined;
    if (kind === "video") {
        for (const candidate of candidates) {
            const channel = toSystemGenerationChannel(candidate);
            if (audio && channel.capabilityProfile?.supportsReferenceAudio !== true) continue;
            const requested = Math.ceil(frameRemakeSeconds(target));
            const duration =
                channel.apiFormat === "gemini" && !["globalaiopc", "huifeng"].includes(channel.advancedConfig?.protocol || "")
                    ? normalizeGeminiVideoDuration(requested)
                    : resolveUpstreamVideoDuration(requested, requested, { ...channel.capabilityProfile, durationRange: channel.advancedConfig?.durationRange });
            if (duration < frameRemakeSeconds(target)) continue;
            try {
                assertCapabilityConstraints(channel.capabilityProfile, { capability: "video", durationSeconds: duration, referenceCount: references.length, aspectRatio: frameRemakeAspectRatio(before) });
                seconds = duration;
                break;
            } catch {
                /* Try another configured binding before reserving a paid task. */
            }
        }
        if (!seconds) throw new FrameRemakeError(`当前视频模型不能覆盖本组 ${frameRemakeSeconds(target)} 秒，请选择兼容模型，或调小每组时长后重新拆帧`);
    }
    return mutateFrameRemake(userId, id, (current) => {
        assertFrameRemakeRevision(current, revision);
        assertFrameRemakeIdle(current, automationLeaseId);
        const group = current.groups.find((item) => item.id === groupId)!;
        const pending: FrameRemakeTask = {
            ...group[kind],
            status: "queued",
            attemptNo: group[kind].attemptNo + 1,
            clientRequestId: `frame-remake:${randomUUID()}`,
            taskId: undefined,
            result: undefined,
            error: undefined,
            model,
            seconds,
            audioReferenceUrl: audio?.url,
            referenceUrls: references.map((media) => media.url),
            prompt: kind !== "video" ? frameRemakeImagePrompt(current, group, kind) : frameRemakeVideoPrompt(current, group, seconds!),
        };
        return changedFrameRemake({
            ...current,
            modelSelection: { ...current.modelSelection, [kind === "template" ? "image" : kind]: model },
            mergedVideo: undefined,
            groups: current.groups.map((item) =>
                item.id === groupId
                    ? {
                          ...item,
                          [kind]: pending,
                          ...(kind !== "video"
                              ? { ...resetFrameRemakeAnalysisFrom(item, "videoPrompt"), [kind]: pending, ...(kind === "template" ? { image: idleFrameRemakeTask(item.image.attemptNo) } : {}), video: idleFrameRemakeTask(item.video.attemptNo) }
                              : {}),
                      }
                    : item,
            ),
        });
    });
}
export async function submitFrameRemakeGeneration(input: { userId: string; projectId: string; revision: number; groupId: string; kind: FrameRemakeGenerationKind; automationLeaseId?: string; origin: string; credential: string }) {
    const project = await reserveGeneration(input.userId, input.projectId, input.revision, input.groupId, input.kind, input.automationLeaseId);
    const group = project.groups.find((item) => item.id === input.groupId)!;
    const pending = group[input.kind];
    const context = { projectId: project.id, generationSlotId: `frame-remake-${input.kind}:${group.id}`, clientRequestId: pending.clientRequestId, attemptNo: pending.attemptNo };
    const references = pending.referenceUrls!.map((url, index) => (input.kind !== "video" ? { url, name: `图${index + 1}` } : { type: "image", role: "reference", url }));
    if (input.kind === "video" && pending.audioReferenceUrl) references.push({ type: "audio", role: "reference", url: pending.audioReferenceUrl });
    let response: Response;
    try {
        response = await fetchInternalApi(`${input.origin}/api/${input.kind !== "video" ? "image-tasks" : "video-generation-tasks"}`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                ...(maintenanceWorkerContextHeaders(input.credential) || { cookie: input.credential }),
                "x-vozeb-pro-client-request-id": pending.clientRequestId!,
                "x-vozeb-pro-attempt-no": String(pending.attemptNo),
            },
            body: JSON.stringify({
                kind: "generation",
                prompt: pending.prompt,
                title: `${project.title} · 第${group.number}组`,
                source: "drama",
                config: {
                    apiSource: "system",
                    model: pending.model,
                    size: input.kind !== "video" ? "9:16" : frameRemakeAspectRatio(project),
                    ...(input.kind !== "video" ? { quality: "2K" } : { videoSeconds: pending.seconds, vquality: "720p", videoGenerateAudio: project.audioMode === "generated" && frameRemakeHasNarration(project, group) }),
                },
                references,
                context,
            }),
        });
    } catch {
        throw new FrameRemakeError("提交结果尚未确认，请继续提交，将复用同一次请求", 502);
    }
    if (!response.ok) {
        const body = object(await response.json().catch(() => ({})));
        const message = text(body.error, 1000) || "生成提交失败";
        if (response.status >= 400 && response.status < 500)
            await mutateFrameRemake(input.userId, project.id, (current) =>
                changedFrameRemake({
                    ...current,
                    groups: current.groups.map((item) =>
                        item.id === group.id && item[input.kind].clientRequestId === pending.clientRequestId && item[input.kind].status === "queued" ? { ...item, [input.kind]: { ...item[input.kind], status: "error", error: message } } : item,
                    ),
                }),
            );
        throw new FrameRemakeError(message, response.status);
    }
    await response.body?.cancel();
    return getFrameRemakeProjectForUser(input.userId, project.id);
}
export async function abandonFrameRemakeGeneration(userId: string, id: string, groupId: string, kind: FrameRemakeGenerationKind) {
    const project = await getFrameRemakeProjectForUser(userId, id);
    const pending = project.groups.find((item) => item.id === groupId)?.[kind];
    if (pending?.status !== "queued" || !pending.clientRequestId) throw new FrameRemakeError("没有待确认提交", 409);
    const settings = await getAuthSettings();
    const result = await withGenerationConcurrencyLimit(
        userId,
        kind === "template" ? "image" : kind,
        10 * 60_000,
        settings.generationConcurrency[kind === "template" ? "image" : kind],
        async () => {
            if (await getStoredGenerationTaskByRequest(kind === "template" ? "image" : kind, userId, pending.clientRequestId!, pending.attemptNo)) return getFrameRemakeProjectForUser(userId, id);
            return mutateFrameRemake(userId, id, (current) =>
                changedFrameRemake({
                    ...current,
                    groups: current.groups.map((item) =>
                        item.id === groupId && item[kind].clientRequestId === pending.clientRequestId && item[kind].status === "queued" ? { ...item, [kind]: { ...item[kind], status: "error", error: "已撤销未确认的提交" } } : item,
                    ),
                }),
            );
        },
        undefined,
        pending.clientRequestId,
    );
    if (!result) throw new FrameRemakeError("提交仍在处理中，请稍后检查", 409);
    return result;
}
export async function validateFrameRemakeGeneration(input: {
    userId: string;
    projectId: string;
    slotId: string;
    kind: "image" | "video";
    clientRequestId?: string;
    attemptNo?: number;
    prompt: string;
    model?: string;
    references: unknown;
    size?: unknown;
    seconds?: unknown;
}) {
    const project = await getFrameRemakeProjectForUser(input.userId, input.projectId);
    const stage = input.kind === "image" && input.slotId.startsWith("frame-remake-template:") ? "template" : input.kind;
    const group = project.groups.find((item) => `frame-remake-${stage}:${item.id}` === input.slotId);
    const pending = group?.[stage];
    if (
        !group ||
        !pending ||
        pending.status !== "queued" ||
        !pending.clientRequestId ||
        pending.clientRequestId !== input.clientRequestId ||
        pending.attemptNo !== input.attemptNo ||
        pending.prompt !== input.prompt ||
        pending.model !== input.model ||
        input.size !== (input.kind !== "video" ? "9:16" : frameRemakeAspectRatio(project)) ||
        (input.kind === "video" && Number(input.seconds) !== pending.seconds)
    )
        throw new FrameRemakeError("生成参数与当前分组预留不一致，请刷新后重试", 409);
    const urls = Array.isArray(input.references)
        ? input.references.map((item, index) => {
              const reference = object(item);
              if (input.kind === "video" && (reference.type !== (pending.audioReferenceUrl && index === pending.referenceUrls?.length ? "audio" : "image") || reference.role !== "reference")) throw new FrameRemakeError("视频参考素材类型不正确");
              return reference.url || reference.serverUrl || reference.dataUrl;
          })
        : [];
    if (JSON.stringify(urls) !== JSON.stringify([...(pending.referenceUrls || []), ...(pending.audioReferenceUrl ? [pending.audioReferenceUrl] : [])])) throw new FrameRemakeError("生成参考素材与当前分组不一致", 409);
    return { prompt: pending.prompt!, durationSeconds: pending.seconds! };
}
function object(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
function text(value: unknown, max: number) {
    return typeof value === "string" ? value.trim().slice(0, max) : "";
}
function requiredText(value: unknown, max: number) {
    if (typeof value !== "string" || value.length > max) throw new FrameRemakeError("文字内容格式不正确或过长");
    return value.trim();
}
