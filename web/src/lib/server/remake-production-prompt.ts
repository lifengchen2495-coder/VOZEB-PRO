import { REMAKE_FEISHU_VIDEO_PROMPTS } from "@/lib/remake-feishu-prompts";
import { remakeVideoPromptSystemInstructions } from "@/lib/remake-video-prompt-instructions";

export const REMAKE_PRODUCTION_GROUP_COUNT = 4;
export const REMAKE_PRODUCTION_BLOCKS_PER_GROUP = 4;

export type RemakeProductionCopyBlock = {
    ordinal: number;
    frameOrdinals: [number, number, number];
    sourceText: string;
    text: string;
};

export type RemakeProductionFrame = {
    ordinal: number;
    subtitle: string;
    sellingPoint: string;
    shotType: string;
    description: string;
};

export type RemakeProductionGroupId = keyof typeof REMAKE_FEISHU_VIDEO_PROMPTS;

export const REMAKE_PRODUCTION_GROUP_IDS: readonly RemakeProductionGroupId[] = ["1-12", "13-24", "25-36", "37-48"];

export type RemakeProductionAssetMetadata = {
    available: boolean;
    mimeType?: string;
    originalName?: string;
    width?: number;
    height?: number;
};

export type RemakeProductionReferenceContext = {
    character: RemakeProductionAssetMetadata;
    characterSupplement: RemakeProductionAssetMetadata;
    product: RemakeProductionAssetMetadata;
    audio: RemakeProductionAssetMetadata;
};

export type RemakeProductionContactSheetContext = {
    groupOrdinal: number;
    frameOrdinals: number[];
    sourceContactSheet: RemakeProductionAssetMetadata;
    redrawnContactSheet: RemakeProductionAssetMetadata;
};

export type RemakeProductionVisualBoardContext = {
    ordinal: number;
    id: string;
    description: string;
    layout: Array<{
        order: number;
        role: string;
        label: string;
        position: string;
        provided: boolean;
        groupOrdinal?: number;
        frameOrdinals?: number[];
    }>;
};

export type RemakeProductionPromptInput = {
    title: string;
    hasNarration: boolean;
    voice?: "female" | "male";
    frames: RemakeProductionFrame[];
    copyBlocks: RemakeProductionCopyBlock[];
    referenceAssets: RemakeProductionReferenceContext;
    contactSheets: RemakeProductionContactSheetContext[];
    visualBoards: RemakeProductionVisualBoardContext[];
};

export type RemakeProductionCopyReportInput = {
    sourceCopy: string;
    blocks: RemakeProductionCopyBlock[];
    optionRaw: string;
    rawReport?: string;
    paragraphs: Array<{ ordinal: number; text: string }>;
    mappings: Array<{ blockOrdinal: number; paragraphOrdinals: number[]; sourceText: string; text: string }>;
    checks: { sequential: boolean; noDuplicates: boolean; noSkips: boolean };
    stats: { paragraphCount: number; unchangedBlocks: number; completedBlocks: number; correctedBlocks: number; emptyBlocks: number };
};

export function remakeProductionMessages(input: RemakeProductionPromptInput, groupId: RemakeProductionGroupId, videoPromptInstructions?: string) {
    const groupOrdinal = REMAKE_PRODUCTION_GROUP_IDS.indexOf(groupId) + 1;
    const firstBlock = (groupOrdinal - 1) * REMAKE_PRODUCTION_BLOCKS_PER_GROUP + 1;
    const blocks = input.copyBlocks.filter((block) => block.ordinal >= firstBlock && block.ordinal < firstBlock + REMAKE_PRODUCTION_BLOCKS_PER_GROUP);
    if (blocks.length !== REMAKE_PRODUCTION_BLOCKS_PER_GROUP) throw new Error(`分镜 ${groupId} 缺少文案预处理区间`);
    return [
        {
            role: "system",
            content: remakeVideoPromptSystemInstructions(groupId, videoPromptInstructions, input.hasNarration, input.voice),
        },
        {
            role: "user",
            content: JSON.stringify({
                "人物六宫格图（可选）": input.referenceAssets.character,
                [`分镜${groupId}生图（十二宫格图）`]: {
                    ...input.contactSheets.find((sheet) => sheet.groupOrdinal === groupOrdinal)?.redrawnContactSheet,
                    visualBoardOrdinal: 2,
                    ...input.visualBoards[1]?.layout.find((item) => item.groupOrdinal === groupOrdinal),
                },
                "48镜头解析": input.frames,
                "文案预处理": {
                    [`第${chineseOrdinal(groupOrdinal)}部分：分镜${groupId}`]: blocks.map((block) => ({
                        "分镜区间": `分镜${block.frameOrdinals[0]}-${block.frameOrdinals[2]}`,
                        "字幕": block.text,
                    })),
                },
                "产品图": input.referenceAssets.product,
                "参考音频（可选）": input.hasNarration ? input.referenceAssets.audio : { available: false },
                "配音选择": input.hasNarration ? (input.voice === "male" ? "男性配音" : "女性配音") : "无配音",
                "图片附件位置": input.visualBoards,
            }),
        },
    ];
}

export function assertRemakeVideoPrompt(value: string, input: Pick<RemakeProductionPromptInput, "copyBlocks" | "hasNarration" | "voice">, groupId: RemakeProductionGroupId) {
    if (!value.trim() || value.length > 100_000) throw new Error(`分镜 ${groupId} 的视频提示词为空或超过长度上限`);
    const firstFrame = Number(groupId.split("-")[0]);
    const intervals = Array.from(value.matchAll(/分镜\s*(\d+)\s*[-－–—~～至]\s*(\d+)\s*[，,:：]/gu));
    if (intervals.length !== 4 || intervals.some((match, index) => Number(match[1]) !== firstFrame + index * 3 || Number(match[2]) !== firstFrame + index * 3 + 2)) {
        throw new Error(`分镜 ${groupId} 的视频提示词未包含对应的四个连续三帧区间`);
    }
    if (!/15\s*秒/u.test(value) || !value.includes("@十二宫格图") || !value.includes("禁止画面出现字幕")) {
        throw new Error(`分镜 ${groupId} 的视频提示词缺少必要的时长、十二宫格或禁字幕要求`);
    }
    const blocks = input.copyBlocks.filter((block) => block.frameOrdinals[0] >= firstFrame && block.frameOrdinals[2] <= firstFrame + 11);
    if (blocks.length !== 4) throw new Error(`分镜 ${groupId} 缺少文案预处理区间`);
    if (input.hasNarration) {
        const speaker = input.voice === "male" ? "旁白" : "人物";
        intervals.forEach((match, index) => {
            const interval = value.slice(match.index, intervals[index + 1]?.index);
            if (!blocks[index].text.trim() || !interval.includes(blocks[index].text) || !new RegExp(`口播[（(][^）)\\n]*[，,]\\s*${speaker}\\s*[，,]`, "u").test(interval)) {
                throw new Error(`分镜 ${groupId} 的第 ${index + 1} 个区间未保留原文案或所选配音格式`);
            }
        });
    } else if (/@音频文件|口播\s*[（(]/u.test(value)) {
        throw new Error(`分镜 ${groupId} 选择无配音，但模型返回了口播或音频引用`);
    }
}

export function renderRemakeCopyReport(input: RemakeProductionCopyReportInput) {
    const blocks = [...input.blocks].sort((left, right) => left.ordinal - right.ordinal);
    if (blocks.length !== 16 || blocks.some((block, index) => block.ordinal !== index + 1)) throw new Error("文案预处理必须包含连续的 16 个区间");
    assertRemakeCopyCoverage(input.sourceCopy, blocks);
    const paragraphs = [...input.paragraphs].sort((left, right) => left.ordinal - right.ordinal);
    const mappings = [...input.mappings].sort((left, right) => left.blockOrdinal - right.blockOrdinal);
    assertSemanticCopyData(input.sourceCopy, blocks, paragraphs, mappings);
    if (input.stats.paragraphCount !== paragraphs.length) throw new Error("文案段落统计与语义段落数量不一致");
    if (input.rawReport && isDetailedCopyReport(input.rawReport, input)) return fenced(input.rawReport);

    const mappingByBlock = new Map(mappings.map((mapping) => [mapping.blockOrdinal, mapping]));
    const allocationRows = blocks
        .map((block) => {
            const paragraphReferences = (mappingByBlock.get(block.ordinal)?.paragraphOrdinals || []).map((ordinal) => `段落${ordinal}`).join("、") || "-";
            return `| 区间${block.ordinal} | 分镜${block.frameOrdinals[0]}-${block.frameOrdinals[2]} | ${paragraphReferences} |`;
        })
        .join("\n");
    const checkRows = blocks.map((block) => `| 区间${block.ordinal} | 分镜${block.frameOrdinals[0]}-${block.frameOrdinals[2]} | ${markdownCell(firstCharacters(block.text, 20))} | ✅ |`).join("\n");
    const sections = Array.from({ length: 4 }, (_, groupIndex) => {
        const first = groupIndex * 4;
        const group = blocks.slice(first, first + 4);
        const firstFrame = groupIndex * 12 + 1;
        const lastFrame = firstFrame + 11;
        return [
            `=== 第${chineseOrdinal(groupIndex + 1)}部分：分镜${firstFrame}-${lastFrame}（第${chineseOrdinal(groupIndex + 1)}张十二宫格，${groupIndex * 15}-${(groupIndex + 1) * 15}秒） ===`,
            "",
            "| 分镜区间 | 字幕 |",
            "|---|---|",
            ...group.map((block) => `| 分镜${block.frameOrdinals[0]}-${block.frameOrdinals[2]} | ${markdownCell(block.text)} |`),
        ].join("\n");
    });
    const filledBlocks = input.stats.completedBlocks;
    return fenced(
        [
            "=== 文案切分结果 ===",
            "",
            `- 文案段落数量：${input.stats.paragraphCount}个`,
            "- 分镜区间数量：16个",
            `- 平均每区间对应段落：约${(paragraphs.length / 16).toFixed(1)}个`,
            "",
            "段落分配表：",
            "| 区间 | 分镜范围 | 文案段落 |",
            "|---|---|---|",
            allocationRows,
            "",
            "---",
            "",
            "=== 处理方式 ===",
            "",
            `选择：【${input.optionRaw || "A: 保持原文案"}】`,
            "",
            "---",
            "",
            "=== 顺序填充检查 ===",
            "",
            "| 区间 | 分镜范围 | 文案内容（前20字符） | 状态 |",
            "|---|---|---|---|",
            checkRows,
            "",
            "检查结果：",
            `- 顺序正确：${input.checks.sequential ? "✅" : "❌"}`,
            `- 无重复：${input.checks.noDuplicates ? "✅" : "❌"}`,
            `- 无跳跃：${input.checks.noSkips ? "✅" : "❌"}`,
            "",
            "---",
            "",
            "=== 字幕补全校对统计 ===",
            "",
            `- 保持不变：${input.stats.unchangedBlocks}个区间`,
            `- 补全字幕：${filledBlocks}个区间`,
            `- 校对修正：${input.stats.correctedBlocks}个区间`,
            `- 字幕为空：${input.stats.emptyBlocks}个区间`,
            "",
            "---",
            "",
            ...sections.flatMap((section) => [section, ""]),
        ]
            .join("\n")
            .trim(),
    );
}

export function assertRemakeCopyCoverage(sourceCopy: string, blocks: RemakeProductionCopyBlock[]) {
    if (blocks.length !== 16 || blocks.some((block, index) => block.ordinal !== index + 1)) throw new Error("文案预处理必须包含连续的 16 个区间");
    if (!sourceCopy.trim()) {
        if (blocks.some((block) => block.sourceText.trim() || block.text.trim())) throw new Error("无口播视频的文案区间必须保持为空");
        return;
    }
    if (blocks.some((block) => !block.sourceText.trim() || !block.text.trim())) throw new Error("文案预处理必须包含连续且非空的 16 个区间");
    const assigned = [...blocks]
        .sort((left, right) => left.ordinal - right.ordinal)
        .map((block) => block.sourceText)
        .join("");
    if (sourceCopy !== assigned) throw new Error("16 个文案区间没有按原顺序完整覆盖原文案（必须逐字符一致）");
}

function markdownCell(value: string) {
    return value
        .trim()
        .replace(/[\r\n]+/g, " ")
        .replace(/\|/g, "\\|");
}

function fenced(value: string) {
    const trimmed = value.trim();
    if (/^```[^\r\n]*\r?\n[\s\S]*\r?\n```$/u.test(trimmed)) return trimmed;
    return `\`\`\`\n${trimmed}\n\`\`\``;
}

function firstCharacters(value: string, count: number) {
    return Array.from(value).slice(0, count).join("");
}

function assertSemanticCopyData(sourceCopy: string, blocks: RemakeProductionCopyBlock[], paragraphs: Array<{ ordinal: number; text: string }>, mappings: Array<{ blockOrdinal: number; paragraphOrdinals: number[]; sourceText: string; text: string }>) {
    if (!sourceCopy.trim()) {
        if (paragraphs.length || mappings.length !== 16 || mappings.some((mapping, index) => mapping.blockOrdinal !== index + 1 || mapping.paragraphOrdinals.length || mapping.sourceText.trim() || mapping.text.trim())) {
            throw new Error("无口播视频的文案预处理数据必须保持为空");
        }
        return;
    }
    if (!paragraphs.length || paragraphs.some((paragraph, index) => paragraph.ordinal !== index + 1 || !paragraph.text.trim()) || paragraphs.map((paragraph) => paragraph.text).join("") !== sourceCopy) {
        throw new Error("文案段落没有按原顺序逐字符完整覆盖原文案");
    }
    if (mappings.length !== 16 || mappings.some((mapping, index) => mapping.blockOrdinal !== index + 1 || !mapping.paragraphOrdinals.length)) {
        throw new Error("文案预处理必须保留连续的 16 个段落映射");
    }
    const flattenedOrdinals = mappings.flatMap((mapping) => mapping.paragraphOrdinals);
    if (flattenedOrdinals.length !== paragraphs.length || flattenedOrdinals.some((ordinal, index) => ordinal !== index + 1)) {
        throw new Error("文案段落映射存在重复或跳跃");
    }
    if (
        mappings.some((mapping, index) => {
            const mappedText = mapping.paragraphOrdinals.map((ordinal) => paragraphs[ordinal - 1]?.text || "").join("");
            return mappedText !== blocks[index].sourceText || mapping.sourceText !== blocks[index].sourceText || mapping.text !== blocks[index].text;
        })
    ) {
        throw new Error("文案段落映射与 16 个口播区间不一致");
    }
}

function isDetailedCopyReport(report: string, input: RemakeProductionCopyReportInput) {
    const expectedFilled = input.stats.completedBlocks;
    const compactReport = report.replace(/\s+/gu, "");
    return [
        `文案段落数量：${input.paragraphs.length}个`,
        "平均每区间对应段落：",
        "段落分配表：",
        "文案内容（前20字符）",
        `保持不变：${input.stats.unchangedBlocks}个区间`,
        `补全字幕：${expectedFilled}个区间`,
        `校对修正：${input.stats.correctedBlocks}个区间`,
        `字幕为空：${input.stats.emptyBlocks}个区间`,
        "0-15秒",
        "15-30秒",
        "30-45秒",
        "45-60秒",
    ].every((section) => compactReport.includes(section.replace(/\s+/gu, "")));
}

function chineseOrdinal(value: number) {
    return ["一", "二", "三", "四"][value - 1] || String(value);
}
