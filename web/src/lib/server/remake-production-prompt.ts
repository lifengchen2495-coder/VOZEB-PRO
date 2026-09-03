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

export type RemakeProductionGroupPlan = {
    ordinal: number;
    style: string;
    scene: string;
    emotionalRhythm: [string, string, string, string];
    person?: string;
    products: string[];
    overallVisual: string;
    intervals: Array<{
        blockOrdinal: number;
        emotion: string;
        actions: [string, string, string];
    }>;
};

export type RemakeProductionPlan = {
    groups: RemakeProductionGroupPlan[];
};

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
    background: RemakeProductionAssetMetadata;
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

export const remakeProductionTool = {
    name: "build_remake_production_plan",
    description: "为四张十二宫格生成严格对应的 Seedance 视频结构，不改变镜头顺序、商品事实或口播文本",
    parameters: {
        type: "object",
        properties: {
            groups: {
                type: "array",
                minItems: REMAKE_PRODUCTION_GROUP_COUNT,
                maxItems: REMAKE_PRODUCTION_GROUP_COUNT,
                items: {
                    type: "object",
                    properties: {
                        ordinal: { type: "integer", minimum: 1, maximum: REMAKE_PRODUCTION_GROUP_COUNT },
                        style: { type: "string", minLength: 1, maxLength: 120 },
                        scene: { type: "string", minLength: 1, maxLength: 160 },
                        emotionalRhythm: {
                            type: "array",
                            minItems: REMAKE_PRODUCTION_BLOCKS_PER_GROUP,
                            maxItems: REMAKE_PRODUCTION_BLOCKS_PER_GROUP,
                            items: { type: "string", minLength: 1, maxLength: 80 },
                        },
                        person: {
                            type: "string",
                            minLength: 1,
                            maxLength: 300,
                            description: "仅当该组镜头解析中确实出现人物时填写；纯产品或纯手部操作组必须省略",
                        },
                        products: {
                            type: "array",
                            minItems: 1,
                            maxItems: 12,
                            items: { type: "string", minLength: 1, maxLength: 300 },
                            description: "逐项列出该组真实画面中的产品、食材或器具；多件素材不得合并为一个字符串",
                        },
                        overallVisual: {
                            type: "string",
                            minLength: 1,
                            maxLength: 300,
                            description: "仅填写人物皮肤、动作连续性、光线等补充画面要求，不要重复产品植入自然、画面有质感、无多余杂物或画面清晰无模糊",
                        },
                        intervals: {
                            type: "array",
                            minItems: REMAKE_PRODUCTION_BLOCKS_PER_GROUP,
                            maxItems: REMAKE_PRODUCTION_BLOCKS_PER_GROUP,
                            items: {
                                type: "object",
                                properties: {
                                    blockOrdinal: { type: "integer", minimum: 1, maximum: 16 },
                                    emotion: { type: "string", minLength: 1, maxLength: 80 },
                                    actions: {
                                        type: "array",
                                        minItems: 3,
                                        maxItems: 3,
                                        items: { type: "string", minLength: 1, maxLength: 300 },
                                    },
                                },
                                required: ["blockOrdinal", "emotion", "actions"],
                                additionalProperties: false,
                            },
                        },
                    },
                    required: ["ordinal", "style", "scene", "emotionalRhythm", "products", "overallVisual", "intervals"],
                    additionalProperties: false,
                },
            },
        },
        required: ["groups"],
        additionalProperties: false,
    },
};

export function remakeProductionMessages(input: RemakeProductionPromptInput) {
    const voice = input.hasNarration ? (input.voice === "male" ? "男性配音" : "女性配音") : "不需要人物口播";
    const narrationRule = input.hasNarration
        ? "必须保持 16 个三帧区间中的原语言口播，禁止翻译、改写或遗漏；声音只引用用户选择的配音和原视频音频。"
        : "当前视频不需要人物口播。16 个三帧区间的 sourceText 与 text 均为空，只生成画面动作和分镜描述，禁止添加口播、配音、音频引用或字幕。";
    return [
        {
            role: "system",
            content: `你是电商视频复刻导演。用户消息后会按 visualBoards 的 ordinal 顺序附带真实图片像素；必须逐张查看，并严格按照每张视觉板的 description、layout、位置标签、groupOrdinal 与 frameOrdinals 建立素材对应关系。第一张视觉板用于识别可选目标人物、可选人物补充角度和目标背景，第二张视觉板按左上、右上、左下、右下对应第 1 至第 4 组重绘十二宫格。必须结合这些真实像素、48 镜头文字解析和 16 个三帧区间生成四个 15 秒 Seedance 生产单元。${narrationRule}保持画面中的原商品、人物身份、场景、动作意图、构图和镜头顺序，禁止添加素材不存在的功效、价格、品牌、认证、促销及视觉事实。products 必须逐项列出组内每件可见产品、食材或器具，多件素材不得合并为一项。纯产品或纯手部操作组省略 person，不得凭空添加人物。每组必须恰好四个连续三帧区间，每个区间恰好三个可执行动作。必须调用 build_remake_production_plan。`,
        },
        {
            role: "user",
            content: JSON.stringify({
                title: input.title,
                hasNarration: input.hasNarration,
                voice,
                runtimeVisualCapability: "multimodal-image-pixels; two ordered visual boards are attached after this text",
                visualBoards: input.visualBoards,
                referenceAssets: {
                    ...input.referenceAssets,
                    audio: input.hasNarration ? input.referenceAssets.audio : { available: false },
                },
                contactSheets: input.contactSheets,
                frames: input.frames,
                copyBlocks: input.copyBlocks.map((block) => ({ ...block, ...(input.hasNarration ? { speechLanguage: speechLanguage(block.text) } : {}) })),
            }),
        },
    ];
}

export function parseRemakeProductionPlan(value: string): RemakeProductionPlan | null {
    let payload: unknown;
    try {
        payload = JSON.parse(value);
    } catch {
        return null;
    }
    const groups = records(record(payload).groups)
        .map(normalizeGroup)
        .filter((group): group is RemakeProductionGroupPlan => Boolean(group))
        .sort((left, right) => left.ordinal - right.ordinal);
    if (groups.length !== REMAKE_PRODUCTION_GROUP_COUNT || groups.some((group, index) => group.ordinal !== index + 1)) return null;
    return { groups };
}

export function renderRemakeSeedancePrompts(input: { plan: RemakeProductionPlan; copyBlocks: RemakeProductionCopyBlock[]; hasNarration: boolean }) {
    const blocks = new Map(input.copyBlocks.map((block) => [block.ordinal, block]));
    if (blocks.size !== REMAKE_PRODUCTION_GROUP_COUNT * REMAKE_PRODUCTION_BLOCKS_PER_GROUP) throw new Error("文案预处理必须包含 16 个三帧区间");
    if (input.hasNarration && input.copyBlocks.some((block) => !block.text.trim())) throw new Error("有口播视频的 16 个三帧区间不能为空");
    if (!input.hasNarration && input.copyBlocks.some((block) => block.sourceText.trim() || block.text.trim())) throw new Error("无口播视频的 16 个三帧区间必须为空");
    return input.plan.groups.map((group) => {
        const firstFrame = (group.ordinal - 1) * 12 + 1;
        const lastFrame = group.ordinal * 12;
        const person = cleanSentence(group.person || "");
        const intervalText = group.intervals
            .map((interval) => {
                const block = blocks.get(interval.blockOrdinal);
                if (!block) throw new Error(`缺少区间 ${interval.blockOrdinal} 的口播文案`);
                const actionText = interval.actions.map(cleanSentence).join("；");
                const personSafety = person ? "；生成人物 禁止出现模糊处理、遮挡" : "";
                const narration = input.hasNarration ? `；口播（${speechLanguage(block.text)}，人物，${cleanSentence(interval.emotion)}）：★\"${block.text}\"` : "";
                return `分镜${block.frameOrdinals[0]}-${block.frameOrdinals[2]}，${actionText}${narration}${personSafety}；`;
            })
            .join("\n\n");
        const opening = `15秒抖音短视频，${cleanSentence(group.style)}，全程高清写实，电影级光影，9:16竖屏，镜头流畅连贯；场景：${cleanSentence(group.scene)}；${person ? "生成人物 禁止出现模糊处理、遮挡；" : ""}`;
        const sections = [
            opening,
            `情绪节奏：${group.emotionalRhythm.map(cleanSentence).join(" → ")}`,
            person ? `人物：${withAssetTag(person, "@人物图")}` : "",
            `产品：${group.products.map((product) => withProductAssetTag(cleanSentence(product))).join("；")}；`,
            input.hasNarration ? "声音风格：说话自然，有停顿，有情绪起伏，人物动作和文案节奏连贯；音色参考@音频文件" : "",
            "无文字 禁止画面出现字幕 禁止画面出现字幕 禁止画面出现字幕",
            "剧情流程：",
            "正在执行分镜图 @十二宫格图 的动作，依次呈现12个连续的分镜头画面分别是：",
            intervalText,
            `整体画面：${renderOverallVisual(group.overallVisual)}`,
            "无文字 禁止画面出现字幕 禁止画面出现字幕 禁止画面出现字幕",
        ].filter(Boolean);
        return {
            ordinal: group.ordinal,
            range: `${firstFrame}-${lastFrame}`,
            text: fenced(sections.join("\n\n")),
        };
    });
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

function normalizeGroup(value: Record<string, unknown>): RemakeProductionGroupPlan | null {
    const ordinal = integer(value.ordinal, 1, REMAKE_PRODUCTION_GROUP_COUNT);
    if (!ordinal) return null;
    const expectedStart = (ordinal - 1) * REMAKE_PRODUCTION_BLOCKS_PER_GROUP + 1;
    const emotions = strings(value.emotionalRhythm, REMAKE_PRODUCTION_BLOCKS_PER_GROUP, 80);
    const intervals = records(value.intervals)
        .map((item) => {
            const blockOrdinal = integer(item.blockOrdinal, expectedStart, expectedStart + REMAKE_PRODUCTION_BLOCKS_PER_GROUP - 1);
            const emotion = text(item.emotion, 80);
            const actions = strings(item.actions, 3, 300);
            return blockOrdinal && emotion && actions.length === 3 ? { blockOrdinal, emotion, actions: actions as [string, string, string] } : null;
        })
        .filter((item): item is NonNullable<typeof item> => Boolean(item))
        .sort((left, right) => left.blockOrdinal - right.blockOrdinal);
    const style = text(value.style, 120);
    const scene = text(value.scene, 160);
    const person = text(value.person, 300);
    const products = stringsBetween(value.products, 1, 12, 300);
    const overallVisual = text(value.overallVisual, 300);
    if (!style || !scene || !products.length || !overallVisual || emotions.length !== 4 || intervals.length !== 4 || intervals.some((item, index) => item.blockOrdinal !== expectedStart + index)) return null;
    return { ordinal, style, scene, emotionalRhythm: emotions as [string, string, string, string], ...(person ? { person } : {}), products, overallVisual, intervals };
}

function cleanSentence(value: string) {
    return value.trim().replace(/[；;。]+$/u, "");
}

function markdownCell(value: string) {
    return value
        .trim()
        .replace(/[\r\n]+/g, " ")
        .replace(/\|/g, "\\|");
}

function speechLanguage(value: string) {
    const hanCount = Array.from(value.matchAll(/\p{Script=Han}/gu)).length;
    const latinCount = Array.from(value.matchAll(/\p{Script=Latin}/gu)).length;
    if (latinCount > hanCount) return "英文";
    if (hanCount > 0) return "中文";
    return latinCount > 0 ? "英文" : "原文";
}

function withAssetTag(value: string, tag: "@人物图") {
    return value.includes(tag) ? value : `${value}${tag}`;
}

function withProductAssetTag(value: string) {
    if (value.includes("@产品图")) return value;
    const descriptionStart = value.search(/[，,]/u);
    return descriptionStart > 0 ? `${value.slice(0, descriptionStart)}@产品图${value.slice(descriptionStart)}` : `${value}@产品图`;
}

function renderOverallVisual(value: string) {
    const fixedSegments = ["产品植入自然", "画面有质感", "无多余杂物", "画面清晰无模糊"];
    const supplementalSegments = cleanSentence(value)
        .split(/[，,；;。]+/u)
        .map((segment) => segment.trim())
        .filter((segment) => segment && !fixedSegments.includes(segment));
    return [fixedSegments[0], fixedSegments[1], ...supplementalSegments, fixedSegments[2], fixedSegments[3]].join("，");
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

function record(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function records(value: unknown) {
    return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
}

function text(value: unknown, maximum: number) {
    return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function strings(value: unknown, maximumItems: number, maximumLength: number) {
    if (!Array.isArray(value) || value.length !== maximumItems) return [];
    const values = value.map((item) => text(item, maximumLength));
    return values.every(Boolean) ? values : [];
}

function stringsBetween(value: unknown, minimumItems: number, maximumItems: number, maximumLength: number) {
    if (!Array.isArray(value) || value.length < minimumItems || value.length > maximumItems) return [];
    const values = value.map((item) => text(item, maximumLength));
    return values.every(Boolean) ? values : [];
}

function integer(value: unknown, minimum: number, maximum: number) {
    const number = Number(value);
    return Number.isInteger(number) && number >= minimum && number <= maximum ? number : 0;
}
