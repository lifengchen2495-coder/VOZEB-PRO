import type { LogicalModelCapabilityProfile, SystemChannelModelConfig } from "@/lib/auth/store-types";
import type { VideoGenerationReference } from "@/lib/video-reference-contract";

// 参数来源：https://huifengai.com/apidoc，核对日期：2026-09-08。
export const HUIFENG_BASE_URL = "https://api.lk888.ai";
export const HUIFENG_CREATE_PATH = "/v1/media/generate";
export const HUIFENG_QUERY_PATH = "/v1/media/status?task_id=:task_id";
export const HUIFENG_OMNI_EDIT_MODEL = "kling-v3-omni-videoref";

const videoOperation = {
    capability: "video",
    protocol: "huifeng",
    apiFormat: "openai",
    createPath: HUIFENG_CREATE_PATH,
    imageToVideoPath: HUIFENG_CREATE_PATH,
    queryPath: HUIFENG_QUERY_PATH,
    resultField: "result_url",
    statusField: "state",
    supportsReferenceImage: true,
    supportsReferenceVideo: false,
    supportsReferenceAudio: false,
} as const satisfies SystemChannelModelConfig;

export const HUIFENG_DEFAULT_VIDEO_OPERATION: SystemChannelModelConfig = {
    ...videoOperation,
    requestTemplate: '{"model":"{{model}}","prompt":"{{prompt}}","params":{"images":"{{images}}","aspect_ratio":"{{aspect_ratio}}"}}',
    durationRange: "10 秒",
    referenceRule: "Omni Flash 固定生成 10 秒 720P；支持最多 7 张参考图片，不支持参考视频、音频或首尾帧。多图可用数量受汇风上游渠道限制。",
};

export const HUIFENG_VIDEO_MODELS = [
    { id: "omni_flash-10s", label: "Omni Flash 10 秒", capability: "video" as const, operation: HUIFENG_DEFAULT_VIDEO_OPERATION },
    {
        id: "omni-1.1",
        label: "Omni 1.1",
        capability: "video" as const,
        operation: {
            ...videoOperation,
            requestTemplate: '{"model":"{{model}}","prompt":"{{prompt}}","params":{"images":["{{first_frame}}"],"aspect_ratio":"{{aspect_ratio}}","duration":"{{duration}}","resolution":"{{resolution}}"}}',
            durationRange: "3-10 秒",
            referenceRule: "可选 1 张首帧图片，支持 3–10 秒及 720P／1080P／4K；不支持参考视频、音频或尾帧。",
        },
    },
    {
        id: HUIFENG_OMNI_EDIT_MODEL,
        label: "可灵 Omni 视频编辑",
        capability: "video" as const,
        operation: {
            ...videoOperation,
            requestTemplate: '{"model":"{{model}}","prompt":"{{prompt}}","params":{"video":"{{video}}","images":"{{images}}","refer_type":"base","mode":"std"}}',
            durationRange: "3-10 秒",
            referenceRule: "编辑原视频：必传 1 段 3–10 秒、宽度至少 700px、最大 100MB 的 MP4／MOV 公网视频；可选最多 4 张图片。输出时长、画幅和原声跟随输入视频，不发送 duration、aspect_ratio 或 keep_original_sound。",
            supportsReferenceVideo: true,
        },
    },
] satisfies Array<{ id: string; label: string; capability: "video"; operation: SystemChannelModelConfig }>;

export function huifengVideoCapabilityProfile(model: string): LogicalModelCapabilityProfile | undefined {
    if (!HUIFENG_VIDEO_MODELS.some((entry) => entry.id === model)) return undefined;
    const common = { supportsReferenceImage: true, supportsReferenceAudio: false, supportsAsync: true, supportsCancel: false, maxBatchSize: 1 };
    if (model === "omni_flash-10s") return { ...common, supportsReferenceVideo: false, maxReferenceImages: 7, aspectRatios: ["16:9", "9:16"], resolutions: ["720p"], durationSeconds: [10], minDurationSeconds: 10, maxDurationSeconds: 10 };
    if (model === "omni-1.1") return { ...common, supportsReferenceVideo: false, maxReferenceImages: 1, aspectRatios: ["16:9", "9:16"], resolutions: ["720p", "1080p", "4k"], durationSeconds: [3, 4, 5, 6, 7, 8, 9, 10], minDurationSeconds: 3, maxDurationSeconds: 10 };
    return { ...common, supportsReferenceVideo: true, maxReferenceImages: 4, minDurationSeconds: 3, maxDurationSeconds: 10, durationSeconds: undefined, aspectRatios: undefined, resolutions: undefined };
}

export function assertHuifengVideoReferences(model: string, references: readonly VideoGenerationReference[]) {
    const profile = huifengVideoCapabilityProfile(model);
    if (!profile) throw new Error("当前模型不在已接入的汇风 Omni 模型列表中");
    const images = references.filter((item) => item.type === "image");
    const videos = references.filter((item) => item.type === "video");
    if (references.some((item) => item.type === "audio")) throw new Error("此汇风 Omni 模型不支持参考音频");
    if (images.length > profile.maxReferenceImages!) throw new Error(`当前汇风 Omni 模型最多支持 ${profile.maxReferenceImages} 张参考图片`);
    if (references.some((item) => item.role && item.role !== "reference" && !(model === "omni-1.1" && item.type === "image" && item.role === "first_frame"))) throw new Error("当前汇风 Omni 模型不支持所选首尾帧角色");
    if (model === HUIFENG_OMNI_EDIT_MODEL ? videos.length !== 1 : videos.length > 0) throw new Error(model === HUIFENG_OMNI_EDIT_MODEL ? "可灵 Omni 视频编辑必须提供 1 段参考视频" : "Omni Flash／Omni 1.1 不支持参考视频，请使用图片生成视频");
}

export function buildHuifengVideoRequest(input: { model: string; prompt: string; duration: number; aspectRatio: string; resolution: string; references: readonly VideoGenerationReference[] }) {
    assertHuifengVideoReferences(input.model, input.references);
    const images = input.references.filter((item) => item.type === "image").map((item) => item.url);
    const profile = huifengVideoCapabilityProfile(input.model)!;
    if (!Number.isFinite(input.duration) || input.duration < profile.minDurationSeconds! || input.duration > profile.maxDurationSeconds!) throw new Error(`当前汇风 Omni 模型时长需要在 ${profile.minDurationSeconds}–${profile.maxDurationSeconds} 秒之间`);
    if (input.model === HUIFENG_OMNI_EDIT_MODEL) {
        return { model: input.model, prompt: input.prompt, params: { video: input.references.find((item) => item.type === "video")!.url, images, refer_type: "base", mode: "std" } };
    }
    if (!profile.aspectRatios!.includes(input.aspectRatio)) throw new Error("此汇风 Omni 模型仅支持 16:9 或 9:16");
    const resolution = input.resolution.toLowerCase();
    if (!profile.resolutions!.includes(resolution)) throw new Error(`此汇风 Omni 模型不支持 ${input.resolution} 清晰度`);
    if (profile.durationSeconds && !profile.durationSeconds.includes(input.duration)) throw new Error("此汇风 Omni 模型不支持所选时长");
    const params = { ...(images.length ? { images } : {}), aspect_ratio: input.aspectRatio };
    return { model: input.model, prompt: input.prompt, params: input.model === "omni-1.1" ? { ...params, duration: String(input.duration), resolution: resolution.toUpperCase() } : params };
}
