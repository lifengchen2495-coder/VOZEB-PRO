import { frameRemakeGenerationSeconds, frameRemakeSeconds, frameRemakeWorkflowSource, type FrameRemakeGroup, type FrameRemakeProject } from "./frame-remake-contract";
import originals from "./frame-remake-upper-original-prompts.json";
import { parameterizeFrameRemakeOriginal } from "./frame-remake-original-renderer";

export const FRAME_REMAKE_PROMPT_SOURCE = "飞书上方工作流字段原文（仅替换时长、镜头数量、分组参数及字段数据）";
export const FRAME_REMAKE_SOURCE_FIELDS = originals.combinedOriginal.fieldMappings;

const productTable = "tbl7CUSql4kncNvk";
const personTable = "tblWsGmy3C9igdZ2";
const videoFields = ["1-12视频提示词", "13-24视频提示词", "25-36视频提示词", "37-48视频提示词"] as const;

export type FrameRemakeVideoPromptSource = { tableId: string; field: string; url: string; shared: boolean; originalGroup: number; completeBody: boolean };

function originalRecord(tableId: string, field: string) {
    const record = originals.records.find((item) => item.tableId === tableId && item.field === field && item.completeBodyVisible);
    if (!record) throw new Error(`飞书原文字段尚未归档：${tableId} / ${field}`);
    return record;
}

function original(tableId: string, field: string) {
    return originalRecord(tableId, field).prompt;
}

export function frameRemakeMissingPromptFields(project?: FrameRemakeProject) {
    if (project && frameRemakeWorkflowSource(project) !== "combined-original") return [];
    return Object.values(FRAME_REMAKE_SOURCE_FIELDS);
}

export function frameRemakeTemplates(project: FrameRemakeProject, group: FrameRemakeGroup) {
    const source = frameRemakeWorkflowSource(project);
    if (source === "combined-original") {
        // 旧项目仍显示其原表可见正文；执行时由缺原文检查阻止，不能冒用别表或重写版。
        const shell = originals.combinedOriginal.visiblePrompts;
        const videoSource: FrameRemakeVideoPromptSource = { tableId: originals.combinedOriginal.tableId, field: FRAME_REMAKE_SOURCE_FIELDS.video_prompt, url: `https://ocn18sf3pb4v.feishu.cn/base/ZxmYbuEfeaY97GsdjZtcv96Bnt0?table=${originals.combinedOriginal.tableId}`, shared: false, originalGroup: 1, completeBody: false };
        return { analysis: shell.analysis, productScript: shell.new_script, storyboardScript: shell.shot_prompts, replacement: shell.template_image, storyboard: shell.final_image, copy: "", video: shell.video_prompt, videoSource };
    }
    const table = source === "person-basic" ? personTable : productTable;
    const seconds = frameRemakeSeconds(group);
    if (!Number.isInteger(group.number) || group.number < 1) throw new Error("当前分组编号无效");
    // 后三组原文仅有编号差异；第五组起继续使用通用后续组，不循环回第一组示例。
    const originalGroup = Math.min(group.number, 4);
    const video = originalRecord(originalGroup === 1 ? table : personTable, videoFields[originalGroup - 1]);
    const videoSource: FrameRemakeVideoPromptSource = { tableId: video.tableId, field: video.field, url: video.sourceUrl, shared: video.tableId !== table, originalGroup, completeBody: true };
    return {
        // 两张基础表的 V2 分析正文已经逐字核实为同一个原文。
        analysis: parameterizeFrameRemakeOriginal(original(productTable, "48镜头解析"), "analysis", seconds),
        productScript: "",
        storyboardScript: "",
        replacement: "",
        storyboard: original(table, "1-12 生图"),
        copy: parameterizeFrameRemakeOriginal(original(table, "文案预处理"), "copy", seconds),
        video: parameterizeFrameRemakeOriginal(video.prompt, "video", frameRemakeGenerationSeconds(group), originalGroup),
        videoSource,
    };
}
