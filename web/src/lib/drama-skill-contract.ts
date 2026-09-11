import manifest from "@/lib/server/drama-skills/manifest.json";

export type DramaSkillStage = "characters" | "beats" | "script" | "content" | "visual" | "video-prompts";

export interface DramaSkillCheck {
    id: string;
    title: string;
    passed: boolean;
    detail: string;
}

export interface DramaSkillReport {
    skillId: string;
    version: string;
    document: string;
    assumptions: string[];
    changes: string[];
    /** 模型自查声明，不代表程序或人工已确认创作质量。 */
    checks: DramaSkillCheck[];
}

export interface DramaSkillValidation {
    valid: boolean;
    issues: string[];
    /** 只检查报告结构和必要模块，独立于模型自查结果。 */
    formatChecks: DramaSkillCheck[];
    modelChecksPassed: boolean;
}

const textSchema = { type: "string", minLength: 1 };
export const DRAMA_SKILL_REPORT_SCHEMA: Record<string, unknown> = {
    type: "object",
    properties: {
        document: { type: "string", minLength: 200, description: "遵照 Skill 输出格式的完整作品正文，包含全部必需模块；不得用分析摘要替代作品。" },
        assumptions: { type: "array", items: textSchema, description: "从原稿无法确定而由 AI 补足的设定；无假设时返回空数组。" },
        changes: { type: "array", items: textSchema, description: "相对原稿的剧情、人物、对白等创作调整及原因；无调整时返回空数组。" },
        checks: {
            type: "array",
            minItems: 1,
            items: { type: "object", properties: { id: textSchema, title: textSchema, passed: { type: "boolean" }, detail: textSchema }, required: ["id", "title", "passed", "detail"], additionalProperties: false },
        },
    },
    required: ["document", "assumptions", "changes", "checks"],
    additionalProperties: false,
};

type ChecklistItem = Pick<DramaSkillCheck, "id" | "title">;
const characterChecklist: ChecklistItem[] = [
    { id: "character-completeness", title: "每名角色的五个小传模块完整" },
    { id: "character-executable", title: "外貌、动作参数、微动态与声音可执行" },
    { id: "character-consistency", title: "不可变特征及动作、声音跨集一致" },
    { id: "character-logic", title: "关键经历、性格、执念与行为动机自洽" },
    { id: "character-concision", title: "背景聚焦影响行为的关键经历" },
];
const beatsChecklist: ChecklistItem[] = [
    { id: "rhythm-timing", title: "秒级节奏与快慢时长符合规范" },
    { id: "rhythm-emotion", title: "每 30 秒有情绪变化、无超过 60 秒的平淡期" },
    { id: "rhythm-payoff", title: "一个核心爽点及两到三个小爽点有铺垫与释放" },
    { id: "rhythm-dynamics", title: "强动态爽点不超过三处且匹配人设" },
    { id: "rhythm-conflict", title: "每 45 秒小冲突、每集核心冲突及 3 至 5 秒留白" },
    { id: "rhythm-series", title: "三集小闭环、十集大节点与下集钩子衔接" },
];
const scriptChecklist: ChecklistItem[] = [
    { id: "writing-format", title: "场景头、人物、动作、台词、动态标注完整" },
    { id: "writing-character", title: "人物逻辑及世界观前后一致" },
    { id: "writing-dynamics", title: "动态分层清晰、强动态不超过三处" },
    { id: "writing-rhythm", title: "每 30 秒有情绪拐点或动作亮点" },
    { id: "writing-duration", title: "时长与字数符合目标，默认 3 至 5 分钟、800 至 1200 字" },
    { id: "writing-dialogue", title: "口语化、人设化、单句不超过十字、独白不超过三十字及口型分级" },
    { id: "writing-production", title: "动作可执行、音效数量和字幕标注符合规范" },
    { id: "writing-content", title: "创作内容与改编说明经过自查" },
];
const contentChecklist: ChecklistItem[] = [
    { id: "storyboard-sequence", title: "分镜编号从 01 起连续且内容完整" },
    { id: "storyboard-fields", title: "每镜场景、时间、人物、景别、画面及台词音效完整" },
    { id: "storyboard-dynamics", title: "使用动・基础、中度、特效三级标注" },
    { id: "storyboard-transitions", title: "逐镜使用规范转场标注" },
    { id: "storyboard-audio", title: "环境、动作、配乐分轨且对白、旁白归属明确" },
    { id: "storyboard-notes", title: "重要动态在备注使用 ▲ 标注" },
    { id: "storyboard-subtitles", title: "字幕位置、样式和朗读时长加 0.5 秒符合规范" },
];
const seedanceChecklist: ChecklistItem[] = [
    { id: "seedance-understanding", title: "理解确认包含叙事、风格、画幅、声音及素材条件" },
    { id: "seedance-timeline", title: "每段时间轴完整覆盖 4 至 15 秒片段且无重叠断点" },
    { id: "seedance-camera", title: "每时间段包含景别、运镜及片段衔接方式" },
    { id: "seedance-motion", title: "逐段主体、环境、背景及特效运动具体连续" },
    { id: "seedance-sound", title: "配乐、音效、对白或旁白设计完整" },
    { id: "seedance-assets", title: "C/S/P 素材编号与中英文提示词完整，引用对应实际素材" },
    { id: "seedance-limits", title: "参考文件总数、类型数量及视频音频时长符合来源限制" },
    { id: "seedance-continuity", title: "主体、场景、光影及首尾帧连续性约束清晰" },
    { id: "seedance-usage", title: "素材建议与使用提示包含素材用途及正确引用语法" },
];

export const DRAMA_SKILL_CHECKLISTS: Record<DramaSkillStage, readonly ChecklistItem[]> = {
    characters: characterChecklist,
    beats: beatsChecklist,
    script: scriptChecklist,
    content: contentChecklist,
    visual: seedanceChecklist,
    "video-prompts": seedanceChecklist,
};

interface DocumentSection {
    title: string;
    minChars: number;
}
const seedanceSections: DocumentSection[] = [
    { title: "理解确认", minChars: 30 },
    { title: "分镜提示词", minChars: 160 },
    { title: "素材清单", minChars: 60 },
    { title: "素材建议", minChars: 15 },
    { title: "使用提示", minChars: 15 },
];

// 固定外层标题只为保存和校验完整作品；各节内部仍遵照源文件模板。
export const DRAMA_SKILL_DOCUMENT_SECTIONS: Record<DramaSkillStage, readonly DocumentSection[]> = {
    characters: [
        { title: "基础信息", minChars: 35 },
        { title: "核心背景", minChars: 35 },
        { title: "性格与行为逻辑", minChars: 35 },
        { title: "动态专属设定", minChars: 35 },
        { title: "剧情关联", minChars: 35 },
    ],
    beats: [
        { title: "输入提取", minChars: 25 },
        { title: "节奏时间表", minChars: 80 },
        { title: "爽点设计", minChars: 70 },
        { title: "冲突与留白", minChars: 40 },
        { title: "系列布局与钩子", minChars: 30 },
    ],
    script: [
        { title: "剧本基础信息", minChars: 15 },
        { title: "详细剧本", minChars: 250 },
        { title: "制作说明", minChars: 40 },
    ],
    content: [
        { title: "剧本基础信息", minChars: 15 },
        { title: "核心设定前置", minChars: 30 },
        { title: "前置剧情", minChars: 10 },
        { title: "分镜脚本", minChars: 130 },
        { title: "特殊标注规范", minChars: 40 },
    ],
    visual: seedanceSections,
    "video-prompts": seedanceSections,
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");

/** 兼容历史记录：没有报告时返回 undefined，不补造作品或自查结果。 */
export function normalizeDramaSkillReport(value: unknown): DramaSkillReport | undefined {
    if (!isRecord(value) || typeof value.skillId !== "string" || typeof value.version !== "string" || typeof value.document !== "string") return undefined;
    if (!strings(value.assumptions) || !strings(value.changes) || !Array.isArray(value.checks)) return undefined;
    if (!value.checks.every((check) => isRecord(check) && typeof check.id === "string" && typeof check.title === "string" && typeof check.passed === "boolean" && typeof check.detail === "string")) return undefined;
    return {
        skillId: value.skillId,
        version: value.version,
        document: value.document,
        assumptions: [...value.assumptions],
        changes: [...value.changes],
        checks: value.checks.map((check) => ({ id: check.id, title: check.title, passed: check.passed, detail: check.detail })),
    };
}

/** 仅比较轻量来源元数据，不向客户端打包 Skill 全文。 */
export function isCurrentDramaSkillReport(stage: DramaSkillStage, value: unknown): boolean {
    const report = normalizeDramaSkillReport(value);
    const definition = manifest.skills.find((skill) => skill.stages.includes(stage));
    return Boolean(report && definition && report.skillId === definition.id && report.version === definition.version);
}

function sectionText(document: string, title: string, titles: readonly string[]): string | undefined {
    const marker = `【${title}】`;
    const start = document.indexOf(marker);
    if (start < 0) return undefined;
    const contentStart = start + marker.length;
    const boundaries = titles.map((next) => document.indexOf(`【${next}】`, contentStart)).filter((index) => index >= 0);
    return document.slice(contentStart, boundaries.length ? Math.min(...boundaries) : undefined).trim();
}

function placeholderOnly(text: string): boolean {
    return /^(?:[\s\p{P}\p{S}]|待补充|未填写|略|同上|参考原稿|按需填写|TODO|N\/A)+$/iu.test(text);
}

function hasField(document: string, label: string, labels: readonly string[], allowMarkup = false): boolean {
    const match = new RegExp(`${label.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}[：:]`, "u").exec(document);
    if (!match) return false;
    const start = match.index + match[0].length;
    const following = labels.flatMap((next) => [document.indexOf(`${next}：`, start), document.indexOf(`${next}:`, start)]).filter((index) => index >= 0);
    const value = document.slice(start, following.length ? Math.min(...following) : undefined).trim();
    return value.length > 0 && (allowMarkup || !value.startsWith("【")) && !placeholderOnly(value);
}

/** 程序检查只证明必要字段和模块存在，不把模型自查声明当作质量证据。 */
export function validateDramaSkillReport(stage: DramaSkillStage, value: unknown): DramaSkillValidation {
    return validateDramaSkillReportPart(stage, value, 1);
}

function validateDramaSkillReportPart(stage: DramaSkillStage, value: unknown, firstShotNumber: number): DramaSkillValidation {
    const formatChecks: DramaSkillCheck[] = [];
    const add = (id: string, title: string, passed: boolean, detail: string) => formatChecks.push({ id, title, passed, detail });
    const report = normalizeDramaSkillReport(value);
    if (!report) return { valid: false, issues: ["Skill 报告结构不完整"], formatChecks: [{ id: "report-shape", title: "报告字段类型", passed: false, detail: "需要完整正文、假设、调整和模型自查数组。" }], modelChecksPassed: false };
    const parts = [...report.document.matchAll(/^# 分段[ \t]+(\d+)[ \t]*\r?$/gmu)];
    if (parts.length > 0) {
        add(
            "report-part-numbering",
            "作品分段编号连续",
            parts.every((part, index) => Number(part[1]) === index + 1),
            "合并作品的分段须从 1 连续编号。",
        );
        let nextShotNumber = firstShotNumber;
        for (const [index, part] of parts.entries()) {
            const document = report.document.slice(part.index + part[0].length, parts[index + 1]?.index).trim();
            const validation = validateDramaSkillReportPart(stage, { ...report, document }, nextShotNumber);
            formatChecks.push(...validation.formatChecks.map((check) => ({ ...check, id: `part-${index + 1}-${check.id}`, title: `分段 ${index + 1}：${check.title}` })));
            if (stage === "content") {
                const script =
                    sectionText(
                        document,
                        "分镜脚本",
                        DRAMA_SKILL_DOCUMENT_SECTIONS.content.map((section) => section.title),
                    ) || "";
                nextShotNumber += [...script.matchAll(/【分镜\s*\d+】/gu)].length;
            }
        }
        const issues = formatChecks.filter((check) => !check.passed).map((check) => `${check.title}：${check.detail}`);
        return { valid: issues.length === 0, issues, formatChecks, modelChecksPassed: DRAMA_SKILL_CHECKLISTS[stage].every((expected) => report.checks.some((check) => check.id === expected.id && check.passed)) };
    }
    add("report-identity", "来源标识与版本", Boolean(report.skillId.trim() && report.version.trim()), "标识与版本必须非空，生成时由服务端注入来源版本。");
    add("report-document", "完整作品正文", report.document.trim().length >= 200, "正文至少 200 字符，仍需逐项验证必要模块。");
    add(
        "report-lists",
        "假设与调整记录格式",
        [...report.assumptions, ...report.changes].every((entry) => entry.trim().length > 0),
        "无假设或调整时使用空数组，不填写空字符串。",
    );
    const ids = report.checks.map((check) => check.id);
    add("report-check-duplicates", "自查条目不重复", new Set(ids).size === ids.length, "每项自查使用唯一 ID。");
    for (const expected of DRAMA_SKILL_CHECKLISTS[stage]) {
        const check = report.checks.find((entry) => entry.id === expected.id);
        add(`model-entry-${expected.id}`, `自查条目：${expected.title}`, Boolean(check?.title.trim() && check.detail.trim()), "只验证该自查条目有说明，不认可或改写模型的 passed 声明。");
    }
    const sections = DRAMA_SKILL_DOCUMENT_SECTIONS[stage];
    const titles = sections.map((section) => section.title);
    const documents = stage === "characters" && report.document.includes("【动态漫人物小传】") ? report.document.split(/(?=【动态漫人物小传】)/u).filter((part) => part.startsWith("【动态漫人物小传】")) : [report.document];
    if (!documents.length) documents.push(report.document);
    for (const [index, document] of documents.entries()) {
        for (const section of sections) {
            const content = sectionText(document, section.title, titles);
            add(
                `section-${index}-${section.title}`,
                `${stage === "characters" ? `人物 ${index + 1}：` : ""}${section.title}`,
                Boolean(content && content.replace(/\s/gu, "").length >= section.minChars && !placeholderOnly(content)),
                `需要【${section.title}】及不少于 ${section.minChars} 个非空白字符的具体内容，不能只放标题或占位摘要。`,
            );
        }
        if (stage === "characters") {
            const labels = ["姓名", "别名", "年龄", "外貌特征", "核心标签", "声音特质", "核心道具", "关键经历", "核心执念", "行为动机", "显性性格", "隐性反差", "行为触发点", "核心动作习惯", "微动态特征", "声音细节", "团队定位", "关系互动", "成长弧线"];
            for (const label of labels) {
                add(`character-${index}-${label}`, `人物 ${index + 1} 字段：${label}`, hasField(document, label, labels), `小传必须填写 ${label}。`);
            }
        }
    }
    if (stage === "script") {
        const script = sectionText(report.document, "详细剧本", titles) || "";
        add("script-scene", "规范场景头", /【(?:外景|内景)\s*[-－—]\s*[^\n】]+[-－—][^\n】]+[（(][^\n）)]+[）)]】/u.test(script), "详细剧本须含内外景、地点、时间与光线条件。");
        add("script-dynamics", "动态等级标注", /(?:【动[・·][微中强]】|[微中强]动态[：:])/u.test(script), "详细剧本须包含具体动态等级。");
        add("script-dialogue", "台词口型或无台词说明", /口型[：:]\s*[微中大]|无台词|无对白/u.test(script), "有台词时须标注口型；无对白作品应明确说明。");
    }
    if (stage === "beats") {
        const timeline = sectionText(report.document, "节奏时间表", titles) || "";
        add("beats-timeline", "秒级节奏表", /\d+(?:\.\d+)?\s*(?:[-~～—至]\s*\d+(?:\.\d+)?)\s*(?:秒|s)/iu.test(timeline), "节奏表须列出实际起止秒数。");
    }
    if (stage === "content") {
        const script = sectionText(report.document, "分镜脚本", titles) || "";
        const shots = [...script.matchAll(/【分镜\s*(\d+)】([\s\S]*?)(?=【分镜\s*\d+】|$)/gu)];
        add("storyboard-numbering", "连续分镜单元", shots.length > 0 && shots.every((shot, index) => Number(shot[1]) === index + firstShotNumber), `本段分镜从 ${String(firstShotNumber).padStart(2, "0")} 连续编号，与前段衔接，每镜作为独立单元。`);
        for (const shot of shots) {
            const body = shot[2];
            const labels = ["场景", "时间", "人物", "镜头", "动作/画面描述", "台词/音效", "动态效果", "转场", "备注"];
            for (const label of labels) {
                add(`shot-${shot[1]}-${label}`, `分镜 ${shot[1]}：${label}`, hasField(body, label, labels, true), `该分镜须填写 ${label}，不适用项需说明。`);
            }
            add(`shot-${shot[1]}-dynamic`, `分镜 ${shot[1]}：动态标记`, /动[・·](?:基础|中度|特效)/u.test(body), "须使用动・基础、中度或特效。");
        }
    }
    if (stage === "visual" || stage === "video-prompts") {
        const prompts = sectionText(report.document, "分镜提示词", titles) || "";
        const rows = [...prompts.matchAll(/(\d+(?:\.\d+)?)\s*[-~～—至]\s*(\d+(?:\.\d+)?)\s*(?:秒|s)\s*[：:]([^\n\r]+)/giu)];
        add("seedance-time-rows", "具体时间轴", rows.length > 0, "分镜提示词须逐行写出 0-X 秒：景别、运镜和具体画面。");
        let previousEnd = 0;
        let continuous = rows.length > 0;
        for (const [index, row] of rows.entries()) {
            add(`seedance-row-${index}-duration`, `时间段 ${index + 1}：起止时间`, Number(row[1]) >= 0 && Number(row[2]) > Number(row[1]) && Number(row[2]) <= 15, "每个片段采用 0 至 15 秒内的正向时间区间。");
            add(`seedance-row-${index}-camera`, `时间段 ${index + 1}：景别与运镜`, /远景|全景|中景|近景|特写|主观视角|黑场/u.test(row[3]) && /推|拉|摇|移|跟|环绕|升|降|切|渐变|叠化|黑场|固定镜头|固定机位/u.test(row[3]), "逐段包含景别及运镜或转场。");
            const start = Number(row[1]);
            if (start === 0 && index > 0) continuous &&= previousEnd >= 4;
            else continuous &&= Math.abs(start - previousEnd) < 0.0001;
            previousEnd = Number(row[2]);
        }
        add("seedance-timeline-continuity", "片段时间轴连续性", continuous && previousEnd >= 4, "每片段从 0 秒开始，不重叠或跳过时间，总时长 4 至 15 秒。");
        add(
            "seedance-prompt-blocks",
            "风格、声音与参考模块",
            ["风格", "声音", "参考"].every((title) => prompts.includes(`【${title}】`)),
            "每份提示词需要风格、声音和参考说明，无已上传素材时应明确写明。",
        );
        const assets = sectionText(report.document, "素材清单", titles) || "";
        add("seedance-bilingual-assets", "素材中英文提示词", /中文提示词/u.test(assets) && /English Prompt/iu.test(assets) && /(?:C|S|P)\d{2}/u.test(assets), "建议素材须使用 C/S/P 编号及中文提示词、English Prompt。");
    }
    const issues = formatChecks.filter((check) => !check.passed).map((check) => `${check.title}：${check.detail}`);
    return { valid: issues.length === 0, issues, formatChecks, modelChecksPassed: DRAMA_SKILL_CHECKLISTS[stage].every((expected) => report.checks.some((check) => check.id === expected.id && check.passed)) };
}
