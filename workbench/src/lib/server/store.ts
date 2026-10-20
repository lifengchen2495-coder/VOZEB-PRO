import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Conversation, ConversationSummary, Media, PublicSettings, Settings } from "@/lib/types";

const root = path.resolve(process.env.WORKBENCH_DATA_DIR || ".data");
const dirs = { conversations: path.join(root, "conversations"), media: path.join(root, "media") };
const settingsFile = path.join(root, "settings.json");

const mimeByExt: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime" };
const extByMime = Object.fromEntries(Object.entries(mimeByExt).map(([ext, mime]) => [mime, ext]));

async function writeJson(file: string, value: unknown) {
    await mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(value, null, 2), "utf8");
    await rename(temp, file);
}

async function readJson<T>(file: string): Promise<T | null> {
    try {
        return JSON.parse(await readFile(file, "utf8")) as T;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
    }
}

export async function getSettings(): Promise<Settings> {
    const saved = (await readJson<Partial<Settings>>(settingsFile)) || {};
    return {
        baseUrl: saved.baseUrl || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
        apiKey: saved.apiKey || process.env.OPENAI_API_KEY || "",
        textModel: saved.textModel || process.env.TEXT_MODEL || "gpt-4o-mini",
        imageModel: saved.imageModel || process.env.IMAGE_MODEL || "gpt-image-1",
        videoModel: saved.videoModel || process.env.VIDEO_MODEL || "sora-2",
        systemPrompt: saved.systemPrompt ?? "",
    };
}

export function toPublicSettings({ apiKey, ...rest }: Settings): PublicSettings {
    return { ...rest, hasApiKey: Boolean(apiKey) };
}

export async function saveSettings(patch: Partial<Settings>) {
    const saved = (await readJson<Partial<Settings>>(settingsFile)) || {};
    const next = { ...saved };
    for (const key of ["baseUrl", "apiKey", "textModel", "imageModel", "videoModel", "systemPrompt"] as const) {
        const value = patch[key];
        if (typeof value !== "string") continue;
        // 空密钥表示保持原值，避免设置页回显时清掉已保存的 Key
        if (key === "apiKey" && !value.trim()) continue;
        next[key] = value.trim();
    }
    await writeJson(settingsFile, next);
    return getSettings();
}

const conversationFile = (id: string) => {
    if (!/^[\w-]+$/.test(id)) throw new Error("无效的会话 ID");
    return path.join(dirs.conversations, `${id}.json`);
};

export const getConversation = (id: string) => readJson<Conversation>(conversationFile(id));

export async function listConversations(): Promise<ConversationSummary[]> {
    await mkdir(dirs.conversations, { recursive: true });
    const files = (await readdir(dirs.conversations)).filter((name) => name.endsWith(".json"));
    const items = await Promise.all(files.map((name) => readJson<Conversation>(path.join(dirs.conversations, name))));
    return items
        .filter((item): item is Conversation => Boolean(item))
        .map(({ messages, ...rest }) => ({ ...rest, count: messages.length, pending: messages.some((m) => m.status === "pending") }))
        .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function createConversation(title = "新对话") {
    const now = Date.now();
    const conversation: Conversation = { id: randomUUID(), title, createdAt: now, updatedAt: now, messages: [] };
    await writeJson(conversationFile(conversation.id), conversation);
    return conversation;
}

// 同一会话的写入串行执行，避免后台任务与用户操作互相覆盖
const queues = new Map<string, Promise<unknown>>();

export function updateConversation(id: string, mutate: (conversation: Conversation) => void) {
    const run = (queues.get(id) || Promise.resolve()).then(async () => {
        const conversation = await getConversation(id);
        if (!conversation) throw new Error("会话不存在");
        mutate(conversation);
        conversation.updatedAt = Date.now();
        await writeJson(conversationFile(id), conversation);
        return conversation;
    });
    queues.set(id, run.catch(() => undefined));
    return run;
}

export async function deleteConversation(id: string) {
    const conversation = await getConversation(id);
    if (!conversation) return;
    await rm(conversationFile(id), { force: true });
    const ids = conversation.messages.flatMap((m) => [...(m.attachments || []), ...(m.results || [])]).map((m) => m.id);
    await Promise.all(ids.map((mediaId) => rm(mediaPath(mediaId), { force: true })));
}

export function mediaPath(id: string) {
    if (!/^[\w-]+\.[a-z0-9]+$/.test(id)) throw new Error("无效的媒体 ID");
    return path.join(dirs.media, id);
}

export const mediaMime = (id: string) => mimeByExt[id.split(".").pop() || ""] || "application/octet-stream";

export async function saveMedia(bytes: Uint8Array, mime: string, name?: string): Promise<Media> {
    const ext = extByMime[mime.split(";")[0].trim()];
    if (!ext) throw new Error(`不支持的媒体类型：${mime}`);
    const id = `${randomUUID()}.${ext}`;
    await mkdir(dirs.media, { recursive: true });
    await writeFile(mediaPath(id), bytes);
    return { id, url: `/api/media/${id}`, kind: mime.startsWith("video/") ? "video" : "image", mime: mimeByExt[ext], name };
}

export async function readMedia(id: string) {
    return { bytes: await readFile(mediaPath(id)), mime: mediaMime(id) };
}
