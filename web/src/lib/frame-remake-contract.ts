import { supportsFrameRemakeChatAudioModel, supportsFrameRemakeEmbeddedAudioModel } from "./frame-remake-transcription-capability";

export type FrameRemakeMedia = { url: string; storageKey?: string; mimeType: string; originalName?: string; bytes?: number; width?: number; height?: number; duration?: number };
export type FrameRemakeGenerationKind = "template" | "image" | "video";
export type FrameRemakeAnalysisStage = "analysis" | "copy" | "productScript" | "imagePrompt" | "videoPrompt";
export const FRAME_REMAKE_ANALYSIS_STAGES: readonly FrameRemakeAnalysisStage[] = ["analysis", "productScript", "imagePrompt", "copy", "videoPrompt"];
export const FRAME_REMAKE_ANALYSIS_LABELS: Record<FrameRemakeAnalysisStage, string> = {
    analysis: "理解来源视频",
    copy: "文案预处理",
    productScript: "新产品-12分镜脚本",
    imagePrompt: "1-12分镜提示词",
    videoPrompt: "生成视频提示词",
};
export type FrameRemakeWorkflowStage = "analysis" | "planning" | "images" | "production";
export type FrameRemakeReplacement = { product: boolean; character: boolean; background: boolean };
export type FrameRemakeWorkflowSource = "product-basic" | "person-basic" | "combined-original";
export type FrameRemakeOperationKind = "inspect" | "extract" | "transcribe" | "analyze" | "merge";
export type FrameRemakeTask = {
    submissionPaused?: boolean;
    status: "idle" | "queued" | "running" | "completed" | "error";
    attemptNo: number;
    clientRequestId?: string;
    taskId?: string;
    prompt?: string;
    model?: string;
    referenceUrls?: string[];
    seconds?: number;
    timingMode?: "trim" | "fit";
    audioReferenceUrl?: string;
    result?: FrameRemakeMedia;
    error?: string;
};
export type FrameRemakeFrameAnalysis = { subtitle: string; sellingPoint: string; shotType: string; description: string; subjectRatio: string; hasFace: boolean };
export type FrameRemakeCopyBlock = { number: number; frameNumbers: number[]; startMs: number; endMs: number; sourceText: string; text: string };
export type FrameRemakePromptSource = { tableId: string; field: string; url: string; shared: boolean };
export type FrameRemakeFrame = { detail?: FrameRemakeFrameAnalysis; number: number; startMs: number; endMs: number; sampleMs: number; media?: FrameRemakeMedia };
export type FrameRemakeGroup = {
    id: string;
    number: number;
    startMs: number;
    endMs: number;
    frames: FrameRemakeFrame[];
    contactSheet?: FrameRemakeMedia;
    analysis: string;
    sourceAnalysisMode?: "video";
    sourceAnalysisTiming?: { reportedEndMs: number; alignedEndMs: number };
    sourceCopy?: string;
    sourceCopyStatus?: "transcribed" | "no-audio" | "no-speech" | "provided";
    sourceCopyStep?: { source: "system-video-transcription" | "dashscope-asr"; model: string; upstreamModel?: string; protocol?: string; prompt: string; startedAt: string; completedAt?: string; elapsedMs?: number; error?: string };
    sourceAudio?: FrameRemakeMedia;
    copy?: string;
    copyBlocks?: FrameRemakeCopyBlock[];
    // 旧项目的 analysis 同时包含产品脚本；新项目从空字符串开始独立执行。
    productScript?: string;
    materialAnalysis?: string;
    analysisSteps?: Partial<Record<FrameRemakeAnalysisStage, { prompt: string; model: string; startedAt: string; completedAt?: string; elapsedMs?: number; error?: string; rawOutput?: string; promptSource?: FrameRemakePromptSource }>>;
    imagePrompt: string;
    videoPrompt: string;
    videoPromptInstructions?: string;
    template: FrameRemakeTask;
    image: FrameRemakeTask;
    video: FrameRemakeTask;
};
export type FrameRemakeProject = {
    id: string;
    title: string;
    status: "active" | "archived";
    revision: number;
    workflowVersion?: "feishu-original-15s";
    workflowSource?: FrameRemakeWorkflowSource;
    createdAt: string;
    updatedAt: string;
    sourceVideo?: FrameRemakeMedia;
    durationMs: number;
    maxSegmentSeconds: number;
    references: { product: FrameRemakeMedia[]; character: FrameRemakeMedia[]; background: FrameRemakeMedia[] };
    replacement?: FrameRemakeReplacement;
    sourceCopy?: string;
    productInfo?: string;
    copyMode?: "original" | "custom";
    copyInstructions?: string;
    instructions: string;
    audioMode: "source" | "generated" | "silent";
    voice?: "female" | "male";
    modelSelection: { analysis: string; image: string; video: string };
    groups: FrameRemakeGroup[];
    mergedVideo?: FrameRemakeMedia;
    automation?: {
        id: string;
        status: "running" | "paused" | "error" | "completed";
        mode?: "auto" | "step";
        stageScope?: FrameRemakeWorkflowStage;
        stopAfterPrompts?: boolean;
        groupId?: string;
        pendingGeneration?: { groupId: string; kind: FrameRemakeGenerationKind };
        startedAt: string;
        updatedAt: string;
        progress: string;
        leaseId?: string;
        leaseUntil?: string;
    };
    operation?: { id: string; kind: FrameRemakeOperationKind; groupId?: string; analysisStage?: FrameRemakeAnalysisStage; startedAt: string; updatedAt: string; progress: string };
    error?: string;
};
export type FrameRemakeRunOptions = {
    groupId?: string;
    restartFrom?: "analysis" | "productScript" | "videoPrompt" | "images";
};
export type FrameRemakeProjectList = { items: FrameRemakeProject[]; total: number; page: number; pageSize: number };
export type FrameRemakePatch = Partial<Pick<FrameRemakeProject, "workflowSource" | "copyMode" | "copyInstructions" | "replacement" | "voice" | "title" | "sourceCopy" | "productInfo" | "instructions" | "audioMode" | "maxSegmentSeconds" | "references" | "modelSelection">> & {
    sourceVideo?: FrameRemakeMedia | null;
    group?: { id: string; sourceCopy?: string; analysis?: string; copy?: string; productScript?: string; imagePrompt?: string; videoPrompt?: string; videoPromptInstructions?: string };
    frame?: { groupId: string; number: number; detail: FrameRemakeFrameAnalysis };
    copyBlock?: { groupId: string; number: number; text: string };
};

export const idleFrameRemakeTask = (attemptNo = 0): FrameRemakeTask => ({ status: "idle", attemptNo });
export function newFrameRemakeProject(id: string, title: string): FrameRemakeProject {
    const now = new Date().toISOString();
    return {
        id,
        title: title.trim() || "原时长拆帧复刻",
        status: "active",
        revision: 1,
        workflowSource: "product-basic",
        createdAt: now,
        updatedAt: now,
        durationMs: 0,
        maxSegmentSeconds: 15,
        references: { product: [], character: [], background: [] },
        replacement: { product: true, character: false, background: false },
        instructions: "",
        audioMode: "source",
        voice: "female",
        copyMode: "original",
        copyInstructions: "",
        modelSelection: { analysis: "", image: "", video: "" },
        groups: [],
    };
}

// 时间线以整数毫秒保存，尾段使用真实剩余时长，不补齐成固定长度。
export function planFrameRemakeTimeline(durationMs: number, maxSegmentSeconds = 15): FrameRemakeGroup[] {
    if (!Number.isSafeInteger(durationMs) || durationMs <= 0) throw new Error("原视频时长无效");
    if (!Number.isInteger(maxSegmentSeconds) || maxSegmentSeconds < 4 || maxSegmentSeconds > 15) throw new Error("每组时长需在 4–15 秒之间");
    const segmentMs = maxSegmentSeconds * 1000;
    const groups: FrameRemakeGroup[] = [];
    let frameNumber = 0;
    for (let startMs = 0; startMs < durationMs; startMs += segmentMs) {
        const endMs = Math.min(durationMs, startMs + segmentMs);
        const count = 12;
        const frames = Array.from({ length: count }, (_, index) => {
            const start = startMs + Math.floor((index * (endMs - startMs)) / count);
            const end = startMs + Math.floor(((index + 1) * (endMs - startMs)) / count);
            return { number: ++frameNumber, startMs: start, endMs: end, sampleMs: start + Math.floor((end - start) / 2) };
        });
        groups.push({
            id: `G${groups.length + 1}`,
            number: groups.length + 1,
            startMs,
            endMs,
            frames,
            analysis: "",
            copy: "",
            productScript: "",
            materialAnalysis: "",
            imagePrompt: "",
            videoPrompt: "",
            template: idleFrameRemakeTask(),
            image: idleFrameRemakeTask(),
            video: idleFrameRemakeTask(),
        });
    }
    return groups;
}
export function frameRemakeAnalysisResult(group: FrameRemakeGroup, stage: FrameRemakeAnalysisStage) {
    return stage === "productScript" ? (group.productScript ?? group.analysis) : stage === "copy" ? (group.copy ?? (group.sourceAnalysisMode === "video" ? "" : group.analysis)) : (group[stage] ?? "");
}
export function frameRemakeWorkflowSource(project: FrameRemakeProject): FrameRemakeWorkflowSource {
    return project.workflowSource ?? "combined-original";
}
export function frameRemakeIsBasicWorkflow(project: FrameRemakeProject) {
    return frameRemakeWorkflowSource(project) !== "combined-original";
}
export function frameRemakeAnalysisStages(project: FrameRemakeProject): readonly FrameRemakeAnalysisStage[] {
    return frameRemakeIsBasicWorkflow(project) ? ["analysis", "copy", "videoPrompt"] : FRAME_REMAKE_ANALYSIS_STAGES.filter((stage) => stage !== "copy");
}
export function nextFrameRemakeAnalysisStage(group: FrameRemakeGroup, project?: FrameRemakeProject) {
    return (project ? frameRemakeAnalysisStages(project) : FRAME_REMAKE_ANALYSIS_STAGES).find((stage) => !frameRemakeAnalysisResult(group, stage));
}
export function frameRemakeSourceCopyNeedsReview(group: FrameRemakeGroup) {
    const step = group.sourceCopyStep;
    if (!step) return group.sourceCopyStatus === "no-speech" || group.sourceCopyStatus === "transcribed";
    if (!step.completedAt || step.error) return true;
    if (step.source !== "system-video-transcription") return false;
    if (!step.upstreamModel) return true;
    return !((step.protocol === "doubao-responses-video-audio" && supportsFrameRemakeEmbeddedAudioModel(step.upstreamModel)) ||
        (step.protocol === "openai-chat-input-audio" && supportsFrameRemakeChatAudioModel(step.upstreamModel)));
}
export function frameRemakeSourceCopyReady(project: FrameRemakeProject, group: FrameRemakeGroup) {
    if (project.sourceCopy?.trim() === "不需要人物口播") return true;
    if (frameRemakeSourceCopyNeedsReview(group)) return false;
    const entireSource = group.startMs === 0 && group.endMs === project.durationMs;
    return Boolean(group.sourceCopyStatus || group.sourceCopy?.trim() || (entireSource && project.sourceCopy?.trim()));
}
// 修改某一步时，仅使它和依赖它的后续结果失效。
export function resetFrameRemakeAnalysisFrom(group: FrameRemakeGroup, stage: FrameRemakeAnalysisStage): FrameRemakeGroup {
    const next = { ...group, analysisSteps: { ...group.analysisSteps }, video: idleFrameRemakeTask(group.video.attemptNo) };
    if (stage !== "videoPrompt" && stage !== "copy") {
        next.template = idleFrameRemakeTask(group.template.attemptNo);
        next.image = idleFrameRemakeTask(group.image.attemptNo);
        next.copyBlocks = undefined;
    }
    if (stage === "analysis") {
        next.sourceAnalysisMode = undefined;
        next.sourceAnalysisTiming = undefined;
        // 重新理解后镜头时间可能变化；保留校对文案，但移除旧时间区间。
        if (group.copyBlocks?.length) next.copy = group.copyBlocks.map((block) => block.text).join("");
        next.copyBlocks = undefined;
        next.frames = next.frames.map(({ detail: _detail, ...frame }) => frame);
    }
    if (stage === "copy") {
        next.copy = "";
        next.copyBlocks = undefined;
        delete next.analysisSteps.copy;
    }
    const resetStage = stage === "copy" ? "videoPrompt" : stage;
    for (const key of FRAME_REMAKE_ANALYSIS_STAGES.slice(FRAME_REMAKE_ANALYSIS_STAGES.indexOf(resetStage))) {
        next[key] = "";
        delete next.analysisSteps[key];
    }
    return next;
}
export function frameRemakeSeconds(group: Pick<FrameRemakeGroup, "startMs" | "endMs">) {
    return (group.endMs - group.startMs) / 1000;
}
export function frameRemakeGenerationSeconds(group: Pick<FrameRemakeGroup, "startMs" | "endMs">) {
    return Math.min(15, Math.max(4, Math.ceil(frameRemakeSeconds(group))));
}
export function frameRemakeGrid(count: number) {
    const columns = count <= 1 ? 1 : count <= 4 ? 2 : 3;
    return { columns, rows: Math.ceil(count / columns) };
}
export function frameRemakeBusy(project: FrameRemakeProject) {
    return Boolean(project.operation || project.groups.some((group) => [group.template, group.image, group.video].some((task) => task.status === "queued" || task.status === "running")));
}
export function frameRemakeImageReferences(project: FrameRemakeProject, group: FrameRemakeGroup, kind: "template" | "image" = "image") {
    const refs = frameRemakeActiveReferences(project);
    if (frameRemakeIsBasicWorkflow(project)) {
        const images = frameRemakeWorkflowSource(project) === "product-basic" ? [...refs.product, group.contactSheet] : [group.contactSheet, ...refs.character, ...refs.background];
        return images.filter((media): media is FrameRemakeMedia => Boolean(media));
    }
    const usesTemplate = frameRemakeUsesTemplate(project);
    return (kind === "template" ? [group.contactSheet, ...refs.character] : [usesTemplate ? group.template.result : group.contactSheet, ...refs.product, ...(!usesTemplate ? refs.character : []), ...refs.background]).filter((media): media is FrameRemakeMedia => Boolean(media));
}
export function frameRemakeVideoReferences(project: FrameRemakeProject, group: FrameRemakeGroup) {
    const refs = frameRemakeActiveReferences(project);
    return [group.image.result, ...refs.product, ...refs.character].filter((media): media is FrameRemakeMedia => Boolean(media));
}
// 旧项目按已有参考素材恢复选项；新项目由用户明确选择，上传素材不会暗中改变目标。
export function frameRemakeReplacement(project: FrameRemakeProject): FrameRemakeReplacement {
    if (frameRemakeWorkflowSource(project) === "product-basic") return { product: true, character: false, background: false };
    if (frameRemakeWorkflowSource(project) === "person-basic") return { product: false, character: Boolean(project.references.character.length), background: true };
    return project.replacement ?? { product: Boolean(project.references.product.length), character: Boolean(project.references.character.length), background: Boolean(project.references.background.length) };
}
export function frameRemakeActiveReferences(project: FrameRemakeProject) {
    const replacement = frameRemakeReplacement(project);
    return { product: replacement.product ? project.references.product : [], character: replacement.character ? project.references.character : [], background: replacement.background ? project.references.background : [] };
}
export function frameRemakeUsesTemplate(project: FrameRemakeProject) {
    return !frameRemakeIsBasicWorkflow(project) && frameRemakeReplacement(project).product;
}
export function frameRemakeInputError(project: FrameRemakeProject) {
    const replacement = frameRemakeReplacement(project);
    for (const [role, label] of [["product", "产品"], ["character", "人物"], ["background", "环境"]] as const) {
        if (replacement[role] && !project.references[role].length) return `请上传要替换的${label}参考图`;
        if (frameRemakeIsBasicWorkflow(project) && replacement[role] && project.references[role].length > 1) return `飞书原流程每个${label}字段使用一张参考图，请合并多角度图片后上传`;
    }
    return "";
}
export function frameRemakeAspectRatio(_project: FrameRemakeProject) {
    return "9:16";
}
export function frameRemakeTime(milliseconds: number) {
    const seconds = milliseconds / 1000;
    return seconds < 60 ? `${Number(seconds.toFixed(3))} 秒` : `${Math.floor(seconds / 60)} 分 ${Number((seconds % 60).toFixed(3))} 秒`;
}
export function assertFrameRemakeTimeline(project: FrameRemakeProject) {
    const expected = planFrameRemakeTimeline(project.durationMs, project.maxSegmentSeconds);
    if (
        project.groups.length !== expected.length ||
        project.groups.some((group, index) => {
            const target = expected[index];
            return (
                group.id !== target.id ||
                group.startMs !== target.startMs ||
                group.endMs !== target.endMs ||
                group.frames.length !== target.frames.length ||
                group.frames.some(
                    (frame, i) =>
                        frame.number !== target.frames[i].number ||
                        !Number.isSafeInteger(frame.startMs) ||
                        !Number.isSafeInteger(frame.endMs) ||
                        !Number.isSafeInteger(frame.sampleMs) ||
                        frame.startMs !== (i ? group.frames[i - 1].endMs : group.startMs) ||
                        frame.endMs < frame.startMs ||
                        frame.endMs > group.endMs ||
                        frame.sampleMs < frame.startMs ||
                        frame.sampleMs > frame.endMs ||
                        frame.sampleMs >= group.endMs,
                ) ||
                group.frames.at(-1)?.endMs !== group.endMs
            );
        })
    )
        throw new Error("拆帧时间线与原片不一致，请重新拆帧");
}

export function frameRemakeHasNarration(project: FrameRemakeProject, group?: FrameRemakeGroup) {
    if (project.sourceCopy?.trim() === "不需要人物口播") return false;
    return (group ? [group] : project.groups).some((g) => {
        if (g.copyBlocks) return g.copyBlocks.some((block) => block.text.trim());
        if (g.sourceCopyStatus || g.sourceCopy !== undefined) return Boolean(g.sourceCopy?.trim());
        return Boolean(g.copy?.trim() || (g.startMs === 0 && g.endMs === project.durationMs && project.sourceCopy?.trim()));
    });
}
