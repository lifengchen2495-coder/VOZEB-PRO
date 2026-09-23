import { remakePersonSegmentVideoPrompt } from "./remake-person-segment-prompts";
import { remakePersonSeconds, type RemakePersonTiming } from "@/lib/remake-person-timing";
import { REMAKE_FEISHU_VIDEO_PROMPTS } from "@/lib/remake-person-feishu-prompts";

export const REMAKE_VIDEO_PROMPT_INSTRUCTIONS_LIMIT = 50_000;

export function normalizeRemakeVideoPromptInstructions(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

export function remakeVideoPromptInstructions(groupId: string, _value?: string): string {
    void _value; // 旧项目的自定义/精简指令不能覆盖已核对的原文。
    return REMAKE_FEISHU_VIDEO_PROMPTS[groupId as keyof typeof REMAKE_FEISHU_VIDEO_PROMPTS] || "";
}

export function remakeVideoPromptSystemInstructions(groupId: string, _value: string | undefined, _hasNarration: boolean, _voice?: "female" | "male", timing?: RemakePersonTiming): string {
    void _value;
    void _hasNarration;
    void _voice;
    if (timing?.version === 2) return remakePersonSegmentVideoPrompt(timing);
    const original = remakeVideoPromptInstructions(groupId);
    return timing ? original.replace(/15\s*秒/gu, `${remakePersonSeconds(timing.durationMs)}秒`) : original;
}
