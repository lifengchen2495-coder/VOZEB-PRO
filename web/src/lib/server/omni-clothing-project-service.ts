import { randomUUID } from "node:crypto";

import { getAuthSettings } from "@/lib/auth/store";
import type { OmniClothingAsset, OmniClothingProject, OmniClothingSegment } from "@/lib/omni-clothing-contract";
import { buildOmniClothingPrompt } from "@/lib/omni-clothing-prompts";
import type { VideoGenerationReference } from "@/lib/video-reference-contract";
import { generationModelId, toSystemGenerationChannel } from "@/lib/server/generation-channel";
import { getStoredGenerationTaskByRequest, getStoredGenerationTaskRecord, withGenerationConcurrencyLimit } from "@/lib/server/generation-task-store";
import { getLocalMediaRegistration } from "@/lib/server/local-media-registry";
import { resolveLogicalModelCandidates } from "@/lib/server/logical-model-router";
import { cleanupOmniClothingMediaAssets, mutateOmniClothingProjectWithMediaCleanup as mutateOmniClothingProject } from "@/lib/server/omni-clothing-media-cleanup";
import { createOmniClothingProject, getOmniClothingProject, deleteOmniClothingProject } from "@/lib/server/omni-clothing-project-store";
import { configuredVideoDurationPolicy } from "@/lib/server/video-task-config";
import { getVideoTask, type VideoTask } from "@/lib/server/video-task-store";

export class OmniClothingError extends Error {
    constructor(
        message: string,
        readonly status = 400,
    ) {
        super(message);
        this.name = "OmniClothingError";
    }
}

export async function createOmniClothingProjectForUser(userId: string, title: unknown) {
    const now = new Date().toISOString();
    return createOmniClothingProject(userId, {
        id: `omni-clothing-${randomUUID()}`,
        title: clean(title, 120) || "服装视频复刻",
        status: "draft",
        revision: 1,
        inputVersion: 1,
        createdAt: now,
        updatedAt: now,
        referenceImages: [],
        garmentDescription: "",
        audioStrategy: "mute",
        model: "",
        maxSegmentSeconds: 10,
        segments: [],
    });
}

export async function getOmniClothingProjectForUser(userId: string, id: string) {
    if (!/^omni-clothing-[a-zA-Z0-9-]+$/.test(id)) throw new OmniClothingError("服装复刻项目不存在", 404);
    const current = await getOmniClothingProject(id, userId);
    if (!current) throw new OmniClothingError("服装复刻项目不存在", 404);
    let project = current;
    for (const segment of current.segments.filter((item) => item.clientRequestId && item.videoStatus !== "success")) {
        const task = segment.videoTaskId ? await getVideoTask(segment.videoTaskId) : await getStoredGenerationTaskByRequest<VideoTask>("video", userId, segment.clientRequestId!, segment.attemptNo);
        if (task) project = await applyOmniClothingVideoTask(userId, id, segment.id, await withStoredTaskContext(task));
    }
    if (project.operation && Date.now() - Date.parse(project.operation.startedAt) > 15 * 60_000) {
        project = (await mutateOmniClothingProject(userId, id, (latest) => (latest.operation?.id === project.operation?.id ? touch({ ...latest, operation: undefined, status: "error", error: "上次处理已超时，可重新切片或合并" }) : null))) || project;
    }
    return project;
}

export async function updateOmniClothingProjectForUser(userId: string, id: string, input: Record<string, unknown>) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new OmniClothingError("项目更新内容无效");
    const current = await getOmniClothingProjectForUser(userId, id);
    const normalizedSource = Object.hasOwn(input, "sourceVideo") ? (input.sourceVideo === null ? undefined : await ownedAsset(userId, input.sourceVideo, "video")) : current.sourceVideo;
    const source = normalizedSource && normalizedSource.url === current.sourceVideo?.url ? { ...current.sourceVideo, ...normalizedSource } : normalizedSource;
    const references = Object.hasOwn(input, "referenceImages") ? await normalizeReferences(userId, input.referenceImages) : current.referenceImages;
    const model = Object.hasOwn(input, "model") ? clean(input.model, 200) : current.model;
    if (model && model !== current.model) await clothingModelPolicy(model, references.length);
    return requireMutation(
        await mutateOmniClothingProject(userId, id, (latest) => {
            assertRevision(latest, input.revision);
            assertNotBusy(latest);
            const garmentDescription = Object.hasOwn(input, "garmentDescription") ? clean(input.garmentDescription, 6000) : latest.garmentDescription;
            const audioStrategy = Object.hasOwn(input, "audioStrategy") ? (input.audioStrategy === "preserve" ? "preserve" : input.audioStrategy === "mute" ? "mute" : invalid("音频策略不正确")) : latest.audioStrategy;
            const maxSegmentSeconds = Object.hasOwn(input, "maxSegmentSeconds") ? Number(input.maxSegmentSeconds) : latest.maxSegmentSeconds;
            if (!Number.isInteger(maxSegmentSeconds) || maxSegmentSeconds < 2 || maxSegmentSeconds > 60) throw new OmniClothingError("单片上限需要在 2–60 秒之间");
            const recut = source?.url !== latest.sourceVideo?.url || model !== latest.model || maxSegmentSeconds !== latest.maxSegmentSeconds;
            const changed = recut || JSON.stringify(references.map((asset) => asset.url)) !== JSON.stringify(latest.referenceImages.map((asset) => asset.url)) || garmentDescription !== latest.garmentDescription || audioStrategy !== latest.audioStrategy;
            const inputVersion = latest.inputVersion + (changed ? 1 : 0);
            return touch({
                ...latest,
                title: Object.hasOwn(input, "title") ? clean(input.title, 120) || latest.title : latest.title,
                sourceVideo: source,
                referenceImages: references,
                model,
                garmentDescription,
                audioStrategy,
                maxSegmentSeconds,
                inputVersion,
                ...(changed ? { mergedVideo: undefined, error: undefined, status: "draft" as const, segments: recut ? [] : latest.segments.map((segment) => clearSegmentResult({ ...segment, inputVersion, prompt: "" })) } : {}),
            });
        }),
    );
}

export async function deleteOmniClothingProjectForUser(userId: string, id: string) {
    const project = await getOmniClothingProjectForUser(userId, id);
    assertNotBusy(project);
    await deleteOmniClothingProject(userId, id, project.revision);
    await cleanupOmniClothingMediaAssets(userId, { clips: project.segments.map((segment) => segment.sourceVideo), mergedVideo: project.mergedVideo });
}

export async function buildOmniClothingPromptsForUser(userId: string, id: string, revision: unknown) {
    return requireMutation(
        await mutateOmniClothingProject(userId, id, (project) => {
            assertRevision(project, revision);
            assertNotBusy(project);
            assertInputs(project);
            if (!project.segments.length) throw new OmniClothingError("请先完成视频切片", 409);
            return touch({
                ...project,
                status: "ready",
                mergedVideo: undefined,
                error: undefined,
                segments: project.segments.map((segment) => clearSegmentResult({ ...segment, prompt: buildOmniClothingPrompt(project, segment), inputVersion: project.inputVersion })),
            });
        }),
    );
}

export async function saveOmniClothingPromptForUser(userId: string, id: string, input: Record<string, unknown>) {
    return requireMutation(
        await mutateOmniClothingProject(userId, id, (project) => {
            assertRevision(project, input.revision);
            assertNotBusy(project);
            const target = project.segments.find((segment) => segment.id === input.segmentId);
            if (!target) throw new OmniClothingError("视频片段不存在", 404);
            const prompt = clean(input.prompt, 20000);
            if (!prompt) throw new OmniClothingError("视频提示词不能为空");
            return touch({ ...project, mergedVideo: undefined, segments: project.segments.map((segment) => (segment.id === target.id && segment.prompt !== prompt ? clearSegmentResult({ ...segment, prompt }) : segment)) });
        }),
    );
}

export async function beginOmniClothingVideoAttempt(userId: string, id: string, input: Record<string, unknown>) {
    const current = await getOmniClothingProjectForUser(userId, id);
    await clothingModelPolicy(current.model, current.referenceImages.length);
    return requireMutation(
        await mutateOmniClothingProject(userId, id, (project) => {
            assertRevision(project, input.revision);
            if (project.operation) throw new OmniClothingError("视频正在处理，请稍后再试", 409);
            assertInputs(project);
            const segment = project.segments.find((item) => item.id === input.segmentId);
            if (!segment || !segment.prompt || segment.inputVersion !== project.inputVersion) throw new OmniClothingError("片段提示词尚未准备好，请重新生成提示词", 409);
            if (segment.videoStatus === "running") throw new OmniClothingError("此片段已有视频任务，请等待或检查原任务", 409);
            if (segment.videoStatus === "submitting") return null;
            const next = { ...clearSegmentResult(segment), attemptNo: segment.attemptNo + 1, clientRequestId: `omni-clothing:${randomUUID()}`, attemptStartedAt: new Date().toISOString(), videoStatus: "submitting" as const };
            return touch({ ...project, status: "generating", mergedVideo: undefined, error: undefined, segments: project.segments.map((item) => (item.id === segment.id ? next : item)) });
        }),
    );
}

export async function failOmniClothingSubmission(userId: string, id: string, input: Record<string, unknown>) {
    return requireMutation(
        await mutateOmniClothingProject(userId, id, (project) => {
            const segment = project.segments.find((item) => item.id === input.segmentId);
            if (!segment || segment.attemptNo !== input.attemptNo || segment.clientRequestId !== input.clientRequestId) throw new OmniClothingError("视频提交版本已过期", 409);
            if (segment.videoStatus !== "submitting") return null;
            // 未知的提交结果保留同一请求 ID；点击继续时由共享入口幂等查询，避免重复扣费。
            return touch({ ...project, segments: project.segments.map((item) => (item.id === segment.id ? { ...item, error: "提交未确认，点击继续提交会检查同一任务" } : item)) });
        }),
    );
}

export async function bindOmniClothingVideoTask(userId: string, id: string, segmentId: string, taskId: string) {
    const task = await getVideoTask(taskId);
    if (!task) throw new OmniClothingError("视频任务不存在或已过期", 404);
    return applyOmniClothingVideoTask(userId, id, segmentId, await withStoredTaskContext(task));
}

export async function abandonOmniClothingSubmission(userId: string, id: string, segmentId: string) {
    const project = await getOmniClothingProjectForUser(userId, id);
    const segment = project.segments.find((item) => item.id === segmentId);
    if (!segment || segment.videoStatus !== "submitting" || !segment.clientRequestId) throw new OmniClothingError("当前片段没有待确认的提交", 409);
    const settings = await getAuthSettings();
    // 与共享创建入口使用同一把提交锁，确认没有真实任务后才允许重新编辑素材。
    const result = await withGenerationConcurrencyLimit(
        userId,
        "video",
        30 * 60_000,
        settings.generationConcurrency.video,
        async () => {
            const task = await getStoredGenerationTaskByRequest<VideoTask>("video", userId, segment.clientRequestId!, segment.attemptNo);
            if (task) return applyOmniClothingVideoTask(userId, id, segmentId, await withStoredTaskContext(task));
            return requireMutation(
                await mutateOmniClothingProject(userId, id, (latest) => {
                    const current = latest.segments.find((item) => item.id === segmentId);
                    if (!current || current.clientRequestId !== segment.clientRequestId || current.videoStatus !== "submitting") throw new OmniClothingError("片段状态已变化，请刷新", 409);
                    return touch({ ...latest, status: "ready", segments: latest.segments.map((item) => (item.id === segmentId ? { ...clearSegmentResult(item), error: "未创建视频任务，可修改素材后重新生成" } : item)) });
                }),
            );
        },
        undefined,
        segment.clientRequestId,
    );
    if (!result) throw new OmniClothingError("提交仍在处理中，请稍后继续检查", 409);
    return result;
}

export async function applyOmniClothingVideoTask(userId: string, id: string, segmentId: string, task: VideoTask) {
    return requireMutation(
        await mutateOmniClothingProject(userId, id, (project) => {
            const segment = project.segments.find((item) => item.id === segmentId);
            if (!segment) throw new OmniClothingError("视频片段不存在", 404);
            assertOmniClothingTask(project, segment, userId, task);
            const videoStatus = task.status === "success" ? "success" : task.status === "running" ? "running" : "error";
            const videoUrl = task.status === "success" ? task.result?.url || task.result?.remoteUrl : undefined;
            if (videoStatus === "success" && !videoUrl) throw new OmniClothingError("视频任务没有可用结果", 409);
            const next: OmniClothingSegment = { ...segment, videoTaskId: task.id, videoStatus, videoUrl, error: videoStatus === "error" ? task.error || "视频任务未成功，可重试" : undefined };
            if (JSON.stringify(next) === JSON.stringify(segment)) return null;
            const segments = project.segments.map((item) => (item.id === segment.id ? next : item));
            return touch({ ...project, segments, status: deriveStatus(segments), mergedVideo: undefined });
        }),
    );
}

export function assertOmniClothingTask(project: OmniClothingProject, segment: OmniClothingSegment, userId: string, task: VideoTask) {
    if (task.userId !== userId || task.projectId !== project.id || task.generationSlotId !== `omni-clothing-video:${segment.id}`) throw new OmniClothingError("视频任务不属于当前项目片段", 403);
    if (!segment.clientRequestId || task.clientRequestId !== segment.clientRequestId || task.attemptNo !== segment.attemptNo || segment.inputVersion !== project.inputVersion) throw new OmniClothingError("视频任务已过期，请使用当前素材重新生成", 409);
    if (task.prompt !== segment.prompt || task.requestedDurationSeconds !== segment.generationDurationSeconds || generationModelId(task.config) !== project.model) throw new OmniClothingError("视频任务与当前提示词、模型或时长不一致", 409);
    if (segment.videoTaskId && task.id !== segment.videoTaskId) throw new OmniClothingError("片段已绑定其他视频任务", 409);
}

export async function validateOmniClothingVideoRequest(
    userId: string,
    projectId: string,
    slotId: string,
    prompt: string,
    references: readonly VideoGenerationReference[],
    seconds: unknown,
    context?: { attemptNo?: number; clientRequestId?: string; model?: string },
) {
    const project = await getOmniClothingProjectForUser(userId, projectId);
    const segment = project.segments.find((item) => `omni-clothing-video:${item.id}` === slotId);
    if (!segment || project.operation || segment.inputVersion !== project.inputVersion || !segment.prompt) throw new OmniClothingError("服装视频片段或提示词已失效，请刷新后重试", 409);
    assertInputs(project);
    if (segment.videoStatus !== "submitting" || context?.attemptNo !== segment.attemptNo || context?.clientRequestId !== segment.clientRequestId) throw new OmniClothingError("请从服装复刻项目提交当前片段任务", 409);
    if (context?.model && context.model !== project.model) throw new OmniClothingError("视频模型与项目已保存的模型不一致", 409);
    if (prompt !== segment.prompt || Number(seconds) !== segment.generationDurationSeconds) throw new OmniClothingError("视频提示词或时长与已保存片段不一致", 409);
    const expected = [...project.referenceImages.map((asset) => ({ type: "image", url: asset.url })), { type: "video", url: segment.sourceVideo.url }];
    if (references.length !== expected.length || expected.some((item, index) => references[index]?.type !== item.type || references[index]?.url !== item.url || (references[index]?.role && references[index]?.role !== "reference")))
        throw new OmniClothingError("视频参考素材与当前服装图或源片段不一致", 409);
    await clothingModelPolicy(project.model, project.referenceImages.length);
    return { prompt: segment.prompt, durationSeconds: segment.generationDurationSeconds };
}

export type ClothingModelPolicy = { minSeconds: number; maxSeconds: number; durationOptions: number[]; minReferenceSeconds: number; maxReferenceSeconds: number };
export async function clothingModelPolicy(model: string, referenceCount = 4): Promise<ClothingModelPolicy> {
    const settings = await getAuthSettings();
    const channel = resolveLogicalModelCandidates(settings, "video", model)
        .map(toSystemGenerationChannel)
        .find(
            (candidate) =>
                (candidate.capabilityProfile?.supportsReferenceVideo ?? candidate.advancedConfig?.supportsReferenceVideo) &&
                (candidate.capabilityProfile?.supportsReferenceImage ?? candidate.advancedConfig?.supportsReferenceImage) &&
                (!candidate.capabilityProfile?.maxReferenceImages || candidate.capabilityProfile.maxReferenceImages >= referenceCount),
        );
    if (!channel) throw new OmniClothingError("请选择支持参考视频和 4–5 张服装参考图的视频编辑模型");
    const policy = configuredVideoDurationPolicy({ ...channel.capabilityProfile, durationRange: channel.advancedConfig?.durationRange });
    const seedance = /seedance|volcengine-video/.test(`${channel.model} ${channel.advancedConfig?.protocol}`);
    const maxSeconds = Math.min(60, policy.maxDurationSeconds || policy.durationSeconds?.at(-1) || (seedance ? 15 : 10));
    return {
        minSeconds: policy.minDurationSeconds || policy.durationSeconds?.[0] || 1,
        maxSeconds,
        durationOptions: policy.durationSeconds || [],
        minReferenceSeconds: seedance ? 2 : 0.5,
        maxReferenceSeconds: Math.min(maxSeconds, seedance ? 15 : maxSeconds),
    };
}

export function clothingGenerationDuration(duration: number, policy: ClothingModelPolicy) {
    const desired = Math.max(policy.minSeconds, Math.ceil(duration - 0.001));
    const result = policy.durationOptions.length ? policy.durationOptions.find((option) => option >= desired) : desired;
    if (!result || result > policy.maxSeconds) throw new OmniClothingError("片段超过所选模型的时长上限，请重新切片");
    return result;
}

export function assertInputs(project: OmniClothingProject) {
    if (!project.sourceVideo) throw new OmniClothingError("请先上传服装源视频", 409);
    if (project.referenceImages.length < 4 || project.referenceImages.length > 5) throw new OmniClothingError("请上传 4–5 张新服装参考图", 409);
    if (!project.model) throw new OmniClothingError("请先选择视频编辑模型", 409);
}

export function assertNotBusy(project: OmniClothingProject) {
    if (project.operation || project.segments.some((segment) => segment.videoStatus === "running" || segment.videoStatus === "submitting")) throw new OmniClothingError("当前仍有视频处理或生成任务，请处理完成后再修改素材", 409);
}

export function assertRevision(project: OmniClothingProject, revision: unknown) {
    if (revision !== project.revision) throw new OmniClothingError("项目已在其他页面更新，请刷新后重试", 409);
}

export function touch(project: OmniClothingProject): OmniClothingProject {
    return { ...project, revision: project.revision + 1, updatedAt: new Date().toISOString() };
}
export function requireMutation(project: OmniClothingProject | null) {
    if (!project) throw new OmniClothingError("服装复刻项目不存在", 404);
    return project;
}
export function clearSegmentResult(segment: OmniClothingSegment): OmniClothingSegment {
    return { ...segment, clientRequestId: undefined, attemptStartedAt: undefined, videoTaskId: undefined, videoStatus: "idle", videoUrl: undefined, error: undefined };
}
function deriveStatus(segments: OmniClothingSegment[]): OmniClothingProject["status"] {
    return segments.some((item) => item.videoStatus === "running" || item.videoStatus === "submitting") ? "generating" : segments.some((item) => item.videoStatus === "error") ? "error" : "ready";
}
function clean(value: unknown, length: number) {
    return typeof value === "string" ? value.trim().slice(0, length) : "";
}
function invalid(message: string): never {
    throw new OmniClothingError(message);
}

async function withStoredTaskContext(task: VideoTask): Promise<VideoTask> {
    if (task.attemptNo && task.clientRequestId && task.projectId && task.generationSlotId) return task;
    const stored = await getStoredGenerationTaskRecord("video", task.id);
    if (!stored || stored.userId !== task.userId) return task;
    return { ...task, attemptNo: task.attemptNo ?? stored.attemptNo, clientRequestId: task.clientRequestId || stored.clientRequestId, projectId: task.projectId || stored.projectId, generationSlotId: task.generationSlotId || stored.generationSlotId };
}

async function normalizeReferences(userId: string, input: unknown) {
    if (!Array.isArray(input) || input.length > 5) throw new OmniClothingError("最多上传 5 张服装参考图");
    const assets = await Promise.all(input.map((asset) => ownedAsset(userId, asset, "image")));
    if (new Set(assets.map((asset) => asset.url)).size !== assets.length) throw new OmniClothingError("参考图不能重复");
    return assets;
}

async function ownedAsset(userId: string, value: unknown, type: "image" | "video"): Promise<OmniClothingAsset> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new OmniClothingError("素材信息无效");
    const asset = value as Record<string, unknown>;
    const key = clean(asset.storageKey, 400);
    const registration = await getLocalMediaRegistration(key);
    if (!registration || registration.ownerUserId !== userId || registration.scope !== "reference" || registration.type !== type || registration.storageClass !== "permanent") throw new OmniClothingError("素材不存在或不属于当前用户，请重新上传", 403);
    return { url: `/api/reference-assets/${key.split("/").map(encodeURIComponent).join("/")}`, storageKey: key, mimeType: registration.mimeType, name: clean(asset.name, 200) || registration.originalName || `${type}-reference`, bytes: registration.bytes };
}
