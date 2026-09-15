import type { FrameRemakeMedia } from "@/lib/frame-remake-contract";
export async function frameRemakeResponse<T>(response: Response): Promise<T> {
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(typeof payload.error === "string" ? payload.error : payload.message || `请求失败（${response.status}）`);
    return payload.data as T;
}
export async function frameRemakeRequest<T>(path: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Promise<T> {
    return frameRemakeResponse<T>(await fetch(`/api/frame-remake${path}`, { method, cache: "no-store", ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) }));
}
export const frameRemakeProjectPath = (id: string) => `/projects/${encodeURIComponent(id)}`;
export async function uploadFrameRemakeMedia(projectId: string, file: File): Promise<FrameRemakeMedia> {
    const limit = file.type.startsWith("video/") ? 200 : 20;
    if (file.size > limit * 1024 * 1024) throw new Error(`文件不能超过 ${limit} MB`);
    const media = await frameRemakeResponse<FrameRemakeMedia>(
        await fetch(`/api/frame-remake/uploads?projectId=${encodeURIComponent(projectId)}`, { method: "POST", headers: { "Content-Type": file.type || "application/octet-stream", "X-File-Name": encodeURIComponent(file.name) }, body: file }),
    );
    if (media.bytes !== file.size) throw new Error("文件上传不完整，请重新上传");
    return media;
}
