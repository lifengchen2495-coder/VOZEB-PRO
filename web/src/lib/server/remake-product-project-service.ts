import { invalidateRemakeMergedVideo } from "./remake-product-merge-contract";
import { createHash } from "node:crypto";
import { nanoid } from "nanoid";

import { remakeProductionInputSnapshot, type RemakeProductionInputProject } from "@/lib/remake-product-production-input";
import { renderRemakeCopyReport } from "./remake-product-production-prompt";
import { restoreRemakeCopyReport } from "./remake-copy-report-recovery";

import {
    buildRemakeCopyBlocks,
    defaultRemakePipeline,
    emptyRemakeCopyState,
    emptyRemakeModelSelection,
    emptyRemakeRangeGroups,
    emptyRemakeReferences,
    idleRemakeAnalysis,
    isRemakeNoNarrationCopy,
    mergeRemakeContactSheets,
    normalizeRemakeCopyState,
    normalizeRemakeCopyBlocks,
    normalizeRemakeFrames,
    normalizeRemakeMediaAsset,
    normalizeRemakeModelSelection,
    normalizeRemakeProjectWorkflow,
    normalizeRemakeRangeGroups,
    normalizeRemakeReferences,
    normalizeRemakeSourceVideo,
    normalizeRemakeTimestamps,
    normalizeRemakeVideoPrompt,
    REMAKE_COPY_BLOCK_COUNT,
    REMAKE_FRAME_COUNT,
    REMAKE_NO_NARRATION_TEXT,
    type HydratedRemakeProject,
    type RemakeAnalysisMode,
    type RemakeContactSheetInput,
    type RemakeCopyBlock,
    type RemakeCopyState,
    type RemakeCopyStrategy,
    type RemakeFrame,
    type RemakeMediaAsset,
    type RemakeModelSelection,
    type RemakePipeline,
    type RemakePipelineStage,
    type RemakePipelineStep,
    type RemakePipelineStepStatus,
    type RemakeProject,
    type RemakeProjectAnalysis,
    type RemakeProjectStatus,
    type RemakeRangeGroup,
    type RemakeReferences,
    type RemakeSourceVideo,
    type RemakeVoice,
} from "@/lib/server/remake-product-project-contract";
import { collectLocalMediaStorageKeys } from "@/lib/server/local-media-references";
import { localMediaStorageKeyFromValue } from "@/lib/server/local-media-references";
import { remakeStoryboardPrompt, remakeStoryboardPromptReferences } from "@/lib/remake-product-image-prompt";
import type { ImageTask } from "@/lib/server/image-task-store";
import { getStoredGenerationTaskRecord } from "@/lib/server/generation-task-store";
import { createRemakeAnalysisTask, failRemakeAnalysisTask, findActiveRemakeAnalysisTask, getRemakeAnalysisTask, queueRemakeAnalysisTask, type RemakeAnalysisTask } from "@/lib/server/remake-product-analysis-task-store";
import { remakeContactSheetDimensionError } from "@/lib/server/remake-contact-sheet-validation";
import { createRemakeProject, deleteRemakeProject, getRemakeProject, listRemakeProjectSummaries, mutateRemakeProject, RemakeProjectStoreError, updateRemakeProject } from "@/lib/server/remake-product-project-store";
import { deleteUserLocalMediaAssets } from "@/lib/server/local-media-storage";
import { getVideoTask } from "@/lib/server/video-task-store";

const MAX_PROJECT_BYTES = 5 * 1024 * 1024;
const MAX_SOURCE_COPY_LENGTH = 200_000;

export class RemakeProjectServiceError extends Error {
    constructor(
        message: string,
        readonly status = 400,
    ) {
        super(message);
        this.name = "RemakeProjectServiceError";
    }
}

export class RemakeAnalysisSupersededError extends Error {
    constructor() {
        super("当前分析任务已被新的任务替换");
        this.name = "RemakeAnalysisSupersededError";
    }
}

export type RemakeVideoPromptInput = { groupOrdinal: number; prompt: string };
export type RemakeProductionCompletionInput = {
    expectedRevision?: number;
    expectedInputVersion?: string;
    groupId?: string;
    copy?: Partial<RemakeCopyState>;
    copyBlocks?: RemakeCopyBlock[];
    videoPrompts?: RemakeVideoPromptInput[];
};

export function remakeProductionInputVersion(project: RemakeProductionInputProject, groupIds?: readonly string[]) {
    return createHash("sha256").update(remakeProductionInputSnapshot(project, groupIds)).digest("hex");
}

export function listRemakeProjectSummariesForUser(userId: string, input: { page?: number; pageSize?: number } = {}) {
    return listRemakeProjectSummaries(userId, input);
}

export async function getRemakeProjectForUser(userId: string, id: string) {
    const project = await getRemakeProject(cleanText(id, 160), userId);
    if (!project) throw new RemakeProjectServiceError("复刻项目不存在", 404);
    return restoreRemakeCopyReport(normalizeRemakeProjectWorkflow(project), renderRemakeCopyReport);
}

export async function createRemakeProjectForUser(userId: string, value: unknown) {
    const input = object(value);
    const now = new Date().toISOString();
    const sourceVideo = sourceVideoInput(input.sourceVideo, false);
    const analysis = idleRemakeAnalysis();
    const project: RemakeProject = {
        id: `remake-product-${nanoid()}`,
        title: cleanText(input.title, 120) || "未命名复刻",
        status: normalizeStatus(input.status),
        revision: 1,
        sourceVideo,
        sourceCopy: cleanText(input.sourceCopy, MAX_SOURCE_COPY_LENGTH),
        productInfo: cleanText(input.productInfo, 20_000),
        copyStrategy: normalizeCopyStrategy(input.copyStrategy),
        voice: normalizeVoice(input.voice),
        analysis,
        frames: [],
        copyBlocks: [],
        pipeline: defaultRemakePipeline({ hasSourceVideo: Boolean(sourceVideo), analysisStatus: analysis.status }),
        modelSelection: emptyRemakeModelSelection(),
        references: emptyRemakeReferences(),
        groups: emptyRemakeRangeGroups(),
        copy: { ...emptyRemakeCopyState(), ...(cleanText(input.sourceCopy, MAX_SOURCE_COPY_LENGTH) === REMAKE_NO_NARRATION_TEXT ? { optionRaw: REMAKE_NO_NARRATION_TEXT } : {}) },
        createdAt: now,
        updatedAt: now,
    };
    assertProjectSize(project);
    try {
        return await createRemakeProject(userId, project);
    } catch (error) {
        throwStoreError(error);
    }
}

export async function updateRemakeProjectForUser(userId: string, id: string, value: unknown) {
    if (Buffer.byteLength(JSON.stringify(value || {})) > MAX_PROJECT_BYTES) throw new RemakeProjectServiceError("复刻项目数据过大", 413);
    const current = await getRemakeProjectForUser(userId, id);
    const input = object(value);
    const requestedRevision = optionalRevision(input.revision);
    if (requestedRevision !== undefined && requestedRevision !== current.revision) throw new RemakeProjectServiceError("复刻项目已在其他页面更新，请刷新后重试", 409);

    if (hasOwn(object(input.references), "character") || hasOwn(object(input.references), "characterSupplement") || hasOwn(object(input.references), "background")) throw new RemakeProjectServiceError("换品不换人流程不接受人物或背景替换素材", 400);
    const hasSourceVideo = hasOwn(input, "sourceVideo");
    const sourceVideo = hasSourceVideo ? sourceVideoInput(input.sourceVideo, true) : current.sourceVideo;
    const sourceChanged = hasSourceVideo && sourceVideoIdentity(sourceVideo) !== sourceVideoIdentity(current.sourceVideo);
    const strategy = hasOwn(input, "copyStrategy") ? normalizeCopyStrategy(input.copyStrategy) : current.copyStrategy;
    const sourceCopy = sourceChanged ? (hasOwn(input, "sourceCopy") ? cleanText(input.sourceCopy, MAX_SOURCE_COPY_LENGTH) : "") : hasOwn(input, "sourceCopy") ? cleanText(input.sourceCopy, MAX_SOURCE_COPY_LENGTH) : current.sourceCopy;
    const narrationSelectionChanged = hasOwn(input, "sourceCopy") && (sourceCopy.trim() === REMAKE_NO_NARRATION_TEXT) !== (current.copy.optionRaw === REMAKE_NO_NARRATION_TEXT);
    const sourceCopyChanged = sourceCopy !== current.sourceCopy || narrationSelectionChanged;
    const productInfo = hasOwn(input, "productInfo") ? cleanText(input.productInfo, 20_000) : current.productInfo;
    const productInfoChanged = productInfo !== current.productInfo;
    const frames = sourceChanged ? [] : normalizeEditableFrames(input, current.frames);
    const analysis = sourceChanged ? idleRemakeAnalysis() : current.analysis;
    const modelSelection = hasOwn(input, "modelSelection") ? normalizeRemakeModelSelection(input.modelSelection, current.modelSelection) : current.modelSelection;
    const imageModelChanged = modelSelection.image !== current.modelSelection.image;
    const promptModelChanged = modelSelection.prompt !== current.modelSelection.prompt;
    const videoModelChanged = modelSelection.video !== current.modelSelection.video;
    const referenceFallback = sourceChanged ? { ...current.references, audio: undefined } : current.references;
    const normalizedReferences = hasOwn(input, "references") ? normalizeRemakeReferences(input.references, referenceFallback) : referenceFallback;
    const references = sourceChanged ? { ...normalizedReferences, audio: undefined } : { ...normalizedReferences, audio: current.references.audio };
    const referencesChanged = remakeGenerationReferenceIdentity(references) !== remakeGenerationReferenceIdentity(current.references);
    let copy = sourceChanged || sourceCopyChanged ? emptyRemakeCopyState() : current.copy;
    if (sourceCopy.trim() === REMAKE_NO_NARRATION_TEXT) copy = { ...copy, optionRaw: REMAKE_NO_NARRATION_TEXT };
    let groups = sourceChanged
        ? emptyRemakeRangeGroups()
        : referencesChanged || imageModelChanged || productInfoChanged || hasOwn(input, "frames")
          ? invalidateRemakeImages(current.groups)
          : hasOwn(input, "groups")
            ? await normalizeEditableRemakeGroups({ userId, projectId: current.id, value: input.groups, current: current.groups, references, frames, modelSelection, productInfo })
            : current.groups;
    const copyBlocks = sourceChanged
        ? []
        : normalizeRemakeCopyBlocks(sourceCopyChanged ? undefined : input.copyBlocks, {
              frames,
              sourceCopy,
              strategy,
              fallback: sourceCopyChanged ? [] : current.copyBlocks,
              mappings: copy.mappings,
          });
    if (!sourceCopyChanged && hasOwn(input, "copyBlocks") && copy.status === "completed" && copy.mappings.length === REMAKE_COPY_BLOCK_COUNT) {
        const blocksByOrdinal = new Map(copyBlocks.map((block) => [block.ordinal, block]));
        const mappings = copy.mappings.map((mapping) => ({ ...mapping, text: blocksByOrdinal.get(mapping.blockOrdinal)?.text || "" }));
        const unchangedBlocks = copyBlocks.filter((block) => block.text.trim() && block.text === block.sourceText).length;
        const correctedBlocks = copyBlocks.filter((block) => block.text.trim() && block.text !== block.sourceText).length;
        const emptyBlocks = copyBlocks.filter((block) => !block.text.trim()).length;
        copy = {
            ...copy,
            mappings,
            stats: { ...copy.stats, unchangedBlocks, completedBlocks: 0, correctedBlocks, emptyBlocks },
        };
    }
    const copyInputsChanged = hasOwn(input, "frames") || hasOwn(input, "copyBlocks") || sourceCopyChanged || strategy !== current.copyStrategy;
    const productionInputsChanged = copyInputsChanged || promptModelChanged || (hasOwn(input, "voice") && normalizeVoice(input.voice) !== current.voice);
    if (productionInputsChanged && !sourceChanged) {
        groups = groups.map((group) => ({ ...group, videoPrompt: "", videoGeneration: { status: "idle" as const } }));
        // 配音和 Prompt 模型只影响视频下游，不改变已完成的文案预处理。
        if (copyInputsChanged) copy = { ...copy, rawReport: "", error: undefined };
    } else if (videoModelChanged) {
        groups = groups.map((group) => ({ ...group, videoGeneration: { status: "idle" as const } }));
    }
    const voice = hasOwn(input, "voice") ? normalizeVoice(input.voice) : current.voice;
    const pipeline = deriveRemakePipeline({ sourceVideo, sourceCopy, analysis, references, groups, copy, copyBlocks });
    const next: RemakeProject = {
        ...current,
        title: hasOwn(input, "title") ? cleanText(input.title, 120) || current.title : current.title,
        status: hasOwn(input, "status") ? normalizeStatus(input.status) : current.status,
        sourceVideo,
        sourceCopy,
        productInfo,
        copyStrategy: strategy,
        voice,
        analysis,
        frames,
        copyBlocks,
        pipeline,
        modelSelection,
        references,
        groups,
        copy,
        revision: current.revision + 1,
        updatedAt: new Date().toISOString(),
    };
    assertProjectSize(next);
    try {
        const saved = await updateRemakeProject(userId, invalidateRemakeMergedVideo(current, next), current.revision);
        await cleanupReplacedMedia(userId, current, saved);
        return saved;
    } catch (error) {
        throwStoreError(error);
    }
}

export async function deleteRemakeProjectForUser(userId: string, id: string) {
    const projectId = cleanText(id, 160);
    const deleted = await deleteRemakeProject(userId, projectId);
    if (!deleted) throw new RemakeProjectServiceError("复刻项目不存在", 404);
    if (typeof deleted === "object") await deleteUserLocalMediaAssets(userId, collectLocalMediaStorageKeys(deleted)).catch(() => undefined);
}

export async function startRemakeAnalysisForUser(userId: string, id: string) {
    const project = await getRemakeProjectForUser(userId, id);
    if (!project.sourceVideo?.url) throw new RemakeProjectServiceError("请先上传原视频", 400);
    const active = await findActiveRemakeAnalysisTask(userId, project.id);
    if (active && active.id === project.analysis.taskId && (project.analysis.status === "queued" || project.analysis.status === "running")) {
        await queueRemakeAnalysisTask(active);
        return { project, task: active, reused: true };
    }
    if (active) await failRemakeAnalysisTask(active, "分析任务未绑定当前项目状态，已停止旧任务");

    const previousTask = project.analysis.taskId ? await getRemakeAnalysisTask(project.analysis.taskId) : null;
    const task = await createRemakeAnalysisTask({ userId, projectId: project.id, attemptNo: (previousTask?.attemptNo || 0) + (previousTask ? 1 : 0) });
    let selected = false;
    const next = await mutateRemakeProject(userId, project.id, (current) => {
        const normalized = normalizeRemakeProjectWorkflow(current);
        if ((normalized.analysis.status === "queued" || normalized.analysis.status === "running") && normalized.analysis.taskId !== project.analysis.taskId) return current;
        if (!normalized.sourceVideo?.url) throw new RemakeProjectServiceError("请先上传原视频", 400);
        selected = true;
        return withRevision(normalized, {
            analysis: { status: "queued", taskId: task.id, runId: task.runId },
            pipeline: withPipelineStep(normalized.pipeline, "analysis", "queued", "analysis", task.id),
        });
    });
    if (!next) {
        await failRemakeAnalysisTask(task, "复刻项目不存在");
        throw new RemakeProjectServiceError("复刻项目不存在", 404);
    }
    if (!selected) {
        await failRemakeAnalysisTask(task, "分析请求已由另一个任务接管");
        const concurrent = next.analysis.taskId ? await getRemakeAnalysisTask(next.analysis.taskId) : null;
        if (concurrent?.userId === userId) return { project: next, task: concurrent, reused: true };
        throw new RemakeProjectServiceError("分析任务状态已变化，请刷新后重试", 409);
    }
    try {
        await queueRemakeAnalysisTask(task);
    } catch (error) {
        const message = safeError(error, "分析任务排队失败");
        await failRemakeAnalysisTask(task, message);
        await failRemakeProjectAnalysis(task, message);
        throw new RemakeProjectServiceError(message, 500);
    }
    return { project: next, task, reused: false };
}

export async function markRemakeProjectAnalysisRunning(task: RemakeAnalysisTask) {
    const next = await mutateRemakeProject(task.userId, task.projectId, (current) => {
        const normalized = normalizeRemakeProjectWorkflow(current);
        if (normalized.analysis.taskId !== task.id) return current;
        if (normalized.analysis.status === "completed") return current;
        return withRevision(normalized, {
            analysis: { status: "running", taskId: task.id, runId: task.runId, raw: normalized.analysis.raw, timestamps: normalized.analysis.timestamps },
            pipeline: withPipelineStep(normalized.pipeline, "analysis", "running", "analysis", task.id),
        });
    });
    if (!next || next.analysis.taskId !== task.id) throw new RemakeAnalysisSupersededError();
    return next;
}

export async function completeRemakeProjectAnalysis(input: {
    task: RemakeAnalysisTask;
    frames: RemakeFrame[];
    sourceVideo: RemakeSourceVideo;
    mode: RemakeAnalysisMode;
    warning?: string;
    sourceCopy?: string;
    analysisRaw?: string;
    timestamps?: number[];
    contactSheets?: RemakeContactSheetInput[];
    copyBlocks?: RemakeCopyBlock[];
    copy?: Partial<RemakeCopyState>;
    audio?: RemakeMediaAsset;
}) {
    let previous: RemakeProject | undefined;
    const next = await mutateRemakeProject(input.task.userId, input.task.projectId, (current) => {
        const normalized = normalizeRemakeProjectWorkflow(current);
        if (normalized.analysis.taskId !== input.task.id) return current;
        const frames = normalizeRemakeFrames(input.frames);
        if (frames.length !== REMAKE_FRAME_COUNT || frames.some((frame, index) => frame.ordinal !== index + 1)) throw new RemakeProjectServiceError("视频分析必须返回完整的 12 个帧单元", 400);
        const timestamps = input.timestamps === undefined ? frames.map((frame) => frame.time) : normalizeRemakeTimestamps(input.timestamps);
        if (timestamps.length !== REMAKE_FRAME_COUNT) throw new RemakeProjectServiceError("视频分析必须返回完整的 12 个抽帧时间点", 400);
        const sourceCopy = normalized.sourceCopy.trim() || cleanText(input.sourceCopy, MAX_SOURCE_COPY_LENGTH);
        const copy = normalizeRemakeCopyState(input.copy, normalized.copy);
        const copyBlocks = input.copyBlocks
            ? normalizeRemakeCopyBlocks(input.copyBlocks, { frames, sourceCopy, strategy: normalized.copyStrategy, mappings: copy.mappings, requireComplete: true })
            : buildRemakeCopyBlocks({ frames, sourceCopy, strategy: normalized.copyStrategy, existing: normalized.copyBlocks, mappings: copy.mappings });
        if (copyBlocks.length !== REMAKE_COPY_BLOCK_COUNT) throw new RemakeProjectServiceError("视频分析必须返回完整的 16 个语义文案区间", 400);
        const groups = mergeRemakeContactSheets(emptyRemakeRangeGroups(), input.contactSheets);
        if (input.contactSheets && groups.some((group) => !group.sourceContactSheet)) throw new RemakeProjectServiceError("视频分析必须返回完整的 1 张十二宫格拼图", 400);
        const audio = input.audio === undefined ? normalized.references.audio : normalizeRemakeMediaAsset(input.audio);
        if (input.audio && !audio) throw new RemakeProjectServiceError("原视频参考音频信息不完整", 400);
        let pipeline = withPipelineStep(normalized.pipeline, "analysis", "completed", "references", input.task.id);
        if (input.copyBlocks || copy.status === "completed") pipeline = withPipelineStep(pipeline, "copy", "completed", "references", copy.taskId);
        previous = normalized;
        return withRevision(normalized, {
            sourceVideo: input.sourceVideo,
            sourceCopy,
            frames,
            copyBlocks,
            copy,
            groups,
            references: { ...normalized.references, audio },
            pipeline,
            analysis: {
                status: "completed",
                taskId: input.task.id,
                runId: input.task.runId,
                mode: input.mode,
                warning: cleanText(input.warning, 2_000) || undefined,
                raw: cleanText(input.analysisRaw, 500_000),
                timestamps,
            },
        });
    });
    if (!next || next.analysis.taskId !== input.task.id) throw new RemakeAnalysisSupersededError();
    if (previous) await cleanupReplacedMedia(input.task.userId, previous, next);
    return next;
}

export async function completeRemakeProductionForUser(userId: string, id: string, input: RemakeProductionCompletionInput) {
    let previous: RemakeProject | undefined;
    const expectedRevision = optionalRevision(input.expectedRevision);
    const next = await mutateRemakeProject(userId, cleanText(id, 160), (current) => {
        const normalized = normalizeRemakeProjectWorkflow(current);
        if (input.expectedInputVersion !== undefined) {
            if (input.expectedInputVersion !== remakeProductionInputVersion(normalized, input.groupId === undefined ? undefined : [input.groupId])) {
                throw new RemakeProjectServiceError("本组提示词或生成素材已变化，请刷新后重试", 409);
            }
        } else if (expectedRevision !== undefined && expectedRevision !== normalized.revision) {
            throw new RemakeProjectServiceError("复刻项目已在其他页面更新，请刷新后重试", 409);
        }
        if (normalized.frames.length !== REMAKE_FRAME_COUNT) throw new RemakeProjectServiceError("请先完成 48 帧视频分析", 409);
        const copy = normalizeRemakeCopyState(input.copy, normalized.copy);
        const copyBlocks = input.copyBlocks
            ? normalizeRemakeCopyBlocks(input.copyBlocks, {
                  frames: normalized.frames,
                  sourceCopy: normalized.sourceCopy,
                  strategy: normalized.copyStrategy,
                  mappings: copy.mappings,
                  requireComplete: true,
              })
            : normalizeRemakeCopyBlocks(normalized.copyBlocks, {
                  frames: normalized.frames,
                  sourceCopy: normalized.sourceCopy,
                  strategy: normalized.copyStrategy,
                  mappings: copy.mappings,
                  requireComplete: true,
              });
        if (copyBlocks.length !== REMAKE_COPY_BLOCK_COUNT) throw new RemakeProjectServiceError("请提交完整的 16 个语义文案区间", 400);
        const promptPatches = normalizeVideoPromptPatches(input.videoPrompts);
        if (input.groupId !== undefined) {
            const target = normalized.groups.find((group) => group.id === input.groupId);
            if (!target || input.videoPrompts?.length !== 1 || promptPatches.length !== 1 || promptPatches[0].ordinal !== target.ordinal) {
                throw new RemakeProjectServiceError("请提交指定分组的一条完整视频提示词", 400);
            }
        } else if (input.videoPrompts && (input.videoPrompts.length !== 4 || promptPatches.length !== 4)) {
            throw new RemakeProjectServiceError("请提交完整的 4 组视频提示词", 400);
        }
        if (normalized.groups.some((group) => (input.groupId === undefined || group.id === input.groupId) && (group.videoGeneration.status === "queued" || group.videoGeneration.status === "running"))) {
            throw new RemakeProjectServiceError("本组视频任务尚未结束，请完成后再生成 Prompt", 409);
        }
        const groups = normalizeRemakeRangeGroups(promptPatches, normalized.groups).map((group, index) =>
            group.videoPrompt !== normalized.groups[index]?.videoPrompt ? { ...group, videoGeneration: { status: "idle" as const } } : group,
        );
        const promptsReady = groups.every((group) => Boolean(group.videoPrompt));
        if (!promptsReady && input.groupId === undefined) throw new RemakeProjectServiceError("4 组视频提示词尚未完整生成", 409);
        const noNarration = isRemakeNoNarrationCopy(normalized.sourceCopy);
        const copyReady = copyBlocks.every((block) => (noNarration ? !block.sourceText.trim() && !block.text.trim() : Boolean(block.sourceText.trim() && block.text.trim())));
        if (!copyReady) throw new RemakeProjectServiceError(noNarration ? "无口播视频的 16 个语义文案区间必须保持为空" : "16 个语义文案区间存在空内容", 409);
        const imagesReady = groups.every((group) => group.imageGeneration.status === "completed" && Boolean(group.imageGeneration.result));
        const stage = promptsReady ? (imagesReady ? "ready" : "prompts-ready") : "prompts";
        let pipeline = withPipelineStep(normalized.pipeline, "copy", "completed", stage, copy.taskId);
        pipeline = withPipelineStep(pipeline, "prompts", promptsReady ? "completed" : "pending", stage);
        if (imagesReady) pipeline = withPipelineStep(pipeline, "images", "completed", stage);
        previous = normalized;
        return withRevision(normalized, { copy, copyBlocks, groups, pipeline });
    });
    if (!next) throw new RemakeProjectServiceError("复刻项目不存在", 404);
    if (previous) await cleanupReplacedMedia(userId, previous, next);
    return next;
}

export async function assertRemakeImageGenerationsForUser(userId: string, project: Pick<HydratedRemakeProject, "id" | "references" | "groups" | "frames" | "modelSelection" | "productInfo">) {
    if (project.groups.length !== 4) throw new RemakeProjectServiceError("四组十二宫格生图任务不完整", 409);
    await Promise.all(
        project.groups.map(async (group) => {
            if (group.imageGeneration.status !== "completed" || !group.imageGeneration.taskId || !group.imageGeneration.result) throw new RemakeProjectServiceError(`分镜 ${group.id} 的最终十二宫格尚未由有效任务完成`, 409);
            const authoritative = await authoritativeRemakeImageGeneration({
                userId,
                projectId: project.id,
                group,
                references: project.references,
                frames: project.frames,
                productInfo: project.productInfo,
                requested: group.imageGeneration,
                stage: "storyboard",
                selectedModel: project.modelSelection.image,
            });
            if (authoritative.status !== "completed" || mediaIdentity(authoritative.result?.url) !== mediaIdentity(group.imageGeneration.result.url)) {
                throw new RemakeProjectServiceError(`分镜 ${group.id} 的十二宫格结果与生成任务不一致`, 409);
            }
        }),
    );
}

async function normalizeEditableRemakeGroups(input: {
    userId: string;
    projectId: string;
    value: unknown;
    current: RemakeRangeGroup[];
    references: RemakeReferences;
    frames: RemakeFrame[];
    modelSelection: RemakeModelSelection;
    productInfo: string;
}) {
    const requested = normalizeRemakeRangeGroups(input.value, input.current);
    return Promise.all(
        requested.map(async (group, index) => {
            const previous = input.current[index] || emptyRemakeRangeGroups()[index];
            const sourceContactSheet = previous.sourceContactSheet;
            const expectedGroup = { ...group, sourceContactSheet };
            const videoPrompt = group.videoPrompt ? previous.videoPrompt : "";
            const imageGeneration = await authoritativeRemakeImageGeneration({
                userId: input.userId, projectId: input.projectId, group: expectedGroup,
                references: input.references, frames: input.frames, productInfo: input.productInfo,
                requested: group.imageGeneration, previous: previous.imageGeneration,
                stage: "storyboard", selectedModel: input.modelSelection.image,
            });
            const stablePrompt = imageGeneration.status === "completed" ? videoPrompt : "";
            const videoGeneration =
                stablePrompt && group.videoGeneration.status !== "idle"
                    ? await authoritativeRemakeVideoGeneration({
                          userId: input.userId,
                          projectId: input.projectId,
                          group: { ...expectedGroup, imageGeneration, videoPrompt: stablePrompt },
                          requested: group.videoGeneration,
                          selectedModel: input.modelSelection.video,
                      })
                    : { status: "idle" as const };
            return { ...expectedGroup, imageGeneration, videoPrompt: stablePrompt, videoGeneration };
        }),
    );
}

async function authoritativeRemakeImageGeneration(input: {
    userId: string;
    projectId: string;
    group: RemakeRangeGroup;
    references: RemakeReferences;
    frames: RemakeFrame[];
    requested: RemakeRangeGroup["imageGeneration"];
    previous?: RemakeRangeGroup["imageGeneration"];
    stage: "storyboard";
    selectedModel: string;
    productInfo: string;
}): Promise<RemakeRangeGroup["imageGeneration"]> {
    const prompt = canonicalRemakeImagePrompt(input.stage, input.group, input.references, input.frames, input.productInfo);
    if (input.requested.status === "idle") return { status: "idle", prompt: "", attemptNo: input.requested.attemptNo };
    if (!prompt || input.requested.prompt !== prompt) throw new RemakeProjectServiceError(`分镜 ${input.group.id} 的生图提示词与当前参考素材不一致`, 409);
    const requestedAttempt = input.requested.attemptNo ?? 0;
    const minimumAttempt = input.previous?.prompt === prompt ? input.previous.attemptNo ?? 0 : 0;
    if (requestedAttempt < minimumAttempt) throw new RemakeProjectServiceError(`分镜 ${input.group.id} 的图片任务已开始新一次生成，请刷新后重试`, 409);
    if (!input.requested.taskId) {
        if (input.requested.status === "queued") return { status: "queued", model: input.requested.model || input.selectedModel || undefined, prompt, attemptNo: requestedAttempt };
        if (input.requested.status === "error") return { status: "error", model: input.requested.model || input.selectedModel || undefined, prompt, attemptNo: requestedAttempt, error: input.requested.error || "图片任务创建失败" };
        throw new RemakeProjectServiceError(`分镜 ${input.group.id} 的图片任务标识缺失`, 409);
    }
    const taskRecord = await getStoredGenerationTaskRecord("image", input.requested.taskId);
    const task = taskRecord?.payload as ImageTask | undefined;
    const slotId = remakeImageGenerationSlotId(input.stage, input.group.id);
    if (!task || task.userId !== input.userId || task.projectId !== input.projectId || task.generationSlotId !== slotId) {
        throw new RemakeProjectServiceError(`分镜 ${input.group.id} 的图片任务不存在或不属于当前项目`, 409);
    }
    // record.attemptNo 是请求幂等版本；payload.attemptNo 会被上游候选重试覆盖。
    const attemptNo = taskRecord?.attemptNo ?? 0;
    if (attemptNo !== requestedAttempt || attemptNo < minimumAttempt) throw new RemakeProjectServiceError(`分镜 ${input.group.id} 的图片任务重试版本不一致`, 409);
    if (task.kind !== "edit" || task.config?.size !== "9:16") {
        throw new RemakeProjectServiceError(`分镜 ${input.group.id} 的十二宫格必须由 9:16 图片编辑任务生成`, 409);
    }
    const taskModel = task.config.logicalModel || task.config.model;
    if (task.prompt !== prompt || (input.selectedModel && taskModel !== input.selectedModel) || !sameRemakeTaskReferences(task, input.stage, input.group, input.references)) {
        throw new RemakeProjectServiceError(`分镜 ${input.group.id} 的图片任务输入与当前参考素材不一致`, 409);
    }
    if (task.status === "pending" || task.status === "running") return { status: "running", taskId: task.id, model: taskModel, prompt, attemptNo };
    if (task.status === "error" || task.status === "cancelled") return { status: "error", taskId: task.id, model: taskModel, prompt, attemptNo, error: task.error || (task.status === "cancelled" ? "图片任务已取消" : "图片生成失败") };
    if (task.status !== "success") throw new RemakeProjectServiceError(`分镜 ${input.group.id} 的图片任务状态无效`, 409);
    const result = authoritativeImageAsset(task, `${input.group.id}-${input.stage}`);
    if (!result) throw new RemakeProjectServiceError(`分镜 ${input.group.id} 的图片任务没有持久化结果`, 409);
    return { status: "completed", taskId: task.id, model: taskModel, prompt, result, attemptNo };
}

function authoritativeImageAsset(task: ImageTask, groupId: string): RemakeMediaAsset | undefined {
    const result = task.result?.results?.[0] || task.result;
    const url = result?.serverUrl || result?.dataUrl || "";
    const storageKey = localMediaStorageKeyFromValue(url);
    if (!storageKey || (!url.startsWith("/api/generation-log-assets/") && !url.startsWith("/api/reference-assets/"))) return undefined;
    const dimensionError = remakeContactSheetDimensionError(result?.width, result?.height);
    if (dimensionError) throw new RemakeProjectServiceError(`分镜 ${groupId} 的十二宫格结果不合格：${dimensionError}`, 409);
    return {
        url,
        storageKey,
        mimeType: result?.mimeType || "image/png",
        originalName: `remake-product-${groupId}.png`,
        bytes: result?.bytes,
        width: result?.width,
        height: result?.height,
    };
}

function sameRemakeTaskReferences(task: ImageTask, _stage: "storyboard", group: RemakeRangeGroup, references: RemakeReferences) {
    const expected = remakeStoryboardPromptReferences({ sourceContactSheet: group.sourceContactSheet, product: references.product }).map((reference) => reference.asset.url!);
    const actual = task.references.map((reference) => reference.serverUrl || reference.remoteUrl || reference.url || reference.dataUrl);
    return actual.length === expected.length && expected.every((value, index) => mediaIdentity(value) === mediaIdentity(actual[index]));
}

function canonicalRemakeImagePrompt(_stage: "storyboard", group: RemakeRangeGroup, references: RemakeReferences, frames: RemakeFrame[], productInfo: string) {
    return productInfo.trim() && group.sourceContactSheet?.url && references.product?.url ? remakeStoryboardPrompt(group.id, frames, productInfo) : "";
}

function invalidateRemakeImages(groups: RemakeRangeGroup[]) {
    return normalizeRemakeRangeGroups(groups).map((group) => ({
        ...group,
        replacementGeneration: { status: "idle" as const, prompt: "" },
        imageGeneration: { status: "idle" as const, prompt: "" },
        videoPrompt: "",
        videoGeneration: { status: "idle" as const },
    }));
}

function remakeImageGenerationSlotId(stage: "storyboard", groupId: string) {
    return `remake-product:${groupId}:${stage}`;
}

async function authoritativeRemakeVideoGeneration(input: {
    userId: string;
    projectId: string;
    group: RemakeRangeGroup;
    requested: RemakeRangeGroup["videoGeneration"];
    selectedModel: string;
}): Promise<RemakeRangeGroup["videoGeneration"]> {
    if (!input.requested.taskId) {
        if (input.requested.status === "queued") return { status: "queued", model: input.requested.model, attemptNo: input.requested.attemptNo };
        if (input.requested.status === "error") return { status: "error", model: input.requested.model, attemptNo: input.requested.attemptNo, error: input.requested.error || "视频任务创建失败" };
        throw new RemakeProjectServiceError(`分镜 ${input.group.id} 的视频任务标识缺失`, 409);
    }
    const task = await getVideoTask(input.requested.taskId);
    if (!task || task.userId !== input.userId || task.projectId !== input.projectId || task.generationSlotId !== `remake-product-video:${input.group.id}` || task.prompt !== input.group.videoPrompt) {
        throw new RemakeProjectServiceError(`分镜 ${input.group.id} 的视频任务不存在或不属于当前项目`, 409);
    }
    const model = task.config.logicalModel || task.config.model || task.upstream.model;
    if ((input.selectedModel && model !== input.selectedModel) || (input.requested.model && model !== input.requested.model)) {
        throw new RemakeProjectServiceError(`分镜 ${input.group.id} 的视频模型与当前任务不一致`, 409);
    }
    if (task.requestedDurationSeconds !== 15) throw new RemakeProjectServiceError(`分镜 ${input.group.id} 的视频任务必须为 15 秒`, 409);
    const attemptNo = task.attemptNo ?? 0;
    if (task.status === "running") {
        const needsReview = task.executionPhase === "needs_review";
        return { status: "running", taskId: task.id, model, attemptNo, needsReview, error: needsReview ? task.reviewReason || "上游任务状态待检查，请点击检查状态继续查询原任务" : undefined };
    }
    if (task.status === "error" || task.status === "cancelled") return { status: "error", taskId: task.id, model, attemptNo, error: task.error || (task.status === "cancelled" ? "视频任务已取消" : "视频生成失败") };
    if (task.status !== "success") throw new RemakeProjectServiceError(`分镜 ${input.group.id} 的视频任务状态无效`, 409);
    const result = normalizeRemakeMediaAsset(task.result);
    if (!result?.url) throw new RemakeProjectServiceError(`分镜 ${input.group.id} 的视频任务没有持久化结果`, 409);
    return { status: "completed", taskId: task.id, model, attemptNo, result: { ...result, originalName: `remake-product-${input.group.id}-15s.mp4` } };
}

function deriveRemakePipeline(input: {
    sourceVideo?: RemakeSourceVideo;
    sourceCopy: string;
    analysis: RemakeProjectAnalysis;
    references: RemakeReferences;
    groups: RemakeRangeGroup[];
    copy: RemakeCopyState;
    copyBlocks: RemakeCopyBlock[];
}): RemakePipeline {
    const pipeline = defaultRemakePipeline({ hasSourceVideo: Boolean(input.sourceVideo?.url), analysisStatus: input.analysis.status });
    pipeline.steps.analysis.taskId = input.analysis.taskId;
    pipeline.steps.analysis.error = input.analysis.error;
    if (input.analysis.status !== "completed") return pipeline;

    const referencesReady = Boolean(input.references.product?.url);
    const imagesReady =
        input.groups.length === 4 &&
        input.groups.every(
            (group) => group.imageGeneration.status === "completed" && group.imageGeneration.result?.url,
        );
    const imageActive = input.groups.some(
        (group) => group.imageGeneration.status === "queued" || group.imageGeneration.status === "running",
    );
    const imageError = input.groups.some((group) => group.imageGeneration.status === "error");
    const noNarration = isRemakeNoNarrationCopy(input.sourceCopy);
    const copyReady =
        input.copy.status === "completed" && input.copyBlocks.length === REMAKE_COPY_BLOCK_COUNT && input.copyBlocks.every((block) => (noNarration ? !block.sourceText.trim() && !block.text.trim() : Boolean(block.sourceText.trim() && block.text.trim())));
    const promptsReady = input.groups.length === 4 && input.groups.every((group) => Boolean(group.videoPrompt.trim()));
    pipeline.steps.references.status = referencesReady ? "completed" : "pending";
    pipeline.steps.images.status = imagesReady ? "completed" : imageError ? "error" : imageActive ? "running" : "pending";
    pipeline.steps.copy = {
        status: copyReady ? "completed" : input.copy.status === "error" ? "error" : input.copy.status === "queued" || input.copy.status === "running" ? input.copy.status : "pending",
        taskId: input.copy.taskId,
        error: input.copy.error,
    };
    pipeline.steps.prompts.status = promptsReady ? "completed" : "pending";
    pipeline.stage = imageError || input.copy.status === "error" ? "failed" : !referencesReady ? "references" : !imagesReady ? "images" : !copyReady ? "copy" : !promptsReady ? "prompts" : "ready";
    return pipeline;
}

function remakeGenerationReferenceIdentity(references: RemakeReferences) {
    return [references.product].map((asset) => mediaIdentity(asset?.url)).join("\0");
}

function mediaIdentity(value?: string) {
    if (!value) return "";
    return localMediaStorageKeyFromValue(value) || value.trim().replace(/[?#].*$/u, "");
}

export async function failRemakeProjectAnalysis(task: Pick<RemakeAnalysisTask, "id" | "userId" | "projectId" | "runId">, error: string) {
    return mutateRemakeProject(task.userId, task.projectId, (current) => {
        const normalized = normalizeRemakeProjectWorkflow(current);
        if (normalized.analysis.taskId !== task.id) return current;
        const message = cleanText(error, 500) || "视频分析失败";
        return withRevision(normalized, {
            analysis: { status: "error", taskId: task.id, runId: task.runId, error: message, raw: normalized.analysis.raw, timestamps: normalized.analysis.timestamps },
            pipeline: withPipelineStep(normalized.pipeline, "analysis", "error", "failed", task.id, message),
        });
    });
}

function withPipelineStep(pipeline: RemakePipeline, step: RemakePipelineStep, status: RemakePipelineStepStatus, stage: RemakePipelineStage, taskId?: string, error?: string): RemakePipeline {
    return {
        ...pipeline,
        stage,
        steps: {
            ...pipeline.steps,
            [step]: {
                status,
                taskId: cleanText(taskId, 300) || undefined,
                error: cleanText(error, 1_000) || undefined,
            },
        },
    };
}

function normalizeVideoPromptPatches(value: RemakeVideoPromptInput[] | undefined) {
    if (!Array.isArray(value)) return [];
    const prompts = new Map<number, { ordinal: number; videoPrompt: string }>();
    for (const item of value) {
        const source = object(item);
        const ordinal = integerInRange(source.groupOrdinal, 1, 4);
        const videoPrompt = normalizeRemakeVideoPrompt(source.prompt);
        if (ordinal && videoPrompt && !prompts.has(ordinal)) prompts.set(ordinal, { ordinal, videoPrompt });
    }
    return Array.from(prompts.values()).sort((left, right) => left.ordinal - right.ordinal);
}

function withRevision(project: RemakeProject, patch: Partial<RemakeProject>): RemakeProject {
    return invalidateRemakeMergedVideo(project, { ...project, ...patch, revision: project.revision + 1, updatedAt: new Date().toISOString() });
}

async function cleanupReplacedMedia(userId: string, previous: RemakeProject, current: RemakeProject) {
    const retained = new Set(collectLocalMediaStorageKeys(current));
    const replaced = collectLocalMediaStorageKeys(previous).filter((storageKey) => !retained.has(storageKey));
    if (replaced.length) await deleteUserLocalMediaAssets(userId, replaced).catch(() => undefined);
}

function sourceVideoInput(value: unknown, allowEmpty: boolean) {
    if (allowEmpty && (value === null || value === undefined)) return undefined;
    if (!allowEmpty && (value === null || value === undefined)) return undefined;
    const source = normalizeRemakeSourceVideo(value);
    if (!source) throw new RemakeProjectServiceError("原视频信息不完整", 400);
    if (!isSupportedSourceUrl(source.url)) throw new RemakeProjectServiceError("原视频地址格式不正确", 400);
    if (!source.mimeType.startsWith("video/")) throw new RemakeProjectServiceError("原视频格式不正确", 400);
    return source;
}

function normalizeEditableFrames(input: Record<string, unknown>, current: RemakeFrame[]) {
    if (!hasOwn(input, "frames")) return current;
    if (current.length !== REMAKE_FRAME_COUNT) throw new RemakeProjectServiceError("视频分析完成后才能编辑帧解析", 409);
    const incoming = normalizeRemakeFrames(input.frames);
    if (incoming.length !== REMAKE_FRAME_COUNT || incoming.some((frame, index) => frame.ordinal !== index + 1)) throw new RemakeProjectServiceError("请提交完整的 12 个帧分析单元", 400);
    return current.map((frame, index) => ({
        ...frame,
        subtitle: incoming[index].subtitle,
        sellingPoint: incoming[index].sellingPoint,
        shotType: incoming[index].shotType,
        description: incoming[index].description,
        subjectRatio: incoming[index].subjectRatio,
        hasFace: incoming[index].hasFace,
    }));
}

function isSupportedSourceUrl(value: string) {
    return value.startsWith("/api/reference-assets/") || value.startsWith("/api/generation-log-assets/") || /^https?:\/\//i.test(value);
}

function sourceVideoIdentity(value?: RemakeSourceVideo) {
    return value ? `${value.storageKey || ""}\0${value.url}` : "";
}

function normalizeStatus(value: unknown): RemakeProjectStatus {
    return value === "archived" ? "archived" : "active";
}

function normalizeCopyStrategy(value: unknown): RemakeCopyStrategy {
    return value === "manual" ? "manual" : "keep";
}

function normalizeVoice(value: unknown): RemakeVoice {
    return value === "female" || value === "male" ? value : "source";
}

function optionalRevision(value: unknown) {
    if (value === undefined || value === null || value === "") return undefined;
    const revision = Number(value);
    if (!Number.isSafeInteger(revision) || revision < 1) throw new RemakeProjectServiceError("项目版本号无效", 400);
    return revision;
}

function integerInRange(value: unknown, minimum: number, maximum: number) {
    const number = Number(value);
    return Number.isInteger(number) && number >= minimum && number <= maximum ? number : 0;
}

function assertProjectSize(project: RemakeProject) {
    if (Buffer.byteLength(JSON.stringify(project)) > MAX_PROJECT_BYTES) throw new RemakeProjectServiceError("复刻项目数据过大", 413);
}

function throwStoreError(error: unknown): never {
    if (error instanceof RemakeProjectStoreError) throw new RemakeProjectServiceError(error.message, error.status);
    throw error;
}

function safeError(error: unknown, fallback: string) {
    return error instanceof Error ? error.message.trim().slice(0, 500) || fallback : fallback;
}

function object(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function cleanText(value: unknown, maxLength: number) {
    return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function hasOwn(value: Record<string, unknown>, key: string) {
    return Object.prototype.hasOwnProperty.call(value, key);
}
