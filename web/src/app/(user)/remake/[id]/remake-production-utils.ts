import type { ImageGenerationResult } from "@/services/api/image";
import { REMAKE_IMAGE_PROMPT, remakeImagePromptReferences } from "@/lib/remake-image-prompt";
import { parseServerMediaUrl } from "@/services/server-media-storage";
import type { ReferenceImage } from "@/types/image";

import { isRemakeNoNarrationCopy, type RemakeMediaAsset, type RemakeProject, type RemakeRangeGroup, type RemakeReferenceAssets } from "../remake-contract";

export function buildRemakeImagePrompt(group: RemakeRangeGroup, references: RemakeReferenceAssets) {
    void group;
    void references;
    return REMAKE_IMAGE_PROMPT;
}

export function remakeGroupReferenceImages(group: RemakeRangeGroup, references: RemakeReferenceAssets): ReferenceImage[] {
    return orderedReferenceAssets(group, references).map(({ key, label, asset }) => mediaAssetReferenceImage(`${group.id}-${key}`, label, asset));
}

export function imageGenerationResultAsset(result: ImageGenerationResult): RemakeMediaAsset | undefined {
    const url = [result.serverUrl, result.remoteUrl, result.dataUrl].find((value) => value && !value.startsWith("data:") && !value.startsWith("blob:"));
    if (!url) return undefined;
    const reference = parseServerMediaUrl(url);
    return {
        url: reference?.url || url,
        storageKey: reference?.storageKey,
        mimeType: result.mimeType || "image/png",
        bytes: positiveNumber(result.bytes),
        width: positiveNumber(result.width),
        height: positiveNumber(result.height),
        originalName: `remake-${Date.now()}.png`,
    };
}

export function remakeReferencesReady(project: Pick<RemakeProject, "references">) {
    return Boolean(project.references.background?.url);
}

export function remakeImagesReady(project: Pick<RemakeProject, "groups">) {
    return project.groups.length === 4 && project.groups.every((group) => group.imageGeneration.status === "completed" && group.imageGeneration.result?.url);
}

export function remakeProductionReady(project: Pick<RemakeProject, "sourceVideo" | "sourceCopy" | "analysis" | "frames" | "copyBlocks" | "references" | "groups" | "copy" | "voice">) {
    const noNarration = isRemakeNoNarrationCopy(project.sourceCopy);
    const analysisReady =
        Boolean(project.sourceVideo?.url) &&
        project.analysis.status === "completed" &&
        project.analysis.mode === "video" &&
        project.frames.length === 48 &&
        project.frames.every((frame, index) => frame.ordinal === index + 1 && frame.analysisStatus === "available" && Boolean(frame.frameUrl));
    const copyReady =
        project.copy.status === "completed" &&
        project.copy.checks.sequential &&
        project.copy.checks.noDuplicates &&
        project.copy.checks.noSkips &&
        Boolean(project.copy.rawReport.trim()) &&
        project.copyBlocks.length === 16 &&
        project.copyBlocks.every((block, index) => block.ordinal === index + 1 && (noNarration ? !block.sourceText.trim() && !block.text.trim() : Boolean(block.sourceText.trim() && block.text.trim())));
    const referencesReady = Boolean(project.references.background?.url && (noNarration || project.references.audio?.url));
    const promptsReady = project.groups.length === 4 && project.groups.every((group, index) => group.ordinal === index + 1 && Boolean(group.sourceContactSheet?.url && group.videoPrompt.trim()));
    const voiceReady = noNarration || project.voice === "female" || project.voice === "male";
    return analysisReady && copyReady && referencesReady && remakeImagesReady(project) && promptsReady && voiceReady;
}

function orderedReferenceAssets(group: RemakeRangeGroup, references: RemakeReferenceAssets) {
    return remakeImagePromptReferences({ sourceContactSheet: group.sourceContactSheet, character: references.character, background: references.background });
}

function mediaAssetReferenceImage(id: string, name: string, asset: RemakeMediaAsset): ReferenceImage {
    return {
        id,
        name: asset.originalName || `${name}.png`,
        type: asset.mimeType || "image/png",
        dataUrl: asset.url,
        url: asset.url,
        storageKey: asset.storageKey,
        width: asset.width,
        height: asset.height,
        ...(asset.url.startsWith("/") ? { serverUrl: asset.url } : /^https?:\/\//i.test(asset.url) ? { remoteUrl: asset.url } : {}),
    };
}

function positiveNumber(value: unknown) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : undefined;
}
