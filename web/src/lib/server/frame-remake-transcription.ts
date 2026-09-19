import type { AuthSettings } from "@/lib/auth/store";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { supportsFrameRemakeChatAudioModel } from "@/lib/frame-remake-transcription-capability";
import { requestFrameOriginalText, type FrameOriginalFile } from "./frame-remake-original-gateway";
import { resolveLogicalModelCandidates, type ResolvedLogicalModel } from "./logical-model-router";
import { RemakeProductionVisionError, requestRemakeVisionPrompt, resolveRemakeVisionProtocol } from "./remake-vision-request";
import { supportsBangbangVideoAudio } from "./bangbang-runtime-video";
import { runFfmpeg } from "./ffmpeg";
import { systemAiBillingHeaders } from "./system-ai-billing";

const TRANSCRIPTION_MODEL_ERROR = "尚未配置支持音轨转录的站内模型。请配置已验证的 Gemini 音频渠道、Doubao Seed 2.0 Lite 260428、Mini 260428 或语音识别渠道；Doubao Seed 2.0 Pro 仅用于画面分析，不能据此判定无口播。";

export function resolveFrameTranscriptionProtocol(candidate: ResolvedLogicalModel) {
    if (supportsBangbangVideoAudio(candidate)) return "doubao-responses-video-audio" as const;
    if (!candidate.channel.apiKey.trim() || !supportsFrameRemakeChatAudioModel(candidate.upstreamModel)) return null;
    const protocol = resolveRemakeVisionProtocol(candidate, 0);
    return protocol?.kind === "chat" && !protocol.requestTemplate ? "openai-chat-input-audio" as const : null;
}

// 画面分析模型仅作为优先候选；转录必须独立找到确实支持音轨的已配置模型。
export function resolveFrameTranscriptionModel(settings: AuthSettings, requested = "") {
    const ids = Array.from(new Set([
        requested.trim(),
        settings.defaultModels.textModel,
        ...settings.logicalModels.filter((model) => model.enabled && model.capability === "text").map((model) => model.id),
        ...(settings.logicalModels.length ? [] : settings.systemChannels.filter((channel) => channel.enabled).flatMap((channel) => channel.models)),
    ].filter(Boolean)));
    for (const id of ids) {
        const candidate = resolveLogicalModelCandidates(settings, "text", id).find((item) => resolveFrameTranscriptionProtocol(item));
        if (candidate) return candidate;
    }
    throw new Error(TRANSCRIPTION_MODEL_ERROR);
}

// 来自旧 remake15-analysis-runtime.ts 的 sourceCopy 字段说明及 JSON 输出协议。
// 这是站内音视频转文字协议，不是飞书创作提示词，也不包含创作或替换规则。
export const FRAME_REMAKE_TRANSCRIPTION_INSTRUCTION = "按视频原语言逐字转写的完整口播，不得翻译；无口播时返回空字符串";
export const FRAME_REMAKE_TRANSCRIPTION_PROMPT = [
    FRAME_REMAKE_TRANSCRIPTION_INSTRUCTION,
    "只输出一个 JSON 对象，不要输出 Markdown 代码围栏、解释或前后缀。JSON 必须严格符合以下 Schema：",
    JSON.stringify({ type: "object", properties: { sourceCopy: { type: "string", description: FRAME_REMAKE_TRANSCRIPTION_INSTRUCTION } }, required: ["sourceCopy"], additionalProperties: false }),
].join("\n\n");

export function parseFrameRemakeTranscription(raw: string) {
    const response = raw.trim();
    // 仅处理代码框和字符串内未转义的控制字符，不补齐截断内容或将说明文字当作口播。
    const fence = response.match(/^(`{3,}|~{3,})(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n\1$/i);
    let value: unknown;
    try {
        value = JSON.parse(escapeJsonStringControls(fence?.[2] ?? response));
    } catch {
        throw new Error("原文案转录未返回完整 JSON，未保存转录结果");
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("原文案转录结果格式无效");
    const result = value as Record<string, unknown>;
    if (Object.keys(result).length !== 1 || typeof result.sourceCopy !== "string" || result.sourceCopy.length > 100_000) {
        throw new Error("原文案转录须完整返回 sourceCopy 文本字段，未保存转录结果");
    }
    return result.sourceCopy.trim()
        ? { status: "transcribed" as const, text: result.sourceCopy }
        : { status: "no-speech" as const, text: "" };
}

function escapeJsonStringControls(raw: string) {
    let result = "";
    let inString = false;
    let escaped = false;
    for (const character of raw) {
        // 模型可能把真实换行直接写进 sourceCopy 引号内；只修正编码，解析后的字符完全保留。
        if (inString && !escaped && character.charCodeAt(0) < 0x20) {
            result += JSON.stringify(character).slice(1, -1);
            continue;
        }
        result += character;
        if (escaped) escaped = false;
        else if (inString && character === "\\") escaped = true;
        else if (character === '"') inString = !inString;
    }
    return result;
}

export async function requestFrameRemakeTranscription(input: {
    origin: string;
    credential: string;
    candidate: ResolvedLogicalModel;
    video: FrameOriginalFile;
    idempotencyKey: string;
    signal?: AbortSignal;
    onResponse?: (raw: string) => void;
}) {
    input.signal?.throwIfAborted();
    const protocol = resolveFrameTranscriptionProtocol(input.candidate);
    if (!protocol) throw new Error(TRANSCRIPTION_MODEL_ERROR);
    if (input.video.type !== "video" || !input.video.content_type.startsWith("video/")) throw new Error("原文案转录需要本组保留原音轨的视频片段");
    const call = protocol === "openai-chat-input-audio" ? await requestChatAudioTranscription(input) : await requestFrameOriginalText({
        origin: input.origin,
        credential: input.credential,
        candidate: input.candidate,
        prompt: FRAME_REMAKE_TRANSCRIPTION_PROMPT,
        files: [input.video],
        idempotencyKey: input.idempotencyKey,
        signal: input.signal,
    });
    try {
        input.signal?.throwIfAborted();
        input.onResponse?.(call.text);
        return {
            ...parseFrameRemakeTranscription(call.text),
            headers: call.headers,
            elapsedMs: call.elapsedMs,
            metadata: {
                source: "system-video-transcription" as const,
                model: input.candidate.logicalModelId,
                upstreamModel: input.candidate.upstreamModel,
                protocol,
                instruction: FRAME_REMAKE_TRANSCRIPTION_INSTRUCTION,
                prompt: FRAME_REMAKE_TRANSCRIPTION_PROMPT,
            },
        };
    } catch (error) {
        throw new RemakeProductionVisionError(error instanceof Error ? error.message : "原文案转录失败", input.signal?.aborted ? 499 : 502, call.headers);
    }
}

async function requestChatAudioTranscription(input: {
    origin: string;
    credential: string;
    candidate: ResolvedLogicalModel;
    video: FrameOriginalFile;
    idempotencyKey: string;
    signal?: AbortSignal;
}) {
    const directory = await mkdtemp(join(tmpdir(), "vozeb-frame-transcription-"));
    try {
        const sourcePath = join(directory, "source.mp4");
        const audioPath = join(directory, "source.wav");
        await writeFile(sourcePath, Buffer.from(input.video.file_base64, "base64"), { signal: input.signal });
        await runFfmpeg(["-y", "-hide_banner", "-loglevel", "error", "-i", sourcePath, "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", audioPath], { timeoutMs: 180_000, signal: input.signal });
        const bytes = await readFile(audioPath, { signal: input.signal });
        if (!bytes.length || bytes.length > 24 * 1024 * 1024) throw new Error("本组转录音轨为空或超过 24 MB，请检查来源音轨或缩短分组后重试");
        input.signal?.throwIfAborted();
        return await requestRemakeVisionPrompt({
            origin: input.origin,
            cookie: input.credential,
            candidate: input.candidate,
            messages: [{ role: "user", content: FRAME_REMAKE_TRANSCRIPTION_PROMPT }],
            boards: [],
            audio: { format: "wav", bytes },
            headers: systemAiBillingHeaders(input.candidate.logicalModelId, input.idempotencyKey, input.candidate.upstreamModel),
            maxOutputTokens: 24_000,
            defaultTimeoutMs: 600_000,
            signal: input.signal,
            stream: false,
            jsonMode: true,
        });
    } finally {
        // 清理失败不能覆盖带计费头的响应或原错误，否则运行层无法正确结算/退款。
        await rm(directory, { recursive: true, force: true }).catch(() => { console.warn("转录临时音频目录清理暂时失败"); });
    }
}
