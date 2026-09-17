import type { FrameRemakeGroup, FrameRemakeProject } from "./frame-remake-contract";
import { REMAKE_FEISHU_ANALYSIS_PROMPT, REMAKE_FEISHU_PRODUCT_SCRIPT_PROMPT, REMAKE_FEISHU_STORYBOARD_SCRIPT_PROMPT, REMAKE_FEISHU_IMAGE_PROMPTS, REMAKE_FEISHU_VIDEO_PROMPTS } from "./remake15-feishu-prompts";

// 复用系统旧 /remake15 的完整模板，不修改正文。该文件本身是依据上方表可见规则
// 与记录重新实现的版本，不是受保护 Skill 的原文；实际分组输入另附运行合同。
export const FRAME_REMAKE_PROMPT_SOURCE = "系统旧15秒复刻完整模板（remake15-feishu-prompts.ts；依据上方表可见规则实现）";
export const FRAME_REMAKE_SOURCE_FIELDS = {
    analysis: "12镜头解析",
    new_script: "新产品-12分镜脚本",
    shot_prompts: "1-12分镜提示词",
    template_image: "1-12 第一步模板图",
    final_image: "1-12 最终分镜图",
    video_prompt: "1-12视频提示词",
} as const;
export function frameRemakeMissingPromptFields() {
    return [] as string[];
}
export function frameRemakeTemplates(_project: FrameRemakeProject, _group: FrameRemakeGroup) {
    return {
        analysis: REMAKE_FEISHU_ANALYSIS_PROMPT,
        productScript: REMAKE_FEISHU_PRODUCT_SCRIPT_PROMPT,
        storyboardScript: REMAKE_FEISHU_STORYBOARD_SCRIPT_PROMPT,
        replacement: REMAKE_FEISHU_IMAGE_PROMPTS["1-12"].replacement,
        storyboard: REMAKE_FEISHU_IMAGE_PROMPTS["1-12"].storyboard,
        video: REMAKE_FEISHU_VIDEO_PROMPTS["1-12"],
    };
}
