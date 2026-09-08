import type { TokenUsage } from "@/lib/model-billing";

type UsageFields = { input?: number; output?: number; cached?: number; cacheCreation?: number };
type UsageFragment = { family: "standard" | "anthropic"; fields: UsageFields };

const MAX_EVENT_CHARACTERS = 1_048_576;
const DECODE_CHUNK_BYTES = 65_536;

export function readTokenUsage(payload: unknown): TokenUsage | undefined {
    try {
        const fragment = readFragment(payload);
        return fragment ? completeUsage(fragment) : undefined;
    } catch {
        return undefined;
    }
}

export function createTokenUsageAccumulator() {
    let current: TokenUsage | undefined;
    let anthropicFields: UsageFields = {};
    let anthropicStreaming = false;
    let anthropicOutputReceived = false;
    let invalid = false;
    let failed = false;

    return {
        push(payload: unknown) {
            const record = object(payload);
            if (!record) return;
            if (isFailure(record)) failed = true;
            try {
                const fragment = readFragment(record);
                if (!fragment) return;
                if (fragment.family === "anthropic") {
                    if (record.type === "message_start" || record.type === "message_delta") anthropicStreaming = true;
                    if (record.type === "message_delta" && fragment.fields.output !== undefined) anthropicOutputReceived = true;
                    anthropicFields = mergeFields(anthropicFields, fragment.fields);
                    current = completeUsage({ family: "anthropic", fields: anthropicFields });
                } else {
                    const usage = completeUsage(fragment);
                    if (usage) current = usage;
                }
            } catch {
                // 用量格式错误时不采用之前的局部数据计费。
                invalid = true;
            }
        },
        usage(): TokenUsage | undefined {
            if (invalid || (anthropicStreaming && !anthropicOutputReceived)) return undefined;
            return current ? { ...current } : undefined;
        },
        get failed() {
            return failed;
        },
    };
}

export function createTokenUsageStreamParser(format: "sse" | "ndjson") {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const accumulator = createTokenUsageAccumulator();
    let line = "";
    let eventData: string[] = [];
    let eventLength = 0;
    let eventType = "";
    let skipLf = false;
    let invalid = false;
    let finished = false;

    function invalidate() {
        invalid = true;
        line = "";
        eventData = [];
        eventLength = 0;
    }

    function parsePayload(data: string, type = "") {
        if (type === "error" || type === "response.failed" || type === "response.incomplete") accumulator.push({ type });
        if (!data.trim() || data.trim() === "[DONE]") return;
        try {
            const payload: unknown = JSON.parse(data);
            accumulator.push(payload);
        } catch {
            invalidate();
        }
    }

    function dispatchEvent() {
        parsePayload(eventData.join("\n"), eventType);
        eventData = [];
        eventLength = 0;
        eventType = "";
    }

    function parseLine(value: string) {
        if (format === "ndjson") {
            parsePayload(value);
            return;
        }
        if (!value) {
            dispatchEvent();
            return;
        }
        if (value.startsWith(":")) return;
        const colon = value.indexOf(":");
        const field = colon < 0 ? value : value.slice(0, colon);
        const raw = colon < 0 ? "" : value.slice(colon + 1);
        const content = raw.startsWith(" ") ? raw.slice(1) : raw;
        if (field === "event") eventType = content;
        if (field !== "data") return;
        eventLength += content.length + 1;
        if (eventLength > MAX_EVENT_CHARACTERS) {
            invalidate();
            return;
        }
        eventData.push(content);
    }

    function readText(value: string) {
        let start = 0;
        for (let index = 0; index < value.length && !invalid; index += 1) {
            const character = value[index];
            if (skipLf) {
                skipLf = false;
                if (character === "\n") {
                    start = index + 1;
                    continue;
                }
            }
            if (character !== "\r" && character !== "\n") continue;
            line += value.slice(start, index);
            if (line.length > MAX_EVENT_CHARACTERS) {
                invalidate();
                return;
            }
            parseLine(line);
            line = "";
            start = index + 1;
            skipLf = character === "\r";
        }
        if (invalid) return;
        line += value.slice(start);
        if (line.length > MAX_EVENT_CHARACTERS) invalidate();
    }

    return {
        push(chunk: Uint8Array) {
            if (finished || invalid) return;
            try {
                // 限制解码分片，避免单次巨大的上游 chunk 扩大解析缓冲区。
                for (let offset = 0; offset < chunk.byteLength && !invalid; offset += DECODE_CHUNK_BYTES) {
                    readText(decoder.decode(chunk.subarray(offset, offset + DECODE_CHUNK_BYTES), { stream: true }));
                }
            } catch {
                invalidate();
            }
        },
        finish(): TokenUsage | undefined {
            if (!finished && !invalid) {
                try {
                    readText(decoder.decode());
                    if (line) parseLine(line);
                    line = "";
                    if (format === "sse" && !invalid) dispatchEvent();
                } catch {
                    invalidate();
                }
            }
            finished = true;
            return invalid ? undefined : accumulator.usage();
        },
        get failed() {
            return accumulator.failed;
        },
    };
}

function readFragment(payload: unknown): UsageFragment | undefined {
    const record = object(payload);
    if (!record) return undefined;
    const metadata = object(record.usageMetadata);
    if (metadata) {
        const output = count(metadata, "candidatesTokenCount");
        const thoughts = count(metadata, "thoughtsTokenCount");
        return {
            family: "standard",
            fields: {
                input: count(metadata, "promptTokenCount"),
                output: output === undefined ? undefined : safeSum(output, thoughts ?? 0),
                cached: count(metadata, "cachedContentTokenCount"),
            },
        };
    }
    const usage = object(record.usage) || object(object(record.response)?.usage) || object(object(record.message)?.usage);
    if (!usage) return undefined;
    const anthropic = record.type === "message" || record.type === "message_start" || record.type === "message_delta" || "cache_creation_input_tokens" in usage || "cache_read_input_tokens" in usage;
    if (anthropic) {
        return {
            family: "anthropic",
            fields: {
                input: count(usage, "input_tokens"),
                output: count(usage, "output_tokens"),
                cached: count(usage, "cache_read_input_tokens"),
                cacheCreation: count(usage, "cache_creation_input_tokens"),
            },
        };
    }
    const chat = "prompt_tokens" in usage || "completion_tokens" in usage;
    const detailKey = chat ? "prompt_tokens_details" : "input_tokens_details";
    if (usage[detailKey] !== undefined && !object(usage[detailKey])) throw new Error("上游 Token 缓存用量无效");
    return {
        family: "standard",
        fields: {
            input: count(usage, chat ? "prompt_tokens" : "input_tokens"),
            output: count(usage, chat ? "completion_tokens" : "output_tokens"),
            cached: count(object(usage[detailKey]) || {}, "cached_tokens"),
        },
    };
}

function completeUsage(fragment: UsageFragment): TokenUsage | undefined {
    const { input, output, cached = 0, cacheCreation = 0 } = fragment.fields;
    if (input === undefined || output === undefined) return undefined;
    const inputTokens = fragment.family === "anthropic" ? safeSum(input, cacheCreation, cached) : input;
    if (cached > inputTokens) throw new Error("上游缓存 Token 超出输入用量");
    return { inputTokens, outputTokens: output, cachedInputTokens: cached };
}

function count(record: Record<string, unknown>, key: string): number | undefined {
    if (!(key in record)) return undefined;
    const value = record[key];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("上游 Token 用量无效");
    return value;
}

function safeSum(...values: number[]) {
    const result = values.reduce((sum, value) => sum + value, 0);
    if (!Number.isSafeInteger(result)) throw new Error("上游 Token 用量超出有效范围");
    return result;
}

function mergeFields(previous: UsageFields, next: UsageFields): UsageFields {
    const result = { ...previous };
    for (const key of ["input", "output", "cached", "cacheCreation"] as const) {
        if (next[key] !== undefined) result[key] = Math.max(previous[key] ?? 0, next[key]);
    }
    return result;
}

function isFailure(record: Record<string, unknown>) {
    const response = object(record.response);
    return record.type === "error" || record.type === "response.failed" || record.type === "response.incomplete" || record.status === "failed" || record.status === "incomplete" || response?.status === "failed" || response?.status === "incomplete" || Boolean(record.error) || Boolean(response?.error);
}

function object(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
