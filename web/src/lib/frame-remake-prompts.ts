import { type FrameRemakeAnalysisStage, type FrameRemakeGroup, type FrameRemakeProject } from "./frame-remake-contract";
import { frameRemakeTemplates } from "./frame-remake-prompt-templates";

export const FRAME_REMAKE_PROMPT_VERSION = "2026-09-16.feishu-upper-fields.1";

// 只绑定原表的字段引用；不追加任务规则，也不展开未取得正文的模块。
function bindFields(template: string, fields: Record<string, string>) {
    return template.replace(/\n\n([^\n]+)\n\n/g, (match, name: string) => {
        if (!Object.hasOwn(fields, name)) return match;
        return `\n\n${fields[name]}\n\n`;
    });
}

export function frameRemakeAnalysisPrompt(project: FrameRemakeProject, group: FrameRemakeGroup, stage: FrameRemakeAnalysisStage) {
    const templates = frameRemakeTemplates(project, group);
    if (stage === "copy") throw new Error("原版流程的文案是可选输入，不调用额外的文案改写模型");
    const template = { analysis: templates.analysis, productScript: templates.productScript, imagePrompt: templates.storyboardScript, videoPrompt: templates.video }[stage];
    return bindFields(template, {
        "12镜头解析": group.analysis,
        产品信息: [project.productInfo, project.instructions].filter(Boolean).join("\n"),
        "新产品-12分镜脚本": group.productScript || "",
        "1-12分镜提示词": group.imagePrompt,
        原文案: project.sourceCopy?.trim() === "不需要人物口播" ? "" : (group.copy ?? group.sourceCopy ?? (project.groups.length === 1 ? project.sourceCopy || "" : "")),
    });
}

export function frameRemakeImagePrompt(project: FrameRemakeProject, group: FrameRemakeGroup, kind: "template" | "image" = "image") {
    const templates = frameRemakeTemplates(project, group);
    return bindFields(kind === "template" ? templates.replacement : templates.storyboard, {
        "1-12分镜提示词": group.imagePrompt,
    });
}

export function frameRemakeVideoPrompt(_project: FrameRemakeProject, group: FrameRemakeGroup, _generationSeconds: number) {
    // 保存的 Seedance 提示词直接传入视频模型，不追加导演规则。
    return group.videoPrompt;
}

export function parseFrameRemakeAnalysis(raw: string, _stage: FrameRemakeAnalysisStage) {
    const text = raw.trim();
    if (!text || text.length > 30000 || /{{[^{}]+}}/.test(text)) throw new Error("模型未返回有效正文，或结果仍包含未展开的模块引用；本步结果未保存");
    return text;
}
