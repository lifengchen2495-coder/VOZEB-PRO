import {
    normalizeRemakeProject,
    normalizeRemakeProjectList,
    normalizeRemakeTask,
    type RemakeCopyStrategy,
    type RemakeEditablePatch,
    type RemakeProject,
    type RemakeProjectList,
    type RemakeSourceVideo,
    type RemakeTask,
    type RemakeVoice,
} from "./remake-contract";

type ApiEnvelope<T = unknown> = {
    code?: number;
    data?: T | null;
    msg?: string;
};

type UnknownRecord = Record<string, unknown>;

export class RemakeRequestError extends Error {
    status: number;
    payload?: unknown;

    constructor(message: string, status: number, payload?: unknown) {
        super(message);
        this.name = "RemakeRequestError";
        this.status = status;
        this.payload = payload;
    }
}

export class RemakeConflictError extends RemakeRequestError {
    constructor(message: string, payload?: unknown) {
        super(message, 409, payload);
        this.name = "RemakeConflictError";
    }
}

function record(value: unknown): UnknownRecord {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as UnknownRecord) : {};
}

function dataFromEnvelope(value: unknown) {
    const envelope = record(value) as ApiEnvelope;
    return Object.prototype.hasOwnProperty.call(envelope, "data") ? envelope.data : value;
}

function messageFromEnvelope(value: unknown, fallback: string) {
    const envelope = record(value) as ApiEnvelope;
    return typeof envelope.msg === "string" && envelope.msg.trim() ? envelope.msg : fallback;
}

async function requestPayload(url: string, init?: RequestInit) {
    const response = await fetch(url, { cache: "no-store", ...init });
    const payload = (await response.json().catch(() => ({}))) as ApiEnvelope;
    if (!response.ok) {
        const fallback = response.status >= 500 ? `复刻工作区服务暂时不可用（HTTP ${response.status}），请稍后重试` : "复刻工作区请求失败";
        const message = messageFromEnvelope(payload, fallback);
        // 409 也用于任务输入校验；只有版本不一致才进入版本合并流程。
        if (response.status === 409 && message === "复刻项目已在其他页面更新，请刷新后重试") throw new RemakeConflictError(message, payload);
        throw new RemakeRequestError(message, response.status, payload);
    }
    return dataFromEnvelope(payload);
}

function projectFromPayload(value: unknown) {
    const payload = record(value);
    return normalizeRemakeProject(payload.project ?? value);
}

export async function listRemakeProjects(input: { page?: number; pageSize?: number } = {}): Promise<RemakeProjectList> {
    const query = new URLSearchParams({ page: String(input.page || 1), pageSize: String(input.pageSize || 12) });
    return normalizeRemakeProjectList(await requestPayload(`/api/remake-product/projects?${query}`));
}

export async function getRemakeProject(id: string): Promise<RemakeProject> {
    return projectFromPayload(await requestPayload(`/api/remake-product/projects/${encodeURIComponent(id)}`));
}

export async function createRemakeProject(input: { title: string; sourceCopy?: string; copyStrategy?: RemakeCopyStrategy; voice?: RemakeVoice }): Promise<RemakeProject> {
    return projectFromPayload(
        await requestPayload("/api/remake-product/projects", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(input),
        }),
    );
}

export async function saveRemakeProject(id: string, revision: number, patch: RemakeEditablePatch): Promise<RemakeProject> {
    return projectFromPayload(
        await requestPayload(`/api/remake-product/projects/${encodeURIComponent(id)}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...patch, revision }),
        }),
    );
}

export async function deleteRemakeProject(id: string) {
    await requestPayload(`/api/remake-product/projects/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function startRemakeAnalysis(id: string, retry = false): Promise<{ project: RemakeProject; task: RemakeTask }> {
    const value = await requestPayload(`/api/remake-product/projects/${encodeURIComponent(id)}/analysis`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(retry ? { retry: true } : {}),
    });
    const payload = record(value);
    return { project: projectFromPayload(payload), task: normalizeRemakeTask(payload.task) };
}

export async function buildRemakeProduction(id: string, revision: number, groupId?: string, inputVersion?: string): Promise<RemakeProject> {
    return projectFromPayload(
        await requestPayload(`/api/remake-product/projects/${encodeURIComponent(id)}/production`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ revision, groupId, inputVersion }),
        }),
    );
}


export async function getRemakeTask(id: string, signal?: AbortSignal) {
    const value = await requestPayload(`/api/remake-product/tasks/${encodeURIComponent(id)}`, { signal });
    const payload = record(value);
    return normalizeRemakeTask(payload.task ?? value);
}

export async function handoffRemakeProject(id: string): Promise<{ href: string; projectId: string }> {
    const value = await requestPayload(`/api/remake-product/projects/${encodeURIComponent(id)}/handoff`, { method: "POST" });
    const payload = record(value);
    const project = record(payload.project);
    const projectId = String(payload.projectId || project.id || "");
    const href = String(payload.href || (projectId ? `/drama/${encodeURIComponent(projectId)}` : ""));
    if (!href) throw new RemakeRequestError("短剧项目交接结果缺少跳转地址", 502, value);
    return { href, projectId };
}

export function uploadRemakeVideo(projectId: string, file: File, onProgress: (progress: number) => void, signal?: AbortSignal): Promise<RemakeSourceVideo> {
    return new Promise((resolve, reject) => {
        const query = new URLSearchParams(projectId ? { projectId } : {});
        const xhr = new XMLHttpRequest();
        xhr.open("POST", `/api/remake-product/uploads${query.size ? `?${query}` : ""}`);
        xhr.responseType = "json";
        xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
        xhr.setRequestHeader("X-File-Name", encodeURIComponent(file.name));
        xhr.upload.onprogress = (event) => {
            if (event.lengthComputable && event.total > 0) onProgress(Math.min(99, Math.round((event.loaded / event.total) * 100)));
        };
        xhr.onerror = () => reject(new RemakeRequestError("视频上传失败，请检查网络后重试", 0));
        xhr.onabort = () => reject(new DOMException("视频上传已取消", "AbortError"));
        xhr.onload = () => {
            const raw = xhr.response ?? safeJsonParse(xhr.responseText);
            if (xhr.status < 200 || xhr.status >= 300) return reject(new RemakeRequestError(messageFromEnvelope(raw, "视频上传失败"), xhr.status, raw));
            const value = record(dataFromEnvelope(raw));
            const url = String(value.url || value.upstreamUrl || "");
            if (!url) return reject(new RemakeRequestError("视频上传成功，但响应缺少媒体地址", 502, raw));
            onProgress(100);
            resolve({
                ...value,
                url,
                storageKey: String(value.storageKey || value.key || "") || undefined,
                mimeType: String(value.mimeType || file.type || "") || undefined,
                originalName: String(value.originalName || file.name || "") || undefined,
                bytes: Number(value.bytes || value.size || file.size) || undefined,
            });
        };
        const abort = () => xhr.abort();
        signal?.addEventListener("abort", abort, { once: true });
        xhr.addEventListener("loadend", () => signal?.removeEventListener("abort", abort));
        xhr.send(file);
    });
}

function safeJsonParse(value: string) {
    try {
        return JSON.parse(value) as unknown;
    } catch {
        return {};
    }
}

export async function mergeRemakeVideos(id: string, revision: number) {
    return projectFromPayload(await requestPayload(`/api/remake-product/projects/${encodeURIComponent(id)}/merge`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revision }) }));
}
