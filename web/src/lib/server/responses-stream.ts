import { toSafeGenerationErrorMessage } from "@/lib/server/generation-errors";
import { applyTokenStreamBilling } from "@/lib/server/token-billing-stream";

export async function readResponsesBody(response: Response, onHeaders: (headers: Headers) => void): Promise<string> {
    let raw = "";
    let bytesRead = 0;
    try {
        // 一直读取到流结束，保留 completed 后的计费尾帧；中断时也交还已收到的结算记录。
        if (response.body) {
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            try {
                while (true) {
                    const next = await reader.read();
                    bytesRead += next.value?.byteLength || 0;
                    if (bytesRead > 8 * 1024 * 1024) {
                        await reader.cancel("Responses response exceeds 8 MiB");
                        throw new Error("Responses 接口响应超过大小上限，请缩短当前生成内容");
                    }
                    raw += decoder.decode(next.value, { stream: !next.done });
                    if (next.done) break;
                }
            } finally {
                reader.releaseLock();
            }
        }
        if (!response.ok) throw new Error(toSafeGenerationErrorMessage(raw, `Responses 接口调用失败（HTTP ${response.status}）`, response.status));
        const payload = response.headers.get("content-type")?.includes("text/event-stream") || /^(?:event:|data:|:)/m.test(raw) ? readResponsesStream(raw) : parseRecord(raw);
        const text = readCompletedResponse(payload);
        if (!text.trim()) throw new Error("Responses 接口响应缺少结果正文");
        return text;
    } finally {
        onHeaders(applyTokenStreamBilling(response.headers, raw));
    }
}

export function readResponsesStream(raw: string): Record<string, unknown> {
    let completed: Record<string, unknown> | undefined;
    const textParts = new Map<string, string>();
    for (const frame of raw
        .replace(/^\uFEFF/u, "")
        .replace(/\r\n|\r/g, "\n")
        .split("\n\n")) {
        const lines = frame.split("\n");
        const event = lines
            .find((line) => line.startsWith("event:"))
            ?.slice(6)
            .trim();
        if (event === "error") throw new Error("Responses 接口流式响应失败，请检查渠道状态");
        const data = lines
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).replace(/^ /, ""))
            .join("\n");
        if (!data.trim() || data.trim() === "[DONE]") continue;
        const payload = parseRecord(data);
        const type = typeof payload.type === "string" ? payload.type : event;
        if (type === "vozeb.billing") continue;
        if (completed && type?.startsWith("response.")) throw new Error("Responses 接口在完成后返回了额外生成事件，无法确认分析完整性");
        if (payload.error || type === "error" || ["response.failed", "response.incomplete", "response.cancelled"].includes(type || "")) {
            throw new Error("Responses 接口未正常完成，请检查渠道状态或输出长度限制");
        }
        if (type?.startsWith("response.refusal.") || type?.startsWith("response.function_call_arguments.")) throw new Error("Responses 接口拒绝了请求或返回了工具调用，未生成完整分析");
        assertOutputItem(payload.item);
        assertOutputItem(payload.part);
        if (type === "response.output_text.delta" && typeof payload.delta === "string") {
            const key = `${payload.output_index ?? 0}:${payload.content_index ?? 0}`;
            textParts.set(key, (textParts.get(key) || "") + payload.delta);
        }
        if (type === "response.output_text.done" && typeof payload.text === "string") textParts.set(`${payload.output_index ?? 0}:${payload.content_index ?? 0}`, payload.text);
        if (type === "response.completed") {
            completed = record(payload.response);
            if (!completed) throw new Error("Responses 接口缺少完整的结束响应");
            readCompletedResponse(completed);
        }
    }
    if (!completed) throw new Error("Responses 接口流式响应中断，未收到完整结束标记");
    const streamedText = Array.from(textParts.entries())
        .sort(([left], [right]) => {
            const [leftOutput, leftContent] = left.split(":").map(Number);
            const [rightOutput, rightContent] = right.split(":").map(Number);
            return leftOutput - rightOutput || leftContent - rightContent;
        })
        .map(([, text]) => text)
        .join("");
    return { ...completed, output_text: readCompletedResponse(completed) || streamedText };
}

function readCompletedResponse(payload: Record<string, unknown>) {
    if (payload.status !== "completed" || payload.error || payload.incomplete_details) throw new Error("Responses 接口返回了未完成的响应，请重试");
    const output = Array.isArray(payload.output) ? payload.output : [];
    output.forEach((item) => assertOutputItem(item, true));
    const direct = typeof payload.output_text === "string" ? payload.output_text : "";
    return (
        direct ||
        output
            .flatMap((item) => {
                const content = record(item)?.content;
                return Array.isArray(content) ? content : [];
            })
            .map((part) => {
                const item = record(part);
                return (item?.type === "output_text" || item?.type === "text") && typeof item.text === "string" ? item.text : "";
            })
            .join("\n")
    );
}

function assertOutputItem(value: unknown, complete = false) {
    const item = record(value);
    if (!item) return;
    if (item.type === "refusal" || item.refusal || item.type === "function_call") throw new Error("Responses 接口拒绝了请求或返回了工具调用，未生成完整分析");
    if (["failed", "incomplete", "cancelled"].includes(String(item.status || "")) || (complete && item.status !== undefined && item.status !== "completed")) throw new Error("Responses 接口输出未完成，请重试");
    if (Array.isArray(item.content)) item.content.forEach((part) => assertOutputItem(part, complete));
}

function parseRecord(raw: string) {
    try {
        const parsed = record(JSON.parse(raw));
        if (parsed) return parsed;
    } catch {
        // 统一报告协议错误，不将不可解析的上游响应当作分析正文。
    }
    throw new Error("Responses 接口返回了无效 JSON");
}

function record(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
