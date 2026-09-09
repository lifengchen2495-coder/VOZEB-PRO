import { REMAKE_FEISHU_VIDEO_PROMPTS } from "@/lib/remake-person-feishu-prompts";

export const REMAKE_VIDEO_PROMPT_INSTRUCTIONS_LIMIT = 50_000;

export function normalizeRemakeVideoPromptInstructions(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

export function remakeVideoPromptInstructions(groupId: string, value?: string): string {
    return normalizeRemakeVideoPromptInstructions(value) || REMAKE_FEISHU_VIDEO_PROMPTS[groupId as keyof typeof REMAKE_FEISHU_VIDEO_PROMPTS] || "";
}

export function remakeVideoPromptSystemInstructions(groupId: string, value: string | undefined, hasNarration: boolean, voice?: "female" | "male"): string {
    const firstFrame = Number(groupId.split("-")[0]);
    const intervals = Array.from({ length: 4 }, (_, index) => `分镜${firstFrame + index * 3}-${firstFrame + index * 3 + 2}：`).join("、");
    return [
        remakeVideoPromptInstructions(groupId, value),
        "",
        "【视频输出格式约束】",
        "仅输出本组可直接使用的视频提示词，不输出解释或分析过程。",
        "保留原产品，禁止引用 @产品图；人物图和人物补充只在输入标记为 available 时引用。",
        `保持 15 秒，按顺序输出且只输出四个连续三帧区间：${intervals}，保留区间标题后的冒号。`,
        "必须保留素材引用 @十二宫格图，以及原句“禁止画面出现字幕”。只引用用户实际提供的素材。",
        hasNarration
            ? `每个区间逐字保留对应文案，使用“口播（中文，${voice === "male" ? "旁白" : "人物"}，[情绪]）：★"[原台词]"”格式；括号内为情绪，台词置于括号外，声线与所选配音一致。`
            : "当前选择无配音，不输出口播括号段，也不引用 @音频文件。",
    ].join("\n");
}
