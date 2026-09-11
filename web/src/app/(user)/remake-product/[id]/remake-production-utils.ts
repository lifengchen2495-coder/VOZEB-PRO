import type { ImageGenerationResult } from "@/services/api/image";
import { remakeReplacementPrompt, remakeReplacementPromptReferences, remakeStoryboardPrompt, remakeStoryboardPromptReferences } from "@/lib/remake-product-image-prompt";
import { parseServerMediaUrl } from "@/services/server-media-storage";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio } from "@/types/media";

import { isRemakeNoNarrationCopy, type RemakeMediaAsset, type RemakeProject, type RemakeRangeGroup, type RemakeReferenceAssets } from "../remake-contract";

export function buildRemakeReplacementPrompt(project: Pick<RemakeProject, "frames">, group: RemakeRangeGroup) {
    return remakeReplacementPrompt(group.id, project.frames);
}

export function remakeReplacementReferenceImages(group: RemakeRangeGroup): ReferenceImage[] {
    return remakeReplacementPromptReferences({ sourceContactSheet: group.sourceContactSheet }).map(({ key, label, asset }) => mediaAssetReferenceImage(`${group.id}-${key}`, label, asset));
}

export function buildRemakeImagePrompt(project: Pick<RemakeProject, "frames" | "productInfo">, group: RemakeRangeGroup) {
    return remakeStoryboardPrompt(group.id, project.frames, project.productInfo);
}

export function remakeGroupReferenceImages(group: RemakeRangeGroup, references: RemakeReferenceAssets): ReferenceImage[] {
    return remakeStoryboardPromptReferences({ replacementContactSheet: group.replacementGeneration.result, product: references.product }).map(({ key, label, asset }) => mediaAssetReferenceImage(`${group.id}-${key}`, label, asset));
}

export function remakeVideoReferenceImages(group: RemakeRangeGroup, references: RemakeReferenceAssets): ReferenceImage[] {
    return [
        group.imageGeneration.result ? mediaAssetReferenceImage(`${group.id}-storyboard`, `分镜 ${group.id} 最终十二宫格`, group.imageGeneration.result) : null,
        references.product ? mediaAssetReferenceImage(`${group.id}-product`, "产品图", references.product) : null,
    ].filter((item): item is ReferenceImage => Boolean(item));
}

export function remakeVideoAudioReferences(project: Pick<RemakeProject, "references" | "sourceCopy">): ReferenceAudio[] {
    const audio = project.references.audio;
    if (!audio || isRemakeNoNarrationCopy(project.sourceCopy)) return [];
    return [{ id: "remake-source-audio", name: audio.originalName || "参考音色.aac", type: audio.mimeType || "audio/aac", url: audio.url, storageKey: audio.storageKey }];
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
    return Boolean(project.references.product?.url);
}

export function remakeImagesReady(project: Pick<RemakeProject, "groups">) {
    return project.groups.length === 4 && project.groups.every((group) => group.replacementGeneration.status === "completed" && group.replacementGeneration.result?.url && group.imageGeneration.status === "completed" && group.imageGeneration.result?.url);
}

export function remakeVideosReady(project: Pick<RemakeProject, "groups">) {
    return project.groups.length === 4 && project.groups.every((group) => group.videoGeneration.status === "completed" && group.videoGeneration.result?.url);
}

export function remakeProductionReady(project: Pick<RemakeProject, "sourceVideo" | "sourceCopy" | "productInfo" | "analysis" | "frames" | "copyBlocks" | "references" | "groups" | "copy" | "voice">) {
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
    const referencesReady = Boolean(project.references.product?.url && (noNarration || project.references.audio?.url));
    const promptsReady = project.groups.length === 4 && project.groups.every((group, index) => group.ordinal === index + 1 && Boolean(group.sourceContactSheet?.url && group.videoPrompt.trim()));
    const voiceReady = noNarration || project.voice === "female" || project.voice === "male";
    return Boolean(project.productInfo.trim()) && analysisReady && copyReady && referencesReady && remakeImagesReady(project) && promptsReady && voiceReady && remakeVideosReady(project);
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
