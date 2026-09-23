import type { AiConfig } from "@/stores/use-config-store";

export type RemakeVideoSettings = {
    vquality: "480" | "720" | "768" | "1080" | "2k" | "4k";
    videoGenerateAudio: "true" | "false";
    videoWatermark: "true" | "false";
};

export const DEFAULT_REMAKE_VIDEO_SETTINGS: RemakeVideoSettings = {
    vquality: "480", videoGenerateAudio: "true", videoWatermark: "false",
};

export function normalizeRemakeVideoSettings(value: unknown, fallback = DEFAULT_REMAKE_VIDEO_SETTINGS): RemakeVideoSettings {
    const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
    const quality = normalizeRemakeVideoQuality(source.vquality);
    return {
        vquality: quality || fallback.vquality,
        videoGenerateAudio: source.videoGenerateAudio === "true" || source.videoGenerateAudio === true ? "true" : source.videoGenerateAudio === "false" || source.videoGenerateAudio === false ? "false" : fallback.videoGenerateAudio,
        videoWatermark: source.videoWatermark === "true" || source.videoWatermark === true ? "true" : source.videoWatermark === "false" || source.videoWatermark === false ? "false" : fallback.videoWatermark,
    };
}

export function normalizeRemakeVideoQuality(value: unknown): RemakeVideoSettings["vquality"] | undefined {
    const quality = String(value || "").trim().toLowerCase().replace(/p$/, "");
    return quality === "480" || quality === "720" || quality === "768" || quality === "1080" || quality === "2k" || quality === "4k" ? quality : undefined;
}

export function remakeVideoQualityLabel(quality: string) {
    return /^\d+$/.test(quality) ? `${quality}p` : quality.toUpperCase();
}

export function remakeVideoSettingsKey(value: unknown) {
    const normalized = JSON.stringify(normalizeRemakeVideoSettings(value));
    // 保留旧默认设置的任务身份，刷新后仍可恢复未完成的请求。
    return normalized === JSON.stringify(DEFAULT_REMAKE_VIDEO_SETTINGS) ? "" : normalized;
}

export function remakeVideoRequestConfig(config: AiConfig, settings: unknown, model: string, requestSeconds: number): AiConfig {
    return { ...config, ...normalizeRemakeVideoSettings(settings), model, videoModel: model, size: "9:16", videoSeconds: String(requestSeconds) };
}

export type RemakeVideoDimensions = { width: number; height: number };

export function remakeVideoOutputDimensions(settings: unknown, source?: RemakeVideoDimensions): RemakeVideoDimensions {
    const quality = normalizeRemakeVideoSettings(settings).vquality;
    // 高清档位的实际像素由上游决定，合并沿用首段尺寸，避免猜测 2K 含义或降为 480p。
    if (quality === "768" || quality === "2k" || quality === "4k") {
        if (!source || !Number.isSafeInteger(source.width) || !Number.isSafeInteger(source.height) || source.width <= 0 || source.height <= 0 || source.width % 2 || source.height % 2) throw new Error("无法读取高清视频的有效尺寸，请重新生成后合并");
        return { width: source.width, height: source.height };
    }
    return quality === "1080" ? { width: 1080, height: 1920 } : quality === "720" ? { width: 720, height: 1280 } : { width: 480, height: 854 };
}
