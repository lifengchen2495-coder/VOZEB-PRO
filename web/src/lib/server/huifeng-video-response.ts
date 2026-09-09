export const HUIFENG_VIDEO_POLL_INTERVAL_MS = 5_000;

type HuifengVideoStep =
    | { state: "pending"; status: string }
    | { state: "result_ready"; status: string; resultUrl: string }
    | { state: "failed"; status: string; error: string };

export function parseHuifengVideoCreateResponse(value: unknown): { id: string; error?: string } {
    const response = record(value);
    if (!response) return { id: "" };
    const data = record(response.data);
    const id = taskId(data?.task_id) || taskId(response.task_id);
    // 有效任务 ID 优先于展示文案，防止“部分失败”等消息触发重复提交。
    if (id) return { id };
    const code = typeof response.code === "number" ? response.code : typeof response.code === "string" && /^\d{3}$/.test(response.code.trim()) ? Number(response.code) : undefined;
    if (code !== undefined && Number.isInteger(code) && code >= 400 && code <= 599) {
        return { id: "", error: text(response.error) || text(response.msg) || `汇风视频请求失败（${code}）` };
    }
    return { id: "" };
}

export function parseHuifengVideoStatus(value: unknown, expectedTaskId: string): HuifengVideoStep {
    const response = record(value);
    if (!response || typeof response.is_final !== "boolean" || typeof response.state !== "string") {
        throw new Error("汇风视频查询响应不完整，原任务已保留，请稍后检查状态");
    }
    const responseTaskId = taskId(response.task_id);
    if (!responseTaskId || responseTaskId !== expectedTaskId) throw new Error("汇风视频查询返回了不匹配的任务 ID，原任务已保留");
    const status = response.state.trim().toLowerCase();
    if (!response.is_final && ["pending", "running", "success", "failed"].includes(status)) return { state: "pending", status };
    if (response.is_final && status === "failed") return { state: "failed", status, error: text(response.error) || "汇风视频生成失败" };
    if (response.is_final && status === "success") {
        const resultUrl = text(response.result_url);
        if (response.result_type !== undefined && response.result_type !== "video") throw new Error("汇风任务返回的结果不是视频，原任务已保留");
        if (!httpUrl(resultUrl)) throw new Error("汇风视频任务已完成但未返回有效视频地址，原任务已保留");
        return { state: "result_ready", status, resultUrl };
    }
    throw new Error("汇风视频查询返回了无法确认的状态，原任务已保留，请稍后检查状态");
}

function record(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function taskId(value: unknown) {
    if (typeof value === "number") return Number.isSafeInteger(value) && value > 0 ? String(value) : "";
    return typeof value === "string" ? value.trim() : "";
}

function text(value: unknown) {
    return typeof value === "string" ? value.trim() : "";
}

function httpUrl(value: string) {
    try {
        const url = new URL(value);
        return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password;
    } catch {
        return false;
    }
}
