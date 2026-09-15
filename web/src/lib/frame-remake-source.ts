import { frameRemakeAnalysisResult, type FrameRemakeCopyBlock, type FrameRemakeFrame, type FrameRemakeGroup, type FrameRemakeProject } from "./frame-remake-contract";
import { frameRemakeTemplates } from "./frame-remake-prompt-templates";
import { REMAKE_FEISHU_COPY_PROMPT } from "./remake15-feishu-prompts";

export function frameRemakeSourcePrompt(project: FrameRemakeProject, group: FrameRemakeGroup) {
    return [
        frameRemakeTemplates(project, group).analysis.replace("读取本组全部实际抽帧及时间码", "完整观看本组上传的视频和声音"),
        `当前执行合同：附视频仅为原片第 ${group.number} 组，原片 ${group.startMs / 1000}–${group.endMs / 1000} 秒。本组实际 ${(group.endMs - group.startMs) / 1000} 秒。分析视频后再按你给出的语义时间拆帧。`,
        `只输出 JSON 对象 {"sourceCopy":"本组原语言逐字口播，无口播则为空字符串","frames":[{"ordinal":1,"startTime":0,"endTime":1,"subtitle":"可见字幕","sellingPoint":"卖点","shotType":"景别","description":"主体、构图、性别、动作、节奏、展示目的及环境","subjectRatio":"主体占比","hasFace":false}]}。`,
        `frames 必须恰好 ${group.frames.length} 项。本组局部编号从 1 到 ${group.frames.length}，局部时间从 0 连续覆盖到 ${(group.endMs - group.startMs) / 1000} 秒，时间使用秒数，保留毫秒精度，禁止重叠、跳过或压缩。不要套用模板中的全片编号。`,
        "仅描述可见画面和实际听见的声音，不能将字幕当作口播。sourceCopy 保持原语言，不翻译、润色、遗漏或重复。",
        project.sourceCopy ? `用户提供的原文案（仅用于校对本组实际口播，禁止将整片文案重复填入每组）：${project.sourceCopy}` : "",
    ]
        .filter(Boolean)
        .join("\n\n");
}
export function renderFrameRemakeSourceAnalysis(frames: FrameRemakeFrame[]) {
    return frames
        .map(
            (f) =>
                `分镜${f.number}:\n时间：${f.startMs / 1000}–${f.endMs / 1000} 秒\n字幕：${f.detail?.subtitle || "无"}\n卖点：${f.detail?.sellingPoint || "无"}\n镜头类型：${f.detail?.shotType || ""}\n画面描述：${f.detail?.description || ""}\n主体占比：${f.detail?.subjectRatio || ""}\n包含人脸：${f.detail?.hasFace ? "是" : "否"}`,
        )
        .join("\n\n");
}
export function frameRemakeCopyRanges(group: FrameRemakeGroup): FrameRemakeCopyBlock[] {
    return Array.from({ length: Math.ceil(group.frames.length / 3) }, (_, i) => {
        const frames = group.frames.slice(i * 3, i * 3 + 3);
        return { number: i + 1, frameNumbers: frames.map((f) => f.number), startMs: frames[0].startMs, endMs: frames.at(-1)!.endMs, sourceText: "", text: "" };
    });
}
export function frameRemakeCopyPrompt(group: FrameRemakeGroup) {
    const ranges = frameRemakeCopyRanges(group);
    return `${REMAKE_FEISHU_COPY_PROMPT}\n\n本次只处理原片第 ${group.number} 组，按下列实际区间执行，取代模板固定的 4 区间/12分镜规则。\n${JSON.stringify({ sourceCopy: group.sourceCopy || "", ranges, frames: group.frames.map(({ media: _media, ...f }) => f) })}\n\n严格按顺序返回 ${ranges.length} 个 blocks，每项包含 number、sourceText、text。所有 sourceText 拼接必须逐字等于 sourceCopy，允许无口播区间为空。text 保留相同原文，不改写事实。不得新增口播。`;
}
export function parseFrameRemakeCopy(raw: string, group: FrameRemakeGroup) {
    const value = JSON.parse(raw) as { blocks?: Array<{ number: number; sourceText: string; text: string }> };
    const ranges = frameRemakeCopyRanges(group),
        blocks = value.blocks;
    if (!Array.isArray(blocks) || blocks.length !== ranges.length || blocks.some((b, i) => b.number !== i + 1 || typeof b.sourceText !== "string" || typeof b.text !== "string" || b.text.length > 20000)) throw new Error("文案区间数量、顺序或正文不完整");
    const normalized = (text: string) => text.replace(/\s/g, "");
    if (normalized(blocks.map((b) => b.sourceText).join("")) !== normalized(group.sourceCopy || "") || blocks.some((b) => normalized(b.text) !== normalized(b.sourceText))) throw new Error("文案没有逐字连续覆盖原文，请重试文案预处理");
    const copyBlocks = ranges.map((range, i) => ({ ...range, sourceText: blocks[i].sourceText, text: blocks[i].text }));
    return { copyBlocks, copy: renderFrameRemakeCopy(copyBlocks) };
}
export function renderFrameRemakeCopy(blocks: FrameRemakeCopyBlock[]) {
    return blocks.map((b) => `区间 ${b.number} · 分镜 ${b.frameNumbers.join("、")} · ${b.startMs / 1000}–${b.endMs / 1000} 秒\n原文：${b.sourceText || "无口播"}\n采用文案：${b.text || "无口播"}`).join("\n\n");
}
export function frameRemakeScriptsReady(project: FrameRemakeProject) {
    return project.groups.length > 0 && project.groups.every((g) => frameRemakeAnalysisResult(g, "productScript") && g.imagePrompt);
}
