import originals from "./frame-remake-upper-original-prompts.json";

// 直接读取已归档的飞书字段正文，不另存精简版或追加执行规则。
function original(tableId: string, field: string) {
    const record = originals.records.find((item) => item.tableId === tableId && item.field === field && item.completeBodyVisible);
    if (!record) throw new Error(`飞书原文字段尚未归档：${tableId} / ${field}`);
    return record.prompt;
}

const PERSON_TABLE = "tblWsGmy3C9igdZ2";
export const REMAKE_FEISHU_ANALYSIS_PROMPT = original("tbl7CUSql4kncNvk", "48镜头解析");
export const REMAKE_FEISHU_IMAGE_PROMPT = original(PERSON_TABLE, "1-12 生图");
export const REMAKE_FEISHU_COPY_PROMPT = original(PERSON_TABLE, "文案预处理");
export const REMAKE_FEISHU_VIDEO_PROMPTS = {
    "1-12": original(PERSON_TABLE, "1-12视频提示词"),
    "13-24": original(PERSON_TABLE, "13-24视频提示词"),
    "25-36": original(PERSON_TABLE, "25-36视频提示词"),
    "37-48": original(PERSON_TABLE, "37-48视频提示词"),
} as const;
export const REMAKE_PERSON_PROMPT_VERSION = "2026-09-19.feishu-verbatim.1";
