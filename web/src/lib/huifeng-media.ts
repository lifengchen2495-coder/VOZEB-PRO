import type { LogicalModelCapabilityProfile, SystemChannelModelConfig } from "@/lib/auth/store-types";
import type { VideoGenerationReference } from "@/lib/video-reference-contract";

// 参数来源：https://huifengai.com/apidoc；Omni 核对于 2026-09-08，H3 按用户提供的站内文档于 2026-09-20 核对。
export const HUIFENG_BASE_URL = "https://api.lk888.ai";
export const HUIFENG_CREATE_PATH = "/v1/media/generate";
export const HUIFENG_QUERY_PATH = "/v1/media/status?task_id=:task_id";
export const HUIFENG_OMNI_EDIT_MODEL = "kling-v3-omni-videoref";
export const HUIFENG_MINIMAX_H3_MODEL = "minimax-h3";

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
        id: HUIFENG_MINIMAX_H3_MODEL,
        label: "MiniMax H3",
        capability: "video" as const,
        operation: {
            ...videoOperation,
            requestTemplate:
                '{"model":"{{model}}","prompt":"{{prompt}}","params":{"mode":"cankaosheng","image_url":"{{images}}","video_url":"{{videos}}","audio_url":"{{audios}}","aspect_ratio":"{{aspect_ratio}}","duration":"{{duration}}","resolution":"{{resolution}}"}}',
            durationRange: "4-15 秒",
            referenceRule:
                "文生、首帧／首尾帧与多模态参考生视频。首尾帧模式最多 2 张图片，与普通参考素材互斥；参考生模式最多 9 张图片、3 个视频、3 段音频，可任意组合或仅用音频。支持自适应画幅及 768P／1080P／2K／4K，有声输出；参考视频按时长增加上游费用，音频仅作节奏／风格参考，不保留原声、不做对口型。",
            supportsReferenceVideo: true,
            supportsReferenceAudio: true,
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
    if (model === HUIFENG_MINIMAX_H3_MODEL)
        return {
            ...common,
            supportsReferenceVideo: true,
            supportsReferenceAudio: true,
            maxReferenceImages: 9,
            aspectRatios: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"],
            resolutions: ["768p", "1080p", "2k", "4k"],
            durationSeconds: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
            minDurationSeconds: 4,
            maxDurationSeconds: 15,
        };
    if (model === "omni_flash-10s") return { ...common, supportsReferenceVideo: false, maxReferenceImages: 7, aspectRatios: ["16:9", "9:16"], resolutions: ["720p"], durationSeconds: [10], minDurationSeconds: 10, maxDurationSeconds: 10 };
    if (model === "omni-1.1")
        return { ...common, supportsReferenceVideo: false, maxReferenceImages: 1, aspectRatios: ["16:9", "9:16"], resolutions: ["720p", "1080p", "4k"], durationSeconds: [3, 4, 5, 6, 7, 8, 9, 10], minDurationSeconds: 3, maxDurationSeconds: 10 };
    return { ...common, supportsReferenceVideo: true, maxReferenceImages: 4, minDurationSeconds: 3, maxDurationSeconds: 10, durationSeconds: undefined, aspectRatios: undefined, resolutions: undefined };
}

export function assertHuifengVideoReferences(model: string, references: readonly VideoGenerationReference[]) {
    if (model === HUIFENG_MINIMAX_H3_MODEL) return assertMiniMaxH3References(references);
    const profile = huifengVideoCapabilityProfile(model);
    if (!profile) throw new Error("当前模型不在已接入的汇风视频模型列表中");
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
    if (!Number.isFinite(input.duration) || input.duration < profile.minDurationSeconds! || input.duration > profile.maxDurationSeconds!) throw new Error(`当前汇风视频模型时长需要在 ${profile.minDurationSeconds}–${profile.maxDurationSeconds} 秒之间`);
    if (input.model === HUIFENG_MINIMAX_H3_MODEL) {
        if (!Number.isInteger(input.duration)) throw new Error("MiniMax H3 时长必须为 4–15 秒的整数");
        const aspectRatio = !input.aspectRatio || ["auto", "adaptive"].includes(input.aspectRatio.toLowerCase()) ? "adaptive" : input.aspectRatio;
        if (aspectRatio !== "adaptive" && !profile.aspectRatios!.includes(aspectRatio)) throw new Error("MiniMax H3 不支持所选画幅比例");
        const resolution = !input.resolution || input.resolution.toLowerCase() === "auto" ? "768P" : input.resolution.toUpperCase();
        if (!profile.resolutions!.includes(resolution.toLowerCase())) throw new Error("MiniMax H3 仅支持 768P／1080P／2K／4K 清晰度");
        const firstFrame = input.references.find((item) => item.role === "first_frame");
        const lastFrame = input.references.find((item) => item.role === "last_frame");
        const videos = input.references.filter((item) => item.type === "video").map((item) => item.url);
        const audios = input.references.filter((item) => item.type === "audio").map((item) => item.url);
        const referenceParams = firstFrame
            ? { mode: "shouweizhen", images: [firstFrame.url, ...(lastFrame ? [lastFrame.url] : [])] }
            : { mode: "cankaosheng", ...(images.length ? { image_url: images } : {}), ...(videos.length ? { video_url: videos } : {}), ...(audios.length ? { audio_url: audios } : {}) };
        return { model: input.model, prompt: input.prompt, params: { ...referenceParams, duration: String(input.duration), resolution, aspect_ratio: aspectRatio } };
    }
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

function assertMiniMaxH3References(references: readonly VideoGenerationReference[]) {
    const firstFrames = references.filter((item) => item.role === "first_frame");
    const lastFrames = references.filter((item) => item.role === "last_frame");
    const frames = [...firstFrames, ...lastFrames];
    if (frames.some((item) => item.type !== "image")) throw new Error("MiniMax H3 首尾帧只能使用图片");
    if (firstFrames.length > 1 || lastFrames.length > 1) throw new Error("MiniMax H3 最多支持 1 张首帧和 1 张尾帧");
    if (lastFrames.length && !firstFrames.length) throw new Error("MiniMax H3 使用尾帧时必须提供首帧");
    if (firstFrames.length && lastFrames.length && firstFrames[0].url === lastFrames[0].url) throw new Error("MiniMax H3 首帧和尾帧不能使用同一张图片");
    if (frames.length && references.length !== frames.length) throw new Error("MiniMax H3 首尾帧模式不能同时使用普通参考图片、视频或音频");
    if (references.filter((item) => item.type === "image").length > 9) throw new Error("MiniMax H3 最多支持 9 张参考图片");
    if (references.filter((item) => item.type === "video").length > 3) throw new Error("MiniMax H3 最多支持 3 个参考视频");
    if (references.filter((item) => item.type === "audio").length > 3) throw new Error("MiniMax H3 最多支持 3 段参考音频");
}
