export type RemakeCopyStrategy = "keep" | "manual";
export type RemakeVoice = "source" | "female" | "male";
export type RemakeAnalysisMode = "video" | "vision" | "hybrid" | "frames-only";
export type RemakeAnalysisStatus = "idle" | "queued" | "running" | "completed" | "error";
export type RemakeTaskStatus = "pending" | "running" | "success" | "error";
export type RemakePipelineStage = "upload" | "analysis" | "references" | "images" | "copy" | "prompts" | "prompts-ready" | "ready" | "failed";
export type RemakePipelineStepKey = "upload" | "analysis" | "references" | "images" | "copy" | "prompts";
export type RemakePipelineStepStatus = "pending" | "queued" | "running" | "completed" | "error";
export type RemakeImageGenerationStatus = "idle" | "queued" | "running" | "completed" | "error";

export const REMAKE_NO_NARRATION_TEXT = "不需要人物口播";

export function isRemakeNoNarrationCopy(value: unknown) {
    const text = typeof value === "string" ? value.trim() : "";
    return !text || text === REMAKE_NO_NARRATION_TEXT;
}

export const REMAKE_GROUP_DEFINITIONS = [
    { id: "1-12", ordinal: 1, start: 1, end: 12 },
    { id: "13-24", ordinal: 2, start: 13, end: 24 },
    { id: "25-36", ordinal: 3, start: 25, end: 36 },
    { id: "37-48", ordinal: 4, start: 37, end: 48 },
] as const;

export type RemakeMediaAsset = {
    url: string;
    storageKey?: string;
    mimeType?: string;
    originalName?: string;
    bytes?: number;
    width?: number;
    height?: number;
    [key: string]: unknown;
};

export type RemakeSourceVideo = {
    url: string;
    storageKey?: string;
    mimeType?: string;
    originalName?: string;
    bytes?: number;
    durationMs?: number;
    width?: number;
    height?: number;
    ratio?: string;
    [key: string]: unknown;
};

export type RemakeFrame = {
    id: string;
    ordinal: number;
    time: number;
    endTime: number;
    frameUrl: string;
    storageKey?: string;
    analysisStatus: "available" | "unavailable";
    subtitle: string;
    sellingPoint: string;
    shotType: string;
    description: string;
    subjectRatio: string;
    hasFace?: boolean;
    [key: string]: unknown;
};

export type RemakeCopyBlock = {
    id: string;
    ordinal: number;
    frameOrdinals: [number, number, number];
    startTime: number;
    endTime: number;
    sourceText: string;
    text: string;
    [key: string]: unknown;
};

export type RemakeAnalysis = {
    status: RemakeAnalysisStatus;
    taskId?: string;
    runId?: string;
    mode?: RemakeAnalysisMode;
    warning?: string;
    error?: string;
    raw?: string;
    timestamps: number[];
};

export type RemakePipelineStep = {
    status: RemakePipelineStepStatus;
    taskId?: string;
    error?: string;
};

export type RemakePipeline = {
    stage: RemakePipelineStage;
    steps: Record<RemakePipelineStepKey, RemakePipelineStep>;
};

export type RemakeReferenceAssets = {
    character?: RemakeMediaAsset;
    characterSupplement?: RemakeMediaAsset;
    background?: RemakeMediaAsset;
    audio?: RemakeMediaAsset;
};

export type RemakeRangeGroup = {
    id: (typeof REMAKE_GROUP_DEFINITIONS)[number]["id"];
    ordinal: number;
    frameOrdinals: number[];
    sourceContactSheet?: RemakeMediaAsset;
    imageGeneration: {
        status: RemakeImageGenerationStatus;
        taskId?: string | null;
        prompt: string;
        result?: RemakeMediaAsset | null;
        error?: string | null;
    };
    videoPrompt: string;
};

export type RemakeSemanticCopy = {
    status: RemakeImageGenerationStatus;
    taskId?: string;
    optionRaw: string;
    rawReport: string;
    paragraphs: Array<{ ordinal: number; text: string }>;
    mappings: Array<{ blockOrdinal: number; paragraphOrdinals: number[]; sourceText: string; text: string }>;
    checks: { sequential: boolean; noDuplicates: boolean; noSkips: boolean };
    stats: { paragraphCount: number; unchangedBlocks: number; completedBlocks: number; correctedBlocks: number; emptyBlocks: number };
    error?: string;
};

export type RemakeProject = {
    id: string;
    title: string;
    status: "active" | "archived";
    revision: number;
    sourceVideo?: RemakeSourceVideo;
    sourceCopy: string;
    copyStrategy: RemakeCopyStrategy;
    voice: RemakeVoice;
    analysis: RemakeAnalysis;
    pipeline: RemakePipeline;
    references: RemakeReferenceAssets;
    groups: RemakeRangeGroup[];
    copy: RemakeSemanticCopy;
    frames: RemakeFrame[];
    copyBlocks: RemakeCopyBlock[];
    createdAt: string;
    updatedAt: string;
    [key: string]: unknown;
};

export type RemakeProjectList = {
    projects: RemakeProjectSummary[];
    total: number;
    page: number;
    pageSize: number;
};

export type RemakeProjectSummary = {
    id: string;
    title: string;
    status: "active" | "archived";
    revision: number;
    sourceVideoUrl?: string;
    analysisStatus: RemakeAnalysisStatus;
    analysisMode?: RemakeAnalysisMode;
    frameCount: number;
    createdAt: string;
    updatedAt: string;
};

export type RemakeTask = {
    id: string;
    projectId: string;
    status: RemakeTaskStatus;
    progress: number;
    stage: string;
    error?: string;
    createdAt: string;
    updatedAt: string;
};

export type RemakeEditablePatch = Partial<Pick<RemakeProject, "title" | "sourceVideo" | "sourceCopy" | "copyStrategy" | "voice" | "references" | "groups" | "frames" | "copyBlocks">>;

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as UnknownRecord) : {};
}

function firstDefined(...values: unknown[]) {
    return values.find((value) => value !== undefined && value !== null);
}

function stringValue(value: unknown, fallback = "") {
    if (typeof value === "string") return value;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    return fallback;
}

function numberValue(value: unknown, fallback = 0) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
        const numeric = Number(value);
        if (Number.isFinite(numeric)) return numeric;
    }
    return fallback;
}

function booleanValue(value: unknown): boolean | undefined {
    if (typeof value === "boolean") return value;
    if (value === 1 || value === "1" || value === "true") return true;
    if (value === 0 || value === "0" || value === "false") return false;
    return undefined;
}

function arrayValue(value: unknown) {
    return Array.isArray(value) ? value : [];
}

export function secondsValue(value: unknown, fallback = 0) {
    if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, value);
    const text = stringValue(value).trim();
    if (!text) return fallback;
    const numeric = Number(text);
    if (Number.isFinite(numeric)) return Math.max(0, numeric);
    const parts = text.split(":").map(Number);
    if (parts.some((part) => !Number.isFinite(part))) return fallback;
    if (parts.length === 2) return Math.max(0, parts[0] * 60 + parts[1]);
    if (parts.length === 3) return Math.max(0, parts[0] * 3600 + parts[1] * 60 + parts[2]);
    return fallback;
}

export function formatFrameTime(seconds: number) {
    const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
    const minutes = Math.floor(safe / 60);
    const remainder = safe - minutes * 60;
    const [whole, fraction] = remainder.toFixed(remainder % 1 ? 2 : 0).split(".");
    return `${minutes}:${whole.padStart(2, "0")}${fraction ? `.${fraction}` : ""}`;
}

function normalizeCopyStrategy(value: unknown): RemakeCopyStrategy {
    return value === "manual" ? "manual" : "keep";
}

function normalizeVoice(value: unknown): RemakeVoice {
    return value === "female" || value === "male" ? value : "source";
}

function normalizeAnalysisStatus(value: unknown): RemakeAnalysisStatus {
    const status = stringValue(value).toLowerCase();
    if (status === "pending" || status === "queued") return "queued";
    if (status === "running" || status === "processing") return "running";
    if (status === "success" || status === "completed" || status === "done") return "completed";
    if (status === "error" || status === "failed") return "error";
    return "idle";
}

function normalizeTaskStatus(value: unknown): RemakeTaskStatus {
    const status = stringValue(value).toLowerCase();
    if (status === "success" || status === "completed" || status === "done") return "success";
    if (status === "error" || status === "failed" || status === "cancelled") return "error";
    if (status === "running" || status === "processing") return "running";
    return "pending";
}

function normalizePipelineStepStatus(value: unknown): RemakePipelineStepStatus {
    const status = stringValue(value).toLowerCase();
    if (status === "queued") return "queued";
    if (status === "running" || status === "processing") return "running";
    if (status === "success" || status === "completed" || status === "done") return "completed";
    if (status === "error" || status === "failed" || status === "cancelled") return "error";
    return "pending";
}

function normalizeImageGenerationStatus(value: unknown): RemakeImageGenerationStatus {
    const status = stringValue(value).toLowerCase();
    if (status === "queued" || status === "pending") return "queued";
    if (status === "running" || status === "processing") return "running";
    if (status === "success" || status === "completed" || status === "done") return "completed";
    if (status === "error" || status === "failed" || status === "cancelled") return "error";
    return "idle";
}

function normalizePipelineStage(value: unknown, fallback: RemakePipelineStage): RemakePipelineStage {
    const stage = stringValue(value).toLowerCase();
    return stage === "upload" || stage === "analysis" || stage === "references" || stage === "images" || stage === "copy" || stage === "prompts" || stage === "prompts-ready" || stage === "ready" || stage === "failed" ? stage : fallback;
}

function normalizeAnalysisMode(value: unknown): RemakeAnalysisMode | undefined {
    const mode = stringValue(value).toLowerCase();
    if (mode === "video" || mode === "vision" || mode === "hybrid" || mode === "frames-only") return mode;
    if (mode === "frames_only" || mode === "frames") return "frames-only";
    return undefined;
}

function normalizeMediaAsset(value: unknown): RemakeMediaAsset | undefined {
    const source = record(value);
    const url = stringValue(firstDefined(source.url, source.src, source.mediaUrl, source.media_url, source.upstreamUrl));
    const storageKey = stringValue(firstDefined(source.storageKey, source.storage_key, source.key)) || undefined;
    const originalName = stringValue(firstDefined(source.originalName, source.original_name, source.name, source.fileName)) || undefined;
    if (!url && !storageKey && !originalName) return undefined;
    return {
        ...source,
        url,
        storageKey,
        mimeType: stringValue(firstDefined(source.mimeType, source.mime_type, source.type)) || undefined,
        originalName,
        bytes: numberValue(firstDefined(source.bytes, source.size), 0) || undefined,
        width: numberValue(source.width, 0) || undefined,
        height: numberValue(source.height, 0) || undefined,
    };
}

function normalizeSourceVideo(value: unknown): RemakeSourceVideo | undefined {
    const source = record(value);
    const media = normalizeMediaAsset(source);
    if (!media) return undefined;
    const durationMsValue = firstDefined(source.durationMs, source.duration_ms);
    const durationSeconds = firstDefined(source.duration, source.durationSeconds);
    return {
        ...media,
        durationMs: durationMsValue === undefined ? (durationSeconds === undefined ? undefined : Math.round(secondsValue(durationSeconds) * 1000)) : numberValue(durationMsValue, 0) || undefined,
        ratio: stringValue(firstDefined(source.ratio, source.aspectRatio, source.aspect_ratio)) || undefined,
    };
}

function normalizeFrame(value: unknown, index: number): RemakeFrame {
    const frame = record(value);
    const ordinal = Math.max(1, Math.round(numberValue(firstDefined(frame.ordinal, frame.order, frame.index), index + 1)));
    const time = secondsValue(firstDefined(frame.time, frame.startTime, frame.start_time, frame.timestamp), 0);
    const endTime = Math.max(time, secondsValue(firstDefined(frame.endTime, frame.end_time, frame.to), time));
    const subtitle = stringValue(firstDefined(frame.subtitle, frame.caption, frame.copy, frame.text));
    const sellingPoint = stringValue(firstDefined(frame.sellingPoint, frame.selling_point, frame.benefit, frame.highlight));
    const shotType = stringValue(firstDefined(frame.shotType, frame.shot_type, frame.type));
    const description = stringValue(firstDefined(frame.description, frame.visualDescription, frame.visual_description, frame.prompt));
    const explicitStatus = stringValue(firstDefined(frame.analysisStatus, frame.analysis_status)).toLowerCase();
    const analysisStatus = explicitStatus === "available" || explicitStatus === "success" || (!explicitStatus && Boolean(subtitle || sellingPoint || shotType || description)) ? "available" : "unavailable";
    return {
        ...frame,
        id: stringValue(firstDefined(frame.id, frame.frameId, frame.frame_id)) || `frame-${ordinal}`,
        ordinal,
        time,
        endTime,
        frameUrl: stringValue(firstDefined(frame.frameUrl, frame.frame_url, frame.imageUrl, frame.image_url, frame.url)),
        storageKey: stringValue(firstDefined(frame.storageKey, frame.storage_key, frame.key)) || undefined,
        analysisStatus,
        subtitle,
        sellingPoint,
        shotType,
        description,
        subjectRatio: stringValue(firstDefined(frame.subjectRatio, frame.subject_ratio, frame.subjectOccupancy, frame.subject_occupancy)),
        hasFace: booleanValue(firstDefined(frame.hasFace, frame.has_face, frame.faceDetected)),
    };
}

function normalizeCopyBlock(value: unknown, index: number): RemakeCopyBlock {
    const block = record(value);
    const ordinal = Math.max(1, Math.round(numberValue(firstDefined(block.ordinal, block.order, block.index), index + 1)));
    const rawOrdinals = arrayValue(firstDefined(block.frameOrdinals, block.frame_ordinals, block.frameRange, block.frame_range)).map((value) => Math.max(1, Math.round(numberValue(value, 1))));
    const fallbackStart = Math.max(1, Math.round(numberValue(firstDefined(block.startFrame, block.start_frame, block.startOrdinal), index * 3 + 1)));
    const frameOrdinals: [number, number, number] = [rawOrdinals[0] || fallbackStart, rawOrdinals[1] || fallbackStart + 1, rawOrdinals[2] || fallbackStart + 2];
    const startTime = secondsValue(firstDefined(block.startTime, block.start_time), 0);
    const endTime = Math.max(startTime, secondsValue(firstDefined(block.endTime, block.end_time), startTime));
    return {
        ...block,
        id: stringValue(firstDefined(block.id, block.blockId, block.block_id)) || `copy-block-${ordinal}`,
        ordinal,
        frameOrdinals,
        startTime,
        endTime,
        sourceText: stringValue(firstDefined(block.sourceText, block.source_text, block.originalText, block.original_text, block.sourceCopy)),
        text: stringValue(firstDefined(block.text, block.copy, block.content, block.optimizedText, block.optimized_text)),
    };
}

function normalizeReferences(value: unknown): RemakeReferenceAssets {
    const references = record(value);
    return {
        character: normalizeMediaAsset(firstDefined(references.character, references.characterImage, references.character_image)),
        characterSupplement: normalizeMediaAsset(firstDefined(references.characterSupplement, references.character_supplement, references.characterExtra, references.character_extra)),
        background: normalizeMediaAsset(firstDefined(references.background, references.backgroundImage, references.background_image)),
        audio: normalizeMediaAsset(firstDefined(references.audio, references.voiceAudio, references.voice_audio)),
    };
}

function normalizeGroups(value: unknown): RemakeRangeGroup[] {
    const incoming = arrayValue(value).map(record);
    return REMAKE_GROUP_DEFINITIONS.map((definition) => {
        const group = incoming.find((item) => stringValue(item.id) === definition.id || numberValue(item.ordinal) === definition.ordinal) || {};
        const generation = record(firstDefined(group.imageGeneration, group.image_generation, group.generation));
        return {
            id: definition.id,
            ordinal: definition.ordinal,
            frameOrdinals: Array.from({ length: 12 }, (_, index) => definition.start + index),
            sourceContactSheet: normalizeMediaAsset(firstDefined(group.sourceContactSheet, group.source_contact_sheet, group.sourceCollage, group.source_collage, group.contactSheet, group.contact_sheet)),
            imageGeneration: {
                status: normalizeImageGenerationStatus(firstDefined(generation.status, group.imageStatus, group.image_status)),
                taskId: stringValue(firstDefined(generation.taskId, generation.task_id, group.imageTaskId, group.image_task_id)) || undefined,
                prompt: stringValue(firstDefined(generation.prompt, group.imagePrompt, group.image_prompt)),
                result: normalizeMediaAsset(firstDefined(generation.result, generation.output, group.generatedImage, group.generated_image)),
                error: stringValue(firstDefined(generation.error, group.imageError, group.image_error)) || undefined,
            },
            videoPrompt: stringValue(firstDefined(group.videoPrompt, group.video_prompt, group.seedancePrompt, group.seedance_prompt)),
        };
    });
}

function normalizeSemanticCopy(value: unknown): RemakeSemanticCopy {
    const copy = record(value);
    const checks = record(copy.checks);
    const stats = record(copy.stats);
    return {
        status: normalizeImageGenerationStatus(copy.status),
        taskId: stringValue(firstDefined(copy.taskId, copy.task_id)) || undefined,
        optionRaw: stringValue(firstDefined(copy.optionRaw, copy.option_raw)),
        rawReport: stringValue(firstDefined(copy.rawReport, copy.raw_report, copy.report)),
        paragraphs: arrayValue(copy.paragraphs).flatMap((value, index) => {
            const paragraph = record(value);
            const text = stringValue(firstDefined(paragraph.text, paragraph.content));
            return text ? [{ ordinal: Math.max(1, Math.round(numberValue(paragraph.ordinal, index + 1))), text }] : [];
        }),
        mappings: arrayValue(copy.mappings).map((value, index) => {
            const mapping = record(value);
            return {
                blockOrdinal: Math.max(1, Math.round(numberValue(firstDefined(mapping.blockOrdinal, mapping.block_ordinal), index + 1))),
                paragraphOrdinals: arrayValue(firstDefined(mapping.paragraphOrdinals, mapping.paragraph_ordinals)).map((ordinal) => Math.max(1, Math.round(numberValue(ordinal, 1)))),
                sourceText: stringValue(firstDefined(mapping.sourceText, mapping.source_text)),
                text: stringValue(firstDefined(mapping.text, mapping.content)),
            };
        }),
        checks: {
            sequential: booleanValue(checks.sequential) ?? false,
            noDuplicates: booleanValue(firstDefined(checks.noDuplicates, checks.no_duplicates)) ?? false,
            noSkips: booleanValue(firstDefined(checks.noSkips, checks.no_skips)) ?? false,
        },
        stats: {
            paragraphCount: nonNegativeInteger(firstDefined(stats.paragraphCount, stats.paragraph_count)),
            unchangedBlocks: nonNegativeInteger(firstDefined(stats.unchangedBlocks, stats.unchanged_blocks)),
            completedBlocks: nonNegativeInteger(firstDefined(stats.completedBlocks, stats.completed_blocks)),
            correctedBlocks: nonNegativeInteger(firstDefined(stats.correctedBlocks, stats.corrected_blocks)),
            emptyBlocks: nonNegativeInteger(firstDefined(stats.emptyBlocks, stats.empty_blocks)),
        },
        error: stringValue(copy.error) || undefined,
    };
}

function normalizePipeline(value: unknown, input: { sourceVideo?: RemakeSourceVideo; analysis: RemakeAnalysis; references: RemakeReferenceAssets; groups: RemakeRangeGroup[]; copy: RemakeSemanticCopy }): RemakePipeline {
    const pipeline = record(value);
    const rawSteps = record(pipeline.steps);
    const referenceReady = Boolean(input.references.background?.url);
    const imagesReady = input.groups.every((group) => group.imageGeneration.status === "completed" && group.imageGeneration.result?.url);
    const promptsReady = input.groups.every((group) => group.videoPrompt.trim());
    const derivedStatuses: Record<RemakePipelineStepKey, RemakePipelineStepStatus> = {
        upload: input.sourceVideo?.url ? "completed" : "pending",
        analysis: input.analysis.status === "completed" ? "completed" : input.analysis.status === "queued" ? "queued" : input.analysis.status === "running" ? "running" : input.analysis.status === "error" ? "error" : "pending",
        references: referenceReady ? "completed" : "pending",
        images: imagesReady
            ? "completed"
            : input.groups.some((group) => group.imageGeneration.status === "running" || group.imageGeneration.status === "queued")
              ? "running"
              : input.groups.some((group) => group.imageGeneration.status === "error")
                ? "error"
                : "pending",
        copy: input.copy.status === "completed" ? "completed" : input.copy.status === "queued" ? "queued" : input.copy.status === "running" ? "running" : input.copy.status === "error" ? "error" : "pending",
        prompts: promptsReady ? "completed" : "pending",
    };
    const fallbackStage: RemakePipelineStage = !input.sourceVideo?.url
        ? "upload"
        : input.analysis.status !== "completed"
          ? "analysis"
          : !referenceReady
            ? "references"
            : !imagesReady
              ? "images"
              : input.copy.status !== "completed"
                ? "copy"
                : !promptsReady
                  ? "prompts"
                  : "ready";
    const steps = Object.fromEntries(
        (Object.keys(derivedStatuses) as RemakePipelineStepKey[]).map((key) => {
            const step = record(rawSteps[key]);
            return [
                key,
                {
                    status: Object.keys(step).length ? normalizePipelineStepStatus(step.status) : derivedStatuses[key],
                    taskId: stringValue(firstDefined(step.taskId, step.task_id)) || undefined,
                    error: stringValue(step.error) || undefined,
                },
            ];
        }),
    ) as Record<RemakePipelineStepKey, RemakePipelineStep>;
    return { stage: normalizePipelineStage(pipeline.stage, fallbackStage), steps };
}

function nonNegativeInteger(value: unknown) {
    return Math.max(0, Math.round(numberValue(value, 0)));
}

export function normalizeRemakeProject(value: unknown): RemakeProject {
    const outer = record(value);
    const snapshot = record(firstDefined(outer.projectJson, outer.project_json, outer.snapshot));
    const project = { ...snapshot, ...outer };
    const analysisRecord = record(firstDefined(project.analysis, project.analysisResult, project.analysis_result));
    const frames = arrayValue(firstDefined(project.frames, analysisRecord.frames, project.shots)).map(normalizeFrame);
    const copyBlocks = arrayValue(firstDefined(project.copyBlocks, project.copy_blocks, project.scriptBlocks, project.script_blocks, project.segments)).map(normalizeCopyBlock);
    const sourceVideo = normalizeSourceVideo(firstDefined(project.sourceVideo, project.source_video, project.video, project.source));
    const references = normalizeReferences(firstDefined(project.references, project.referenceAssets, project.reference_assets));
    const groups = normalizeGroups(firstDefined(project.groups, project.rangeGroups, project.range_groups));
    const copy = normalizeSemanticCopy(firstDefined(project.copy, project.copyReport, project.copy_report));
    const analysis: RemakeAnalysis = {
        status: normalizeAnalysisStatus(firstDefined(analysisRecord.status, project.analysisStatus, project.analysis_status)),
        taskId: stringValue(firstDefined(analysisRecord.taskId, analysisRecord.task_id, project.analysisTaskId, project.analysis_task_id)) || undefined,
        runId: stringValue(firstDefined(analysisRecord.runId, analysisRecord.run_id)) || undefined,
        mode: normalizeAnalysisMode(firstDefined(analysisRecord.mode, analysisRecord.analysisMode, project.analysisMode, project.analysis_mode)),
        warning: stringValue(firstDefined(analysisRecord.warning, project.analysisWarning, project.analysis_warning)) || undefined,
        error: stringValue(firstDefined(analysisRecord.error, project.analysisError, project.analysis_error)) || undefined,
        raw: stringValue(firstDefined(analysisRecord.raw, analysisRecord.rawReport, analysisRecord.raw_report)) || undefined,
        timestamps: arrayValue(firstDefined(analysisRecord.timestamps, project.timestamps)).map((timestamp) => secondsValue(timestamp)),
    };
    return {
        ...project,
        id: stringValue(firstDefined(project.id, project.projectId, project.project_id)),
        title: stringValue(firstDefined(project.title, project.name), "未命名复刻项目"),
        status: project.status === "archived" ? "archived" : "active",
        revision: Math.max(0, Math.round(numberValue(firstDefined(project.revision, project.version), 0))),
        sourceVideo,
        sourceCopy: stringValue(firstDefined(project.sourceCopy, project.source_copy, project.sourceTranscript, project.source_transcript, project.originalCopy, project.original_copy, project.transcript)),
        copyStrategy: normalizeCopyStrategy(firstDefined(project.copyStrategy, project.copy_strategy)),
        voice: normalizeVoice(firstDefined(project.voice, project.voiceType, project.voice_type)),
        analysis,
        pipeline: normalizePipeline(firstDefined(project.pipeline, project.workflow), { sourceVideo, analysis, references, groups, copy }),
        references,
        groups,
        copy,
        frames,
        copyBlocks,
        createdAt: stringValue(firstDefined(project.createdAt, project.created_at)),
        updatedAt: stringValue(firstDefined(project.updatedAt, project.updated_at)),
    };
}

export function normalizeRemakeProjectList(value: unknown): RemakeProjectList {
    const payload = record(value);
    const values = Array.isArray(value) ? value : arrayValue(firstDefined(payload.projects, payload.items, payload.records));
    const projects = values.map(normalizeRemakeProjectSummary).filter((project) => project.id);
    return {
        projects,
        total: Math.max(projects.length, Math.round(numberValue(firstDefined(payload.total, payload.count), projects.length))),
        page: Math.max(1, Math.round(numberValue(payload.page, 1))),
        pageSize: Math.max(1, Math.round(numberValue(firstDefined(payload.pageSize, payload.page_size, payload.limit), Math.max(12, projects.length)))),
    };
}

export function normalizeRemakeProjectSummary(value: unknown): RemakeProjectSummary {
    const summary = record(value);
    const analysis = record(summary.analysis);
    const fullFrames = arrayValue(summary.frames);
    return {
        id: stringValue(firstDefined(summary.id, summary.projectId, summary.project_id)),
        title: stringValue(firstDefined(summary.title, summary.name), "未命名复刻项目"),
        status: summary.status === "archived" ? "archived" : "active",
        revision: Math.max(0, Math.round(numberValue(firstDefined(summary.revision, summary.version), 0))),
        sourceVideoUrl: stringValue(firstDefined(summary.sourceVideoUrl, summary.source_video_url, record(summary.sourceVideo).url, record(summary.source_video).url)) || undefined,
        analysisStatus: normalizeAnalysisStatus(firstDefined(summary.analysisStatus, summary.analysis_status, analysis.status)),
        analysisMode: normalizeAnalysisMode(firstDefined(summary.analysisMode, summary.analysis_mode, summary.mode, analysis.mode)),
        frameCount: Math.max(0, Math.round(numberValue(firstDefined(summary.frameCount, summary.frame_count), fullFrames.length))),
        createdAt: stringValue(firstDefined(summary.createdAt, summary.created_at)),
        updatedAt: stringValue(firstDefined(summary.updatedAt, summary.updated_at)),
    };
}

export function normalizeRemakeTask(value: unknown): RemakeTask {
    const task = record(value);
    return {
        id: stringValue(firstDefined(task.id, task.taskId, task.task_id)),
        projectId: stringValue(firstDefined(task.projectId, task.project_id)),
        status: normalizeTaskStatus(task.status),
        progress: Math.min(100, Math.max(0, Math.round(numberValue(task.progress, 0)))),
        stage: stringValue(firstDefined(task.stage, task.phase), "等待处理"),
        error: stringValue(firstDefined(task.error, task.message)) || undefined,
        createdAt: stringValue(firstDefined(task.createdAt, task.created_at)),
        updatedAt: stringValue(firstDefined(task.updatedAt, task.updated_at)),
    };
}

export function editableProjectPatch(project: RemakeProject): RemakeEditablePatch {
    return {
        title: project.title,
        sourceVideo: project.sourceVideo,
        sourceCopy: project.sourceCopy,
        copyStrategy: project.copyStrategy,
        voice: project.voice,
        references: project.references,
        groups: project.groups,
        frames: project.frames,
        copyBlocks: project.copyBlocks,
    };
}
