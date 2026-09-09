import { createHash, randomUUID } from "node:crypto";
import { getAuthSettings } from "@/lib/auth/store";
import { createOmniProject, omniInputVersion, parseOmniAnalysis, parseOmniPlan, type OmniInputPatch, type OmniMedia, type OmniProject, type OmniSegment } from "@/lib/omni-remake-contract";
import { createRemakeProject, deleteRemakeProject, getRemakeProject, mutateRemakeProject } from "./omni-remake-project-store";
import { getLocalMediaRegistration, isLocalMediaRegistrationExpired } from "./local-media-registry";
import { collectLocalMediaStorageKeys, localMediaStorageKeyFromValue } from "./local-media-references";
import { deleteUserLocalMediaAssets } from "./local-media-storage";
import { getStoredGenerationTaskByRequest, getStoredGenerationTaskRecord, withGenerationConcurrencyLimit } from "./generation-task-store";
import type { VideoTask } from "./video-task-store";
import type { VideoGenerationReference } from "@/lib/video-reference-contract";
import { strictJsonObjectText } from "./structured-model-output";

type OmniMediaContext = { origin: string; credential: string };

export class OmniProjectError extends Error {
    constructor(
        message: string,
        readonly status = 400,
    ) {
        super(message);
    }
}
export async function createOmniProjectForUser(userId: string, title: string) {
    return createRemakeProject(userId, createOmniProject(`omni-remake-${randomUUID()}`, title));
}
export async function getOmniProjectForUser(userId: string, id: string): Promise<OmniProject> {
    if (!id.startsWith("omni-remake-")) throw new OmniProjectError("Omni 项目不存在", 404);
    let project = await getRemakeProject(id, userId);
    if (!project) throw new OmniProjectError("Omni 项目不存在", 404);
    if (project.operation && Date.now() - Date.parse(project.operation.startedAt) > 30 * 60_000) {
        const staleId = project.operation.id;
        project = await mutateOmni(userId, id, (current) => (current.operation?.id === staleId ? changed({ ...current, operation: undefined, error: "上次处理已中断，请重新运行该步骤" }) : current));
    }
    const updates = new Map<string, OmniSegment["video"]>();
    for (const segment of project.segments) {
        if (!["running", "queued"].includes(segment.video.status)) continue;
        const task = segment.video.taskId
            ? ((await getStoredGenerationTaskRecord("video", segment.video.taskId))?.payload as VideoTask | undefined)
            : segment.video.clientRequestId
              ? await getStoredGenerationTaskByRequest<VideoTask>("video", userId, segment.video.clientRequestId, segment.video.attemptNo)
              : null;
        if (!task) continue;
        const record = await getStoredGenerationTaskRecord("video", task.id);
        if (!record || record.userId !== userId || task.projectId !== id || task.generationSlotId !== `omni-remake-video:${segment.id}` || task.prompt !== segment.prompt || (record.attemptNo || 0) !== segment.video.attemptNo) continue;
        const video = { ...segment.video, taskId: task.id, needsReview: record.executionPhase === "needs_review", error: record.executionPhase === "needs_review" ? (typeof record.resultPayload?.reviewReason === "string" ? record.resultPayload.reviewReason : "任务需要检查，请继续查询原任务") : undefined };
        if (task.status === "success" && task.result?.url) {
            updates.set(segment.id, {
                ...video,
                status: "completed",
                error: undefined,
                result: { url: task.result.url, storageKey: localMediaStorageKeyFromValue(task.result.url) || undefined, mimeType: task.result.mimeType || "video/mp4", duration: (task.result.durationMs || 0) / 1000 || undefined },
            });
        } else if (task.status === "error" || task.status === "cancelled") updates.set(segment.id, { ...video, status: "error", error: task.error || "视频任务已取消" });
        else if (JSON.stringify({ ...video, status: "running" }) !== JSON.stringify(segment.video)) updates.set(segment.id, { ...video, status: "running" });
    }
    if (updates.size)
        project = await mutateOmni(userId, id, (current) =>
            changed({
                ...current,
                segments: current.segments.map((segment) => {
                    const update = updates.get(segment.id);
                    return update && update.attemptNo === segment.video.attemptNo && update.clientRequestId === segment.video.clientRequestId && ["queued", "running"].includes(segment.video.status) ? { ...segment, video: update } : segment;
                }),
            }),
        );
    return project;
}

export async function saveOmniProjectForUser(userId: string, id: string, revision: number, raw: unknown, context?: OmniMediaContext) {
    const value = object(raw);
    const patch: OmniInputPatch = {};
    for (const key of ["title", "productName", "instructions"] as const)
        if (value[key] !== undefined) {
            if (typeof value[key] !== "string" || (value[key] as string).length > (key === "instructions" ? 20000 : 160)) throw new OmniProjectError("名称或补充要求过长");
            patch[key] = (value[key] as string).trim();
        }
    if (value.videoPromptInstructions !== undefined) {
        if (typeof value.videoPromptInstructions !== "string" || value.videoPromptInstructions.length > 50_000) throw new OmniProjectError("视频提示词生成指令必须是文字且不能超过 50000 字");
        patch.videoPromptInstructions = value.videoPromptInstructions.trim();
    }
    if (value.sourceVideo !== undefined) patch.sourceVideo = value.sourceVideo === null ? undefined : await ownedOmniMedia(userId, value.sourceVideo, "video");
    if (value.references !== undefined) {
        const refs = object(value.references);
        patch.references = { product: [], character: [], background: [] };
        for (const role of ["product", "character", "background"] as const) {
            if (!Array.isArray(refs[role]) || refs[role].length > 5) throw new OmniProjectError("每类参考图最多 5 张");
            patch.references[role] = await Promise.all(refs[role].map((asset: unknown) => ownedOmniMedia(userId, asset, "image")));
        }
        if (Object.values(patch.references).flat().length > 10) throw new OmniProjectError("参考图合计最多 10 张");
    }
    if (value.productStrategy !== undefined) {
        if (!["replace", "preserve"].includes(String(value.productStrategy))) throw new OmniProjectError("产品处理方式不正确");
        patch.productStrategy = value.productStrategy as OmniProject["productStrategy"];
    }
    if (value.audioMode !== undefined) {
        if (!["auto", "silent", "source"].includes(String(value.audioMode))) throw new OmniProjectError("音频处理方式不正确");
        patch.audioMode = value.audioMode as OmniProject["audioMode"];
    }
    for (const key of ["replaceCharacter", "replaceBackground"] as const)
        if (value[key] !== undefined) {
            if (typeof value[key] !== "boolean") throw new OmniProjectError("替换选项不正确");
            patch[key] = value[key] as boolean;
        }
    if (value.modelSelection !== undefined) {
        const models = object(value.modelSelection);
        patch.modelSelection = { analysis: clean(models.analysis, 200), prompt: clean(models.prompt, 200), video: clean(models.video, 200) };
    }
    let importedAnalysis: Partial<OmniProject> | undefined;
    if (value.analysisJson !== undefined) {
        const before = await getOmniProjectForUser(userId, id);
        assertRevision(before, revision);
        assertIdle(before);
        const source = "sourceVideo" in patch ? patch.sourceVideo : before.sourceVideo;
        if (!source || !context) throw new OmniProjectError("请先上传原视频，再导入分析 JSON");
        const { inspectOmniVideoAsset } = await import("./omni-remake-runtime");
        const analysisRaw = importedJson(value.analysisJson);
        try {
            const measured = await inspectOmniVideoAsset({ ...context, userId, media: source });
            const analysis = parseOmniAnalysis(analysisRaw, measured.duration!, patch.audioMode || before.audioMode);
            const supplied = object(JSON.parse(analysisRaw));
            const rows = supplied.segments as Array<Record<string, unknown>>;
            const hasPrompts = rows.some((row) => row.prompt !== undefined || row.promptZh !== undefined);
            const plan = hasPrompts ? parseOmniPlan(JSON.stringify({ ...supplied, materialAnalysis: supplied.materialAnalysis || "人工导入的素材分析", plan: supplied.plan || "按人工分析逐段准备素材与提示词", segments: rows.map((row, index) => ({ ...row, id: analysis.segments[index].id })) }), analysis.segments) : undefined;
            importedAnalysis = { sourceVideo: measured, analysisRaw, analysisSummary: analysis.summary, segments: plan?.segments || analysis.segments, materialAnalysis: plan?.materialAnalysis || "", plan: plan?.plan || "", mergedVideo: undefined };
        } catch (error) {
            throw new OmniProjectError(error instanceof Error ? error.message : "分析 JSON 不正确");
        }
    }
    return mutateOmni(userId, id, (current) => {
        assertRevision(current, revision);
        assertIdle(current);
        const next = { ...current, ...patch };
        if (next.sourceVideo && next.sourceVideo.url === current.sourceVideo?.url) next.sourceVideo = { ...current.sourceVideo, ...next.sourceVideo };
        if (omniInputVersion(next) !== omniInputVersion(current)) {
            const onlyPromptInstructionsChanged = omniInputVersion({ ...next, videoPromptInstructions: current.videoPromptInstructions }) === omniInputVersion(current);
            const sourceChanged = next.sourceVideo?.url !== current.sourceVideo?.url;
            if (sourceChanged || next.audioMode !== current.audioMode) Object.assign(next, { segments: [], analysisRaw: "", analysisSummary: "" });
            else next.segments = next.segments.map((segment) => ({ ...segment, prompt: "", promptZh: "", sourceClip: onlyPromptInstructionsChanged ? segment.sourceClip : undefined, video: { status: "idle", attemptNo: segment.video.attemptNo } }));
            Object.assign(next, { materialAnalysis: "", plan: "", mergedVideo: undefined });
        }
        if (importedAnalysis) Object.assign(next, importedAnalysis);
        if (value.planJson !== undefined) {
            if (!next.segments.length) throw new OmniProjectError("请先导入视频分析，再导入提示词计划");
            try {
                Object.assign(next, parseOmniPlan(importedJson(value.planJson), next.segments), { mergedVideo: undefined });
            } catch (error) {
                throw new OmniProjectError(error instanceof Error ? error.message : "提示词计划 JSON 不正确");
            }
        }
        return changed(next);
    });
}

export async function updateOmniPrompt(userId: string, id: string, revision: number, segmentId: string, prompt: string, promptZh: string) {
    if (!prompt.trim() || !promptZh.trim() || prompt.length > 30000 || promptZh.length > 30000) throw new OmniProjectError("片段中英文提示词为空或过长");
    return mutateOmni(userId, id, (current) => {
        assertRevision(current, revision);
        assertIdle(current);
        if (!current.segments.some((segment) => segment.id === segmentId)) throw new OmniProjectError("片段不存在", 404);
        return changed({
            ...current,
            mergedVideo: undefined,
            segments: current.segments.map((segment) => (segment.id === segmentId ? { ...segment, prompt: prompt.trim(), promptZh: promptZh.trim(), video: { status: "idle", attemptNo: segment.video.attemptNo } } : segment)),
        });
    });
}

export async function startOmniOperation(userId: string, id: string, revision: number, kind: NonNullable<OmniProject["operation"]>["kind"], promptMode: "template" | "ai" = "template") {
    return mutateOmni(userId, id, (current) => {
        assertRevision(current, revision);
        assertIdle(current);
        return changed({ ...current, operation: { id: randomUUID(), kind, promptMode, startedAt: new Date().toISOString() }, error: undefined });
    });
}
export async function finishOmniOperation(userId: string, id: string, operationId: string, patch: Partial<OmniProject>) {
    return mutateOmni(userId, id, (current) => {
        if (current.operation?.id !== operationId) throw new OmniProjectError("项目素材已经变化，未保存旧任务结果", 409);
        return changed({ ...current, ...patch, id: current.id, createdAt: current.createdAt, operation: undefined });
    });
}

export async function validateOmniVideoRequest(input: { userId: string; projectId: string; slotId: string; prompt: string; references: unknown; seconds: unknown; attemptNo?: number; clientRequestId?: string; model?: string; size?: unknown }): Promise<{ prompt: string; durationSeconds: number; references: VideoGenerationReference[] }> {
    await getOmniProjectForUser(input.userId, input.projectId);
    throw new OmniProjectError("此流程已改为导出素材后在 Google 手动生成，请回传成片", 410);
}

export function assertOmniManualResultReady(project: OmniProject, segmentId: string) {
    assertIdle(project);
    const segment = project.segments.find((item) => item.id === segmentId);
    if (!segment?.sourceClip?.url || !segment.prompt.trim() || !segment.promptZh.trim()) throw new OmniProjectError("请先准备该片段的参考视频和中英文提示词", 409);
    return segment;
}

export function omniManualResultVersion(project: OmniProject, segment: OmniSegment) {
    const digest = createHash("sha256").update(JSON.stringify([omniInputVersion(project), segment.id, segment.start, segment.end, segment.audioStrategy, segment.sourceClip?.url, segment.prompt, segment.promptZh])).digest("hex");
    return `omni-manual:${segment.id}:${digest}`;
}

export function omniManualUploadId(storageKey: string) {
    return createHash("sha256").update(storageKey).digest("hex");
}

export async function importOmniSegmentVideo(userId: string, id: string, revision: number, segmentId: string, url: string, context: OmniMediaContext) {
    const before = await getOmniProjectForUser(userId, id);
    const target = assertOmniManualResultReady(before, segmentId);
    const version = omniManualResultVersion(before, target);
    const uploadedKey = localMediaStorageKeyFromValue(url);
    if (!uploadedKey) throw new OmniProjectError("请上传该片段在 Google 生成的视频", 400);
    // 响应丢失后的重复采用返回原结果，避免再次复制文件或清空已合并成片。
    const existingKey = target.video.result && localMediaStorageKeyFromValue(target.video.result.url);
    const existing = existingKey ? await getLocalMediaRegistration(existingKey) : null;
    if (target.video.status === "completed" && existing?.ownerUserId === userId && existing.projectId === id && existing.taskId === version && existing.runId === uploadedKey) return before;
    assertRevision(before, revision);
    const uploaded = await getLocalMediaRegistration(uploadedKey);
    if (!uploaded || uploaded.ownerUserId !== userId || uploaded.projectId !== id || uploaded.type !== "video" || uploaded.source !== "omni-remake-result-upload" || isLocalMediaRegistrationExpired(uploaded)) throw new OmniProjectError("回传视频不存在、已过期或不属于本项目，请重新上传", 403);
    if (uploaded.taskId !== version) throw new OmniProjectError("片段素材或提示词已变化，请按最新素材重新生成并上传结果", 409);
    const media = await ownedOmniMedia(userId, { url }, "video");
    const { prepareOmniManualResult } = await import("./omni-remake-runtime");
    let result: OmniMedia;
    try {
        result = await prepareOmniManualResult({ ...context, userId, projectId: id, media, segment: target, version });
    } catch (error) {
        throw new OmniProjectError(error instanceof Error ? error.message : "回传素材不是有效视频");
    }
    let adopted = false;
    try {
        const saved = await mutateOmni(userId, id, (current) => {
            assertRevision(current, revision);
            const segment = assertOmniManualResultReady(current, segmentId);
            if (omniManualResultVersion(current, segment) !== version) throw new OmniProjectError("片段已变化，请刷新后重试", 409);
            return changed({ ...current, mergedVideo: undefined, segments: current.segments.map((item) => item.id === segmentId ? { ...item, video: { status: "completed", attemptNo: item.video.attemptNo + 1, manualUploadId: omniManualUploadId(uploadedKey), result } } : item) });
        });
        adopted = true;
        await deleteUserLocalMediaAssets(userId, [uploadedKey]).catch((error) => console.warn("Omni 已采用的临时视频清理失败", error));
        return saved;
    } finally {
        if (!adopted && result.storageKey) await deleteUserLocalMediaAssets(userId, [result.storageKey]).catch((error) => console.warn("Omni 未采用的回传视频清理失败", error));
    }
}
export async function deleteOmniProjectForUser(userId: string, id: string) {
    const project = await getOmniProjectForUser(userId, id);
    assertIdle(project);
    await deleteRemakeProject(userId, id);
    const keys = collectLocalMediaStorageKeys(project);
    if (keys.length) await deleteUserLocalMediaAssets(userId, keys);
}
export async function ownedOmniMedia(userId: string, value: unknown, type: "image" | "video"): Promise<OmniMedia> {
    const url = clean(object(value).url, 3000);
    const storageKey = localMediaStorageKeyFromValue(url);
    const asset = storageKey ? await getLocalMediaRegistration(storageKey) : null;
    if (!asset || asset.ownerUserId !== userId || asset.type !== type || isLocalMediaRegistrationExpired(asset)) throw new OmniProjectError("参考素材不存在或无权访问", 403);
    return {
        url: `/api/${asset.scope === "reference" ? "reference-assets" : "generation-log-assets"}/${asset.storageKey.split("/").map(encodeURIComponent).join("/")}`,
        storageKey: asset.storageKey,
        mimeType: asset.mimeType,
        originalName: asset.originalName,
        bytes: asset.bytes,
    };
}
export async function mutateOmni(userId: string, id: string, mutate: (current: OmniProject) => OmniProject) {
    if (!id.startsWith("omni-remake-")) throw new OmniProjectError("Omni 项目不存在", 404);
    let removedKeys: string[] = [];
    const project = await mutateRemakeProject(userId, id, (current) => {
        const next = mutate(current);
        const retained = new Set(collectLocalMediaStorageKeys(next));
        removedKeys = collectLocalMediaStorageKeys([current.mergedVideo, ...current.segments.map((segment) => [segment.sourceClip, segment.video.result])]).filter((key) => !retained.has(key));
        return next;
    });
    if (!project) throw new OmniProjectError("Omni 项目不存在", 404);
    if (removedKeys.length) await deleteUserLocalMediaAssets(userId, removedKeys).catch((error) => console.warn("Omni 已移除媒体清理失败", error));
    return project;
}

export async function abandonOmniSubmission(userId: string, id: string, segmentId: string) {
    const project = await getOmniProjectForUser(userId, id);
    const segment = project.segments.find((item) => item.id === segmentId);
    if (!segment || segment.video.status !== "queued" || !segment.video.clientRequestId) throw new OmniProjectError("片段没有待确认的提交", 409);
    const settings = await getAuthSettings();
    const result = await withGenerationConcurrencyLimit(
        userId,
        "video",
        30 * 60_000,
        settings.generationConcurrency.video,
        async () => {
            const task = await getStoredGenerationTaskByRequest<VideoTask>("video", userId, segment.video.clientRequestId!, segment.video.attemptNo);
            if (task) return getOmniProjectForUser(userId, id);
            return mutateOmni(userId, id, (current) => {
                const active = current.segments.find((item) => item.id === segmentId);
                if (active?.video.status !== "queued" || active.video.clientRequestId !== segment.video.clientRequestId) throw new OmniProjectError("片段状态已变化，请刷新", 409);
                return changed({ ...current, segments: current.segments.map((item) => (item.id === segmentId ? { ...item, video: { status: "idle", attemptNo: item.video.attemptNo, error: "尚未创建视频任务，可重新编辑后生成" } } : item)) });
            });
        },
        undefined,
        segment.video.clientRequestId,
    );
    if (!result) throw new OmniProjectError("提交仍在处理中，请稍后检查", 409);
    return result;
}
function changed(project: OmniProject) {
    return { ...project, revision: project.revision + 1, updatedAt: new Date().toISOString() };
}
function assertRevision(project: OmniProject, revision: number) {
    if (!Number.isInteger(revision) || project.revision !== revision) throw new OmniProjectError("项目已更新，请刷新后重试", 409);
}
function assertIdle(project: OmniProject) {
    if (project.operation || project.segments.some((segment) => ["queued", "running"].includes(segment.video.status))) throw new OmniProjectError("请等待当前任务完成后再修改项目", 409);
}
function object(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
function clean(value: unknown, max: number) {
    if (typeof value !== "string") return "";
    if (value.length > max) throw new OmniProjectError("输入内容过长");
    return value.trim();
}

function importedJson(value: unknown) {
    const raw = typeof value === "string" ? value.trim() : JSON.stringify(value);
    if (!raw || raw.length > 500_000) throw new OmniProjectError("导入 JSON 为空或超过 500000 字");
    const json = strictJsonObjectText(raw);
    if (!json) throw new OmniProjectError("请提供完整的 JSON 对象");
    return json;
}
