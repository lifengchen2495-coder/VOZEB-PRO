import type { TokenUsage } from "@/lib/model-billing";
import { createTokenUsageStreamParser } from "@/lib/server/token-usage";

export type TokenStreamBilling = {
    type: "vozeb.billing";
    recordId: string;
    cost: number;
    remaining: number;
    status: "reserved" | "settled" | "usage-missing" | "refunded";
};

export function meterTokenStream(input: { body: ReadableStream<Uint8Array>; format: "sse" | "ndjson"; settle: (usage: TokenUsage | undefined, failed: boolean) => Promise<TokenStreamBilling>; refund: () => Promise<unknown> }) {
    const reader = input.body.getReader();
    const parser = createTokenUsageStreamParser(input.format);
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let pending = "";
    let terminal = "";
    let cancelled = false;
    let complete = false;
    const isTerminal = (frame: string) => {
        if (/(?:^|[\r\n])data:\s*\[DONE\]\s*(?:[\r\n]|$)/.test(frame) || /(?:^|[\r\n])event:\s*(?:message_stop|response.completed)\s*(?:[\r\n]|$)/.test(frame)) return true;
        const data =
            input.format === "ndjson"
                ? frame.trim()
                : frame
                      .split(/\r\n|\r|\n/)
                      .filter((line) => line.startsWith("data:"))
                      .map((line) => line.slice(5).trimStart())
                      .join("\n");
        try {
            const type = JSON.parse(data)?.type;
            return type === "message_stop" || type === "response.completed";
        } catch {
            return false;
        }
    };
    const holdTerminal = (frame: string) => {
        if (frame.length > 1_048_576) return frame;
        if (terminal.length + frame.length > 1_048_576) {
            const overflow = terminal;
            terminal = frame;
            return overflow;
        }
        terminal += frame;
        return "";
    };
    const forward = (controller: ReadableStreamDefaultController<Uint8Array>, text: string, flush = false) => {
        let emitted = false;
        const emit = (frame: string) => {
            controller.enqueue(encoder.encode(frame));
            emitted = true;
        };
        pending += text;
        const delimiter = input.format === "sse" ? /\r\n\r\n|\n\n|\r\r/ : /\r\n|\n|\r(?!$)/;
        let match: RegExpExecArray | null;
        while ((match = delimiter.exec(pending))) {
            const end = match.index + match[0].length;
            const frame = pending.slice(0, end);
            pending = pending.slice(end);
            if (isTerminal(frame)) {
                const overflow = holdTerminal(frame);
                if (overflow) emit(overflow);
            } else emit(frame);
        }
        // 正文不做全量缓存；超大事件仍透传，由计量器标记用量待核对。
        if (flush || pending.length > 1_048_576) {
            if (pending && isTerminal(pending)) {
                const overflow = holdTerminal(pending);
                if (overflow) emit(overflow);
            } else if (pending) emit(pending);
            pending = "";
        }
        return emitted;
    };
    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            try {
                while (true) {
                    const next = await reader.read();
                    if (cancelled) return;
                    if (!next.done) {
                        parser.push(next.value);
                        if (forward(controller, decoder.decode(next.value, { stream: true }))) return;
                        continue;
                    }
                    forward(controller, decoder.decode(), true);
                    const usage = parser.finish();
                    const billing = await input.settle(usage, parser.failed);
                    if (cancelled) return;
                    complete = true;
                    const payload = JSON.stringify(billing);
                    controller.enqueue(encoder.encode(input.format === "sse" ? `\n\nevent: vozeb.billing\ndata: ${payload}\n\n` : `\n${payload}\n`));
                    if (terminal) controller.enqueue(encoder.encode(terminal));
                    controller.close();
                    return;
                }
            } catch (error) {
                if (!complete) await input.refund();
                if (!cancelled) controller.error(error);
            }
        },
        async cancel(reason) {
            cancelled = true;
            try {
                await reader.cancel(reason);
            } finally {
                if (!complete) await input.refund();
            }
        },
    });
}

export function applyTokenStreamBilling(headers: Headers, raw: string) {
    if (headers.get("x-vozeb-pro-billing-mode") !== "token") return headers;
    const next = new Headers(headers);
    for (const line of raw.split(/\r?\n/)) {
        const value = line.startsWith("data:") ? line.slice(5).trim() : line.trim();
        if (!value.startsWith("{")) continue;
        try {
            const billing = JSON.parse(value) as Partial<TokenStreamBilling>;
            if (billing.type !== "vozeb.billing" || billing.recordId !== headers.get("x-vozeb-pro-points-record-id")) continue;
            if (typeof billing.cost !== "number" || !Number.isFinite(billing.cost) || billing.cost < 0 || typeof billing.remaining !== "number" || !Number.isFinite(billing.remaining)) continue;
            if (!["settled", "usage-missing", "refunded"].includes(billing.status || "")) continue;
            next.set("x-vozeb-pro-points-cost", String(billing.cost));
            next.set("x-vozeb-pro-points-remaining", String(billing.remaining));
            next.set("x-vozeb-pro-billing-status", billing.status!);
        } catch {
            // 非计费事件继续交给原协议解析器处理。
        }
    }
    return next;
}
