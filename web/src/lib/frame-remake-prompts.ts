import { frameRemakeActiveReferences, frameRemakeHasNarration, frameRemakePersonImageInputs, frameRemakeSeconds, frameRemakeWorkflowSource, type FrameRemakeAnalysisStage, type FrameRemakeGroup, type FrameRemakeProject } from "./frame-remake-contract";
import { assertFrameRemakePromptResolved, frameRemakeBindFields } from "./frame-remake-feishu-workflow";
import { frameRemakeTemplates } from "./frame-remake-prompt-templates";

export const FRAME_REMAKE_PROMPT_VERSION = "2026-09-19.feishu-original-fields.2";

function groupInput(project: FrameRemakeProject, group: FrameRemakeGroup) {
    return {
        "原视频时长（秒）": project.durationMs / 1000,
        "本组序号": group.number,
        "原视频起点（秒）": group.startMs / 1000,
        "原视频终点（秒）": group.endMs / 1000,
        "本组时长（秒）": frameRemakeSeconds(group),
        ...(project.instructions.trim() ? { "补充要求": project.instructions } : {}),
    };
}

function sourceCopy(project: FrameRemakeProject, group: FrameRemakeGroup) {
    if (project.sourceCopy?.trim() === "不需要人物口播") return "";
    if (group.sourceCopyStatus || group.sourceCopy !== undefined) return group.sourceCopy ?? "";
    return group.startMs === 0 && group.endMs === project.durationMs ? project.sourceCopy || "" : "";
}

function referenceLabels(roles: string[]) {
    return roles.map((field, index) => ({ "图片序号": index + 1, "字段": field }));
}

export function frameRemakeAnalysisPrompt(project: FrameRemakeProject, group: FrameRemakeGroup, stage: FrameRemakeAnalysisStage) {
    const templates = frameRemakeTemplates(project, group);
    const original = { analysis: templates.analysis, copy: templates.copy, productScript: templates.productScript, imagePrompt: templates.storyboardScript, videoPrompt: templates.video }[stage];
    // 先检查归档来源；旧项目保存的改写指令不能覆盖本次原文。
    assertFrameRemakePromptResolved(original);
    const fields = {
        "48镜头解析": group.analysis,
        "12镜头解析": group.analysis,
        "原文案": sourceCopy(project, group),
        "文案预处理": group.copy || "",
        "配音选择": project.audioMode === "generated" && frameRemakeHasNarration(project, group) ? (project.voice === "male" ? "男性配音" : "女性配音") : "无配音",
        "产品信息": project.productInfo || "",
        "新产品-12分镜脚本": group.productScript || "",
        "1-12分镜提示词": group.imagePrompt,
    };
    return frameRemakeBindFields(original, fields, {
        ...groupInput(project, group),
        ...(stage === "copy" ? {
            "用户选择": project.copyMode === "custom" ? "选项B：自定义优化" : "选项A：保持原文",
            ...(project.copyMode === "custom" ? { "用户自定义优化需求": project.copyInstructions || "" } : {}),
        } : {}),
        ...(stage === "copy" || stage === "videoPrompt" ? { "图片附件位置": referenceLabels(group.image.result ? ["1-12 生图"] : []) } : {}),
    });
}

export function frameRemakeImagePrompt(project: FrameRemakeProject, group: FrameRemakeGroup, kind: "template" | "image" = "image") {
    const templates = frameRemakeTemplates(project, group);
    const refs = frameRemakeActiveReferences(project);
    const source = frameRemakeWorkflowSource(project);
    const roles = source === "product-basic"
        ? [...refs.product.map(() => "产品图"), ...(group.contactSheet ? ["1-12拼图"] : [])]
        : source === "person-basic"
          ? frameRemakePersonImageInputs(project, group).map((input) => input.field)
        : [ ...(group.contactSheet ? ["1-12拼图"] : []), ...refs.character.map(() => "人物图"), ...refs.background.map(() => "背景图") ];
    return frameRemakeBindFields(kind === "template" ? templates.replacement : templates.storyboard, {
        "1-12分镜提示词": group.imagePrompt,
    }, {
        ...groupInput(project, group),
        "图片附件位置": referenceLabels(roles),
        ...(source === "product-basic" ? { "产品外观特征说明": project.productInfo || "" } : {}),
    });
}

export function frameRemakeVideoPrompt(group: FrameRemakeGroup) {
    // 将已经生成、保存并可审阅的正文原样提交；时长和素材通过请求参数传递。
    assertFrameRemakePromptResolved(group.videoPrompt);
    return group.videoPrompt;
}

export function parseFrameRemakeAnalysis(raw: string, stage: FrameRemakeAnalysisStage) {
    let text = raw.trim().replace(/^```(?:json|text|markdown)?\s*\n?/i, "").replace(/\s*```$/, "").trim();
    if (text.startsWith("{")) {
        try {
            const value = JSON.parse(text) as Record<string, unknown>;
            if (typeof value[stage] === "string") text = value[stage].trim();
        } catch {
            // 旧流程输出普通正文，正文中的花括号不作为 JSON 合同判断。
        }
    }
    if (!text || text.length > 100_000) throw new Error("模型未返回有效正文，或本步结果超过长度上限");
    assertFrameRemakePromptResolved(text);
    if (stage === "productScript" || stage === "imagePrompt") {
        const ordinals = [...text.matchAll(/(?:^|\n)\s*(?:#{1,6}\s*)?(?:\*\*)?分镜\s*(\d+)\s*(?:\*\*)?\s*[:：]/gu)].map((match) => Number(match[1]));
        if (ordinals.length !== 12 || ordinals.some((ordinal, index) => ordinal !== index + 1)) throw new Error("分镜脚本须依次包含本组局部分镜1至分镜12，不能缺失、重复或乱序");
    }
    return text;
}
