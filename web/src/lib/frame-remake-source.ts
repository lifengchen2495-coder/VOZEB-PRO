import { frameRemakeAnalysisResult, type FrameRemakeCopyBlock, type FrameRemakeFrame, type FrameRemakeFrameAnalysis, type FrameRemakeGroup, type FrameRemakeProject } from "./frame-remake-contract";
import { frameRemakePromptWithContract } from "./frame-remake-feishu-workflow";
import { frameRemakeTemplates } from "./frame-remake-prompt-templates";
import { parseFrameRemakeAnalysis } from "./frame-remake-prompts";

export function frameRemakeSourcePrompt(project: FrameRemakeProject, group: FrameRemakeGroup) {
    const seconds = (group.endMs - group.startMs) / 1000;
    return frameRemakePromptWithContract(frameRemakeTemplates(project, group).analysis, [
        `完整观看所附本组视频及声音。本组为原片第 ${group.number} 组，原片 ${group.startMs / 1000}–${group.endMs / 1000} 秒，本组实际 ${seconds} 秒。只分析这一段，不分析或生成其他组。`,
        "先按真实动作和语义分析视频，再由系统按返回时间抽帧；不将等间隔采样时间冒充分析结果。",
        `只返回 JSON 对象，含 sourceCopy 字符串和 frames 数组。frames 恰好 12 项，ordinal 必须依次为 1–12。startTime、endTime 为本组局部秒数，保留毫秒精度，从 0 连续覆盖到 ${seconds}，禁止重叠、跳跃、重复或压缩；最后 endTime 必须等于 ${seconds}。`,
        '每帧结构：{"ordinal":1,"startTime":0,"endTime":1.25,"subtitle":"真实可见字幕，无则为空","sellingPoint":"实际卖点，无则为空","shotType":"景别或镜头类型","description":"主体、构图、动作、节奏与环境背景","subjectRatio":"主体占比","hasFace":false}。',
        "sourceCopy 仅返回本组实际听见的原语言逐字口播，不能将字幕当口播，不翻译、改写、概括或补造；无口播则为空字符串。不得把全片文案重复填入各组。",
        "本步只分析原视频，不执行换品、换人、换环境；不要输出 Markdown、代码围栏或额外说明。",
    ], {
        group: group.number,
        sourceStartSeconds: group.startMs / 1000,
        sourceEndSeconds: group.endMs / 1000,
        actualSeconds: seconds,
        ...(project.groups.length === 1 && project.sourceCopy?.trim() !== "不需要人物口播" ? { "用户校对文案（只用于核对实际听见的本组口播）": project.sourceCopy || "" } : {}),
    });
}

function secondsToMilliseconds(value: unknown) {
    if (typeof value === "number") {
        if (!Number.isFinite(value) || value < 0) throw new Error("视频分析时间必须为非负秒数");
        return Math.round(value * 1000);
    }
    if (typeof value !== "string") throw new Error("视频分析缺少有效时间码");
    const parts = value.trim().replace(/秒$/, "").trim().replace(/：/g, ":").split(":");
    if (!parts.length || parts.length > 3 || parts.some((part) => !/^\d+(?:\.\d+)?$/.test(part))) throw new Error("视频分析时间码格式无效");
    return Math.round(parts.reduce((total, part) => total * 60 + Number(part), 0) * 1000);
}

function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("视频分析镜头结构无效");
    return value as Record<string, unknown>;
}

function analysisText(value: unknown, maxLength: number, required = false) {
    if (typeof value !== "string" || value.length > maxLength || (required && !value.trim())) throw new Error("视频分析镜头字段不完整或超过长度上限");
    return value.trim();
}

type ParsedFrame = { ordinal: number; startMs: number; endMs: number; sampleMs?: number; detail: FrameRemakeFrameAnalysis };

function bindAnalyzedFrames(items: ParsedFrame[], group: FrameRemakeGroup) {
    const duration = group.endMs - group.startMs;
    if (group.frames.length !== 12 || items.length !== 12) throw new Error("视频分析必须返回本组完整的12个镜头");
    return items.map((item, index) => {
        if (item.ordinal !== index + 1) throw new Error("视频分析分镜须使用局部编号1至12，不能重复或乱序");
        if (!Number.isSafeInteger(item.startMs) || !Number.isSafeInteger(item.endMs) || item.startMs !== (index ? items[index - 1].endMs : 0) || item.endMs <= item.startMs || item.endMs > duration || (index === 11 && item.endMs !== duration)) throw new Error("视频分析时间线必须从0连续覆盖本组真实结尾，不能跳跃、重叠或越界");
        const sampleMs = item.sampleMs ?? item.startMs + Math.floor((item.endMs - item.startMs) / 2);
        if (sampleMs < item.startMs || sampleMs >= item.endMs) throw new Error("视频分析抽帧时间超出镜头范围");
        return { ...group.frames[index], media: undefined, startMs: group.startMs + item.startMs, endMs: group.startMs + item.endMs, sampleMs: group.startMs + sampleMs, detail: item.detail };
    });
}

function parseJsonAnalysis(text: string, group: FrameRemakeGroup) {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new Error("视频理解模型返回的分析不是有效JSON");
    }
    const payload = record(parsed);
    if (typeof payload.sourceCopy !== "string" || payload.sourceCopy.length > 100_000) throw new Error("视频理解模型缺少本组原文案sourceCopy字段；无口播须返回空字符串");
    if (!Array.isArray(payload.frames)) throw new Error("视频理解模型缺少完整frames数组");
    const items = payload.frames.map((value): ParsedFrame => {
        const item = record(value);
        if (!Number.isInteger(item.ordinal) || typeof item.hasFace !== "boolean") throw new Error("视频分析缺少有效镜头编号或人脸判断");
        return {
            ordinal: item.ordinal as number,
            startMs: secondsToMilliseconds(item.startTime),
            endMs: secondsToMilliseconds(item.endTime),
            detail: {
                subtitle: analysisText(item.subtitle, 2000),
                sellingPoint: analysisText(item.sellingPoint, 2000),
                shotType: analysisText(item.shotType, 200, true),
                description: analysisText(item.description, 4000, true),
                subjectRatio: analysisText(item.subjectRatio, 200, true),
                hasFace: item.hasFace,
            },
        };
    });
    const frames = bindAnalyzedFrames(items, group);
    return { analysis: renderFrameRemakeSourceAnalysis(frames), frames, sourceCopy: payload.sourceCopy.trim(), sourceAnalysisMode: "video" as const };
}

// 兼容已有项目保存的带引号“时间”正文；新模型调用优先使用上面的结构化合同。
export function parseFrameRemakeOriginalAnalysis(raw: string, group: FrameRemakeGroup) {
    const analysis = parseFrameRemakeAnalysis(raw, "analysis");
    if (analysis.startsWith("{")) return parseJsonAnalysis(analysis, group);
    const fields = [...analysis.matchAll(/时间\s*[:：]\s*["“”']([^"“”']+)["“”']/g)];
    if (fields.length !== 12) throw new Error("视频分析须返回JSON镜头数组，或含12个带引号时间字段的完整正文");
    const ranges = fields.map((field) => field[1].split(/[-–—~～至]/).map((value) => secondsToMilliseconds(value)));
    const duration = group.endMs - group.startMs;
    const items = fields.map((time, index): ParsedFrame => {
        const section = analysis.slice(time.index, fields[index + 1]?.index ?? analysis.length);
        const field = (label: string) => {
            const match = section.match(new RegExp(`(?:^|\\n)\\s*(?:${label})\\s*[:：]\\s*[“"']?([^\\n]+)`));
            return match?.[1]?.trim().replace(/[”"',，]$/, "") || "";
        };
        return {
            ordinal: index + 1,
            startMs: ranges[index][0],
            endMs: ranges[index][1] ?? ranges[index + 1]?.[0] ?? duration,
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
    const frames = bindAnalyzedFrames(items, group);
    const sourceCopy = analysis.match(/(?:^|\n)\s*(?:sourceCopy|本组原文案|原文案)\s*[:：]\s*[“"']?([^\n]*)/)?.[1]?.trim().replace(/[”"']$/, "") || "";
    return { analysis, frames, sourceCopy, sourceAnalysisMode: "video" as const };
}

export function renderFrameRemakeSourceAnalysis(frames: FrameRemakeFrame[]) {
    const offset = frames[0]?.startMs || 0;
    return frames.map((frame, index) => `分镜${index + 1}:\n时间: "${(frame.startMs - offset) / 1000}-${(frame.endMs - offset) / 1000}"\n字幕：${frame.detail?.subtitle || "无"}\n卖点：${frame.detail?.sellingPoint || "无"}\n镜头类型：${frame.detail?.shotType || ""}\n画面描述：${frame.detail?.description || ""}\n主体占比：${frame.detail?.subjectRatio || ""}\n包含人脸：${frame.detail?.hasFace ? "是" : "否"}`).join("\n\n");
}

export function frameRemakeCopyRanges(group: FrameRemakeGroup): FrameRemakeCopyBlock[] {
    return Array.from({ length: Math.ceil(group.frames.length / 3) }, (_, index) => {
        const frames = group.frames.slice(index * 3, index * 3 + 3);
        return { number: index + 1, frameNumbers: frames.map((frame) => frame.number), startMs: frames[0].startMs, endMs: frames.at(-1)!.endMs, sourceText: "", text: "" };
    });
}
export function renderFrameRemakeCopy(blocks: FrameRemakeCopyBlock[]) {
    return blocks.map((block) => `区间 ${block.number} · 分镜 ${block.frameNumbers.join("、")} · ${block.startMs / 1000}–${block.endMs / 1000} 秒\n原文：${block.sourceText || "无口播"}\n采用文案：${block.text || "无口播"}`).join("\n\n");
}
export function frameRemakeScriptsReady(project: FrameRemakeProject) {
    return project.groups.length > 0 && project.groups.every((group) => frameRemakeAnalysisResult(group, "productScript") && group.imagePrompt);
}
