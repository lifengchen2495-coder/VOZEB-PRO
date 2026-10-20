export type Mode = "chat" | "image" | "video";

export type Media = { id: string; url: string; kind: "image" | "video"; mime: string; name?: string };

export type Message = {
    id: string;
    role: "user" | "assistant";
    mode: Mode;
    content: string;
    attachments?: Media[];
    results?: Media[];
    params?: Record<string, string>;
    model?: string;
    status: "done" | "pending" | "failed";
    error?: string;
    upstreamTaskId?: string;
    createdAt: number;
    finishedAt?: number;
};

export type Conversation = { id: string; title: string; createdAt: number; updatedAt: number; messages: Message[] };

export type ConversationSummary = Omit<Conversation, "messages"> & { count: number; pending: boolean };

// 每种创作类型可配置多个模型，第一个为默认模型
export type Settings = { baseUrl: string; apiKey: string; systemPrompt: string; models: Record<Mode, string[]> };

export type PublicSettings = Omit<Settings, "apiKey"> & { hasApiKey: boolean; dataDir: string };

// 工作台汇总：所有对话中的素材与图片/视频任务
export type Asset = Media & { source: "result" | "reference"; mode: Mode; prompt: string; model?: string; conversationId: string; conversationTitle: string; messageId: string; createdAt: number };
export type Task = Pick<Message, "id" | "mode" | "model" | "status" | "error" | "results" | "createdAt" | "finishedAt"> & { prompt: string; params?: Record<string, string>; conversationId: string; conversationTitle: string };
export type Workspace = { assets: Asset[]; tasks: Task[]; stats: { conversations: number; images: number; videos: number; running: number; failed: number } };

export type SendBody = { mode: Mode; prompt: string; model?: string; attachmentIds?: string[]; params?: Record<string, string> };

export type ApiResult<T> = { code: number; data: T; msg: string };
