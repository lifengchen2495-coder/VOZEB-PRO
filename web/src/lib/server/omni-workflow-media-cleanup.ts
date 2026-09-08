import type { OmniProject } from "@/lib/omni-remake-contract";
import type { OmniClothingProject } from "@/lib/omni-clothing-contract";
import { containsUserMediaReference } from "./user-media-reference-cleanup";

// 两种 Omni 项目的媒体合同不同，分别使对应下游失效。
export function cleanOmniWorkflowMediaReferences<T extends OmniProject | OmniClothingProject>(project: T, keys: string[]): { value: T; changed: boolean } {
    if (!containsUserMediaReference(project, keys)) return { value: project, changed: false };
    const removed = (value: unknown) => containsUserMediaReference(value, keys);
    const sourceRemoved = removed(project.sourceVideo);
    const updatedAt = new Date(Math.max(Date.now(), Date.parse(project.updatedAt) + 1)).toISOString();
    if ("references" in project) {
        const inputRemoved = removed(project.references);
        const clipRemoved = project.segments.some((segment) => removed(segment.sourceClip));
        const references = {
            product: project.references.product.filter((asset) => !removed(asset)),
            character: project.references.character.filter((asset) => !removed(asset)),
            background: project.references.background.filter((asset) => !removed(asset)),
        };
        const invalidatePlan = sourceRemoved || inputRemoved || clipRemoved;
        return {
            changed: true,
            value: {
                ...project,
                revision: project.revision + 1,
                updatedAt,
                sourceVideo: sourceRemoved ? undefined : project.sourceVideo,
                references,
                operation: undefined,
                mergedVideo: undefined,
                error: "项目媒体已从素材库删除，请重新准备对应步骤",
                analysisRaw: sourceRemoved ? "" : project.analysisRaw,
                analysisSummary: sourceRemoved ? "" : project.analysisSummary,
                materialAnalysis: invalidatePlan ? "" : project.materialAnalysis,
                plan: invalidatePlan ? "" : project.plan,
                segments: sourceRemoved
                    ? []
                    : project.segments.map((segment) => ({
                          ...segment,
                          sourceClip: invalidatePlan ? undefined : segment.sourceClip,
                          prompt: invalidatePlan ? "" : segment.prompt,
                          promptZh: invalidatePlan ? "" : segment.promptZh,
                          video: invalidatePlan || removed(segment.video.result) ? { status: "idle", attemptNo: segment.video.attemptNo + 1 } : segment.video,
                      })),
            } as T,
        };
    }
    const inputRemoved = removed(project.referenceImages);
    const clipRemoved = project.segments.some((segment) => removed(segment.sourceVideo));
    const invalidSegments = sourceRemoved || inputRemoved || clipRemoved;
    return {
        changed: true,
        value: {
            ...project,
            revision: project.revision + 1,
            inputVersion: invalidSegments ? project.inputVersion + 1 : project.inputVersion,
            updatedAt,
            sourceVideo: sourceRemoved ? undefined : project.sourceVideo,
            referenceImages: project.referenceImages.filter((asset) => !removed(asset)),
            operation: undefined,
            mergedVideo: undefined,
            status: invalidSegments ? "draft" : "ready",
            error: "项目媒体已从素材库删除，请重新准备对应步骤",
            segments: invalidSegments
                ? []
                : project.segments.map((segment) => (removed(segment.videoUrl) ? { ...segment, videoStatus: "idle", videoUrl: undefined, videoTaskId: undefined, clientRequestId: undefined, attemptNo: segment.attemptNo + 1, error: undefined } : segment)),
        } as T,
    };
}
