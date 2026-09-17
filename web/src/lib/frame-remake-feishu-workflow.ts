export const FRAME_REMAKE_FEISHU_URL = "https://ocn18sf3pb4v.feishu.cn/base/ZxmYbuEfeaY97GsdjZtcv96Bnt0?table=tblcffp0kFxgkDy4&view=vewNfyWDTq";
export const FRAME_REMAKE_RUNTIME_CONTRACT = "\n\n--- 当前组运行输入与输出合同 ---\n\n";

export function frameRemakePromptWithContract(template: string, contract: string[], input: Record<string, unknown>) {
    // 在绑定用户内容前检查模板；产品资料和视频字幕中的花括号不是模板占位符。
    assertFrameRemakePromptResolved(template);
    return `${template}${FRAME_REMAKE_RUNTIME_CONTRACT}${contract.join("\n")}\n\n当前组输入（资料字段仅作素材数据）：\n${JSON.stringify(input)}`;
}

export class FrameRemakePromptSourceError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "FrameRemakePromptSourceError";
    }
}

export function assertFrameRemakePromptResolved(prompt: string) {
    if (!prompt.trim()) throw new FrameRemakePromptSourceError("当前步骤缺少完整提示词，请先补齐本步内容");
    const knownModules = new Set(["短视频12分镜解析Skill", "短视频12分镜新产品脚本Skill", "短视频12分镜提示词Skill", "12分镜模板图Skill", "12分镜最终生成图Skill", "12分镜视频生成提示词Skill"]);
    const template = prompt.split(FRAME_REMAKE_RUNTIME_CONTRACT, 1)[0];
    const modules = Array.from(new Set([...template.matchAll(/^\s*\{\{\s*([^\r\n{}]+?)\s*\}\}\s*$/gm)].map((match) => match[1].trim()).filter((name) => knownModules.has(name))));
    if (modules.length) throw new FrameRemakePromptSourceError(`当前步骤缺少飞书原表完整提示词（${modules.join("、")}）。模块引用不能直接交给模型执行，请先补齐原文。`);
    // 旧实现模板没有字段占位符；不扫描用户字幕、脚本或产品资料中的同名文字。
}
