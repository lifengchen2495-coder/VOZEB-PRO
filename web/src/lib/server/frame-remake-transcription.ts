import { requestFrameOriginalText, type FrameOriginalFile } from "./frame-remake-original-gateway";
import type { ResolvedLogicalModel } from "./logical-model-router";
import { RemakeProductionVisionError } from "./remake-vision-request";

// 来自旧 remake15-analysis-runtime.ts 的 sourceCopy 字段说明及 JSON 输出协议。
// 这是站内音视频转文字协议，不是飞书创作提示词，也不包含创作或替换规则。
export const FRAME_REMAKE_TRANSCRIPTION_INSTRUCTION = "按视频原语言逐字转写的完整口播，不得翻译；无口播时返回空字符串";
export const FRAME_REMAKE_TRANSCRIPTION_PROMPT = [
    FRAME_REMAKE_TRANSCRIPTION_INSTRUCTION,
    "只输出一个 JSON 对象，不要输出 Markdown 代码围栏、解释或前后缀。JSON 必须严格符合以下 Schema：",
    JSON.stringify({ type: "object", properties: { sourceCopy: { type: "string", description: FRAME_REMAKE_TRANSCRIPTION_INSTRUCTION } }, required: ["sourceCopy"], additionalProperties: false }),
].join("\n\n");

export function parseFrameRemakeTranscription(raw: string) {
    let value: unknown;
    try {
        value = JSON.parse(raw);
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

export async function requestFrameRemakeTranscription(input: {
    origin: string;
    credential: string;
    candidate: ResolvedLogicalModel;
    video: FrameOriginalFile;
    idempotencyKey: string;
    signal?: AbortSignal;
}) {
    input.signal?.throwIfAborted();
    if (input.video.type !== "video" || !input.video.content_type.startsWith("video/")) throw new Error("原文案转录需要本组保留原音轨的视频片段");
    const call = await requestFrameOriginalText({
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
        return {
            ...parseFrameRemakeTranscription(call.text),
            headers: call.headers,
            elapsedMs: call.elapsedMs,
            metadata: {
                source: "system-video-transcription" as const,
                model: input.candidate.logicalModelId,
                instruction: FRAME_REMAKE_TRANSCRIPTION_INSTRUCTION,
                prompt: FRAME_REMAKE_TRANSCRIPTION_PROMPT,
            },
        };
    } catch (error) {
        throw new RemakeProductionVisionError(error instanceof Error ? error.message : "原文案转录失败", input.signal?.aborted ? 499 : 502, call.headers);
    }
}
