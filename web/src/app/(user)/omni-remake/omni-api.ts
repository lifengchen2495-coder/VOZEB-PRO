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
    return uploadVideo(new URLSearchParams({ projectId: id }), file);
}
export async function uploadOmniResult(id: string, segmentId: string, revision: number, file: File): Promise<OmniMedia & { uploadId: string }> {
    const asset = await uploadVideo(new URLSearchParams({ projectId: id, purpose: "result", segmentId, revision: String(revision) }), file);
    if (!asset.uploadId) throw new Error("上传结果缺少确认标识，请刷新页面后重试");
    return { ...asset, uploadId: asset.uploadId };
}
async function uploadVideo(params: URLSearchParams, file: File): Promise<OmniMedia & { uploadId?: string }> {
    if (file.size > 200 * 1024 * 1024) throw new Error("视频不能超过 200 MB");
    if (!file.size) throw new Error("视频文件为空");
    const response = await fetch(`/api/omni-remake/uploads?${params}`, { method: "POST", headers: { "Content-Type": file.type || "application/octet-stream", "X-File-Name": encodeURIComponent(file.name) }, body: file });
    const payload = (await response.json().catch(() => ({}))) as { data?: OmniMedia & { uploadId?: string }; msg?: string };
    if (!response.ok || !payload.data?.url) throw new Error(payload.msg || "视频上传失败");
    return payload.data;
}
export function omniEditable(project: OmniProject) {
    const { title, sourceVideo, productName, instructions, videoPromptInstructions, stageInstructions, productStrategy, replaceCharacter, replaceBackground, audioMode, references, modelSelection } = project;
    return { title, sourceVideo, productName, instructions, videoPromptInstructions, stageInstructions, productStrategy, replaceCharacter, replaceBackground, audioMode, references, modelSelection };
}
