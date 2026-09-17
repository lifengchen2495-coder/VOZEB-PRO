type ImageRequest = { src: string; signal: AbortSignal; onRetry?: (retry: number, delayMs: number) => void };
type ImageJob = { signal: AbortSignal; start: () => Promise<void>; reject: (error: unknown) => void; cancel: () => void };

const pending: ImageJob[] = [];
const maxConcurrent = 4;
const maxRetries = 3;
let active = 0;

export class MediaImageRedirectError extends Error {
    constructor() {
        super("图片地址发生重定向，改用浏览器加载");
        this.name = "MediaImageRedirectError";
    }
}

function aborted() {
    return new DOMException("图片加载已取消", "AbortError");
}

function waitForRetry(delayMs: number, signal: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal.aborted) return reject(aborted());
        const cancel = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", cancel);
            reject(aborted());
        };
        const timer = setTimeout(() => {
            signal.removeEventListener("abort", cancel);
            resolve();
        }, delayMs);
        signal.addEventListener("abort", cancel, { once: true });
    });
}

function retryDelay(value: string | null, retry: number) {
    if (value?.trim()) {
        const seconds = Number(value);
        if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
        const date = Date.parse(value);
        if (Number.isFinite(date)) return Math.max(0, date - Date.now());
    }
    return 1000 * 2 ** retry;
}

async function readImage(job: ImageRequest) {
    for (let retry = 0; ; retry++) {
        if (job.signal.aborted) throw aborted();
        const controller = new AbortController();
        const cancel = () => controller.abort();
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, 30_000);
        job.signal.addEventListener("abort", cancel, { once: true });
        let delayMs: number | undefined;
        try {
            const response = await fetch(job.src, { signal: controller.signal, credentials: "same-origin", redirect: "manual" });
            if (response.type === "opaqueredirect") throw new MediaImageRedirectError();
            if (response.status === 429) {
                delayMs = retryDelay(response.headers.get("Retry-After"), retry);
                await response.body?.cancel();
                if (retry >= maxRetries || delayMs > 60_000) throw new Error("图片请求繁忙，请稍后重试");
            } else {
                if (!response.ok) {
                    await response.body?.cancel();
                    throw new Error(response.status === 401 || response.status === 403 ? "图片访问已失效，请刷新页面" : `图片加载失败（${response.status}）`);
                }
                // 服务端会在流读取完成后释放配额；收到响应头时不能提前让下一张开始。
                const blob = await response.blob();
                if (timedOut) throw new Error("图片加载超时，请重试");
                if (job.signal.aborted) throw aborted();
                if (!blob.size) throw new Error("图片内容为空，请重试");
                return blob;
            }
        } catch (error) {
            if (job.signal.aborted) throw aborted();
            if (timedOut) throw new Error("图片加载超时，请重试");
            throw error;
        } finally {
            clearTimeout(timer);
            job.signal.removeEventListener("abort", cancel);
        }
        if (delayMs !== undefined) {
            job.onRetry?.(retry + 1, delayMs);
            await waitForRetry(delayMs, job.signal);
        }
    }
}

function drainQueue() {
    while (active < maxConcurrent && pending.length) {
        const job = pending.shift()!;
        job.signal.removeEventListener("abort", job.cancel);
        if (job.signal.aborted) {
            job.reject(aborted());
            continue;
        }
        active++;
        void job.start().finally(() => {
            active--;
            drainQueue();
        });
    }
}

function enqueueImage<T>(read: () => Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
        if (signal.aborted) return reject(aborted());
        const job: ImageJob = {
            signal,
            start: async () => {
                try {
                    resolve(await read());
                } catch (error) {
                    reject(error);
                }
            },
            reject,
            cancel: () => {
                const index = pending.indexOf(job);
                if (index >= 0) {
                    pending.splice(index, 1);
                    reject(aborted());
                }
            },
        };
        pending.push(job);
        signal.addEventListener("abort", job.cancel, { once: true });
        drainQueue();
    });
}

export function queueMediaImage(src: string, signal: AbortSignal, onRetry?: ImageRequest["onRetry"]): Promise<Blob> {
    return enqueueImage(() => readImage({ src, signal, onRetry }), signal);
}

// 对象存储可能把私有入口重定向到未开放 CORS 的签名地址。
// 仅在重定向或 fetch 网络/CORS 失败后使用，并与 blob 请求共用相同的并发上限。
export function queueNativeMediaImage(src: string, signal: AbortSignal): Promise<HTMLImageElement> {
    return enqueueImage(
        () =>
            new Promise((resolve, reject) => {
                const image = new window.Image();
                const cleanup = () => {
                    clearTimeout(timer);
                    image.onload = null;
                    image.onerror = null;
                    signal.removeEventListener("abort", cancel);
                };
                const fail = (error: Error) => {
                    cleanup();
                    image.removeAttribute("src");
                    reject(error);
                };
                const cancel = () => fail(aborted());
                const timer = setTimeout(() => fail(new Error("图片加载超时，请重试")), 30_000);
                image.onload = () => {
                    cleanup();
                    resolve(image);
                };
                image.onerror = () => fail(new Error("图片加载失败，请重试"));
                signal.addEventListener("abort", cancel, { once: true });
                if (signal.aborted) cancel();
                else image.src = src;
            }),
        signal,
    );
}
