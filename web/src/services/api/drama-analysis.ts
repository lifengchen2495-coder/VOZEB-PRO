"use client";

import { useUserStore } from "@/stores/use-user-store";
import { syncUserPointsFromHeaders } from "@/services/api/points";
import type { DramaAnalysisTask } from "@/lib/drama-analysis-task-contract";

type AnalysisTask<T> = Omit<DramaAnalysisTask, "result"> & { result?: T };
type PendingAnalysis = { requestId: string; taskId?: string; createdAt: number };
const pendingRequests = new Map<string, PendingAnalysis>();
const storagePrefix = "drama-analysis:";
const retentionMs = 24 * 60 * 60 * 1000;

// 相同输入的网络重试沿用任务身份，避免网关丢失响应后重复调用模型。
export async function requestDramaAnalysis<T>(url: string, input: Record<string, unknown>, options: { signal?: AbortSignal } = {}): Promise<T> {
    const userId = useUserStore.getState().user?.id;
    const identity = JSON.stringify([userId || "", url, canonical({ ...input, requestId: undefined })]);
    const digest = typeof crypto !== "undefined" && crypto.subtle ? Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity))), (value) => value.toString(16).padStart(2, "0")).join("") : undefined;
    const key = digest || identity;
    let pending = readPending(key, Boolean(digest)) || { requestId: String(input.requestId || crypto.randomUUID()), createdAt: Date.now() };
    writePending(key, pending, Boolean(digest));
    const assertSession = () => {
        options.signal?.throwIfAborted();
        if (useUserStore.getState().user?.id !== userId) throw new Error("登录状态已变化，请重新打开项目后继续分析");
    };
    const clearPending = () => {
        pendingRequests.delete(key);
        if (digest)
            try {
                sessionStorage.removeItem(storagePrefix + key);
            } catch {
                /* 浏览器可能禁用会话存储。 */
            }
    };
    const readResponse = async (response: Response): Promise<{ task?: AnalysisTask<T>; result?: T }> => {
        assertSession();
        syncUserPointsFromHeaders(response.headers, "system");
        const payload = (await response.json().catch(() => null)) as { data?: T | { task?: AnalysisTask<T> }; msg?: string } | null;
        if (!response.ok) {
            const error = new AnalysisRequestError(payload?.msg || (response.status === 504 ? "网关等待超时，后台分析可能仍在执行，请稍后继续" : `分析请求失败（HTTP ${response.status}），请稍后继续`), response.status);
            throw error;
        }
        if (!payload?.data) throw new AnalysisRequestError("分析服务返回了无效结果，请稍后继续", 502);
        if (typeof payload.data === "object" && "task" in payload.data && payload.data.task) return { task: payload.data.task };
        return { result: payload.data as T };
    };
    const finish = (task: AnalysisTask<T>) => {
        if (task.status === "success") {
            if (task.result === undefined) throw new AnalysisRequestError("分析任务缺少结果，请稍后继续", 502);
            clearPending();
            return { result: task.result };
        }
        if (task.status === "error" || task.status === "cancelled") {
            clearPending();
            throw new AnalysisRequestError(task.error || (task.status === "cancelled" ? "分析已取消" : "分析失败，请重试"), 400);
        }
        return undefined;
    };
    const send = async (target: string, init: RequestInit = {}) => {
        assertSession();
        const timeout = AbortSignal.timeout(20_000);
        return fetch(target, { ...init, cache: "no-store", signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout });
    };
    try {
        if (!pending.taskId) {
            for (let attempt = 0; ; attempt++) {
                try {
                    const response = await send(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...input, requestId: pending.requestId }) });
                    const payload = await readResponse(response);
                    if (payload.result !== undefined) {
                        clearPending();
                        return payload.result;
                    }
                    const task = payload.task!;
                    if (!task.id || !["pending", "running", "success", "error", "cancelled"].includes(task.status)) throw new AnalysisRequestError("分析任务状态无效，请稍后继续", 502);
                    pending = { ...pending, taskId: task.id };
                    writePending(key, pending, Boolean(digest));
                    const completed = finish(task);
                    if (completed) return completed.result;
                    break;
                } catch (error) {
                    assertSession();
                    if (!retryable(error) || attempt >= 2) throw error;
                    await delay((attempt + 1) * 1000, options.signal);
                }
            }
        }
        const deadline = Date.now() + 30 * 60 * 1000;
        let failures = 0;
        while (Date.now() < deadline) {
            await delay(Math.min(2000 * (failures + 1), 10000), options.signal);
            try {
                const payload = await readResponse(await send(`/api/drama/analysis-tasks/${encodeURIComponent(pending.taskId!)}`));
                if (!payload.task || payload.task.id !== pending.taskId || !["pending", "running", "success", "error", "cancelled"].includes(payload.task.status)) throw new AnalysisRequestError("分析任务状态无效，请稍后继续", 502);
                const completed = finish(payload.task);
                if (completed) return completed.result;
                failures = 0;
            } catch (error) {
                assertSession();
                if (!retryable(error) || ++failures >= 5) throw error;
            }
        }
        throw new Error("分析仍在后台执行，稍后再次点击可继续查询已有任务");
    } catch (error) {
        if (error instanceof AnalysisRequestError && !retryable(error)) clearPending();
        throw error;
    }
}

class AnalysisRequestError extends Error {
    constructor(
        message: string,
        readonly status: number,
    ) {
        super(message);
    }
}
function retryable(error: unknown) {
    return error instanceof AnalysisRequestError ? [408, 429, 500, 502, 503, 504].includes(error.status) : error instanceof TypeError || (error instanceof Error && error.name === "TimeoutError");
}
function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object")
        return Object.fromEntries(
            Object.entries(value)
                .filter(([, item]) => item !== undefined)
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([key, item]) => [key, canonical(item)]),
        );
    return value;
}
function readPending(key: string, persist: boolean) {
    let value = pendingRequests.get(key);
    if (!value && persist)
        try {
            value = JSON.parse(sessionStorage.getItem(storagePrefix + key) || "null") as PendingAnalysis | undefined;
        } catch {
            /* 会话存储不可用时仍可在当前页面重试。 */
        }
    return value && typeof value.requestId === "string" && (value.taskId === undefined || typeof value.taskId === "string") && Number.isFinite(value.createdAt) && Date.now() - value.createdAt < retentionMs ? value : undefined;
}
function writePending(key: string, value: PendingAnalysis, persist: boolean) {
    pendingRequests.set(key, value);
    if (persist)
        try {
            sessionStorage.setItem(storagePrefix + key, JSON.stringify(value));
        } catch {
            /* 隐私模式下使用内存保留任务身份。 */
        }
}
function delay(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
            reject(signal.reason);
            return;
        }
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", abort);
            resolve();
        }, ms);
        const abort = () => {
            clearTimeout(timer);
            reject(signal?.reason);
        };
        signal?.addEventListener("abort", abort, { once: true });
    });
}
