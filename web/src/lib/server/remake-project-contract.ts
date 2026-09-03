export const REMAKE_FRAME_COUNT = 48;
export const REMAKE_COPY_BLOCK_COUNT = 16;
export const REMAKE_FRAMES_PER_COPY_BLOCK = 3;
export const REMAKE_RANGE_GROUP_COUNT = 4;
export const REMAKE_FRAMES_PER_RANGE_GROUP = 12;
export const REMAKE_NO_NARRATION_TEXT = "不需要人物口播";

export const REMAKE_RANGE_GROUP_DEFINITIONS = [
    { id: "1-12", ordinal: 1, startFrame: 1, endFrame: 12 },
    { id: "13-24", ordinal: 2, startFrame: 13, endFrame: 24 },
    { id: "25-36", ordinal: 3, startFrame: 25, endFrame: 36 },
    { id: "37-48", ordinal: 4, startFrame: 37, endFrame: 48 },
] as const;

export const REMAKE_PIPELINE_STEPS = ["upload", "analysis", "references", "images", "copy", "prompts"] as const;

export type RemakeProjectStatus = "active" | "archived";
export type RemakeCopyStrategy = "keep" | "manual";
export type RemakeVoice = "source" | "female" | "male";
export type RemakeAnalysisStatus = "idle" | "queued" | "running" | "completed" | "error";
export type RemakeAnalysisMode = "video" | "vision" | "hybrid" | "frames-only";
export type RemakeFrameAnalysisStatus = "available" | "unavailable";
export type RemakePipelineStep = (typeof REMAKE_PIPELINE_STEPS)[number];
export type RemakePipelineStage = RemakePipelineStep | "prompts-ready" | "ready" | "failed";
export type RemakePipelineStepStatus = "pending" | "queued" | "running" | "completed" | "error";
export type RemakeWorkStatus = "idle" | "queued" | "running" | "completed" | "error";
export type RemakeRangeGroupId = (typeof REMAKE_RANGE_GROUP_DEFINITIONS)[number]["id"];

export type RemakeSourceVideo = {
    url: string;
    storageKey?: string;
    mimeType: string;
    originalName?: string;
    bytes?: number;
    durationMs?: number;
    width?: number;
    height?: number;
    ratio?: string;
};

export type RemakeMediaAsset = {
    url: string;
    storageKey?: string;
    mimeType: string;
    originalName?: string;
    bytes?: number;
    width?: number;
    height?: number;
};

export type RemakeReferences = {
    character?: RemakeMediaAsset;
    characterSupplement?: RemakeMediaAsset;
    background?: RemakeMediaAsset;
    audio?: RemakeMediaAsset;
};

export type RemakePipelineStepState = {
    status: RemakePipelineStepStatus;
    taskId?: string;
    error?: string;
};

export type RemakePipeline = {
    stage: RemakePipelineStage;
    steps: Record<RemakePipelineStep, RemakePipelineStepState>;
};

export type RemakeFrame = {
    ordinal: number;
    time: number;
    endTime: number;
    frameUrl: string;
    storageKey?: string;
    analysisStatus: RemakeFrameAnalysisStatus;
    analysisWarning?: string;
    subtitle: string;
    sellingPoint: string;
    shotType: string;
    description: string;
    subjectRatio: string;
    hasFace?: boolean;
};

export type RemakeCopyBlock = {
    id: string;
    ordinal: number;
    frameOrdinals: [number, number, number];
    startTime: number;
    endTime: number;
    sourceText: string;
    text: string;
};

export type RemakeCopyParagraph = {
    ordinal: number;
    text: string;
};

export type RemakeCopyMapping = {
    blockOrdinal: number;
    paragraphOrdinals: number[];
    sourceText: string;
    text: string;
};

export type RemakeCopyChecks = {
    sequential: boolean;
    noDuplicates: boolean;
    noSkips: boolean;
};

export type RemakeCopyStats = {
    paragraphCount: number;
    unchangedBlocks: number;
    completedBlocks: number;
    correctedBlocks: number;
    emptyBlocks: number;
};

export type RemakeCopyState = {
    status: RemakeWorkStatus;
    taskId?: string;
    optionRaw: string;
    rawReport: string;
    paragraphs: RemakeCopyParagraph[];
    mappings: RemakeCopyMapping[];
    checks: RemakeCopyChecks;
    stats: RemakeCopyStats;
    error?: string;
};

export type RemakeImageGeneration = {
    status: RemakeWorkStatus;
    taskId?: string;
    prompt: string;
    result?: RemakeMediaAsset;
    error?: string;
};

export type RemakeRangeGroup = {
    id: RemakeRangeGroupId;
    ordinal: number;
    frameOrdinals: number[];
    sourceContactSheet?: RemakeMediaAsset;
    imageGeneration: RemakeImageGeneration;
    videoPrompt: string;
};

export type RemakeContactSheetInput = {
    groupOrdinal: number;
    asset: RemakeMediaAsset;
};

export type RemakeProjectAnalysis = {
    status: RemakeAnalysisStatus;
    taskId?: string;
    runId?: string;
    mode?: RemakeAnalysisMode;
    warning?: string;
    error?: string;
    raw?: string;
    timestamps?: number[];
};

export type RemakeProject = {
    id: string;
    title: string;
    status: RemakeProjectStatus;
    revision: number;
    sourceVideo?: RemakeSourceVideo;
    sourceCopy: string;
    copyStrategy: RemakeCopyStrategy;
    voice: RemakeVoice;
    analysis: RemakeProjectAnalysis;
    frames: RemakeFrame[];
    copyBlocks: RemakeCopyBlock[];
    pipeline?: RemakePipeline;
    references?: RemakeReferences;
    groups?: RemakeRangeGroup[];
    copy?: RemakeCopyState;
    createdAt: string;
    updatedAt: string;
};

export type HydratedRemakeProject = RemakeProject & {
    analysis: RemakeProjectAnalysis & { raw: string; timestamps: number[] };
    pipeline: RemakePipeline;
    references: RemakeReferences;
    groups: RemakeRangeGroup[];
    copy: RemakeCopyState;
};

export type RemakeProjectSummary = {
    id: string;
    title: string;
    status: RemakeProjectStatus;
    revision: number;
    sourceVideoUrl?: string;
    analysisStatus: RemakeAnalysisStatus;
    analysisMode?: RemakeAnalysisMode;
    frameCount: number;
    createdAt: string;
    updatedAt: string;
};

export type RemakeProjectSummaryPage = {
    items: RemakeProjectSummary[];
    total: number;
    page: number;
    pageSize: number;
};

export function isRemakeNoNarrationCopy(value: unknown) {
    const text = typeof value === "string" ? value.trim() : "";
    return !text || text === REMAKE_NO_NARRATION_TEXT;
}

export function idleRemakeAnalysis(): RemakeProjectAnalysis {
    return { status: "idle", raw: "", timestamps: [] };
}

export function summarizeRemakeProject(project: RemakeProject): RemakeProjectSummary {
    return {
        id: project.id,
        title: project.title,
        status: project.status,
        revision: project.revision,
        sourceVideoUrl: project.sourceVideo?.url,
        analysisStatus: project.analysis.status,
        analysisMode: project.analysis.mode,
        frameCount: project.frames.length,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
    };
}

export function normalizeRemakeSourceVideo(value: unknown): RemakeSourceVideo | undefined {
    const source = object(value);
    const url = cleanText(source.url, 4_000);
    if (!url) return undefined;
    return {
        url,
        storageKey: cleanText(source.storageKey, 1_000) || undefined,
        mimeType: cleanText(source.mimeType, 120) || "video/mp4",
        originalName: cleanText(source.originalName, 300) || undefined,
        bytes: optionalPositiveInteger(source.bytes),
        durationMs: optionalPositiveInteger(source.durationMs),
        width: optionalPositiveInteger(source.width),
        height: optionalPositiveInteger(source.height),
        ratio: cleanText(source.ratio, 40) || undefined,
    };
}

export function normalizeRemakeMediaAsset(value: unknown): RemakeMediaAsset | undefined {
    const source = object(value);
    const url = cleanText(firstDefined(source.url, source.serverUrl, source.imageUrl, source.audioUrl), 4_000);
    if (!url) return undefined;
    return {
        url,
        storageKey: cleanText(firstDefined(source.storageKey, source.key), 1_000) || undefined,
        mimeType: cleanText(firstDefined(source.mimeType, source.type), 120) || "application/octet-stream",
        originalName: cleanText(firstDefined(source.originalName, source.name), 300) || undefined,
        bytes: optionalPositiveInteger(firstDefined(source.bytes, source.size)),
        width: optionalPositiveInteger(source.width),
        height: optionalPositiveInteger(source.height),
    };
}

export function emptyRemakeReferences(): RemakeReferences {
    return {};
}

export function normalizeRemakeReferences(value: unknown, fallback: RemakeReferences = emptyRemakeReferences()): RemakeReferences {
    const source = object(value);
    return {
        character: normalizedAssetProperty(source, "character", fallback.character),
        characterSupplement: normalizedAssetProperty(source, "characterSupplement", fallback.characterSupplement),
        background: normalizedAssetProperty(source, "background", fallback.background),
        audio: normalizedAssetProperty(source, "audio", fallback.audio),
    };
}

export function defaultRemakePipeline(input: { hasSourceVideo?: boolean; analysisStatus?: RemakeAnalysisStatus } = {}): RemakePipeline {
    const uploadStatus: RemakePipelineStepStatus = input.hasSourceVideo ? "completed" : "pending";
    const analysisStatus = pipelineStatusFromAnalysis(input.analysisStatus);
    const stage: RemakePipelineStage = analysisStatus === "error" ? "failed" : analysisStatus === "queued" || analysisStatus === "running" ? "analysis" : analysisStatus === "completed" ? "references" : input.hasSourceVideo ? "analysis" : "upload";
    return {
        stage,
        steps: {
            upload: { status: uploadStatus },
            analysis: { status: analysisStatus },
            references: { status: "pending" },
            images: { status: "pending" },
            copy: { status: "pending" },
            prompts: { status: "pending" },
        },
    };
}

export function normalizeRemakePipeline(value: unknown, fallback: RemakePipeline = defaultRemakePipeline()): RemakePipeline {
    const source = object(value);
    const sourceSteps = object(source.steps);
    const steps = Object.fromEntries(
        REMAKE_PIPELINE_STEPS.map((step) => {
            const current = object(sourceSteps[step]);
            const previous = fallback.steps[step];
            const status = normalizePipelineStepStatus(current.status) || previous.status;
            return [
                step,
                {
                    status,
                    taskId: hasOwn(current, "taskId") ? cleanText(current.taskId, 300) || undefined : previous.taskId,
                    error: hasOwn(current, "error") ? cleanText(current.error, 1_000) || undefined : previous.error,
                },
            ];
        }),
    ) as Record<RemakePipelineStep, RemakePipelineStepState>;
    return { stage: normalizePipelineStage(source.stage) || fallback.stage, steps };
}

export function normalizeRemakeFrames(value: unknown): RemakeFrame[] {
    if (!Array.isArray(value)) return [];
    const byOrdinal = new Map<number, RemakeFrame>();
    for (const item of value) {
        const frame = normalizeRemakeFrame(item);
        if (frame && !byOrdinal.has(frame.ordinal)) byOrdinal.set(frame.ordinal, frame);
    }
    return Array.from(byOrdinal.values())
        .sort((left, right) => left.ordinal - right.ordinal)
        .slice(0, REMAKE_FRAME_COUNT);
}

export function normalizeRemakeFrame(value: unknown): RemakeFrame | null {
    const source = object(value);
    const ordinal = integerInRange(source.ordinal, 1, REMAKE_FRAME_COUNT);
    const frameUrl = cleanText(source.frameUrl, 4_000);
    if (!ordinal || !frameUrl) return null;
    const time = nonNegativeNumber(source.time);
    const endTime = Math.max(time, nonNegativeNumber(source.endTime));
    return {
        ordinal,
        time,
        endTime,
        frameUrl,
        storageKey: cleanText(source.storageKey, 1_000) || undefined,
        analysisStatus: source.analysisStatus === "available" ? "available" : "unavailable",
        analysisWarning: cleanText(source.analysisWarning, 500) || undefined,
        subtitle: cleanText(source.subtitle, 2_000),
        sellingPoint: cleanText(source.sellingPoint, 2_000),
        shotType: cleanText(source.shotType, 200),
        description: cleanText(source.description, 4_000),
        subjectRatio: cleanText(source.subjectRatio, 200),
        hasFace: typeof source.hasFace === "boolean" ? source.hasFace : undefined,
    };
}

export function normalizeRemakeTimestamps(value: unknown): number[] {
    if (!Array.isArray(value) || value.length !== REMAKE_FRAME_COUNT) return [];
    const timestamps = value.map(optionalNonNegativeNumber);
    return timestamps.every((item): item is number => item !== undefined) ? timestamps : [];
}

export function emptyRemakeCopyState(): RemakeCopyState {
    return {
        status: "idle",
        optionRaw: "",
        rawReport: "",
        paragraphs: [],
        mappings: [],
        checks: { sequential: false, noDuplicates: false, noSkips: false },
        stats: { paragraphCount: 0, unchangedBlocks: 0, completedBlocks: 0, correctedBlocks: 0, emptyBlocks: REMAKE_COPY_BLOCK_COUNT },
    };
}

export function normalizeRemakeCopyState(value: unknown, fallback: RemakeCopyState = emptyRemakeCopyState()): RemakeCopyState {
    const source = object(value);
    const checks = object(source.checks);
    const stats = object(source.stats);
    return {
        status: normalizeWorkStatus(source.status) || fallback.status,
        taskId: hasOwn(source, "taskId") ? cleanText(source.taskId, 300) || undefined : fallback.taskId,
        optionRaw: hasOwn(source, "optionRaw") ? cleanText(source.optionRaw, 500) : fallback.optionRaw,
        rawReport: hasOwn(source, "rawReport") ? cleanText(source.rawReport, 200_000) : fallback.rawReport,
        paragraphs: hasOwn(source, "paragraphs") ? normalizeCopyParagraphs(source.paragraphs) : fallback.paragraphs,
        mappings: hasOwn(source, "mappings") ? normalizeCopyMappings(source.mappings) : fallback.mappings,
        checks: {
            sequential: hasOwn(checks, "sequential") ? checks.sequential === true : fallback.checks.sequential,
            noDuplicates: hasOwn(checks, "noDuplicates") ? checks.noDuplicates === true : fallback.checks.noDuplicates,
            noSkips: hasOwn(checks, "noSkips") ? checks.noSkips === true : fallback.checks.noSkips,
        },
        stats: {
            paragraphCount: hasOwn(stats, "paragraphCount") ? nonNegativeInteger(stats.paragraphCount) : fallback.stats.paragraphCount,
            unchangedBlocks: hasOwn(stats, "unchangedBlocks") ? boundedCount(stats.unchangedBlocks, REMAKE_COPY_BLOCK_COUNT) : fallback.stats.unchangedBlocks,
            completedBlocks: hasOwn(stats, "completedBlocks") ? boundedCount(stats.completedBlocks, REMAKE_COPY_BLOCK_COUNT) : fallback.stats.completedBlocks,
            correctedBlocks: hasOwn(stats, "correctedBlocks") ? boundedCount(stats.correctedBlocks, REMAKE_COPY_BLOCK_COUNT) : fallback.stats.correctedBlocks,
            emptyBlocks: hasOwn(stats, "emptyBlocks") ? boundedCount(stats.emptyBlocks, REMAKE_COPY_BLOCK_COUNT) : fallback.stats.emptyBlocks,
        },
        error: hasOwn(source, "error") ? cleanText(source.error, 1_000) || undefined : fallback.error,
    };
}

export function emptyRemakeRangeGroups(): RemakeRangeGroup[] {
    return REMAKE_RANGE_GROUP_DEFINITIONS.map((definition) => ({
        id: definition.id,
        ordinal: definition.ordinal,
        frameOrdinals: frameOrdinalRange(definition.startFrame, definition.endFrame),
        imageGeneration: { status: "idle", prompt: "" },
        videoPrompt: "",
    }));
}

export function normalizeRemakeRangeGroups(value: unknown, fallback: RemakeRangeGroup[] = emptyRemakeRangeGroups()): RemakeRangeGroup[] {
    const fallbackByOrdinal = new Map(fallback.map((group) => [group.ordinal, group]));
    const incomingByOrdinal = new Map<number, Record<string, unknown>>();
    if (Array.isArray(value)) {
        for (const item of value) {
            const source = object(item);
            const ordinal = groupOrdinal(source);
            if (ordinal && !incomingByOrdinal.has(ordinal)) incomingByOrdinal.set(ordinal, source);
        }
    }
    const emptyGroups = emptyRemakeRangeGroups();
    return REMAKE_RANGE_GROUP_DEFINITIONS.map((definition) => {
        const previous = fallbackByOrdinal.get(definition.ordinal) || emptyGroups[definition.ordinal - 1];
        const source = incomingByOrdinal.get(definition.ordinal) || {};
        const generationSource = object(source.imageGeneration);
        const previousGeneration = previous.imageGeneration;
        return {
            id: definition.id,
            ordinal: definition.ordinal,
            frameOrdinals: frameOrdinalRange(definition.startFrame, definition.endFrame),
            sourceContactSheet: hasOwn(source, "sourceContactSheet") ? normalizeRemakeMediaAsset(source.sourceContactSheet) : previous.sourceContactSheet,
            imageGeneration: {
                status: normalizeWorkStatus(generationSource.status) || previousGeneration.status,
                taskId: hasOwn(generationSource, "taskId") ? cleanText(generationSource.taskId, 300) || undefined : previousGeneration.taskId,
                prompt: hasOwn(generationSource, "prompt") ? cleanText(generationSource.prompt, 100_000) : previousGeneration.prompt,
                result: hasOwn(generationSource, "result") ? normalizeRemakeMediaAsset(generationSource.result) : previousGeneration.result,
                error: hasOwn(generationSource, "error") ? cleanText(generationSource.error, 1_000) || undefined : previousGeneration.error,
            },
            videoPrompt: hasOwn(source, "videoPrompt") ? cleanText(source.videoPrompt, 100_000) : previous.videoPrompt,
        };
    });
}

export function mergeRemakeContactSheets(groups: RemakeRangeGroup[], value: unknown): RemakeRangeGroup[] {
    if (!Array.isArray(value)) return normalizeRemakeRangeGroups(groups);
    const patches = value.flatMap((item) => {
        const source = object(item);
        const groupOrdinal = integerInRange(source.groupOrdinal, 1, REMAKE_RANGE_GROUP_COUNT);
        const asset = normalizeRemakeMediaAsset(source.asset);
        return groupOrdinal && asset ? [{ ordinal: groupOrdinal, sourceContactSheet: asset }] : [];
    });
    return normalizeRemakeRangeGroups(patches, groups);
}

export function buildRemakeCopyBlocks(input: { frames: RemakeFrame[]; sourceCopy: string; strategy: RemakeCopyStrategy; existing?: RemakeCopyBlock[]; mappings?: RemakeCopyMapping[] }): RemakeCopyBlock[] {
    const frames = normalizeRemakeFrames(input.frames);
    if (frames.length !== REMAKE_FRAME_COUNT || frames.some((frame, index) => frame.ordinal !== index + 1)) return [];
    const existing = new Map((input.existing || []).map((block) => [block.ordinal, block]));
    const mappings = new Map((input.mappings || []).map((mapping) => [mapping.blockOrdinal, mapping]));
    return Array.from({ length: REMAKE_COPY_BLOCK_COUNT }, (_, index) => {
        const ordinal = index + 1;
        const firstFrame = frames[index * REMAKE_FRAMES_PER_COPY_BLOCK];
        const lastFrame = frames[index * REMAKE_FRAMES_PER_COPY_BLOCK + REMAKE_FRAMES_PER_COPY_BLOCK - 1];
        const previous = existing.get(ordinal);
        const mapping = mappings.get(ordinal);
        const sourceText = mapping?.sourceText ?? previous?.sourceText ?? "";
        const text = input.strategy === "keep" ? (mapping?.text ?? sourceText) : (previous?.text ?? mapping?.text ?? sourceText);
        return {
            id: `copy-block-${ordinal}`,
            ordinal,
            frameOrdinals: [firstFrame.ordinal, firstFrame.ordinal + 1, lastFrame.ordinal],
            startTime: firstFrame.time,
            endTime: lastFrame.endTime,
            sourceText,
            text,
        };
    });
}

export function normalizeRemakeCopyBlocks(value: unknown, input: { frames: RemakeFrame[]; sourceCopy: string; strategy: RemakeCopyStrategy; fallback?: RemakeCopyBlock[]; mappings?: RemakeCopyMapping[]; requireComplete?: boolean }): RemakeCopyBlock[] {
    const incoming = Array.isArray(value)
        ? value.flatMap((item) => {
              const source = object(item);
              const ordinal = integerInRange(source.ordinal, 1, REMAKE_COPY_BLOCK_COUNT);
              if (!ordinal) return [];
              return [
                  {
                      id: `copy-block-${ordinal}`,
                      ordinal,
                      frameOrdinals: [ordinal * 3 - 2, ordinal * 3 - 1, ordinal * 3] as [number, number, number],
                      startTime: nonNegativeNumber(source.startTime),
                      endTime: nonNegativeNumber(source.endTime),
                      sourceText: cleanText(source.sourceText, 20_000),
                      text: cleanText(source.text, 20_000),
                  },
              ];
          })
        : [];
    const uniqueIncoming = new Map(incoming.map((block) => [block.ordinal, block]));
    if (input.requireComplete && (incoming.length !== REMAKE_COPY_BLOCK_COUNT || uniqueIncoming.size !== REMAKE_COPY_BLOCK_COUNT)) return [];
    return buildRemakeCopyBlocks({
        frames: input.frames,
        sourceCopy: input.sourceCopy,
        strategy: input.strategy,
        existing: mergeCopyBlocks(input.fallback || [], Array.from(uniqueIncoming.values())),
        mappings: input.mappings,
    });
}

export function normalizeRemakeProjectWorkflow(project: RemakeProject): HydratedRemakeProject {
    const frames = normalizeRemakeFrames(project.frames);
    const copy = normalizeRemakeCopyState(project.copy);
    const sourceCopy = isRemakeNoNarrationCopy(project.sourceCopy) ? "" : project.sourceCopy;
    const normalizedCopyBlocks = normalizeRemakeCopyBlocks(project.copyBlocks, {
        frames,
        sourceCopy,
        strategy: project.copyStrategy,
        mappings: copy.mappings,
    });
    const noNarration = isRemakeNoNarrationCopy(sourceCopy);
    const trustedSemanticCopy =
        copy.status === "completed" &&
        copy.checks.sequential &&
        copy.checks.noDuplicates &&
        copy.checks.noSkips &&
        copy.mappings.length === REMAKE_COPY_BLOCK_COUNT &&
        copy.mappings.every(
            (mapping, index) => mapping.blockOrdinal === index + 1 && (noNarration ? !mapping.sourceText.trim() && !mapping.text.trim() && mapping.paragraphOrdinals.length === 0 : Boolean(mapping.sourceText.trim()) && Boolean(mapping.text.trim())),
        );
    const copyBlocks = trustedSemanticCopy ? normalizedCopyBlocks : normalizedCopyBlocks.map((block) => ({ ...block, sourceText: "", text: "" }));
    const timestampFallback = frames.length === REMAKE_FRAME_COUNT ? frames.map((frame) => frame.time) : [];
    const timestamps = normalizeRemakeTimestamps(project.analysis.timestamps);
    const pipelineFallback = defaultRemakePipeline({ hasSourceVideo: Boolean(project.sourceVideo?.url), analysisStatus: project.analysis.status });
    return {
        ...project,
        sourceCopy,
        frames,
        copyBlocks,
        analysis: {
            ...project.analysis,
            raw: cleanText(project.analysis.raw, 500_000),
            timestamps: timestamps.length ? timestamps : timestampFallback,
        },
        pipeline: normalizeRemakePipeline(project.pipeline, pipelineFallback),
        references: normalizeRemakeReferences(project.references),
        groups: normalizeRemakeRangeGroups(project.groups),
        copy,
    };
}

function normalizeCopyParagraphs(value: unknown): RemakeCopyParagraph[] {
    if (!Array.isArray(value)) return [];
    const paragraphs = new Map<number, RemakeCopyParagraph>();
    for (const item of value.slice(0, 500)) {
        const source = object(item);
        const ordinal = integerInRange(source.ordinal, 1, 500);
        const text = cleanText(source.text, 20_000);
        if (ordinal && text && !paragraphs.has(ordinal)) paragraphs.set(ordinal, { ordinal, text });
    }
    return Array.from(paragraphs.values()).sort((left, right) => left.ordinal - right.ordinal);
}

function normalizeCopyMappings(value: unknown): RemakeCopyMapping[] {
    if (!Array.isArray(value)) return [];
    const mappings = new Map<number, RemakeCopyMapping>();
    for (const item of value) {
        const source = object(item);
        const blockOrdinal = integerInRange(source.blockOrdinal, 1, REMAKE_COPY_BLOCK_COUNT);
        if (!blockOrdinal || mappings.has(blockOrdinal)) continue;
        mappings.set(blockOrdinal, {
            blockOrdinal,
            paragraphOrdinals: uniquePositiveIntegers(source.paragraphOrdinals, 500),
            sourceText: cleanText(source.sourceText, 20_000),
            text: cleanText(source.text, 20_000),
        });
    }
    return Array.from(mappings.values()).sort((left, right) => left.blockOrdinal - right.blockOrdinal);
}

function mergeCopyBlocks(fallback: RemakeCopyBlock[], incoming: RemakeCopyBlock[]) {
    const merged = new Map(fallback.map((block) => [block.ordinal, block]));
    for (const block of incoming) merged.set(block.ordinal, { ...merged.get(block.ordinal), ...block });
    return Array.from(merged.values());
}

function normalizedAssetProperty(source: Record<string, unknown>, key: keyof RemakeReferences, fallback?: RemakeMediaAsset) {
    return hasOwn(source, key) ? normalizeRemakeMediaAsset(source[key]) : fallback;
}

function groupOrdinal(source: Record<string, unknown>) {
    const direct = integerInRange(source.ordinal, 1, REMAKE_RANGE_GROUP_COUNT);
    if (direct) return direct;
    const id = cleanText(firstDefined(source.id, source.rangeId), 20);
    return REMAKE_RANGE_GROUP_DEFINITIONS.find((definition) => definition.id === id)?.ordinal || 0;
}

function frameOrdinalRange(start: number, end: number) {
    return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

function pipelineStatusFromAnalysis(value?: RemakeAnalysisStatus): RemakePipelineStepStatus {
    if (value === "queued" || value === "running" || value === "completed" || value === "error") return value;
    return "pending";
}

function normalizePipelineStepStatus(value: unknown): RemakePipelineStepStatus | undefined {
    return value === "pending" || value === "queued" || value === "running" || value === "completed" || value === "error" ? value : undefined;
}

function normalizePipelineStage(value: unknown): RemakePipelineStage | undefined {
    return REMAKE_PIPELINE_STEPS.includes(value as RemakePipelineStep) || value === "prompts-ready" || value === "ready" || value === "failed" ? (value as RemakePipelineStage) : undefined;
}

function normalizeWorkStatus(value: unknown): RemakeWorkStatus | undefined {
    return value === "idle" || value === "queued" || value === "running" || value === "completed" || value === "error" ? value : undefined;
}

function uniquePositiveIntegers(value: unknown, maximum: number) {
    if (!Array.isArray(value)) return [];
    return Array.from(new Set(value.map((item) => integerInRange(item, 1, maximum)).filter(Boolean)));
}

function boundedCount(value: unknown, maximum: number) {
    return Math.min(maximum, nonNegativeInteger(value));
}

function nonNegativeInteger(value: unknown) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}

function object(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function cleanText(value: unknown, maxLength = 20_000) {
    return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function firstDefined(...values: unknown[]) {
    return values.find((value) => value !== undefined && value !== null);
}

function optionalPositiveInteger(value: unknown) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.floor(number) : undefined;
}

function optionalNonNegativeNumber(value: unknown) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? Number(number.toFixed(3)) : undefined;
}

function nonNegativeNumber(value: unknown) {
    return optionalNonNegativeNumber(value) || 0;
}

function integerInRange(value: unknown, minimum: number, maximum: number) {
    const number = Number(value);
    return Number.isInteger(number) && number >= minimum && number <= maximum ? number : 0;
}

function hasOwn(value: Record<string, unknown>, key: PropertyKey) {
    return Object.prototype.hasOwnProperty.call(value, key);
}
