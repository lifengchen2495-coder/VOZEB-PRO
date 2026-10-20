import { randomUUID } from "node:crypto";
import { getConversation, getSettings, mediaMime, updateConversation } from "@/lib/server/store";
import { createVideo, generateImages, streamChat, waitVideo } from "@/lib/server/upstream";
import type { Conversation, Media, Message, SendBody } from "@/lib/types";

// 当前进程内正在执行的助手消息；进程重启后由 recoverPending 处理遗留的 pending 消息
const running: Set<string> = ((globalThis as { __workbenchRunning?: Set<string> }).__workbenchRunning ??= new Set());

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)) || "生成失败";

function finish(conversationId: string, assistantId: string, patch: Partial<Message>) {
    return updateConversation(conversationId, (conversation) => {
        const message = conversation.messages.find((m) => m.id === assistantId);
        if (message) Object.assign(message, { finishedAt: Date.now() }, patch);
    });
}

function requestOf(conversation: Conversation, assistantId: string) {
    const index = conversation.messages.findIndex((m) => m.id === assistantId);
    const user = conversation.messages[index - 1];
    if (index < 1 || user.role !== "user") throw new Error("找不到对应的用户请求");
    return user;
}

async function runMedia(conversationId: string, assistantId: string) {
    running.add(assistantId);
    try {
        const settings = await getSettings();
        const conversation = await getConversation(conversationId);
        if (!conversation) return;
        const assistant = conversation.messages.find((m) => m.id === assistantId);
        if (assistant?.status !== "pending" || !assistant.model) return;
        const user = requestOf(conversation, assistantId);
        const params = user.params || {};
        if (assistant.mode === "image") {
            const results = await generateImages(settings, assistant.model, user.content, user.attachments || [], params);
            await finish(conversationId, assistantId, { status: "done", results });
            return;
        }
        let taskId = assistant.upstreamTaskId;
        if (!taskId) {
            taskId = await createVideo(settings, assistant.model, user.content, user.attachments || [], params);
            await updateConversation(conversationId, (c) => {
                const message = c.messages.find((m) => m.id === assistantId);
                if (message) message.upstreamTaskId = taskId;
            });
        }
        await finish(conversationId, assistantId, { status: "done", results: [await waitVideo(settings, taskId)] });
    } catch (error) {
        await finish(conversationId, assistantId, { status: "failed", error: errorText(error) }).catch(() => undefined);
    } finally {
        running.delete(assistantId);
    }
}

// 生成器在被读取前不会执行，因此由 start 先登记为运行中；客户端断开时 finally 会把已收到的内容标记为中断
async function* runChat(conversationId: string, assistantId: string) {
    let content = "";
    let error: string | undefined = "对话已中断，请重试";
    try {
        const settings = await getSettings();
        const conversation = await getConversation(conversationId);
        const model = conversation?.messages.find((m) => m.id === assistantId)?.model;
        if (!conversation || !model) return;
        for await (const text of streamChat(settings, model, conversation, assistantId)) {
            content += text;
            yield text;
        }
        error = undefined;
    } catch (cause) {
        error = errorText(cause);
    } finally {
        await finish(conversationId, assistantId, error ? { status: "failed", content, error } : { status: "done", content }).catch(() => undefined);
        running.delete(assistantId);
    }
}

function start(conversationId: string, assistant: Message) {
    running.add(assistant.id);
    if (assistant.mode === "chat") return runChat(conversationId, assistant.id);
    void runMedia(conversationId, assistant.id);
    return null;
}

export async function sendMessage(conversationId: string, body: SendBody) {
    const prompt = body.prompt?.trim() || "";
    if (!["chat", "image", "video"].includes(body.mode)) throw new Error("不支持的创作类型");
    if (!prompt) throw new Error("请输入内容");
    const attachments: Media[] = (body.attachmentIds || []).map((id) => ({ id, url: `/api/media/${id}`, kind: "image", mime: mediaMime(id) }));
    if (attachments.some((m) => !m.mime.startsWith("image/"))) throw new Error("参考素材只支持图片");
    const models = (await getSettings()).models[body.mode];
    if (body.model && !models.includes(body.model)) throw new Error("所选模型不在设置的模型列表中");
    const now = Date.now();
    const user: Message = { id: randomUUID(), role: "user", mode: body.mode, content: prompt, attachments, params: body.params, status: "done", createdAt: now };
    const assistant: Message = { id: randomUUID(), role: "assistant", mode: body.mode, content: "", model: body.model || models[0], status: "pending", createdAt: now };
    await updateConversation(conversationId, (conversation) => {
        if (!conversation.messages.length) conversation.title = prompt.slice(0, 30);
        conversation.messages.push(user, assistant);
    });
    return { assistantId: assistant.id, stream: start(conversationId, assistant) };
}

export async function retryMessage(conversationId: string, assistantId: string) {
    if (running.has(assistantId)) throw new Error("该任务仍在执行");
    let target: Message | undefined;
    await updateConversation(conversationId, (c) => {
        target = c.messages.find((m) => m.id === assistantId && m.role === "assistant");
        if (!target || target.status !== "failed") throw new Error("只能重试失败的结果");
        // 重试沿用原模型和原请求，但新建一次上游请求，不复用旧任务 ID
        Object.assign(target, { status: "pending", error: undefined, content: "", results: undefined, upstreamTaskId: undefined, createdAt: Date.now(), finishedAt: undefined });
    });
    return { assistantId, stream: start(conversationId, target!) };
}

// 读取会话时接管上次进程遗留的任务：已拿到上游视频任务 ID 的继续查询，其余标记为可重试
export async function recoverPending(conversation: Conversation) {
    const orphans = conversation.messages.filter((m) => m.status === "pending" && !running.has(m.id));
    for (const message of orphans) {
        if (message.mode === "video" && message.upstreamTaskId) void runMedia(conversation.id, message.id);
        else
            // 在写入队列内按最新状态判断，避免覆盖刚刚结束的任务
            await updateConversation(conversation.id, (c) => {
                const current = c.messages.find((m) => m.id === message.id);
                if (current?.status === "pending" && !running.has(current.id)) Object.assign(current, { status: "failed", error: "本地服务重启，任务已中断，请重试", finishedAt: Date.now() });
            });
    }
    return orphans.length ? getConversation(conversation.id) : conversation;
}
