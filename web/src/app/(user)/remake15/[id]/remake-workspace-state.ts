import { isRemakeNoNarrationCopy, type RemakeCopyBlock, type RemakeEditablePatch, type RemakeMediaAsset, type RemakeProject, type RemakeRangeGroup, type RemakeReferenceAssets, type RemakeTaskStatus } from "../remake-contract";

export type RemakeWorkspacePatch = RemakeEditablePatch & Partial<Pick<RemakeProject, "copy" | "pipeline">>;

export function recoveredFlowStage(project: RemakeProject): "analysis" | "images" | "production" {
    if (project.groups.length === 1 && project.groups.every(groupImagesReady)) return "production";
    if (project.pipeline.stage === "references" || project.pipeline.stage === "images" || project.analysis.status === "completed") return "images";
    return "analysis";
}

export type RemakePendingVideoProgress = {
    inputVersion: string;
    generation: RemakeRangeGroup["videoGeneration"];
};

export function remakeVideoInputVersion(project: RemakeProject, groupId: string) {
    const group = project.groups.find((item) => item.id === groupId);
    return JSON.stringify([
        project.id, groupId, group?.videoPromptInstructions?.trim() || "", group?.videoPrompt || "", assetIdentity(group?.imageGeneration.result || undefined),
        project.modelSelection.video, assetIdentity(project.references.product), assetIdentity(project.references.character), assetIdentity(project.references.audio),
    ]);
}

export function mergeRemakeVideoProgress(project: RemakeProject, updates: ReadonlyMap<string, RemakePendingVideoProgress>): RemakeProject {
    return {
        ...project,
        groups: project.groups.map((group) => {
            const update = updates.get(group.id);
            if (!update || update.inputVersion !== remakeVideoInputVersion(project, group.id)) return group;
            const local = update.generation;
            const remote = group.videoGeneration;
            if ((remote.attemptNo ?? 0) > (local.attemptNo ?? 0)) return group;
            if ((remote.attemptNo ?? 0) === (local.attemptNo ?? 0)) {
                if (remote.taskId && remote.taskId !== local.taskId) return group;
                if (remote.status === "completed" || (remote.status === "error" && local.status !== "completed")) return group;
            }
            return { ...group, videoGeneration: local };
        }),
    };
}

export function mergeRemakeConcurrentResult(incoming: RemakeProject, current: RemakeProject | null, pending: RemakeWorkspacePatch, videoOnly: boolean, updates: ReadonlyMap<string, RemakePendingVideoProgress>) {
    const newest = current && current.revision > incoming.revision ? current : incoming;
    const patch = { ...pending };
    // 视频进度只覆盖所属分组，不能把旧的整组快照写回新 Prompt。
    if (videoOnly) delete patch.groups;
    return mergeRemakeVideoProgress(mergeEditablePatch(newest, patch), updates);
}

export type RemakeImageTaskSnapshot = {
    groupId: string;
    stage: "replacement" | "storyboard";
    slotId: string;
    taskId: string;
    inputVersion: string;
};

export function hasRemakePatch(patch: RemakeWorkspacePatch) {
    return Object.keys(patch).length > 0;
}

export function isRemakeAnalysisActive(analyzing: boolean, status?: RemakeTaskStatus | null) {
    return analyzing || status === "pending" || status === "running";
}

export function mergeEditablePatch(project: RemakeProject, patch: RemakeWorkspacePatch): RemakeProject {
    return {
        ...project,
        title: patch.title !== undefined ? patch.title : project.title,
        sourceVideo: Object.prototype.hasOwnProperty.call(patch, "sourceVideo") ? patch.sourceVideo : project.sourceVideo,
        sourceCopy: patch.sourceCopy !== undefined ? patch.sourceCopy : project.sourceCopy,
        productInfo: patch.productInfo !== undefined ? patch.productInfo : project.productInfo,
        productScript: patch.productScript !== undefined ? patch.productScript : project.productScript,
        storyboardScript: patch.storyboardScript !== undefined ? patch.storyboardScript : project.storyboardScript,
        copyStrategy: patch.copyStrategy !== undefined ? patch.copyStrategy : project.copyStrategy,
        voice: patch.voice !== undefined ? patch.voice : project.voice,
        modelSelection: patch.modelSelection !== undefined ? patch.modelSelection : project.modelSelection,
        references: patch.references !== undefined ? patch.references : project.references,
        groups: patch.groups !== undefined ? patch.groups : project.groups,
        frames: patch.frames !== undefined ? patch.frames : project.frames,
        copyBlocks: patch.copyBlocks !== undefined ? patch.copyBlocks : project.copyBlocks,
        copy: patch.copy !== undefined ? patch.copy : project.copy,
        pipeline: patch.pipeline !== undefined ? patch.pipeline : project.pipeline,
    };
}

export function mergeSavedProject(saved: RemakeProject, current: RemakeProject, pending: RemakeWorkspacePatch): RemakeProject {
    return {
        ...saved,
        title: pending.title !== undefined ? current.title : saved.title,
        sourceVideo: Object.prototype.hasOwnProperty.call(pending, "sourceVideo") ? current.sourceVideo : saved.sourceVideo,
        sourceCopy: pending.sourceCopy !== undefined ? current.sourceCopy : saved.sourceCopy,
        productInfo: pending.productInfo !== undefined ? current.productInfo : saved.productInfo,
        productScript: pending.productScript !== undefined ? current.productScript : saved.productScript,
        storyboardScript: pending.storyboardScript !== undefined ? current.storyboardScript : saved.storyboardScript,
        copyStrategy: pending.copyStrategy !== undefined ? current.copyStrategy : saved.copyStrategy,
        voice: pending.voice !== undefined ? current.voice : saved.voice,
        modelSelection: pending.modelSelection !== undefined ? current.modelSelection : saved.modelSelection,
        references: pending.references !== undefined ? current.references : saved.references,
        groups: pending.groups !== undefined ? current.groups : saved.groups,
        frames: pending.frames !== undefined ? current.frames : saved.frames,
        copyBlocks: pending.copyBlocks !== undefined ? current.copyBlocks : saved.copyBlocks,
        copy: pending.copy !== undefined ? current.copy : saved.copy,
        pipeline: pending.pipeline !== undefined ? current.pipeline : saved.pipeline,
    };
}

export function safeConflictPatch(dirty: RemakeWorkspacePatch, local: RemakeProject, remote: RemakeProject): RemakeWorkspacePatch {
    const analysisChanged = local.analysis.runId !== remote.analysis.runId || local.analysis.taskId !== remote.analysis.taskId;
    const sourceChanged = sourceIdentity(local) !== sourceIdentity(remote);
    const referencesChanged = remakeReferenceVersion(local.references) !== remakeReferenceVersion(remote.references);
    const safe = { ...dirty };
    if (analysisChanged || sourceChanged) {
        delete safe.sourceVideo;
        delete safe.groups;
        delete safe.frames;
        delete safe.copyBlocks;
        delete safe.copy;
        delete safe.pipeline;
        delete safe.productScript;
        delete safe.storyboardScript;
        if (sourceChanged) delete safe.sourceCopy;
    } else if (referencesChanged || local.productInfo !== remote.productInfo || local.productScript !== remote.productScript || local.storyboardScript !== remote.storyboardScript) {
        delete safe.groups;
        delete safe.productScript;
        delete safe.storyboardScript;
    } else if (safe.groups) {
        safe.groups = mergeConflictGroups(safe.groups, remote.groups);
    }
    return safe;
}

export function rebaseRemakeConflict(dirty: RemakeWorkspacePatch, local: RemakeProject, remote: RemakeProject) {
    const safe = safeConflictPatch(dirty, local, remote);
    return { dirty: safe, project: mergeEditablePatch(remote, safe) };
}

export function invalidateRemakeProduction(project: RemakeProject, patch: RemakeWorkspacePatch): RemakeWorkspacePatch {
    const groups = (patch.groups || project.groups).map((group) => ({ ...group, videoPrompt: "", videoGeneration: { status: "idle" as const } }));
    const imagesReady = groups.length === 1 && groups.every(groupImagesReady);
    const sourceCopyChanged = patch.sourceCopy !== undefined && patch.sourceCopy !== project.sourceCopy;
    return {
        ...patch,
        groups,
        copy: {
            ...project.copy,
            status: "idle",
            taskId: "",
            optionRaw: sourceCopyChanged ? "" : project.copy.optionRaw,
            rawReport: "",
            paragraphs: sourceCopyChanged ? [] : project.copy.paragraphs,
            mappings: sourceCopyChanged ? [] : project.copy.mappings,
            checks: { sequential: false, noDuplicates: false, noSkips: false },
            stats: sourceCopyChanged ? { paragraphCount: 0, unchangedBlocks: 0, completedBlocks: 0, correctedBlocks: 0, emptyBlocks: 4 } : project.copy.stats,
            error: "",
        },
        pipeline: {
            ...project.pipeline,
            stage: imagesReady ? "copy" : "images",
            steps: {
                ...project.pipeline.steps,
                copy: { status: "pending", taskId: "", error: "" },
                prompts: { status: "pending", taskId: "", error: "" },
            },
        },
    };
}

export function invalidateRemakeProductScript(project: RemakeProject, patch: RemakeWorkspacePatch): RemakeWorkspacePatch {
    return {
        ...patch,
        productScript: patch.productScript ?? "",
        storyboardScript: patch.storyboardScript ?? "",
        groups: project.groups.map((group) => ({
            ...group,
            replacementGeneration: { status: "idle", prompt: "" },
            imageGeneration: { status: "idle", prompt: "" },
            videoPrompt: "",
            videoGeneration: { status: "idle" },
        })),
    };
}

export function isRemakeCopyPlanReady(project: Pick<RemakeProject, "sourceCopy" | "copy" | "copyBlocks">) {
    const noNarration = isRemakeNoNarrationCopy(project.sourceCopy);
    return (
        project.copy.status === "completed" &&
        project.copy.checks.sequential &&
        project.copy.checks.noDuplicates &&
        project.copy.checks.noSkips &&
        project.copyBlocks.length === 4 &&
        project.copyBlocks.every((block, index) => block.ordinal === index + 1 && (noNarration ? !block.sourceText.trim() && !block.text.trim() : Boolean(block.sourceText.trim() && block.text.trim())))
    );
}

export function editRemakeCopyBlock(project: RemakeProject, blockId: string, patch: Partial<RemakeCopyBlock>): RemakeWorkspacePatch {
    const copyBlocks = project.copyBlocks.map((block) => (block.id === blockId ? { ...block, ...patch } : block));
    const blocksByOrdinal = new Map(copyBlocks.map((block) => [block.ordinal, block]));
    const mappings = project.copy.mappings.map((mapping) => ({ ...mapping, text: blocksByOrdinal.get(mapping.blockOrdinal)?.text ?? mapping.text }));
    const groups = project.groups.map((group) => ({ ...group, videoPrompt: "", videoGeneration: { status: "idle" as const } }));
    const copy = {
        ...project.copy,
        rawReport: "",
        mappings,
        stats: {
            ...project.copy.stats,
            unchangedBlocks: copyBlocks.filter((block) => block.text.trim() && block.text === block.sourceText).length,
            completedBlocks: 0,
            correctedBlocks: copyBlocks.filter((block) => block.text.trim() && block.text !== block.sourceText).length,
            emptyBlocks: copyBlocks.filter((block) => !block.text.trim()).length,
        },
        error: "",
    };
    const copyReady = isRemakeCopyPlanReady({ sourceCopy: project.sourceCopy, copy, copyBlocks });
    const imagesReady = groups.length === 1 && groups.every(groupImagesReady);
    return {
        copyBlocks,
        groups,
        copy,
        pipeline: {
            ...project.pipeline,
            stage: imagesReady ? (copyReady ? "prompts" : "copy") : "images",
            steps: {
                ...project.pipeline.steps,
                copy: { ...project.pipeline.steps.copy, status: copyReady ? "completed" : "pending", error: "" },
                prompts: { status: "pending", taskId: "", error: "" },
            },
        },
    };
}

export function remakeReferenceVersion(references: RemakeReferenceAssets) {
    return JSON.stringify([assetIdentity(references.product), assetIdentity(references.character)]);
}

export function remakeGroupInputVersion(group: RemakeRangeGroup, references: RemakeReferenceAssets, stage: "replacement" | "storyboard" = "storyboard", storyboardScript = "") {
    return JSON.stringify([storyboardScript, assetIdentity(group.sourceContactSheet), remakeReferenceVersion(references), stage === "storyboard" ? assetIdentity(group.replacementGeneration.result || undefined) : ""]);
}

export function remakeImageClientRequestId(
    projectId: string,
    group: RemakeRangeGroup,
    references: RemakeReferenceAssets,
    stage: "replacement" | "storyboard",
    request: { model: string; prompt: string; quality?: string },
) {
    // 模型、提示词和画质改变后属于新请求，不能复用旧输入的失败或成功任务。
    const identity = JSON.stringify([projectId, remakeGroupInputVersion(group, references, stage), request.model, request.prompt, request.quality || ""]);
    return `remake15-image:${group.id}:${stage}:${stableTextHash(identity)}`;
}

export function remakeImageGenerationSlotId(groupId: string, stage: "replacement" | "storyboard" = "storyboard") {
    return `remake15:${groupId}:${stage}`;
}

export function isRemakeImageTaskCurrent(project: Pick<RemakeProject, "groups" | "references" | "storyboardScript">, snapshot: RemakeImageTaskSnapshot) {
    const group = project.groups.find((item) => item.id === snapshot.groupId);
    const generation = snapshot.stage === "replacement" ? group?.replacementGeneration : group?.imageGeneration;
    return Boolean(group && generation && snapshot.slotId === remakeImageGenerationSlotId(group.id, snapshot.stage) && generation.taskId === snapshot.taskId && remakeGroupInputVersion(group, project.references, snapshot.stage, project.storyboardScript) === snapshot.inputVersion);
}

export function isRemakeImageInputCurrent(project: Pick<RemakeProject, "groups" | "references" | "storyboardScript">, groupId: string, inputVersion: string, stage: "replacement" | "storyboard" = "storyboard") {
    const group = project.groups.find((item) => item.id === groupId);
    return Boolean(group && remakeGroupInputVersion(group, project.references, stage, project.storyboardScript) === inputVersion);
}

export function remakeImageCreationFailureDisposition(reason: unknown): "aborted" | "deferred" | "error" {
    const error = reason && typeof reason === "object" ? (reason as { name?: unknown; status?: unknown; message?: unknown }) : {};
    if (error.name === "AbortError") return "aborted";
    if (error.name === "TimeoutError") return "deferred";
    const status = Number(error.status);
    if (Number.isFinite(status)) return status === 408 || status === 425 || status === 429 || status >= 500 ? "deferred" : "error";
    const message = typeof error.message === "string" ? error.message : typeof reason === "string" ? reason : "";
    return error.name === "TypeError" || /network|failed to fetch|timed?\s*out|timeout|网络/i.test(message) ? "deferred" : "error";
}

function sourceIdentity(project: RemakeProject) {
    return project.sourceVideo?.storageKey || project.sourceVideo?.url || "";
}

function assetIdentity(asset?: RemakeMediaAsset) {
    return asset?.storageKey?.trim() || asset?.url.trim() || "";
}

function mergeConflictGroups(localGroups: RemakeRangeGroup[], remoteGroups: RemakeRangeGroup[]) {
    const localById = new Map(localGroups.map((group) => [group.id, group]));
    return remoteGroups.map((remote) => {
        const local = localById.get(remote.id);
        if (!local) return remote;
        const localTaskIds = groupTaskIds(local);
        const remoteTaskIds = groupTaskIds(remote);
        if (remoteTaskIds.some((taskId, index) => taskId && taskId !== localTaskIds[index])) return remote;
        const imageGeneration = preferredTaskState(local.imageGeneration, remote.imageGeneration);
        const replacementGeneration = preferredTaskState(local.replacementGeneration, remote.replacementGeneration);
        const videoGeneration = preferredTaskState(local.videoGeneration, remote.videoGeneration);
        return { ...local, replacementGeneration, imageGeneration, videoGeneration };
    });
}

function preferredTaskState<T extends { status: RemakeRangeGroup["imageGeneration"]["status"] }>(local: T, remote: T) {
    if (remote.status === "completed") return remote;
    if (local.status === "completed") return local;
    if (remote.status === "error") return remote;
    if (local.status === "error") return local;
    return remote;
}

function groupTaskIds(group: RemakeRangeGroup) {
    return [group.replacementGeneration.taskId || "", group.imageGeneration.taskId || "", group.videoGeneration.taskId || ""];
}

function groupImagesReady(group: RemakeRangeGroup) {
    return Boolean(group.replacementGeneration.status === "completed" && group.replacementGeneration.result?.url && group.imageGeneration.status === "completed" && group.imageGeneration.result?.url);
}

function stableTextHash(value: string) {
    let first = 0x811c9dc5;
    let second = 0x9e3779b9;
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        first = Math.imul(first ^ code, 0x01000193);
        second = Math.imul(second ^ code, 0x85ebca6b);
    }
    return `${(first >>> 0).toString(36)}${(second >>> 0).toString(36)}`;
}
