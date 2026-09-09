type MediaInput = {
    url: string;
    storageKey?: string;
    mimeType?: string;
    originalName?: string;
    width?: number;
    height?: number;
};

type GenerationInput = {
    status: string;
    taskId?: string | null;
    model?: string | null;
    prompt?: string;
    attemptNo?: number;
    needsReview?: boolean;
    result?: MediaInput | null;
};

export type RemakeProductionInputProject = {
    id: string;
    sourceVideo?: MediaInput & { durationMs?: number };
    sourceCopy: string;
    copyStrategy: string;
    voice: string;
    analysis: { status: string; taskId?: string; runId?: string; mode?: string };
    modelSelection: { prompt: string; image: string };
    frames: Array<{
        ordinal: number; time: number; endTime: number; frameUrl: string; analysisStatus: string;
        subtitle: string; sellingPoint: string; shotType: string; description: string; subjectRatio: string; hasFace?: boolean;
    }>;
    copyBlocks: Array<{ ordinal: number; frameOrdinals: number[]; sourceText: string; text: string }>;
    copy: {
        status: string;
        optionRaw: string;
        paragraphs: Array<{ ordinal: number; text: string }>;
        mappings: Array<{ blockOrdinal: number; paragraphOrdinals: number[]; sourceText: string; text: string }>;
        checks: { sequential: boolean; noDuplicates: boolean; noSkips: boolean };
    };
    references: { product?: MediaInput; character?: MediaInput; characterSupplement?: MediaInput; audio?: MediaInput };
    groups: Array<{
        id: string; ordinal: number; frameOrdinals: number[]; sourceContactSheet?: MediaInput;
        replacementGeneration: GenerationInput; imageGeneration: GenerationInput;
        videoPromptInstructions?: string; videoPrompt: string; videoGeneration: GenerationInput;
    }>;
};

export function remakeProductionInputSnapshot(project: RemakeProductionInputProject, groupIds?: readonly string[]): string {
    const selected = groupIds === undefined ? undefined : new Set(groupIds);
    return JSON.stringify({
        id: project.id,
        sourceVideo: { asset: mediaInput(project.sourceVideo), durationMs: project.sourceVideo?.durationMs ?? null },
        sourceCopy: project.sourceCopy,
        copyStrategy: project.copyStrategy,
        voice: project.voice,
        analysis: { status: project.analysis.status, taskId: project.analysis.taskId || "", runId: project.analysis.runId || "", mode: project.analysis.mode || "" },
        modelSelection: { prompt: project.modelSelection.prompt, image: project.modelSelection.image },
        frames: project.frames.map((frame) => ({
            ordinal: frame.ordinal, time: frame.time, endTime: frame.endTime, frameUrl: frame.frameUrl, analysisStatus: frame.analysisStatus,
            subtitle: frame.subtitle, sellingPoint: frame.sellingPoint, shotType: frame.shotType, description: frame.description, subjectRatio: frame.subjectRatio, hasFace: frame.hasFace ?? null,
        })),
        copyBlocks: project.copyBlocks.map((block) => ({ ordinal: block.ordinal, frameOrdinals: block.frameOrdinals, sourceText: block.sourceText, text: block.text })),
        copy: {
            status: project.copy.status,
            optionRaw: project.copy.optionRaw,
            paragraphs: project.copy.paragraphs.map((paragraph) => ({ ordinal: paragraph.ordinal, text: paragraph.text })),
            mappings: project.copy.mappings.map((mapping) => ({ blockOrdinal: mapping.blockOrdinal, paragraphOrdinals: mapping.paragraphOrdinals, sourceText: mapping.sourceText, text: mapping.text })),
            checks: { sequential: project.copy.checks.sequential, noDuplicates: project.copy.checks.noDuplicates, noSkips: project.copy.checks.noSkips },
        },
        references: {
            product: mediaInput(project.references.product), character: mediaInput(project.references.character),
            characterSupplement: mediaInput(project.references.characterSupplement), audio: mediaInput(project.references.audio),
        },
        groups: project.groups.map((group) => ({
            id: group.id, ordinal: group.ordinal, frameOrdinals: group.frameOrdinals,
            sourceContactSheet: mediaInput(group.sourceContactSheet),
            replacementGeneration: generationInput(group.replacementGeneration),
            imageGeneration: generationInput(group.imageGeneration),
            ...(selected === undefined || selected.has(group.id) ? { videoPromptInstructions: group.videoPromptInstructions?.trim() || "", videoPrompt: group.videoPrompt, videoGeneration: generationInput(group.videoGeneration) } : {}),
        })),
    });
}

function mediaInput(asset?: MediaInput | null) {
    if (!asset) return null;
    return { url: asset.url, storageKey: asset.storageKey || "", mimeType: asset.mimeType || "", originalName: asset.originalName || "", width: asset.width ?? null, height: asset.height ?? null };
}

function generationInput(generation: GenerationInput) {
    return {
        status: generation.status, taskId: generation.taskId || "", model: generation.model || "", prompt: generation.prompt || "",
        attemptNo: generation.attemptNo ?? 0, needsReview: generation.needsReview === true, result: mediaInput(generation.result),
    };
}
