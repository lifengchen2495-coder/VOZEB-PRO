const HEARTBEAT_INTERVAL_MS = 10_000;

// 认证和请求校验仍由路由执行；长操作只把最终 HTTP 结果封装进带心跳的响应。
export function streamLongOperation(request: Request, operation: () => Promise<Response>): Response | Promise<Response> {
    if (!request.headers.get("accept")?.includes("text/event-stream")) return operation();

    const encoder = new TextEncoder();
    let closed = false;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let abortListener: (() => void) | undefined;
    const stop = () => {
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        if (abortListener) request.signal.removeEventListener("abort", abortListener);
    };
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            const close = () => {
                if (closed) return;
                stop();
                controller.close();
            };
            const send = (value: string) => {
                if (!closed) controller.enqueue(encoder.encode(value));
            };
            abortListener = close;
            if (request.signal.aborted) return close();
            request.signal.addEventListener("abort", close, { once: true });
            send(": started\n\n");
            heartbeat = setInterval(() => send(": heartbeat\n\n"), HEARTBEAT_INTERVAL_MS);
            void (async () => {
                let status: number;
                let payload: unknown;
                try {
                    const result = await operation();
                    status = result.status;
                    payload = await result.json();
                } catch (error) {
                    console.error("复刻长操作执行失败", error);
                    status = 500;
                    payload = { code: status, data: null, msg: "复刻处理失败，请稍后重试" };
                }
                if (closed) return;
                send(`event: result\ndata: ${JSON.stringify({ status, payload })}\n\n`);
                close();
            })();
        },
        cancel() {
            // 断开页面仅停止传输，已启动的业务继续完成保存或退款。
            stop();
        },
    });
    return new Response(body, {
        headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" },
    });
}
