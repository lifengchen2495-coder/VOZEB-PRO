import original from "./frame-remake-original-prompts.json";
import type { FrameRemakeGroup, FrameRemakeProject } from "./frame-remake-contract";

// 2026-09-16 直接读取用户指定的上方 15 秒表字段编辑器；仅去除 U+200B。
// 这些是字段可见原文，仍含缺少正文的模块引用，不能当成完整可执行提示词。
export const FRAME_REMAKE_PROMPT_SOURCE = "上方15秒换品换人实操表（tblcffp0kFxgkDy4）的字段配置";
export const FRAME_REMAKE_SOURCE_FIELDS = {
    analysis: "12镜头解析",
    new_script: "新产品-12分镜脚本",
    shot_prompts: "1-12分镜提示词",
    template_image: "1-12 第一步模板图",
    final_image: "1-12 最终分镜图",
    video_prompt: "1-12视频提示词",
} as const;
export function frameRemakeMissingPromptFields() {
    return Object.entries(original).filter(([, prompt]) => /{{[^{}]*Skill}}/.test(prompt)).map(([key]) => FRAME_REMAKE_SOURCE_FIELDS[key as keyof typeof FRAME_REMAKE_SOURCE_FIELDS]);
}
export function frameRemakeTemplates(_project: FrameRemakeProject, _group: FrameRemakeGroup) {
    return {
        analysis: original.analysis,
        productScript: original.new_script,
        storyboardScript: original.shot_prompts,
        replacement: original.template_image,
        storyboard: original.final_image,
        video: original.video_prompt,
    };
}
