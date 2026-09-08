import type { OmniClothingAsset, OmniClothingProject, OmniClothingProjectSummaryPage } from "@/lib/omni-clothing-contract";
import { throwIfClientSessionExpired } from "@/services/api/session-expiration";

const ROOT = "/api/omni-clothing";
async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${ROOT}${path}`, { cache: "no-store", ...init });
    throwIfClientSessionExpired(response);
    const payload = (await response.json().catch(() => ({}))) as { data?: T; msg?: string; error?: string };
    if (!response.ok || payload.data === undefined) throw new Error(payload.msg || payload.error || "服装项目请求失败");
    return payload.data;
}
function json(method: string, body: unknown): RequestInit {
    return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}
export function listClothingProjects(page = 1) {
    return request<OmniClothingProjectSummaryPage>(`/projects?page=${page}&pageSize=12`);
}
export async function createClothingProject(title: string) {
    return (await request<{ project: OmniClothingProject }>("/projects", json("POST", { title }))).project;
}
export async function loadClothingProject(id: string) {
    return (await request<{ project: OmniClothingProject }>(`/projects/${encodeURIComponent(id)}`)).project;
}
export async function saveClothingProject(id: string, input: Record<string, unknown>) {
    return (await request<{ project: OmniClothingProject }>(`/projects/${encodeURIComponent(id)}`, json("PATCH", input))).project;
}
export async function clothingAction(id: string, action: string, input: Record<string, unknown>) {
    return (await request<{ project: OmniClothingProject }>(`/projects/${encodeURIComponent(id)}`, json("POST", { ...input, action }))).project;
}
export function deleteClothingProject(id: string) {
    return request(`/projects/${encodeURIComponent(id)}`, { method: "DELETE" });
}
export async function uploadClothingAsset(id: string, file: File, type: "image" | "video") {
    const maximum = (type === "image" ? 20 : 200) * 1024 * 1024;
    if (!file.size || file.size > maximum) throw new Error(`文件需大于 0 且不超过 ${type === "image" ? 20 : 200} MB`);
    return (
        await request<{ asset: OmniClothingAsset }>(`/uploads?projectId=${encodeURIComponent(id)}&type=${type}`, {
            method: "POST",
            headers: { "Content-Type": file.type || "application/octet-stream", "X-File-Name": encodeURIComponent(file.name) },
            body: file,
        })
    ).asset;
}
export async function downloadClothingBundle(id: string, title: string) {
    const response = await fetch(`${ROOT}/projects/${encodeURIComponent(id)}/export`);
    throwIfClientSessionExpired(response);
    if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.msg || "完整包导出失败");
    }
    const url = URL.createObjectURL(await response.blob());
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${title}-服装复刻完整包.zip`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
