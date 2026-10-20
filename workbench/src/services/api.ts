import type { ApiResult, Conversation, ConversationSummary, Media, Mode, PublicSettings, SendBody, SettingsPatch, Workspace } from "@/lib/types";

async function request<T>(url: string, init?: RequestInit): Promise<T> {
    const response = await fetch(url, init);
    const result = (await response.json()) as ApiResult<T>;
    if (result.code !== 0) throw new Error(result.msg || `请求失败：HTTP ${response.status}`);
    return result.data;
}

const json = (method: string, body: unknown): RequestInit => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export const api = {
    settings: () => request<PublicSettings>("/api/settings"),
    saveSettings: (patch: SettingsPatch) => request<PublicSettings>("/api/settings", json("PATCH", patch)),
    fetchModels: (apiKey: string) => request<PublicSettings>("/api/settings/models", json("POST", { apiKey })),
    workspace: () => request<Workspace>("/api/workspace"),
    conversations: () => request<ConversationSummary[]>("/api/conversations"),
    createConversation: () => request<Conversation>("/api/conversations", { method: "POST" }),
    conversation: (id: string) => request<Conversation>(`/api/conversations/${id}`),
    renameConversation: (id: string, title: string) => request<{ id: string; title: string }>(`/api/conversations/${id}`, json("PATCH", { title })),
    deleteConversation: (id: string) => request<null>(`/api/conversations/${id}`, { method: "DELETE" }),
    optimizePrompt: (mode: Mode, prompt: string) => request<string>("/api/optimize-prompt", json("POST", { mode, prompt })),
    upload: (file: File) => {
        const form = new FormData();
        form.append("file", file);
        return request<Media>("/api/uploads", { method: "POST", body: form });
    },
};

// 发送与重试：对话模式逐段回调流式文本，媒体模式立即返回，由页面轮询会话获取结果
async function generation(url: string, init: RequestInit, onText: (assistantId: string, text: string) => void) {
    const response = await fetch(url, init);
    const assistantId = response.headers.get("x-assistant-id");
    if (!assistantId) {
        const result = (await response.json().catch(() => null)) as ApiResult<null> | null;
        throw new Error(result?.msg || `请求失败：HTTP ${response.status}`);
    }
    onText(assistantId, "");
    if (!response.headers.get("content-type")?.startsWith("text/plain") || !response.body) return;
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        onText(assistantId, value);
    }
}

export const sendMessage = (conversationId: string, body: SendBody, onText: (assistantId: string, text: string) => void) =>
    generation(`/api/conversations/${conversationId}/messages`, json("POST", body), onText);

export const retryMessage = (conversationId: string, messageId: string, onText: (assistantId: string, text: string) => void) =>
    generation(`/api/conversations/${conversationId}/messages/${messageId}/retry`, { method: "POST" }, onText);
