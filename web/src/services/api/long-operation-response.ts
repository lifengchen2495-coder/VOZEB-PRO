type OperationResponse = { status: number; ok: boolean; payload: unknown };

export async function readLongOperationResponse(response: Response): Promise<OperationResponse> {
    if (!response.headers.get("content-type")?.includes("text/event-stream")) {
        return { status: response.status, ok: response.ok, payload: await response.json().catch(() => ({})) };
    }
    if (!response.body) throw new Error("处理连接已中断，结果尚未确认，请刷新项目查看当前状态");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    try {
        for (;;) {
            const chunk = await reader.read();
            pending = (pending + decoder.decode(chunk.value, { stream: !chunk.done })).replace(/\r\n/g, "\n");
            if (pending.length > 16 * 1024 * 1024) throw new Error("处理结果超过接收上限，请刷新项目查看已保存结果");
            let boundary: number;
            while ((boundary = pending.indexOf("\n\n")) !== -1) {
                const frame = pending.slice(0, boundary);
                pending = pending.slice(boundary + 2);
                const lines = frame.split("\n");
                if (!lines.some((line) => line.trim() === "event: result")) continue;
                let result: { status?: unknown; payload?: unknown };
                try {
                    result = JSON.parse(lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n"));
                } catch {
                    throw new Error("处理结果格式不正确，请刷新项目查看当前状态");
                }
                if (!result || typeof result.status !== "number" || !Number.isInteger(result.status) || result.status < 200 || result.status > 599 || !("payload" in result)) {
                    throw new Error("处理结果不完整，请刷新项目查看当前状态");
                }
                return { status: result.status, ok: result.status < 300, payload: result.payload };
            }
            if (chunk.done) throw new Error("处理连接已中断，结果尚未确认，请刷新项目查看当前状态");
        }
    } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
    }
}
