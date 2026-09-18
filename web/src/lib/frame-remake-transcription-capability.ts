// 官方支持视频内嵌音轨的模型；视频画面理解能力不能代替此能力。
// https://docs.volcengine.com/docs/ark/Modellist?lang=zh#9619c0ba
export const FRAME_REMAKE_EMBEDDED_AUDIO_MODELS = ["doubao-seed-2-0-lite-260428", "doubao-seed-2-0-mini-260428"] as const;

// 站内已用“画面文字与口播不同”的样本实测通过 input_audio 的 Gemini 渠道别名。
// 不按 gem/gemini 前缀推断兼容能力；其他型号须确认其音频协议后再加入。
export const FRAME_REMAKE_CHAT_AUDIO_MODELS = ["gem-3-pro"] as const;

export function supportsFrameRemakeEmbeddedAudioModel(model: string) {
    const normalized = model.trim().replace(/^models\//i, "").toLowerCase();
    return FRAME_REMAKE_EMBEDDED_AUDIO_MODELS.some((supported) => supported === normalized);
}

export function supportsFrameRemakeChatAudioModel(model: string) {
    const normalized = model.trim().replace(/^models\//i, "").toLowerCase();
    return FRAME_REMAKE_CHAT_AUDIO_MODELS.some((supported) => supported === normalized);
}
