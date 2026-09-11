import { fetchInternalApi } from "@/lib/server/internal-origin";
import type { ResolvedLogicalModel } from "@/lib/server/logical-model-router";
import { maintenanceWorkerContextHeaders } from "@/lib/server/maintenance-auth";
import { resolveModelRequestTimeoutMs } from "@/lib/server/model-request-policy";
import { strictJsonObjectText } from "@/lib/server/structured-model-output";
import { systemAiBillingHeaders } from "@/lib/server/system-ai-billing";
import { readResponsesBody } from "@/lib/server/responses-stream";

export async function requestDoubaoVideoResponse(input: {
    candidate: ResolvedLogicalModel;
    model: string;
    origin: string;
    credential: string;
    idempotencyKey: string;
    body: { model: string; input: unknown[]; store: boolean; max_output_tokens: number };
    onInvalidResponse: (headers: Headers) => Promise<void>;
}) {
    const headers = new Headers({
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        "Idempotency-Key": input.idempotencyKey,
        "X-Client-Request-Id": input.idempotencyKey,
        ...systemAiBillingHeaders(input.model, input.idempotencyKey, input.candidate.upstreamModel),
    });
    const workerHeaders = maintenanceWorkerContextHeaders(input.credential);
    if (workerHeaders) Object.entries(workerHeaders).forEach(([key, value]) => headers.set(key, value));
    else if (input.credential) headers.set("cookie", input.credential);
    const response = await fetchInternalApi(`${input.origin}/api/ai/system/${encodeURIComponent(input.candidate.channelId)}/responses`, {
        method: "POST",
        headers,
        body: JSON.stringify({ ...input.body, stream: true }),
        cache: "no-store",
        signal: AbortSignal.timeout(Math.max(10 * 60_000, resolveModelRequestTimeoutMs(input.candidate, "text"))),
    });
    let billedHeaders = response.headers;
    try {
        const text = await readResponsesBody(response, (headers) => {
            billedHeaders = headers;
        });
        const argumentsText = strictJsonObjectText(text);
        if (!argumentsText) throw new Error("Doubao 视频理解没有返回完整的结构化分析");
        return { arguments: argumentsText, headers: billedHeaders };
    } catch (error) {
        await input.onInvalidResponse(billedHeaders);
        throw error;
    }
}
