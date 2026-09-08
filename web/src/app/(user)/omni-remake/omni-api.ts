import type { OmniProject, OmniMedia } from "@/lib/omni-remake-contract";

export async function omniRequest<T>(path: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Promise<T> {
    const response = await fetch(`/api/omni-remake${path}`, { method, cache: "no-store", ...(body !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
    const payload = (await response.json().catch(() => ({}))) as { data?: T; msg?: string };
    if (!response.ok) throw new Error(payload.msg || `请求失败（${response.status}）`);
    return payload.data as T;
}
export function omniProjectPath(id: string) {
    return `/projects/${encodeURIComponent(id)}`;
}
export async function uploadOmniVideo(id: string, file: File): Promise<OmniMedia> {
    if (file.size > 200 * 1024 * 1024) throw new Error("参考视频不能超过 200 MB");
    const response = await fetch(`/api/omni-remake/uploads?projectId=${encodeURIComponent(id)}`, { method: "POST", headers: { "Content-Type": file.type || "application/octet-stream", "X-File-Name": encodeURIComponent(file.name) }, body: file });
    const payload = (await response.json()) as { data?: OmniMedia; msg?: string };
    if (!response.ok || !payload.data?.url) throw new Error(payload.msg || "视频上传失败");
    return payload.data;
}
export function omniEditable(project: OmniProject) {
    const { title, sourceVideo, productName, instructions, productStrategy, replaceCharacter, replaceBackground, audioMode, references, modelSelection } = project;
    return { title, sourceVideo, productName, instructions, productStrategy, replaceCharacter, replaceBackground, audioMode, references, modelSelection };
}
