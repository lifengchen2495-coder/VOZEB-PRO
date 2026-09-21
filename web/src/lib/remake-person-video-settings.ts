import type { AiConfig } from "@/stores/use-config-store";

export type RemakeVideoSettings = {
    vquality: "480" | "720" | "1080";
    videoGenerateAudio: "true" | "false";
    videoWatermark: "true" | "false";
};

export const DEFAULT_REMAKE_VIDEO_SETTINGS: RemakeVideoSettings = {
    vquality: "480", videoGenerateAudio: "true", videoWatermark: "false",
};

export function normalizeRemakeVideoSettings(value: unknown, fallback = DEFAULT_REMAKE_VIDEO_SETTINGS): RemakeVideoSettings {
    const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
    const quality = String(source.vquality || "").replace(/p$/i, "");
    return {
        vquality: quality === "480" || quality === "720" || quality === "1080" ? quality : fallback.vquality,
        videoGenerateAudio: source.videoGenerateAudio === "true" || source.videoGenerateAudio === true ? "true" : source.videoGenerateAudio === "false" || source.videoGenerateAudio === false ? "false" : fallback.videoGenerateAudio,
        videoWatermark: source.videoWatermark === "true" || source.videoWatermark === true ? "true" : source.videoWatermark === "false" || source.videoWatermark === false ? "false" : fallback.videoWatermark,
    };
}

export function remakeVideoSettingsKey(value: unknown) {
    const normalized = JSON.stringify(normalizeRemakeVideoSettings(value));
    // 保留旧默认设置的任务身份，刷新后仍可恢复未完成的请求。
    return normalized === JSON.stringify(DEFAULT_REMAKE_VIDEO_SETTINGS) ? "" : normalized;
}

export function remakeVideoRequestConfig(config: AiConfig, settings: unknown, model: string, requestSeconds: number): AiConfig {
    return { ...config, ...normalizeRemakeVideoSettings(settings), model, videoModel: model, size: "9:16", videoSeconds: String(requestSeconds) };
}

export function remakeVideoOutputDimensions(settings: unknown) {
    const quality = normalizeRemakeVideoSettings(settings).vquality;
    return quality === "1080" ? { width: 1080, height: 1920 } : quality === "720" ? { width: 720, height: 1280 } : { width: 480, height: 854 };
}
