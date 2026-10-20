import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Asset, Conversation, ConversationSummary, Media, Mode, PublicSettings, Settings, Task, Workspace } from "@/lib/types";

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

const modeLabels: Record<Mode, string> = { chat: "对话", image: "图片", video: "视频" };
const envModels: Record<Mode, string | undefined> = { chat: process.env.TEXT_MODELS, image: process.env.IMAGE_MODELS, video: process.env.VIDEO_MODELS };
const defaultModels: Record<Mode, string> = { chat: "gpt-4o-mini", image: "gpt-image-1", video: "sora-2" };
const modelList = (value: unknown) => [...new Set((Array.isArray(value) ? value : String(value || "").split(",")).map((m) => String(m).trim()).filter(Boolean))];

export async function getSettings(): Promise<Settings> {
    const saved = (await readJson<Partial<Settings>>(settingsFile)) || {};
    const models = Object.fromEntries(
        (Object.keys(modeLabels) as Mode[]).map((mode) => {
            const list = modelList(saved.models?.[mode] ?? envModels[mode]);
            return [mode, list.length ? list : [defaultModels[mode]]];
        }),
    ) as Record<Mode, string[]>;
    return {
        baseUrl: saved.baseUrl || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
        apiKey: saved.apiKey || process.env.OPENAI_API_KEY || "",
        systemPrompt: saved.systemPrompt ?? "",
        models,
    };
}

export function toPublicSettings({ apiKey, ...rest }: Settings): PublicSettings {
    return { ...rest, hasApiKey: Boolean(apiKey), dataDir: root };
}

export async function saveSettings(patch: Partial<Settings>) {
    const saved = (await readJson<Partial<Settings>>(settingsFile)) || {};
    const next = { ...saved };
    for (const key of ["baseUrl", "apiKey", "systemPrompt"] as const) {
        const value = patch[key];
        if (typeof value !== "string") continue;
        // 空密钥表示保持原值，避免设置页回显时清掉已保存的 Key
        if (key === "apiKey" && !value.trim()) continue;
        next[key] = value.trim();
    }
    if (patch.models) {
        const models = { ...(await getSettings()).models };
        for (const mode of Object.keys(modeLabels) as Mode[]) {
            if (!patch.models[mode]) continue;
            models[mode] = modelList(patch.models[mode]);
            if (!models[mode].length) throw new Error(`请至少填写一个${modeLabels[mode]}模型`);
        }
        next.models = models;
    }
    await writeJson(settingsFile, next);
    return getSettings();
}

const conversationFile = (id: string) => {
    if (!/^[\w-]+$/.test(id)) throw new Error("无效的会话 ID");
    return path.join(dirs.conversations, `${id}.json`);
};

export const getConversation = (id: string) => readJson<Conversation>(conversationFile(id));

async function allConversations() {
    await mkdir(dirs.conversations, { recursive: true });
    const files = (await readdir(dirs.conversations)).filter((name) => name.endsWith(".json"));
    const items = await Promise.all(files.map((name) => readJson<Conversation>(path.join(dirs.conversations, name))));
    return items.filter((item): item is Conversation => Boolean(item));
}

export async function listConversations(): Promise<ConversationSummary[]> {
    return (await allConversations())
        .map(({ messages, ...rest }) => ({ ...rest, count: messages.length, pending: messages.some((m) => m.status === "pending") }))
        .sort((a, b) => b.updatedAt - a.updatedAt);
}

// 单用户本地数据量有限，直接汇总全部对话生成素材库、任务列表和统计
export async function getWorkspace(): Promise<Workspace> {
    const conversations = await allConversations();
    // 同一文件被多次引用时素材库只保留一份，生成结果优先于参考图
    const assetMap = new Map<string, Asset>();
    const addAsset = (asset: Asset) => {
        const prev = assetMap.get(asset.id);
        if (!prev || (prev.source === "reference" && asset.source === "result")) assetMap.set(asset.id, asset);
    };
    const tasks: Task[] = [];
    for (const c of conversations) {
        const base = { conversationId: c.id, conversationTitle: c.title };
        c.messages.forEach((message, index) => {
            const request = message.role === "assistant" ? c.messages[index - 1] : message;
            const prompt = request?.content || "";
            const createdAt = message.finishedAt || message.createdAt;
            for (const media of message.attachments || []) addAsset({ ...media, ...base, source: "reference", mode: message.mode, prompt, messageId: message.id, createdAt });
            for (const media of message.results || []) addAsset({ ...media, ...base, source: "result", mode: message.mode, prompt, model: message.model, messageId: message.id, createdAt });
            if (message.role !== "assistant" || message.mode === "chat") return;
            const { id, mode, model, status, error, results, finishedAt } = message;
            tasks.push({ id, mode, model, status, error, results, createdAt: message.createdAt, finishedAt, prompt, params: request?.params, ...base });
        });
    }
    const assets = [...assetMap.values()];
    const results = assets.filter((a) => a.source === "result");
    return {
        assets: assets.sort((a, b) => b.createdAt - a.createdAt),
        tasks: tasks.sort((a, b) => b.createdAt - a.createdAt),
        stats: {
            conversations: conversations.length,
            images: results.filter((a) => a.kind === "image").length,
            videos: results.filter((a) => a.kind === "video").length,
            running: tasks.filter((t) => t.status === "pending").length,
            failed: tasks.filter((t) => t.status === "failed").length,
        },
    };
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

const mediaIdsOf = (conversation: Conversation) => conversation.messages.flatMap((m) => [...(m.attachments || []), ...(m.results || [])]).map((m) => m.id);

// 删除会话时一并删除媒体文件，但保留仍被其他会话引用的素材
export async function deleteConversation(id: string) {
    const conversation = await getConversation(id);
    if (!conversation) return;
    await rm(conversationFile(id), { force: true });
    const others = await Promise.all((await readdir(dirs.conversations)).filter((name) => name.endsWith(".json")).map((name) => readJson<Conversation>(path.join(dirs.conversations, name))));
    const used = new Set(others.flatMap((c) => (c ? mediaIdsOf(c) : [])));
    await Promise.all(mediaIdsOf(conversation).filter((mediaId) => !used.has(mediaId)).map((mediaId) => rm(mediaPath(mediaId), { force: true })));
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
