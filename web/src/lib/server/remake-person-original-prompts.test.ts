import { describe, expect, it, vi } from "vitest";
import { remakePersonTimings } from "@/lib/remake-person-timing";
import originals from "@/lib/frame-remake-upper-original-prompts.json";
import { REMAKE_FEISHU_ANALYSIS_PROMPT, REMAKE_FEISHU_COPY_PROMPT, REMAKE_FEISHU_IMAGE_PROMPT, REMAKE_FEISHU_VIDEO_PROMPTS } from "@/lib/remake-person-feishu-prompts";
import { remakeStoryboardPrompt, remakeStoryboardPromptReferences } from "@/lib/remake-person-image-prompt";
import { remakeVideoPromptSystemInstructions } from "@/lib/remake-person-video-prompt-instructions";
import { imageTaskRequestPrompt } from "@/app/api/image-tasks/image-task-support";
import { buildDoubaoVideoUnderstandingPrompt, parseOriginalCopyPlan, parseVideoUnderstanding } from "./remake-person-analysis-runtime";
import { assertRemakeVideoPrompt, remakeProductionMessages, renderRemakeCopyReport, type RemakeProductionPromptInput } from "./remake-person-production-prompt";
import { normalizeRemakeCopyState, normalizeRemakeCopyBlocks, type RemakeFrame } from "./remake-person-project-contract";

const original = (field: string, table = "tblWsGmy3C9igdZ2") => originals.records.find((record) => record.tableId === table && record.field === field)!.prompt;
const frames: RemakeFrame[] = Array.from({ length: 48 }, (_, i) => ({ ordinal: i + 1, time: i, endTime: i + 1, frameUrl: `/frame-${i + 1}.jpg`, analysisStatus: "available", subtitle: "-", sellingPoint: "产品外观", shotType: "产品特写", description: "特写镜头，产品位于桌面中心。", subjectRatio: "-", hasFace: false }));
const copyBody = (texts: string[]) => Array.from({ length: 4 }, (_, group) => [
    `=== 第${group + 1}部分 ===`, "| 分镜区间 | 字幕 |", "| --- | --- |",
    ...texts.slice(group * 4, group * 4 + 4).map((text, index) => `| 分镜${(group * 4 + index) * 3 + 1}-${(group * 4 + index) * 3 + 3} | ${text || "-"} |`),
].join("\n")).join("\n\n");

function productionInput(): RemakeProductionPromptInput {
    return { title: "测试", productInfo: "", hasNarration: false, frames, timings: remakePersonTimings({ frames }), copyBlocks: Array.from({ length: 16 }, (_, i) => ({ ordinal: i + 1, frameOrdinals: [i * 3 + 1, i * 3 + 2, i * 3 + 3], sourceText: "", text: "" })), referenceAssets: { character: { available: false }, characterSupplement: { available: false }, background: { available: true }, audio: { available: false } }, contactSheets: [], visualBoards: [] };
}

describe("person remake verbatim prompts", () => {
    it("uses the full archived analysis, copy and image fields", () => {
        expect(REMAKE_FEISHU_ANALYSIS_PROMPT).toBe(original("48镜头解析", "tbl7CUSql4kncNvk"));
        expect(buildDoubaoVideoUnderstandingPrompt(68_017)).toBe(REMAKE_FEISHU_ANALYSIS_PROMPT);
        expect(REMAKE_FEISHU_COPY_PROMPT).toBe(original("文案预处理"));
        expect(REMAKE_FEISHU_IMAGE_PROMPT).toBe(original("1-12 生图"));
        expect(remakeStoryboardPrompt("13-24", frames)).toBe(original("1-12 生图"));
    });
    it.each(["1-12", "13-24", "25-36", "37-48"] as const)("preserves the complete %s prompt even when an old project saved a short override", (groupId) => {
        const expected = original(`${groupId}视频提示词`);
        expect(REMAKE_FEISHU_VIDEO_PROMPTS[groupId]).toBe(expected);
        expect(remakeVideoPromptSystemInstructions(groupId, "旧精简指令", true, "female")).toBe(expected);
        const messages = remakeProductionMessages(productionInput(), groupId, "旧精简指令");
        expect(messages.filter((message) => message.role === "system")).toEqual([{ role: "system", content: expected.replace(/15\s*秒/gu, "12秒") }]);
        expect(JSON.parse(messages[1].content)).not.toHaveProperty("保留产品规则");
    });
    it("passes the storyboard text through provider decoration unchanged", () => {
        const decorate = vi.fn(() => "不要换成新人物");
        expect(imageTaskRequestPrompt({ projectId: "remake-person-test", generationSlotId: "remake-person:1-12:storyboard", prompt: REMAKE_FEISHU_IMAGE_PROMPT }, decorate)).toBe(REMAKE_FEISHU_IMAGE_PROMPT);
        expect(decorate).not.toHaveBeenCalled();
        expect(imageTaskRequestPrompt({ projectId: "other", generationSlotId: "image", prompt: "编辑" }, decorate)).toBe("不要换成新人物");
    });
    it("supplies the source contact sheet, background, then optional character", () => {
        const references = remakeStoryboardPromptReferences({ contactSheet: { url: "/contact-sheet.jpg" }, background: { url: "/background.jpg" }, character: { url: "/person.jpg" } });
        expect(references.map(({ asset }) => asset.url)).toEqual(["/contact-sheet.jpg", "/background.jpg", "/person.jpg"]);
        expect(() => remakeStoryboardPromptReferences({ background: { url: "/background.jpg" } })).toThrow("十二宫格拼图");
    });
});

describe("original Feishu response formats", () => {
    const analysis = frames.map((frame) => `分镜${frame.ordinal}:\n时间: "0:${frame.time}-0:${frame.endTime}"\n字幕: "-"\n卖点: "产品外观"\n镜头类型: "产品特写"\n画面描述: "产品位于桌面中心"\n人物占比: "-"\n是否包含人脸: "否"`).join("\n\n");
    it("reads all 48 text shots without requiring extra sourceCopy or JSON", () => {
        const parsed = parseVideoUnderstanding(analysis, 48_000);
        expect(parsed.frames).toHaveLength(48);
        expect(parsed.frames.at(-1)).toMatchObject({ ordinal: 48, time: 47, endTime: 48 });
        expect(parsed.sourceCopy).toBe("");
        expect(() => parseVideoUnderstanding(analysis.replace('0:1-0:2', '0:1.1-0:2'), 48_000)).toThrow("连续且无重叠");
    });
    it("accepts the original four subtitle tables including empty intervals", () => {
        const texts = Array.from({ length: 16 }, (_, i) => i === 0 ? "第一句。" : i === 9 ? "第二句。" : "");
        const raw = copyBody(texts);
        const sourceCopy = "第一句。第二句。";
        const plan = parseOriginalCopyPlan(raw, sourceCopy, frames);
        expect(plan.blocks.map((block) => block.text)).toEqual(texts);
        expect(plan.blocks.map((block) => block.sourceText).join("")).toBe(sourceCopy);
        expect(plan.copy.paragraphs).toHaveLength(2);
        expect(renderRemakeCopyReport({ sourceCopy, blocks: plan.blocks, ...plan.copy })).toBe(raw);
    });
    it("preserves source whitespace and empty rows through saved project normalization", () => {
        const texts = Array.from({ length: 16 }, (_, i) => i === 0 ? "第一句。" : i === 9 ? "第二句。" : "");
        const sourceCopy = "第一句。\n第二句。";
        const plan = parseOriginalCopyPlan(copyBody(texts), sourceCopy, frames);
        const copy = normalizeRemakeCopyState(plan.copy);
        const blocks = normalizeRemakeCopyBlocks(plan.blocks, { frames, sourceCopy, strategy: "keep", mappings: copy.mappings, requireComplete: true });
        expect(blocks.map((block) => block.sourceText).join("")).toBe(sourceCopy);
        expect(renderRemakeCopyReport({ sourceCopy, blocks, ...copy })).toBe(copyBody(texts));
    });
    it("rejects a missing table range or copy that skips source text", () => {
        const raw = copyBody(Array(16).fill("文案。"));
        expect(() => parseOriginalCopyPlan(raw.replace("| 分镜46-48 | 文案。 |", ""), "文案。".repeat(16), frames)).toThrow("16个字幕区间");
        expect(() => parseOriginalCopyPlan(raw, "其他原文", frames)).toThrow("完整覆盖");
    });
    it("accepts product references required by the original video template", () => {
        const value = "12秒，@十二宫格图，产品：原产品@产品图，禁止画面出现字幕\n" + [1, 4, 7, 10].map((i) => `分镜${i}-${i + 2}，展示产品；`).join("\n");
        expect(() => assertRemakeVideoPrompt(value, productionInput(), "1-12")).not.toThrow();
    });
});
