import type { BangbangMedia, BangbangProject } from "@/lib/bangbang-contract";

export async function bangbangResponse<T>(response: Response): Promise<T> {
    const payload = (await response.json().catch(() => ({}))) as { data?: T; msg?: string; error?: string | { message?: string }; message?: string };
    if (!response.ok) throw new Error(payload.msg || (typeof payload.error === "string" ? payload.error : payload.error?.message) || payload.message || `请求失败（${response.status}）`);
    return payload.data as T;
}
export async function bangbangRequest<T>(path: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Promise<T> {
    return bangbangResponse<T>(await fetch(`/api/bangbang${path}`, { method, cache: "no-store", ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) }));
}
export const bangbangProjectPath = (id: string) => `/projects/${encodeURIComponent(id)}`;
export async function uploadBangbangMedia(projectId: string, file: File): Promise<BangbangMedia> {
    const limit = file.type.startsWith("video/") ? 200 : 20;
    if (file.size > limit * 1024 * 1024) throw new Error(`文件不能超过 ${limit} MB`);
    const media = await bangbangResponse<BangbangMedia>(
        await fetch(`/api/bangbang/uploads?projectId=${encodeURIComponent(projectId)}`, { method: "POST", headers: { "Content-Type": file.type || "application/octet-stream", "X-File-Name": encodeURIComponent(file.name) }, body: file }),
    );
    if (!media?.url) throw new Error("上传失败：未返回素材地址");
    return media;
}
export function acceptsBangbangRefresh(current: BangbangProject | undefined, incoming: BangbangProject) {
    return !current || (current.id === incoming.id && incoming.revision >= current.revision);
}
