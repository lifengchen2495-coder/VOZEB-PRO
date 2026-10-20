export const ok = <T>(data: T) => Response.json({ code: 0, data, msg: "ok" });

export const fail = (error: unknown, status = 400) =>
    Response.json({ code: status, data: null, msg: error instanceof Error ? error.message : String(error) }, { status });

// 对话模式返回纯文本流，媒体模式返回 JSON；两者都通过响应头告知助手消息 ID
export function generationResponse({ assistantId, stream }: { assistantId: string; stream: AsyncGenerator<string> | null }) {
    if (!stream) return Response.json({ code: 0, data: { assistantId }, msg: "ok" }, { headers: { "x-assistant-id": assistantId } });
    const encoder = new TextEncoder();
    const body = new ReadableStream({
        async pull(controller) {
            const { value, done } = await stream.next();
            if (done) controller.close();
            else controller.enqueue(encoder.encode(value));
        },
        async cancel() {
            await stream.return(undefined);
        },
    });
    return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8", "x-assistant-id": assistantId, "cache-control": "no-store" } });
}
