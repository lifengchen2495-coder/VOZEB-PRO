export type OmniClothingAsset = {
    url: string;
    storageKey: string;
    name: string;
    mimeType: string;
    bytes: number;
    durationSeconds?: number;
    width?: number;
    height?: number;
};

export type OmniClothingSegment = {
    id: string;
    index: number;
    startSeconds: number;
    endSeconds: number;
    durationSeconds: number;
    generationDurationSeconds: number;
    boundary: "scene" | "duration" | "manual" | "end";
    sourceVideo: OmniClothingAsset;
    prompt: string;
    inputVersion: number;
    attemptNo: number;
    clientRequestId?: string;
    attemptStartedAt?: string;
    videoTaskId?: string;
    videoStatus: "idle" | "submitting" | "running" | "success" | "error";
    videoUrl?: string;
    error?: string;
};

export type OmniClothingProject = {
    id: string;
    title: string;
    status: "draft" | "ready" | "generating" | "completed" | "error";
    revision: number;
    inputVersion: number;
    createdAt: string;
    updatedAt: string;
    sourceVideo?: OmniClothingAsset;
    referenceImages: OmniClothingAsset[];
    garmentDescription: string;
    audioStrategy: "preserve" | "mute";
    model: string;
    maxSegmentSeconds: number;
    segments: OmniClothingSegment[];
    mergedVideo?: OmniClothingAsset;
    operation?: { id: string; kind: "split" | "merge"; startedAt: string; inputVersion: number };
    error?: string;
};

export type OmniClothingProjectSummary = Pick<OmniClothingProject, "id" | "title" | "status" | "createdAt" | "updatedAt"> & { segmentCount: number; completedCount: number; thumbnailUrl?: string };
export type OmniClothingProjectSummaryPage = { items: OmniClothingProjectSummary[]; total: number; page: number; pageSize: number };

export function summarizeOmniClothingProject(project: OmniClothingProject): OmniClothingProjectSummary {
    return {
        id: project.id,
        title: project.title,
        status: project.status,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        segmentCount: project.segments.length,
        completedCount: project.segments.filter((segment) => segment.videoStatus === "success").length,
        thumbnailUrl: project.referenceImages[0]?.url,
    };
}

export const OMNI_CLOTHING_REFERENCE_MIN = 4;
export const OMNI_CLOTHING_REFERENCE_MAX = 5;
export const OMNI_CLOTHING_SOURCE = { baseToken: "ScUYbyoAbaJptZsnuTbcg6WwnN3", tableId: "tblTb6y4DGpl59hb", documentId: "FPORd1Dcyoh3vExp4Qicjfminve" } as const;

export function omniClothingStatusLabel(status: OmniClothingProject["status"]) {
    return { draft: "待准备素材", ready: "待生成视频", generating: "视频生成中", completed: "已完成", error: "需要处理" }[status];
}
