export type FrameRemakeMedia = { url: string; storageKey?: string; mimeType: string; originalName?: string; bytes?: number; width?: number; height?: number; duration?: number };
export type FrameRemakeGenerationKind = "template" | "image" | "video";
export const FRAME_REMAKE_ANALYSIS_STAGES = ["analysis", "productScript", "imagePrompt", "videoPrompt"] as const;
export type FrameRemakeAnalysisStage = (typeof FRAME_REMAKE_ANALYSIS_STAGES)[number];
export const FRAME_REMAKE_ANALYSIS_LABELS: Record<FrameRemakeAnalysisStage, string> = { analysis: "分析原片画面", productScript: "适配产品脚本", imagePrompt: "优化分镜脚本", videoPrompt: "生成视频提示词" };
export type FrameRemakeOperationKind = "inspect" | "extract" | "analyze" | "merge";
export type FrameRemakeTask = {
    status: "idle" | "queued" | "running" | "completed" | "error";
    attemptNo: number;
    clientRequestId?: string;
    taskId?: string;
    prompt?: string;
    model?: string;
    referenceUrls?: string[];
    seconds?: number;
    result?: FrameRemakeMedia;
    error?: string;
};
export type FrameRemakeFrame = { number: number; startMs: number; endMs: number; sampleMs: number; media?: FrameRemakeMedia };
export type FrameRemakeGroup = {
    id: string;
    number: number;
    startMs: number;
    endMs: number;
    frames: FrameRemakeFrame[];
    contactSheet?: FrameRemakeMedia;
    analysis: string;
    // 旧项目的 analysis 同时包含产品脚本；新项目从空字符串开始独立执行。
    productScript?: string;
    analysisSteps?: Partial<Record<FrameRemakeAnalysisStage, { prompt: string; model: string; startedAt: string; completedAt?: string; elapsedMs?: number; error?: string }>>;
    imagePrompt: string;
    videoPrompt: string;
    template: FrameRemakeTask;
    image: FrameRemakeTask;
    video: FrameRemakeTask;
};
export type FrameRemakeProject = {
    id: string;
    title: string;
    status: "active" | "archived";
    revision: number;
    createdAt: string;
    updatedAt: string;
    sourceVideo?: FrameRemakeMedia;
    durationMs: number;
    maxSegmentSeconds: number;
    references: { product: FrameRemakeMedia[]; character: FrameRemakeMedia[]; background: FrameRemakeMedia[] };
    instructions: string;
    audioMode: "source" | "generated" | "silent";
    modelSelection: { analysis: string; image: string; video: string };
    groups: FrameRemakeGroup[];
    mergedVideo?: FrameRemakeMedia;
    automation?: {
        id: string;
        status: "running" | "paused" | "error" | "completed";
        mode?: "auto" | "step";
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
export type FrameRemakeProjectList = { items: FrameRemakeProject[]; total: number; page: number; pageSize: number };
export type FrameRemakePatch = Partial<Pick<FrameRemakeProject, "title" | "instructions" | "audioMode" | "maxSegmentSeconds" | "references" | "modelSelection">> & {
    sourceVideo?: FrameRemakeMedia | null;
    group?: { id: string; analysis: string; productScript?: string; imagePrompt: string; videoPrompt: string };
};

export const idleFrameRemakeTask = (attemptNo = 0): FrameRemakeTask => ({ status: "idle", attemptNo });
export function newFrameRemakeProject(id: string, title: string): FrameRemakeProject {
    const now = new Date().toISOString();
    return {
        id,
        title: title.trim() || "原时长拆帧复刻",
        status: "active",
        revision: 1,
        createdAt: now,
        updatedAt: now,
        durationMs: 0,
        maxSegmentSeconds: 15,
        references: { product: [], character: [], background: [] },
        instructions: "",
        audioMode: "source",
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
        const count = Math.max(1, Math.ceil((endMs - startMs) / 1250));
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
            productScript: "",
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
    return stage === "productScript" ? (group.productScript ?? group.analysis) : group[stage];
}
export function nextFrameRemakeAnalysisStage(group: FrameRemakeGroup) {
    return FRAME_REMAKE_ANALYSIS_STAGES.find((stage) => !frameRemakeAnalysisResult(group, stage));
}
// 修改某一步时，仅使它和依赖它的后续结果失效。
export function resetFrameRemakeAnalysisFrom(group: FrameRemakeGroup, stage: FrameRemakeAnalysisStage): FrameRemakeGroup {
    const next = { ...group, analysisSteps: { ...group.analysisSteps }, video: idleFrameRemakeTask(group.video.attemptNo) };
    if (stage !== "videoPrompt") {
        next.template = idleFrameRemakeTask(group.template.attemptNo);
        next.image = idleFrameRemakeTask(group.image.attemptNo);
    }
    for (const key of FRAME_REMAKE_ANALYSIS_STAGES.slice(FRAME_REMAKE_ANALYSIS_STAGES.indexOf(stage))) {
        next[key] = "";
        delete next.analysisSteps[key];
    }
    return next;
}
export function frameRemakeSeconds(group: Pick<FrameRemakeGroup, "startMs" | "endMs">) {
    return (group.endMs - group.startMs) / 1000;
}
export function frameRemakeGrid(count: number) {
    const columns = count <= 1 ? 1 : count <= 4 ? 2 : 3;
    return { columns, rows: Math.ceil(count / columns) };
}
export function frameRemakeBusy(project: FrameRemakeProject) {
    return Boolean(project.operation || project.groups.some((group) => [group.template, group.image, group.video].some((task) => task.status === "queued" || task.status === "running")));
}
export function frameRemakeImageReferences(project: FrameRemakeProject, group: FrameRemakeGroup, kind: "template" | "image" = "image") {
    return (kind === "template" ? [group.contactSheet, ...project.references.character] : [group.template.result, ...project.references.product, ...project.references.background]).filter((media): media is FrameRemakeMedia => Boolean(media));
}
export function frameRemakeVideoReferences(project: FrameRemakeProject, group: FrameRemakeGroup) {
    return [group.image.result, ...project.references.product, ...project.references.character].filter((media): media is FrameRemakeMedia => Boolean(media));
}
export function frameRemakeAspectRatio(project: FrameRemakeProject) {
    return (project.sourceVideo?.width || 9) >= (project.sourceVideo?.height || 16) ? "16:9" : "9:16";
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
                JSON.stringify(group.frames.map(({ number, startMs, endMs, sampleMs }) => ({ number, startMs, endMs, sampleMs }))) !== JSON.stringify(target.frames)
            );
        })
    )
        throw new Error("拆帧时间线与原片不一致，请重新拆帧");
}
