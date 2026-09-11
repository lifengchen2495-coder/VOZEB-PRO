import { toSafeGenerationErrorMessage, toSafeGenerationTransportError } from "@/lib/server/generation-errors";
import { fetchInternalApi } from "@/lib/server/internal-origin";
import type { ResolvedLogicalModel } from "@/lib/server/logical-model-router";
import { resolveModelRequestTimeoutMs } from "@/lib/server/model-request-policy";
import { maintenanceWorkerContextHeaders } from "@/lib/server/maintenance-auth";
import { buildProviderRequest } from "@/lib/server/provider-task-config";
import { resolveTextProtocol } from "@/lib/server/text-protocol-resolver";
import { applyTokenStreamBilling } from "@/lib/server/token-billing-stream";
import { readVisionChatStream } from "@/lib/server/vision-chat-stream";
import { readResponsesStream } from "@/lib/server/responses-stream";

const MODEL_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;
const MODEL_STREAM_RESPONSE_MAX_BYTES = 8 * 1024 * 1024;

export type RemakeProductionVisionProtocol = "chat" | "responses" | "gemini";
export type VisionRequestBoard = { mimeType: string; bytes: Buffer };
export type RemakeProductionVisionCall = { text: string; headers: Headers; protocol: RemakeProductionVisionProtocol; elapsedMs: number };

export type ResolvedVisionProtocol = {
    kind: RemakeProductionVisionProtocol;
    path: string;
    requestTemplate?: string;
};

export class RemakeProductionVisionError extends Error {
    constructor(
        message: string,
        readonly status = 502,
        readonly responseHeaders?: Headers,
    ) {
        super(message);
        this.name = "RemakeProductionVisionError";
    }
}

export function resolveRemakeVisionProtocol(candidate: ResolvedLogicalModel, requiredImageCount = 1): ResolvedVisionProtocol | null {
    if (requiredImageCount > 0 && candidate.capabilityProfile?.supportsReferenceImage !== true) return null;
    if (requiredImageCount > 0 && candidate.capabilityProfile?.maxReferenceImages !== undefined && candidate.capabilityProfile.maxReferenceImages < requiredImageCount) return null;
    try {
        const protocol = resolveTextProtocol({
            model: candidate.upstreamModel,
            apiFormat: candidate.channel.apiFormat,
            advancedConfig: candidate.channel.advancedConfig,
            throughSystemProxy: true,
        });
        if (protocol.providerKind === "gemini") return { kind: "gemini", path: protocol.providerPath };
        if (protocol.kind === "responses" && protocol.providerKind === "responses") return { kind: "responses", path: protocol.path };
        if (protocol.kind === "chat" && protocol.providerKind === "chat") return { kind: "chat", path: protocol.path };
        if (protocol.kind === "custom" && /^\/(?:v1\/)?chat\/completions\/?$/.test(protocol.path) && /^choices(?:\[0\]|\.0)\.message\.content$/.test(protocol.resultField || "")) {
            const template = record(JSON.parse(protocol.requestTemplate || ""));
            // 仅接入完整透传多模态消息的 Chat 模板，保留模型专属参数，避免参考图被文本占位符丢弃。
            if (template.model === "{{model}}" && template.messages === "{{messages}}" && (template.stream === undefined || typeof template.stream === "boolean" || template.stream === "{{stream}}")) {
                return { kind: "chat", path: protocol.path, requestTemplate: protocol.requestTemplate };
            }
        }
        return null;
    } catch {
        return null;
    }
}

export async function requestRemakeVisionPrompt(input: {
    origin: string;
    cookie: string;
    candidate: ResolvedLogicalModel;
    messages: Array<{ role: string; content: string }>;
    boards: VisionRequestBoard[];
    headers?: HeadersInit;
    signal?: AbortSignal;
    allowTextOnly?: boolean;
    maxOutputTokens?: number;
    stream?: boolean;
    jsonMode?: boolean;
}): Promise<RemakeProductionVisionCall> {
    const protocol = resolveRemakeVisionProtocol(input.candidate, input.boards.length);
    if (!protocol) throw new RemakeProductionVisionError("当前文本候选不支持受信任的多模态图片协议", 503);
    const startedAt = Date.now();
    const headers = new Headers(input.headers);
    headers.set("content-type", "application/json");
    const workerHeaders = maintenanceWorkerContextHeaders(input.cookie);
    if (workerHeaders) Object.entries(workerHeaders).forEach(([key, value]) => headers.set(key, value));
    else if (input.cookie) headers.set("cookie", input.cookie);
    const timeoutSignal = AbortSignal.timeout(resolveModelRequestTimeoutMs(input.candidate, "text"));
    const signal = input.signal ? AbortSignal.any([input.signal, timeoutSignal]) : timeoutSignal;
    const stream = input.stream !== false && protocol.kind !== "gemini";
    const defaults = { ...buildVisionRequest(protocol.kind, input.candidate.upstreamModel, input.messages, input.boards, input.maxOutputTokens), ...(input.jsonMode && protocol.kind === "chat" ? { response_format: { type: "json_object" } } : {}) };
    const body = protocol.requestTemplate ? { ...defaults, ...buildProviderRequest(protocol.requestTemplate, defaults, { ...defaults, stream }), stream } : { ...defaults, ...(stream ? { stream: true } : {}) };
    if (stream) headers.set("accept", "text/event-stream");
    const response = await fetchInternalApi(modelProxyUrl(input.origin, input.candidate.channelId, protocol.path), {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        cache: "no-store",
        signal,
    });
    if (!response.ok) {
        const detail = await readResponseText(response, 64 * 1024).catch(() => "");
        throw new RemakeProductionVisionError(toSafeGenerationErrorMessage(detail, `生产视觉规划模型调用失败（HTTP ${response.status}）`, response.status), response.status, response.headers);
    }
    let responseHeaders = response.headers;
    let payload: Record<string, unknown>;
    try {
        const raw = await readResponseText(response, stream ? MODEL_STREAM_RESPONSE_MAX_BYTES : MODEL_RESPONSE_MAX_BYTES, (partial) => {
            if (stream) responseHeaders = applyTokenStreamBilling(response.headers, partial);
        });
        if (stream && (/event-stream/i.test(response.headers.get("content-type") || "") || /^\s*(?:data:|event:|:)/.test(raw))) payload = protocol.kind === "responses" ? readResponsesStream(raw) : readVisionChatStream(raw);
        else {
            const parsed: unknown = JSON.parse(raw);
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new SyntaxError();
            payload = parsed as Record<string, unknown>;
        }
    } catch (error) {
        const message = error instanceof SyntaxError ? "生产视觉规划模型返回了无效 JSON" : toSafeGenerationErrorMessage(error, "生产视觉规划模型响应读取失败");
        throw new RemakeProductionVisionError(message, error instanceof RemakeProductionVisionError ? error.status : toSafeGenerationTransportError(error, "response").status, responseHeaders);
    }
    const prompt = readPromptText(protocol.kind, payload);
    if (!prompt.trim()) {
        throw new RemakeProductionVisionError("模型没有返回创作正文", 502, responseHeaders);
    }
    return { text: prompt, headers: responseHeaders, protocol: protocol.kind, elapsedMs: Date.now() - startedAt };
}

function buildVisionRequest(protocol: RemakeProductionVisionProtocol, model: string, messages: Array<{ role: string; content: string }>, boards: VisionRequestBoard[], maxOutputTokens?: number) {
    const systemText = messages
        .filter((message) => message.role === "system")
        .map((message) => message.content)
        .join("\n\n");
    const userText = messages
        .filter((message) => message.role !== "system")
        .map((message) => message.content)
        .join("\n\n");
    if (protocol === "responses") {
        return {
            model,
            ...(maxOutputTokens ? { max_output_tokens: maxOutputTokens } : {}),
            input: [
                ...(systemText ? [{ role: "system", content: systemText }] : []),
                {
                    role: "user",
                    content: [{ type: "input_text", text: userText }, ...boards.map((board) => ({ type: "input_image", image_url: boardDataUrl(board), detail: "high" }))],
                },
            ],
        };
    }
    if (protocol === "gemini") {
        return {
            ...(maxOutputTokens ? { generationConfig: { maxOutputTokens } } : {}),
            contents: [
                {
                    role: "user",
                    parts: [{ text: userText }, ...boards.map((board) => ({ inlineData: { mimeType: board.mimeType, data: board.bytes.toString("base64") } }))],
                },
            ],
            ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
        };
    }
    return {
        model,
        ...(maxOutputTokens ? { max_tokens: maxOutputTokens } : {}),
        messages: [
            ...(systemText ? [{ role: "system", content: systemText }] : []),
            {
                role: "user",
                content: [{ type: "text", text: userText }, ...boards.map((board) => ({ type: "image_url", image_url: { url: boardDataUrl(board), detail: "high" } }))],
            },
        ],
    };
}

function boardDataUrl(board: VisionRequestBoard) {
    return `data:${board.mimeType};base64,${board.bytes.toString("base64")}`;
}

function modelProxyUrl(origin: string, channelId: string, path: string) {
    const normalizedPath = path.trim();
    if (!normalizedPath || /^https?:\/\//i.test(normalizedPath)) throw new RemakeProductionVisionError("多模态文本协议路径无效", 503);
    return `${origin.replace(/\/+$/, "")}/api/ai/system/${encodeURIComponent(channelId)}${normalizedPath.startsWith("/") ? normalizedPath : `/${normalizedPath}`}`;
}

function readPromptText(protocol: RemakeProductionVisionProtocol, payload: Record<string, unknown>) {
    if (protocol === "responses") {
        if (payload.status !== "completed" || payload.error || payload.incomplete_details) return "";
        const output = records(payload.output);
        if (output.some((item) => item.type === "function_call" || records(item.content).some((part) => part.type === "refusal"))) return "";
        if (typeof payload.output_text === "string") return payload.output_text;
        return records(payload.output)
            .filter((item) => item.type === "message" && item.role === "assistant")
            .flatMap((item) => records(item.content))
            .filter((part) => part.type === "output_text")
            .map((part) => (typeof part.text === "string" ? part.text : ""))
            .join("");
    }
    if (protocol === "gemini") {
        const candidate = records(payload.candidates)[0];
        if (candidate?.finishReason && candidate.finishReason !== "STOP") return "";
        return records(record(candidate?.content).parts)
            .filter((part) => part.thought !== true && typeof part.text === "string")
            .map((part) => part.text)
            .join("");
    }
    const choice = records(payload.choices)[0];
    if (choice?.finish_reason && choice.finish_reason !== "stop") return "";
    const message = record(choice?.message);
    if (message.refusal || records(message.tool_calls).length || records(message.content).some((part) => part.type === "refusal")) return "";
    return typeof message.content === "string"
        ? message.content
        : records(message.content)
              .filter((part) => part.type === "text" && typeof part.text === "string")
              .map((part) => part.text)
              .join("");
}

async function readResponseText(response: Response, maximum: number, onRead?: (raw: string) => void) {
    if (!response.body) return "";
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    try {
        for (;;) {
            const next = await reader.read();
            if (next.done) break;
            total += next.value.byteLength;
            if (total > maximum) {
                throw new RemakeProductionVisionError("模型响应超过大小上限", 413);
            }
            chunks.push(Buffer.from(next.value));
        }
    } catch (error) {
        await reader.cancel(error).catch(() => undefined);
        throw error;
    } finally {
        // 读取中断时仍交还已收到的计费尾帧，调用方可按实际结算结果退款。
        onRead?.(Buffer.concat(chunks).toString("utf8"));
        reader.releaseLock();
    }
    if (!total) throw new RemakeProductionVisionError("读取到的图片或模型响应为空", 422);
    return Buffer.concat(chunks, total).toString("utf8");
}

function record(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function records(value: unknown) {
    return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
}
