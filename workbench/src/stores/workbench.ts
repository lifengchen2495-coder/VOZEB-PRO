"use client";

import { create } from "zustand";
import type { Conversation, ConversationSummary, Media, Mode, PublicSettings, Workspace } from "@/lib/types";
import { api, retryMessage, sendMessage } from "@/services/api";

// 发送前的参考素材只保存在内存里：本地文件发送时才上传，已有素材直接复用 ID
export type DraftItem = { key: string; url: string; name: string; file?: File; media?: Media };

export const defaultParams: Record<Mode, Record<string, string>> = { chat: {}, image: { size: "auto", quality: "auto", n: "1" }, video: { seconds: "auto", size: "auto" } };

// OpenAI 视频接口只接受一张 input_reference
export const referenceLimit = (mode: Mode) => (mode === "video" ? 1 : Infinity);

type State = {
    settings: PublicSettings | null;
    list: ConversationSummary[];
    conversation: Conversation | null;
    stream: Record<string, string>;
    busy: boolean;
    notice: { text: string; type: "success" | "error"; at: number } | null;
    mode: Mode;
    models: Partial<Record<Mode, string>>;
    params: Record<Mode, Record<string, string>>;
    prompt: string;
    attachments: DraftItem[];
    optimizing: boolean;
    workspace: Workspace | null;
    paletteOpen: boolean;
    assetsOpen: boolean;
};

const initial: State = {
    settings: null,
    list: [],
    conversation: null,
    stream: {},
    busy: false,
    notice: null,
    mode: "chat",
    models: {},
    params: defaultParams,
    prompt: "",
    attachments: [],
    optimizing: false,
    workspace: null,
    paletteOpen: false,
    assetsOpen: true,
};

export const useWorkbench = create<State>(() => initial);

const set = useWorkbench.setState;
const get = useWorkbench.getState;
let activeId: string | null = null;

const fail = (error: unknown) => set({ notice: { text: error instanceof Error ? error.message : String(error), type: "error", at: Date.now() } });

function releaseDraft(items: DraftItem[]) {
    for (const item of items) if (item.file) URL.revokeObjectURL(item.url);
}

export const workbench = {
    notify: (text: string, type: "success" | "error" = "success") => set({ notice: { text, type, at: Date.now() } }),
    setPrompt: (prompt: string) => set({ prompt }),
    setMode: (mode: Mode) => set((s) => ({ mode, attachments: s.attachments.slice(0, referenceLimit(mode)) })),
    setModel: (mode: Mode, model: string) => set((s) => ({ models: { ...s.models, [mode]: model } })),
    setParam: (key: string, value: string) => set((s) => ({ params: { ...s.params, [s.mode]: { ...s.params[s.mode], [key]: value } } })),
    toggle: (key: "paletteOpen" | "assetsOpen", value?: boolean) => set((s) => ({ [key]: value ?? !s[key] })),

    loadSettings: () => api.settings().then((settings) => set({ settings }), fail),
    loadWorkspace: () => api.workspace().then((workspace) => set({ workspace }), fail),

    // 从总览或素材库进入创作：新开对话并预设创作类型或参考图
    startNew(mode?: Mode, media?: Media) {
        void workbench.open(null);
        if (mode) workbench.setMode(mode);
        if (media) workbench.reference(media);
    },

    async retryTask(conversationId: string, messageId: string) {
        try {
            await retryMessage(conversationId, messageId, () => undefined);
        } catch (error) {
            fail(error);
        }
        if (get().conversation?.id === conversationId) await workbench.open(conversationId);
        await workbench.loadWorkspace();
    },

    refreshList: () => api.conversations().then((list) => set({ list }), fail),

    async open(id: string | null) {
        // 切换或新建对话时释放未发送的本地素材
        if (id !== activeId) {
            releaseDraft(get().attachments);
            set({ attachments: [], prompt: "" });
        }
        activeId = id;
        if (!id) return set({ conversation: null });
        try {
            const conversation = await api.conversation(id);
            if (activeId === id) set({ conversation });
        } catch (error) {
            fail(error);
        }
    },

    addFiles(files: File[]) {
        const { mode, attachments } = get();
        const images = files.filter((file) => file.type.startsWith("image/"));
        if (images.length < files.length) fail("参考素材只支持图片");
        const room = referenceLimit(mode) - attachments.length;
        const items = images.slice(0, Math.max(0, room)).map((file) => ({ key: crypto.randomUUID(), url: URL.createObjectURL(file), name: file.name, file }));
        if (images.length > room) fail(mode === "video" ? "视频只能使用一张参考图" : "参考素材数量已达上限");
        set({ attachments: [...attachments, ...items] });
    },

    removeAttachment(key: string) {
        const { attachments } = get();
        releaseDraft(attachments.filter((item) => item.key === key));
        set({ attachments: attachments.filter((item) => item.key !== key) });
    },

    // 引用当前对话中的已有图片，再次点击取消引用
    reference(media: Media) {
        const { attachments, mode } = get();
        if (attachments.some((item) => item.media?.id === media.id)) return set({ attachments: attachments.filter((item) => item.media?.id !== media.id) });
        const nextMode = mode === "chat" ? "image" : mode;
        if (attachments.length >= referenceLimit(nextMode)) return fail(nextMode === "video" ? "视频只能使用一张参考图，请先移除当前参考图" : "参考素材数量已达上限");
        set({ mode: nextMode, attachments: [...attachments, { key: media.id, url: media.url, name: media.name || "参考图", media }] });
    },

    async optimize() {
        const { prompt, mode } = get();
        if (!prompt.trim() || get().optimizing) return;
        set({ optimizing: true });
        try {
            const text = await api.optimizePrompt(mode, prompt);
            // 用户在等待期间继续编辑或已发送时，丢弃迟到的结果
            if (get().prompt === prompt) set({ prompt: text });
        } catch (error) {
            fail(error);
        } finally {
            set({ optimizing: false });
        }
    },

    async run(conversationId: string, action: () => ReturnType<typeof sendMessage>) {
        set({ busy: true });
        try {
            await action();
            return true;
        } catch (error) {
            fail(error);
            return false;
        } finally {
            if (activeId === conversationId) await workbench.open(conversationId);
            set({ stream: {}, busy: false });
            void workbench.refreshList();
            void workbench.loadWorkspace();
        }
    },

    onText(conversationId: string) {
        return (assistantId: string, text: string) => {
            if (!text) return void workbench.open(conversationId);
            set((s) => ({ stream: { ...s.stream, [assistantId]: (s.stream[assistantId] || "") + text } }));
        };
    },

    async send() {
        const { prompt, mode, attachments, params, models, settings, busy, conversation } = get();
        if (!prompt.trim() || busy) return;
        set({ busy: true });
        try {
            const media = await Promise.all(attachments.map((item) => item.media || api.upload(item.file!)));
            // 本地文件上传后改为引用已保存的素材，发送失败重试时不会重复上传
            releaseDraft(attachments);
            const uploaded = media.map((m, i) => ({ key: attachments[i].key, url: m.url, name: attachments[i].name, media: m }));
            if (get().attachments === attachments) set({ attachments: uploaded });
            const id = conversation?.id || (await api.createConversation()).id;
            if (!conversation) {
                activeId = id;
                set({ conversation: { id, title: "新对话", createdAt: Date.now(), updatedAt: Date.now(), messages: [] } });
            }
            const model = models[mode] && settings?.models[mode].includes(models[mode]!) ? models[mode] : undefined;
            const body = { mode, prompt, model, attachmentIds: media.map((m) => m.id), params: params[mode] };
            const onText = workbench.onText(id);
            await workbench.run(id, () =>
                sendMessage(id, body, (assistantId, text) => {
                    // 服务端接受请求后才清空草稿；期间用户改过的内容保留
                    if (!text && get().prompt === prompt) set({ prompt: "", attachments: [] });
                    onText(assistantId, text);
                }),
            );
        } catch (error) {
            fail(error);
            set({ busy: false });
        }
    },

    retry(messageId: string) {
        const id = get().conversation?.id;
        if (id) void workbench.run(id, () => retryMessage(id, messageId, workbench.onText(id)));
    },

    async rename(id: string, title: string) {
        try {
            await api.renameConversation(id, title);
            const { conversation } = get();
            if (conversation?.id === id) set({ conversation: { ...conversation, title: title.trim() } });
            await workbench.refreshList();
        } catch (error) {
            fail(error);
        }
    },

    async remove(ids: string[]) {
        try {
            await Promise.all(ids.map((id) => api.deleteConversation(id)));
            if (activeId && ids.includes(activeId)) await workbench.open(null);
            await Promise.all([workbench.refreshList(), workbench.loadWorkspace()]);
        } catch (error) {
            fail(error);
        }
    },
};
