import OpenAI, { toFile } from "openai";
import type { ChatCompletionContentPart, ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { ImageEditParams, ImageGenerateParams } from "openai/resources/images";
import type { VideoCreateParams } from "openai/resources/videos";
import { readMedia, saveMedia } from "@/lib/server/store";
import type { Conversation, Media, Mode, Settings } from "@/lib/types";

// 生成类请求不自动重试，避免上游重复创建任务和重复计费
export function createClient(settings: Settings) {
    if (!settings.apiKey) throw new Error("请先在「模型设置」里填写 API Key");
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

export async function* streamChat(settings: Settings, model: string, conversation: Conversation, assistantId: string) {
    const stream = await createClient(settings).chat.completions.create({
        model,
        messages: await historyMessages(settings, conversation, assistantId),
        stream: true,
    });
    for await (const chunk of stream) {
        const text = chunk.choices[0]?.delta?.content;
        if (text) yield text;
    }
}

const fixed = (value?: string) => (value && value !== "auto" ? value : undefined);

export async function generateImages(settings: Settings, model: string, prompt: string, attachments: Media[], params: Record<string, string>) {
    const client = createClient(settings);
    const common = { model, prompt, n: Number(params.n) || 1, size: fixed(params.size), quality: fixed(params.quality) };
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

export async function createVideo(settings: Settings, model: string, prompt: string, attachments: Media[], params: Record<string, string>) {
    const image = attachments.find((m) => m.kind === "image");
    const body: VideoCreateParams = {
        model,
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

const optimizeInstructions: Record<Mode, string> = {
    chat: "把用户的问题改写得更清晰、具体、便于回答，保留原意和语言。只输出改写后的问题本身。",
    image: "你是图片生成提示词优化助手。把用户的想法改写成一段可直接交给图像生成模型的提示词，补充主体、构图、光线、色彩、风格和细节，保留用户明确提出的要求和语言。只输出提示词本身。",
    video: "你是视频生成提示词优化助手。把用户的想法改写成一段可直接交给视频生成模型的提示词，补充主体动作、场景、镜头运动、节奏、光线和风格，保留用户明确提出的要求和语言。只输出提示词本身。",
};

// 接口返回 supported_endpoint_types 时按类型归类，否则按模型名称归类；向量、语音等模型不归入任何创作类型，可在设置里手动加入
export function classifyModel(id: string, types: string[] = []): Mode | null {
    if (types.some((t) => t.includes("video"))) return "video";
    if (types.includes("image-generation")) return "image";
    if (types.length) return types.some((t) => /embedding|rerank/.test(t)) ? null : "chat";
    if (/embed|tts|whisper|moderation|rerank|transcri|speech|audio/i.test(id)) return null;
    if (/sora|veo|kling|video|runway|hailuo|seedance|vidu|pika|luma/i.test(id)) return "video";
    if (/image|dall-e|flux|midjourney|stable-diffusion|sdxl|seedream|imagen|ideogram|recraft|kolors|banana/i.test(id)) return "image";
    return "chat";
}

// 使用默认文本模型改写提示词，结果只回填为草稿，不会自动发送
export async function optimizePrompt(settings: Settings, mode: Mode, prompt: string) {
    if (!settings.models.chat.length) throw new Error("还没有可用的文本模型，请先在「模型设置」里获取模型");
    const response = await createClient(settings).chat.completions.create({
        model: settings.models.chat[0],
        messages: [
            { role: "system", content: optimizeInstructions[mode] },
            { role: "user", content: prompt },
        ],
    });
    const text = response.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error("模型没有返回优化结果");
    return text;
}
