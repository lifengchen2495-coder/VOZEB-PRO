export const FRAME_REMAKE_FEISHU_URL = "https://ocn18sf3pb4v.feishu.cn/base/ZxmYbuEfeaY97GsdjZtcv96Bnt0?table=tblcffp0kFxgkDy4&view=vewNfyWDTq";
// 保留分隔符用于检查历史项目，新的调用不再添加运行合同。
export const FRAME_REMAKE_RUNTIME_CONTRACT = "\n\n--- 当前组运行输入与输出合同 ---\n\n";
export const FRAME_REMAKE_FIELD_INPUTS = "\n\n--- 字段输入数据 ---\n\n";

/** 一次性绑定原表字段 chip。字段值序列化为 JSON 字符串，保留换行等原始数据，避免将资料中的模块字样当成模板。 */
export function frameRemakeBindFields(template: string, fields: Record<string, string>, input: Record<string, unknown> = {}) {
    assertFrameRemakePromptResolved(template);
    const names = Object.keys(fields).map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const text = names.length ? template.replace(new RegExp(`(?<=\\n\\n)(${names.join("|")})(?=\\n\\n)`, "g"), (name) => JSON.stringify(fields[name])) : template;
    return Object.keys(input).length ? `${text}${FRAME_REMAKE_FIELD_INPUTS}${JSON.stringify(input)}` : text;
}

/** @deprecated 使用 frameRemakeBindFields。旧运行合同不再允许添加创作规则。 */
export function frameRemakePromptWithContract(template: string, contract: string[], input: Record<string, unknown>) {
    if (contract.length) throw new FrameRemakePromptSourceError("飞书原文流程不接受额外运行提示词，请使用原字段数据绑定");
    return frameRemakeBindFields(template, {}, input);
}

export class FrameRemakePromptSourceError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "FrameRemakePromptSourceError";
    }
}

export function assertFrameRemakePromptResolved(prompt: string) {
    if (!prompt.trim()) throw new FrameRemakePromptSourceError("当前步骤缺少完整飞书提示词原文");
    const knownModules = new Set(["短视频12分镜解析Skill", "短视频12分镜新产品脚本Skill", "短视频12分镜提示词Skill", "12分镜模板图Skill", "12分镜最终生成图Skill", "12分镜视频生成提示词Skill", "Codex60秒长视频全量拆解", "Codex新产品60秒分镜脚本适配", "Codex分镜图1-12-第二步", "Codex分镜图13-24-第二步", "Codex分镜图1-12-第一步", "Codex分镜图13-24-第一步"]);
    const template = prompt.split(FRAME_REMAKE_RUNTIME_CONTRACT, 1)[0].split(FRAME_REMAKE_FIELD_INPUTS, 1)[0];
    const modules = Array.from(new Set([...template.matchAll(/^\s*\{\{\s*([^\r\n{}]+?)\s*\}\}\s*$/gm)].map((match) => match[1].trim()).filter((name) => knownModules.has(name))));
    if (modules.length) throw new FrameRemakePromptSourceError(`当前步骤缺少飞书原表完整提示词（${modules.join("、")}）。模块引用不能直接交给模型执行，请补齐原文或选择原文完整的基础流程。`);
}
