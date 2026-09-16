import { frameRemakeAnalysisResult, type FrameRemakeCopyBlock, type FrameRemakeFrame, type FrameRemakeGroup, type FrameRemakeProject } from "./frame-remake-contract";
import { frameRemakeTemplates } from "./frame-remake-prompt-templates";
import { parseFrameRemakeAnalysis } from "./frame-remake-prompts";

export function frameRemakeSourcePrompt(project: FrameRemakeProject, group: FrameRemakeGroup) {
    return frameRemakeTemplates(project, group).analysis;
}

// 从分析结果的 12 个“时间”字段读取抽帧起点。
// 此处只解析结果，不要求模型改成 JSON，也不再用另一轮模型补写。
export function parseFrameRemakeOriginalAnalysis(raw: string, group: FrameRemakeGroup) {
    const analysis = parseFrameRemakeAnalysis(raw, "analysis");
    const timeFields = [...analysis.matchAll(/时间\s*[:：]\s*["“”']([^"“”']+)["“”']/g)];
    if (timeFields.length !== 12) throw new Error("原版分析结果未包含12个带引号的时间字段，请检查本步原文后重试");
    const seconds = (value: string) => {
        const parts = value.trim().split(":");
        if (!parts.length || parts.length > 3 || parts.some((p) => !/^\d+(?:\.\d+)?$/.test(p))) throw new Error("原版时间码格式无效");
        return parts.reduce((total, part) => total * 60 + Number(part), 0);
    };
    const duration = group.endMs - group.startMs;
    const starts = timeFields.map((field) => Math.min(Math.max(Math.round(seconds(field[1].split(/[-–—~～]/)[0]) * 1000), 0), Math.max(duration - 50, 0)));
    if (starts.some((start, i) => !Number.isSafeInteger(start) || (i > 0 && start < starts[i - 1]))) throw new Error("原版返回的12个抽帧时间须按视频顺序排列，请重试视频分析");
    const frames = group.frames.map((frame, index) => {
        const section = analysis.slice(timeFields[index].index, timeFields[index + 1]?.index ?? analysis.length);
        const field = (label: string) => {
            const match = section.match(new RegExp(`(?:${label})\\s*[:：]\\s*[“"']?([^\\n]+)`));
            return match?.[1]?.trim().replace(/[”"',，]$/, "") || "";
        };
        const startMs = group.startMs + (index === 0 ? 0 : starts[index]);
        const endMs = index === 11 ? group.endMs : group.startMs + starts[index + 1];
        return {
            ...frame,
            media: undefined,
            startMs,
            endMs,
            sampleMs: group.startMs + Math.min(starts[index], duration - 1),
            detail: {
                subtitle: field("字幕"),
                sellingPoint: field("卖点"),
                shotType: field("镜头类型|景别"),
                description: field("画面描述") || section.trim(),
                subjectRatio: field("人物占比|主体占比"),
                hasFace: /^(是|有|true)/.test(field("是否出现人脸|是否有人脸|包含人脸")),
            },
        };
    });
    return { analysis, frames };
}
export function renderFrameRemakeSourceAnalysis(frames: FrameRemakeFrame[]) {
    const offset = frames[0]?.startMs || 0;
    return frames
        .map(
            (f, index) =>
                `分镜${index + 1}:\n时间: "${(f.startMs - offset) / 1000}-${(f.endMs - offset) / 1000}"\n字幕：${f.detail?.subtitle || "无"}\n卖点：${f.detail?.sellingPoint || "无"}\n镜头类型：${f.detail?.shotType || ""}\n画面描述：${f.detail?.description || ""}\n主体占比：${f.detail?.subjectRatio || ""}\n包含人脸：${f.detail?.hasFace ? "是" : "否"}`,
        )
        .join("\n\n");
}
export function frameRemakeCopyRanges(group: FrameRemakeGroup): FrameRemakeCopyBlock[] {
    return Array.from({ length: Math.ceil(group.frames.length / 3) }, (_, i) => {
        const frames = group.frames.slice(i * 3, i * 3 + 3);
        return { number: i + 1, frameNumbers: frames.map((f) => f.number), startMs: frames[0].startMs, endMs: frames.at(-1)!.endMs, sourceText: "", text: "" };
    });
}
export function renderFrameRemakeCopy(blocks: FrameRemakeCopyBlock[]) {
    return blocks.map((b) => `区间 ${b.number} · 分镜 ${b.frameNumbers.join("、")} · ${b.startMs / 1000}–${b.endMs / 1000} 秒\n原文：${b.sourceText || "无口播"}\n采用文案：${b.text || "无口播"}`).join("\n\n");
}
export function frameRemakeScriptsReady(project: FrameRemakeProject) {
    return project.groups.length > 0 && project.groups.every((g) => frameRemakeAnalysisResult(g, "productScript") && g.imagePrompt);
}
