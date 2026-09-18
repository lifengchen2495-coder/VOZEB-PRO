import { frameRemakeAnalysisResult, type FrameRemakeCopyBlock, type FrameRemakeFrame, type FrameRemakeFrameAnalysis, type FrameRemakeGroup, type FrameRemakeProject } from "./frame-remake-contract";
import { frameRemakeTemplates } from "./frame-remake-prompt-templates";
import { parseFrameRemakeAnalysis } from "./frame-remake-prompts";

export function frameRemakeSourcePrompt(project: FrameRemakeProject, group: FrameRemakeGroup) {
    return frameRemakeTemplates(project, group).analysis;
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
    const frames = items.map((item, index) => {
        if (item.ordinal !== index + 1) throw new Error("视频分析分镜须使用局部编号1至12，不能重复或乱序");
        // 模型可能把 5 秒写成末帧时间 4.9 秒，也可能把 8.267 秒四舍五入为 8.3 秒。
        // 仅对齐末镜头不超过 0.1 秒的双向尾差，且尾差须小于对齐前后的镜头长度；中间时间线仍严格校验。
        const tailError = Math.abs(duration - item.endMs);
        const shorterShotDuration = Math.min(item.endMs, duration) - item.startMs;
        const endMs = index === 11 && tailError > 0 && tailError <= 100 && tailError < shorterShotDuration ? duration : item.endMs;
        if (!Number.isSafeInteger(item.startMs) || !Number.isSafeInteger(item.endMs) || item.startMs !== (index ? items[index - 1].endMs : 0) || item.endMs <= item.startMs || endMs <= item.startMs || endMs > duration || (index === 11 && endMs !== duration)) throw new Error(`视频分析时间线必须从0连续覆盖本组真实结尾，不能跳跃、重叠或越界（分镜${item.ordinal}：${item.startMs / 1000}–${item.endMs / 1000}秒，前一终点${(index ? items[index - 1].endMs : 0) / 1000}秒，本组时长${duration / 1000}秒）`);
        const sampleMs = item.sampleMs ?? item.startMs + Math.floor((endMs - item.startMs) / 2);
        if (sampleMs < item.startMs || sampleMs >= endMs) throw new Error("视频分析抽帧时间超出镜头范围");
        return { ...group.frames[index], media: undefined, startMs: group.startMs + item.startMs, endMs: group.startMs + endMs, sampleMs: group.startMs + sampleMs, detail: item.detail };
    });
    const reportedEndMs = items[11].endMs;
    return { frames, sourceAnalysisTiming: reportedEndMs === duration ? undefined : { reportedEndMs, alignedEndMs: duration } };
}

function parseJsonAnalysis(text: string, group: FrameRemakeGroup) {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new Error("视频理解模型返回的分析不是有效JSON");
    }
    const payload = record(parsed);
    if (payload.sourceCopy !== undefined && (typeof payload.sourceCopy !== "string" || payload.sourceCopy.length > 100_000)) throw new Error("视频理解模型返回的原文案sourceCopy字段无效");
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
    const bound = bindAnalyzedFrames(items, group);
    return { analysis: renderFrameRemakeSourceAnalysis(bound.frames), ...bound, sourceCopy: typeof payload.sourceCopy === "string" ? payload.sourceCopy.trim() : "", sourceAnalysisMode: "video" as const };
}

function originalFieldValue(value: string) {
    let text = value.trim().replace(/^[*]{2}|[*]{2}$/g, "").trim();
    if (/^["“‘']/.test(text)) text = text.slice(1).replace(/["”’'][,，]?$/, "");
    return text.trim();
}

function originalAnalysisField(section: string, labels: string, required = false) {
    const match = section.match(new RegExp(`(?:^|\\n)\\s*(?:[-*]\\s+)?(?:\\*\\*)?(?:${labels})(?:\\*\\*)?\\s*[:：]\\s*(?:\\*\\*)?([^\\n]*)`));
    if (!match && required) throw new Error("视频分析镜头字段不完整");
    return match ? originalFieldValue(match[1]) : "";
}

// 读取飞书原提示词的分镜正文，同时兼容历史 JSON 结果。
export function parseFrameRemakeOriginalAnalysis(raw: string, group: FrameRemakeGroup) {
    const analysis = parseFrameRemakeAnalysis(raw, "analysis");
    if (analysis.startsWith("{")) return parseJsonAnalysis(analysis, group);
    const sections = [...analysis.matchAll(/(?:^|\n)\s*(?:#{1,6}\s*)?(?:\*\*)?分镜\s*(\d+)\s*(?:\*\*)?\s*[:：](?:\*\*)?/gu)];
    if (sections.length !== 12) throw new Error("视频分析须依次包含完整的本组分镜1至12");
    const items = sections.map((heading, index): ParsedFrame => {
        const section = analysis.slice(heading.index! + heading[0].length, sections[index + 1]?.index ?? analysis.length);
        const range = originalAnalysisField(section, "时间", true).split(/\s*[-–—~～至]\s*/);
        if (range.length !== 2) throw new Error("视频分析每个分镜必须给出完整的开始和结束时间");
        const face = originalAnalysisField(section, "是否包含人脸|是否出现人脸|是否有人脸|包含人脸", true).replace(/^[\s🔴🟢✅❌]+/u, "");
        if (!/^(?:是|有|否|无|true|false)$/i.test(face)) throw new Error("视频分析人脸判断须明确为是或否");
        return {
            ordinal: Number(heading[1]),
            startMs: secondsToMilliseconds(range[0]),
            endMs: secondsToMilliseconds(range[1]),
            detail: {
                subtitle: analysisText(originalAnalysisField(section, "字幕", true), 2000),
                sellingPoint: analysisText(originalAnalysisField(section, "卖点", true), 2000),
                shotType: analysisText(originalAnalysisField(section, "镜头类型|景别", true), 200, true),
                description: analysisText(originalAnalysisField(section, "画面描述", true), 4000, true),
                subjectRatio: analysisText(originalAnalysisField(section, "人物占比|主体占比", true), 200, true),
                hasFace: /^(?:是|有|true)$/i.test(face),
            },
        };
    });
    const bound = bindAnalyzedFrames(items, group);
    const sourceCopy = originalAnalysisField(analysis, "sourceCopy|本组原文案|原文案");
    return { analysis, ...bound, sourceCopy, sourceAnalysisMode: "video" as const };
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

function markdownTableCells(line: string) {
    if (!line.trim().startsWith("|")) return undefined;
    return line.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

export function parseFrameRemakeCopy(raw: string, group: FrameRemakeGroup) {
    const copy = parseFrameRemakeAnalysis(raw, "copy");
    const rows: { first: number; last: number; text: string }[] = [];
    let subtitleTable = false;
    for (const line of copy.split(/\r?\n/)) {
        const cells = markdownTableCells(line);
        if (!cells) {
            subtitleTable = false;
            continue;
        }
        const labels = cells.map((cell) => cell.replace(/\*\*/g, ""));
        if (labels[0] === "分镜区间" && labels[1] === "字幕" && cells.length === 2) {
            subtitleTable = true;
            continue;
        }
        if (!subtitleTable || cells.every((cell) => /^:?-+:?$/.test(cell))) continue;
        const range = labels[0]?.match(/^分镜\s*(\d+)\s*[-–—~～至]\s*(\d+)$/u);
        if (cells.length !== 2 || !range) throw new Error("文案预处理字幕表须包含完整的分镜区间和字幕");
        rows.push({ first: Number(range[1]), last: Number(range[2]), text: cells[1] });
    }
    if (group.frames.length !== 12 || rows.length !== 4 || rows.some((row, index) => row.first !== index * 3 + 1 || row.last !== index * 3 + 3)) {
        throw new Error("文案预处理须依次包含分镜1-3、4-6、7-9、10-12，不能缺失、重复或乱序");
    }
    const copyBlocks = frameRemakeCopyRanges(group).map((block, index) => ({ ...block, text: rows[index].text === "-" ? "" : rows[index].text }));
    return { copy, copyBlocks };
}

export function frameRemakeScriptsReady(project: FrameRemakeProject) {
    if (project.workflowSource === "product-basic" || project.workflowSource === "person-basic") {
        return project.groups.length > 0 && project.groups.every((group) => group.analysis && group.contactSheet && group.frames.length === 12 && group.frames.every((frame) => frame.media));
    }
    return project.groups.length > 0 && project.groups.every((group) => frameRemakeAnalysisResult(group, "productScript") && group.imagePrompt);
}
