import { REMAKE_FEISHU_VIDEO_PROMPTS } from "@/lib/remake15-feishu-prompts";

export const REMAKE_VIDEO_PROMPT_INSTRUCTIONS_LIMIT = 50_000;

export function normalizeRemakeVideoPromptInstructions(value: unknown): string {
    if (value === undefined) return "";
    if (typeof value !== "string") throw new Error("视频提示词生成指令必须是文本");
    if (value.length > REMAKE_VIDEO_PROMPT_INSTRUCTIONS_LIMIT) throw new Error("视频提示词生成指令不能超过 50000 字");
    return value.trim();
}

export function remakeEffectiveVideoPromptInstructions(group: { id: string; videoPromptInstructions?: string }): string {
    const text = normalizeRemakeVideoPromptInstructions(group.videoPromptInstructions);
    const fallback = REMAKE_FEISHU_VIDEO_PROMPTS[group.id as keyof typeof REMAKE_FEISHU_VIDEO_PROMPTS];
    if (!fallback) throw new Error("分镜组没有对应的视频提示词生成指令");
    return text || fallback;
}
