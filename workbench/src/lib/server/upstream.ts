import OpenAI, { toFile } from "openai";
import type { ChatCompletionContentPart, ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { ImageEditParams, ImageGenerateParams } from "openai/resources/images";
import type { VideoCreateParams } from "openai/resources/videos";
import { readMedia, saveMedia } from "@/lib/server/store";
import type { Conversation, Media, Settings } from "@/lib/types";

// 生成类请求不自动重试，避免上游重复创建任务和重复计费
export function createClient(settings: Settings) {
    if (!settings.apiKey) throw new Error("请先在「设置」里填写 API Key");
    return new OpenAI({ baseURL: settings.baseUrl, apiKey: settings.apiKey, maxRetries: 0 });
}

async function dataUrl(media: Media) {
    const { bytes, mime } = await readMedia(media.id);
    return `data:${mime};base64,${bytes.toString("base64")}`;
}

const fileOf = async (media: Media) => toFile((await readMedia(media.id)).bytes, media.id, { type: media.mime });

async function historyMessages(settings: Settings, conversation: Conversation, untilId: string) {
    const messages: ChatCompletionMessageParam[] = settings.systemPrompt ? [{ role: "system", content: settings.systemPrompt }] : [];
    for (const message of conversation.messages) {
        if (message.id === untilId) break;
        if (message.mode !== "chat" || message.status === "failed") continue;
        if (message.role === "assistant") {
            if (message.content) messages.push({ role: "assistant", content: message.content });
            continue;
        }
        const images = (message.attachments || []).filter((m) => m.kind === "image");
        if (!images.length) {
            messages.push({ role: "user", content: message.content });
            continue;
        }
        const parts: ChatCompletionContentPart[] = [{ type: "text", text: message.content }];
        for (const image of images) parts.push({ type: "image_url", image_url: { url: await dataUrl(image) } });
        messages.push({ role: "user", content: parts });
    }
    return messages;
}

export async function* streamChat(settings: Settings, conversation: Conversation, assistantId: string) {
    const stream = await createClient(settings).chat.completions.create({
        model: settings.textModel,
        messages: await historyMessages(settings, conversation, assistantId),
        stream: true,
    });
    for await (const chunk of stream) {
        const text = chunk.choices[0]?.delta?.content;
        if (text) yield text;
    }
}

const fixed = (value?: string) => (value && value !== "auto" ? value : undefined);

export async function generateImages(settings: Settings, prompt: string, attachments: Media[], params: Record<string, string>) {
    const client = createClient(settings);
    const common = { model: settings.imageModel, prompt, n: Number(params.n) || 1, size: fixed(params.size), quality: fixed(params.quality) };
    const images = attachments.filter((m) => m.kind === "image");
    const response = images.length
        ? await client.images.edit({ ...common, image: await Promise.all(images.map(fileOf)) } as ImageEditParams & { stream?: false })
        : await client.images.generate(common as ImageGenerateParams & { stream?: false });
    const results: Media[] = [];
    for (const item of response.data || []) {
        if (item.b64_json) {
            results.push(await saveMedia(Buffer.from(item.b64_json, "base64"), `image/${response.output_format || "png"}`));
        } else if (item.url) {
            const file = await fetch(item.url);
            if (!file.ok) throw new Error(`下载图片失败：HTTP ${file.status}`);
            results.push(await saveMedia(new Uint8Array(await file.arrayBuffer()), file.headers.get("content-type") || "image/png"));
        }
    }
    if (!results.length) throw new Error("上游没有返回图片");
    return results;
}

export async function createVideo(settings: Settings, prompt: string, attachments: Media[], params: Record<string, string>) {
    const image = attachments.find((m) => m.kind === "image");
    const body: VideoCreateParams = {
        model: settings.videoModel,
        prompt,
        seconds: fixed(params.seconds) as VideoCreateParams["seconds"],
        size: fixed(params.size) as VideoCreateParams["size"],
        input_reference: image ? await fileOf(image) : undefined,
    };
    return (await createClient(settings).videos.create(body)).id;
}

// OpenAI 视频任务需要轮询查询状态；间隔沿用官方示例的数秒级查询
const pollMs = 5000;

export async function waitVideo(settings: Settings, taskId: string) {
    const client = createClient(settings);
    for (;;) {
        const video = await client.videos.retrieve(taskId);
        if (video.status === "failed") throw new Error(video.error?.message || "视频生成失败");
        if (video.status === "completed") break;
        await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    const content = await client.videos.downloadContent(taskId);
    return saveMedia(new Uint8Array(await content.arrayBuffer()), "video/mp4");
}
