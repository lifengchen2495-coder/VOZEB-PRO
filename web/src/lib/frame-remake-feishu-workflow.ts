export const FRAME_REMAKE_FEISHU_URL = "https://ocn18sf3pb4v.feishu.cn/base/ZxmYbuEfeaY97GsdjZtcv96Bnt0?table=tblcffp0kFxgkDy4&view=vewNfyWDTq";

export class FrameRemakePromptSourceError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "FrameRemakePromptSourceError";
    }
}

export function assertFrameRemakePromptResolved(prompt: string) {
    if (!prompt.trim()) throw new FrameRemakePromptSourceError("当前步骤缺少飞书原表完整提示词，请先补齐原文");
    const knownModules = new Set(["短视频12分镜解析Skill", "短视频12分镜新产品脚本Skill", "短视频12分镜提示词Skill", "12分镜模板图Skill", "12分镜最终生成图Skill", "12分镜视频生成提示词Skill"]);
    const modules = Array.from(new Set([...prompt.matchAll(/\{\{\s*([^\r\n{}]+?)\s*\}\}/g)].map((match) => match[1].trim()).filter((name) => knownModules.has(name))));
    if (modules.length) throw new FrameRemakePromptSourceError(`当前步骤缺少飞书原表完整提示词（${modules.join("、")}）。模块引用不能直接交给模型执行，请先补齐原文。`);
    // 原表模板图在字段外保留字面 {{ }}；只有已核实的字段标记仍在时才算未绑定。
    const unbound = prompt.match(/\n\n(12镜头解析|产品信息|新产品-12分镜脚本|1-12分镜提示词|原文案)\n\n/);
    if (unbound) throw new FrameRemakePromptSourceError(`当前步骤的飞书原表字段尚未绑定（${unbound[1]}），未提交生成`);
}
