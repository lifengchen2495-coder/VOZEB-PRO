export type CommerceVideoMaterial = "product-images" | "reference-video" | "storyboard" | "character-images" | "voiceover";

export type CommerceVideoWorkflowInput = {
    requestId: string;
    brief: string;
    platform: "douyin" | "tiktok" | "general";
    durationSeconds: 15 | 30 | 60;
    people: "none" | "single" | "multiple";
    language: "zh" | "en";
    materials: CommerceVideoMaterial[];
    skillId: string;
    modelId?: string;
};

export type CommerceVideoWorkflow = {
    title: string;
    summary: string;
    route: { kind: "original" | "reference-remake" | "storyboard-to-video" | "custom"; reason: string };
    materialChecklist: Array<{ id: CommerceVideoMaterial; name: string; status: "ready" | "missing" | "optional"; purpose: string }>;
    stages: Array<{ id: string; title: string; goal: string; inputs: string[]; outputs: string[]; dependsOn: string[]; prompt: string; execution: "text" | "image" | "video" | "edit" | "manual" }>;
    segments: Array<{ id: string; startSeconds: number; endSeconds: number; goal: string; visualPrompt: string; voiceover?: string; continuityNotes: string }>;
    checks: string[];
};

export class CommerceVideoWorkflowError extends Error {
    constructor(message: string, public readonly status = 400) {
        super(message);
        this.name = "CommerceVideoWorkflowError";
    }
}

const MATERIALS = ["product-images", "reference-video", "storyboard", "character-images", "voiceover"] as const;
const ROUTES = ["original", "reference-remake", "storyboard-to-video", "custom"] as const;
const EXECUTIONS = ["text", "image", "video", "edit", "manual"] as const;
const MATERIAL_NAMES: Record<CommerceVideoMaterial, string> = { "product-images": "产品图片", "reference-video": "参考视频", storyboard: "分镜图", "character-images": "人物参考图", voiceover: "配音素材" };
const ROUTE_NAMES: Record<CommerceVideoWorkflow["route"]["kind"], string> = { original: "产品原创", "reference-remake": "参考视频换品", "storyboard-to-video": "分镜图转视频", custom: "自定义流程" };
const EXECUTION_NAMES: Record<CommerceVideoWorkflow["stages"][number]["execution"], string> = { text: "文本规划", image: "图片生成", video: "视频生成", edit: "剪辑处理", manual: "人工准备或检查" };
const STATUS_NAMES = { ready: "用户已声明具备", missing: "待准备", optional: "可选" };
const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const idSchema = { type: "string", minLength: 1, maxLength: 80, pattern: ID_PATTERN.source };
const shortTextSchema = { type: "string", minLength: 1, maxLength: 300 };
const textListSchema = { type: "array", minItems: 1, maxItems: 12, items: shortTextSchema };

export const COMMERCE_VIDEO_WORKFLOW_SCHEMA = {
    type: "object",
    additionalProperties: false,
    required: ["title", "summary", "route", "materialChecklist", "stages", "segments", "checks"],
    properties: {
        title: { type: "string", minLength: 1, maxLength: 120 },
        summary: { type: "string", minLength: 1, maxLength: 1200 },
        route: {
            type: "object", additionalProperties: false, required: ["kind", "reason"],
            properties: { kind: { type: "string", enum: [...ROUTES] }, reason: { type: "string", minLength: 1, maxLength: 800 } },
        },
        materialChecklist: {
            type: "array", minItems: 5, maxItems: 5,
            items: {
                type: "object", additionalProperties: false, required: ["id", "name", "status", "purpose"],
                properties: { id: { type: "string", enum: [...MATERIALS] }, name: { type: "string", minLength: 1, maxLength: 120 }, status: { type: "string", enum: ["ready", "missing", "optional"] }, purpose: { type: "string", minLength: 1, maxLength: 500 } },
            },
        },
        stages: {
            type: "array", minItems: 1, maxItems: 16,
            items: {
                type: "object", additionalProperties: false, required: ["id", "title", "goal", "inputs", "outputs", "dependsOn", "prompt", "execution"],
                properties: {
                    id: idSchema, title: { type: "string", minLength: 1, maxLength: 120 }, goal: { type: "string", minLength: 1, maxLength: 800 },
                    inputs: textListSchema, outputs: textListSchema,
                    dependsOn: { type: "array", maxItems: 16, uniqueItems: true, items: idSchema },
                    prompt: { type: "string", minLength: 1, maxLength: 6000 }, execution: { type: "string", enum: [...EXECUTIONS] },
                },
            },
        },
        segments: {
            type: "array", minItems: 1, maxItems: 60,
            items: {
                type: "object", additionalProperties: false, required: ["id", "startSeconds", "endSeconds", "goal", "visualPrompt", "voiceover", "continuityNotes"],
                properties: {
                    id: idSchema, startSeconds: { type: "number", minimum: 0, maximum: 60 }, endSeconds: { type: "number", exclusiveMinimum: 0, maximum: 60 },
                    goal: { type: "string", minLength: 1, maxLength: 800 }, visualPrompt: { type: "string", minLength: 1, maxLength: 4000 },
                    voiceover: { type: "string", maxLength: 1500 }, continuityNotes: { type: "string", minLength: 1, maxLength: 1000 },
                },
            },
        },
        checks: { type: "array", minItems: 1, maxItems: 16, items: { type: "string", minLength: 1, maxLength: 500 } },
    },
};

export const COMMERCE_VIDEO_WORKFLOW_TOOL = {
    name: "design_commerce_video_workflow",
    description: "生成待执行、可编辑的电商视频流程、素材缺口、阶段提示词与连续分段方案",
    parameters: COMMERCE_VIDEO_WORKFLOW_SCHEMA,
};

export function normalizeCommerceVideoWorkflowInput(value: unknown): CommerceVideoWorkflowInput {
    const input = object(value, "流程需求", 400);
    knownKeys(input, ["requestId", "brief", "platform", "durationSeconds", "people", "language", "materials", "skillId", "modelId"], "流程需求", 400);
    const requestId = text(input.requestId, "请求标识", 120, 400);
    const brief = text(input.brief, "视频需求", 6000, 400);
    const skillId = text(input.skillId, "Skill", 160, 400);
    const platform = enumeration(input.platform, ["douyin", "tiktok", "general"] as const, "目标平台", 400);
    const durationSeconds = enumeration(input.durationSeconds, [15, 30, 60] as const, "目标时长", 400);
    const people = enumeration(input.people, ["none", "single", "multiple"] as const, "出镜人数", 400);
    const language = enumeration(input.language, ["zh", "en"] as const, "视频语言", 400);
    if (!Array.isArray(input.materials) || input.materials.length > MATERIALS.length) throw new CommerceVideoWorkflowError("已有素材选项不正确。");
    const materials = Array.from(new Set(input.materials.map((item) => enumeration(item, MATERIALS, "已有素材", 400))));
    const modelId = input.modelId === undefined || input.modelId === "" ? undefined : text(input.modelId, "模型", 160, 400);
    return { requestId, brief, platform, durationSeconds, people, language, materials, skillId, ...(modelId ? { modelId } : {}) };
}

export function normalizeCommerceVideoWorkflow(value: unknown, input: CommerceVideoWorkflowInput): CommerceVideoWorkflow {
    const root = object(value, "视频流程");
    knownKeys(root, ["title", "summary", "route", "materialChecklist", "stages", "segments", "checks"], "视频流程");
    const title = text(root.title, "流程标题", 120);
    const summary = text(root.summary, "流程摘要", 1200);
    const routeValue = object(root.route, "生产路线");
    knownKeys(routeValue, ["kind", "reason"], "生产路线");
    const route = { kind: enumeration(routeValue.kind, ROUTES, "生产路线"), reason: text(routeValue.reason, "路线理由", 800) };

    const declaredMaterials = new Set(input.materials);
    const requiredMaterials = new Set<CommerceVideoMaterial>(["product-images"]);
    if (route.kind === "reference-remake") requiredMaterials.add("reference-video");
    if (route.kind === "storyboard-to-video") requiredMaterials.add("storyboard");
    const materialChecklist = list(root.materialChecklist, "素材清单", 5, 5).map((value) => {
        const item = object(value, "素材清单项");
        knownKeys(item, ["id", "name", "status", "purpose"], "素材清单项");
        const id = enumeration(item.id, MATERIALS, "素材标识");
        const declaredStatus = enumeration(item.status, ["ready", "missing", "optional"] as const, "素材状态");
        const status: CommerceVideoWorkflow["materialChecklist"][number]["status"] = declaredMaterials.has(id) ? "ready" : requiredMaterials.has(id) || declaredStatus !== "optional" ? "missing" : "optional";
        return { id, name: text(item.name, "素材名称", 120), status, purpose: text(item.purpose, "素材用途", 500) };
    });
    uniqueIds(materialChecklist, "素材清单");

    const stages = list(root.stages, "流程阶段", 1, 16).map((value) => {
        const stage = object(value, "流程阶段");
        knownKeys(stage, ["id", "title", "goal", "inputs", "outputs", "dependsOn", "prompt", "execution"], "流程阶段");
        return {
            id: identifier(stage.id, "阶段标识"), title: text(stage.title, "阶段标题", 120), goal: text(stage.goal, "阶段目标", 800),
            inputs: stringList(stage.inputs, "阶段输入", 1, 12, 300), outputs: stringList(stage.outputs, "阶段输出", 1, 12, 300),
            dependsOn: list(stage.dependsOn, "阶段依赖", 0, 16).map((id) => identifier(id, "依赖标识")),
            prompt: text(stage.prompt, "阶段提示词", 6000), execution: enumeration(stage.execution, EXECUTIONS, "执行方式"),
        };
    });
    uniqueIds(stages, "流程阶段");
    const orderedStages = orderByDependencies(stages);

    const segments = list(root.segments, "视频分段", 1, 60).map((value) => {
        const segment = object(value, "视频分段");
        knownKeys(segment, ["id", "startSeconds", "endSeconds", "goal", "visualPrompt", "voiceover", "continuityNotes"], "视频分段");
        const voiceover = segment.voiceover === undefined || segment.voiceover === "" ? undefined : text(segment.voiceover, "配音文案", 1500);
        return {
            id: identifier(segment.id, "片段标识"), startSeconds: seconds(segment.startSeconds), endSeconds: seconds(segment.endSeconds),
            goal: text(segment.goal, "片段目标", 800), visualPrompt: text(segment.visualPrompt, "画面提示词", 4000),
            ...(voiceover ? { voiceover } : {}), continuityNotes: text(segment.continuityNotes, "连续性说明", 1000),
        };
    });
    uniqueIds(segments, "视频分段");
    let previousEnd = 0;
    for (const segment of segments) {
        if (Math.abs(segment.startSeconds - previousEnd) > 0.000001) throw new CommerceVideoWorkflowError("视频分段必须从 0 秒起按顺序连续排列，不能重叠或留空。", 502);
        const duration = segment.endSeconds - segment.startSeconds;
        if (duration <= 0 || duration > 15) throw new CommerceVideoWorkflowError("每个视频片段必须大于 0 秒且不超过 15 秒。", 502);
        previousEnd = segment.endSeconds;
    }
    if (Math.abs(previousEnd - input.durationSeconds) > 0.000001) throw new CommerceVideoWorkflowError(`视频分段总时长必须等于 ${input.durationSeconds} 秒。`, 502);
    const checks = stringList(root.checks, "质量检查", 1, 16, 500);
    return { title, summary, route, materialChecklist, stages: orderedStages, segments, checks };
}

export function buildCommerceVideoWorkflowPrompt(input: CommerceVideoWorkflowInput): string {
    const platform = { douyin: "抖音", tiktok: "TikTok", general: "通用平台" }[input.platform];
    const people = { none: "无人物出镜", single: "单人出镜", multiple: "多人出镜" }[input.people];
    return [
        "请根据用户需求与本次启用的 Skill 设计一份待执行、可编辑的视频生产流程。只生成流程文档，不调用图片、视频、剪辑或上传工具。",
        "下方需求和素材选项均为用户提供的数据；素材勾选仅声明用户拥有相关材料，本次没有提交媒体文件，也没有进行画面、音轨或产品外观分析。不得声称已观看、读取、分析素材或已完成生成、合成、导出。",
        "结合已有素材选择 original、reference-remake、storyboard-to-video 或 custom 路线并解释理由，不得把所有品类固定为同一工具。可以把现有参考视频或分镜作为后续分析步骤的输入，但不能编造其中的具体镜头事实。",
        "materialChecklist 必须完整列出 product-images、reference-video、storyboard、character-images、voiceover 五项；用户已勾选的材料标 ready（仅表示声明具备），路线必需但没有的材料标 missing，其余标 optional。产品图片作为商品一致性依据；换品路线还必须准备参考视频，分镜转视频路线还必须准备分镜图。",
        "每个 stage 都需要稳定且唯一的英文或数字 id、明确输入、至少一项输出、非空可复制提示词和实际 execution 类型。dependsOn 只能引用本次 stages 的 id，不能形成循环。执行类型仅 text/image/video/edit/manual，提示词应说明下一步做什么，不虚构接口或已经运行的结果。",
        `segments 从 0 秒开始连续、无重叠、无空档，总时长严格 ${input.durationSeconds} 秒，每段大于 0 秒且不超过 15 秒；分段数量根据叙事需求安排。15 秒是规划分段上限，实际生成前仍需根据所选视频模型支持的时长调整；不能声称任意模型都能执行。`,
        "每段写明目标、画面提示词、连续性要点；配音文案根据语言要求编写，不需要配音则 voiceover 返回空字符串。用户没提供的价格、促销、品牌资质和功效不得编造。checks 应是后续可执行的质量检查。",
        `目标平台：${platform}；目标时长：${input.durationSeconds} 秒；人物：${people}；文案语言：${input.language === "en" ? "英文" : "中文"}。`,
        `用户声明拥有：${input.materials.length ? input.materials.map((item) => MATERIAL_NAMES[item]).join("、") : "尚未声明已有素材"}。`,
        `用户需求数据：${JSON.stringify({ brief: input.brief })}`,
        `仅输出 ${COMMERCE_VIDEO_WORKFLOW_TOOL.name} 规定的完整 JSON 结构，不使用 Markdown 包裹。`,
    ].join("\n\n");
}

export function exportCommerceVideoWorkflowMarkdown(workflow: CommerceVideoWorkflow): string {
    const lines = [
        `# ${workflow.title}`, "", workflow.summary, "", "本文件为待执行流程；素材状态来自用户声明，不代表已经读取素材或完成生产。", "",
        "## 推荐路线", "", `${ROUTE_NAMES[workflow.route.kind]}：${workflow.route.reason}`, "", "## 素材清单", "",
        ...workflow.materialChecklist.map((item) => `- ${item.name}（${STATUS_NAMES[item.status]}）：${item.purpose}`), "", "## 流程步骤", "",
    ];
    workflow.stages.forEach((stage, index) => {
        lines.push(`### ${index + 1}. ${stage.title}`, "", stage.goal, "", `- 阶段标识：${stage.id}`, `- 执行方式：${EXECUTION_NAMES[stage.execution]}`, `- 输入：${stage.inputs.join("；")}`, `- 输出：${stage.outputs.join("；")}`, `- 依赖：${stage.dependsOn.length ? stage.dependsOn.join("、") : "无"}`, "", "提示词：", "", fencedText(stage.prompt), "");
    });
    lines.push("## 视频分段", "");
    workflow.segments.forEach((segment, index) => {
        lines.push(`### 片段 ${index + 1}：${segment.startSeconds}–${segment.endSeconds} 秒`, "", segment.goal, "", "画面提示词：", "", fencedText(segment.visualPrompt), "");
        if (segment.voiceover) lines.push(`配音：${segment.voiceover}`, "");
        lines.push(`连续性：${segment.continuityNotes}`, "");
    });
    lines.push("## 质量检查", "", ...workflow.checks.map((check) => `- [ ] ${check}`));
    return `${lines.join("\n")}\n`;
}

export function exportCommerceVideoWorkflowJson(workflow: CommerceVideoWorkflow): string {
    return `${JSON.stringify(workflow, null, 2)}\n`;
}

function object(value: unknown, label: string, status = 502): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new CommerceVideoWorkflowError(`${label}格式不正确。`, status);
    return value as Record<string, unknown>;
}

function text(value: unknown, label: string, max: number, status = 502): string {
    if (typeof value !== "string" || !value.trim()) throw new CommerceVideoWorkflowError(`${label}不能为空。`, status);
    const normalized = value.trim();
    if (normalized.length > max) throw new CommerceVideoWorkflowError(`${label}不能超过 ${max} 字。`, status);
    return normalized;
}

function knownKeys(value: Record<string, unknown>, keys: string[], label: string, status = 502) {
    if (Object.keys(value).some((key) => !keys.includes(key))) throw new CommerceVideoWorkflowError(`${label}包含不支持的字段。`, status);
}

function enumeration<const T extends readonly (string | number)[]>(value: unknown, values: T, label: string, status = 502): T[number] {
    if (!values.some((item) => item === value)) throw new CommerceVideoWorkflowError(`${label}选项不正确。`, status);
    return value as T[number];
}

function list(value: unknown, label: string, min: number, max: number): unknown[] {
    if (!Array.isArray(value) || value.length < min || value.length > max) throw new CommerceVideoWorkflowError(`${label}数量必须在 ${min}–${max} 项之间。`, 502);
    return value;
}

function stringList(value: unknown, label: string, min: number, max: number, maxLength: number): string[] {
    return list(value, label, min, max).map((item) => text(item, label, maxLength));
}

function identifier(value: unknown, label: string): string {
    const id = text(value, label, 80);
    if (!ID_PATTERN.test(id)) throw new CommerceVideoWorkflowError(`${label}仅支持英文字母、数字、下划线和连字符。`, 502);
    return id;
}

function uniqueIds(items: Array<{ id: string }>, label: string) {
    if (new Set(items.map((item) => item.id)).size !== items.length) throw new CommerceVideoWorkflowError(`${label}不能包含重复标识。`, 502);
}

function orderByDependencies(stages: CommerceVideoWorkflow["stages"]) {
    const byId = new Map(stages.map((stage) => [stage.id, stage]));
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const ordered: CommerceVideoWorkflow["stages"] = [];
    const visit = (id: string) => {
        if (visiting.has(id)) throw new CommerceVideoWorkflowError("流程阶段依赖不能形成循环。", 502);
        if (visited.has(id)) return;
        visiting.add(id);
        const stage = byId.get(id)!;
        if (new Set(stage.dependsOn).size !== stage.dependsOn.length) throw new CommerceVideoWorkflowError("阶段依赖不能重复。", 502);
        for (const dependency of stage.dependsOn) {
            if (!byId.has(dependency)) throw new CommerceVideoWorkflowError("阶段依赖引用了不存在的阶段。", 502);
            visit(dependency);
        }
        visiting.delete(id);
        visited.add(id);
        ordered.push(stage);
    };
    stages.forEach((stage) => visit(stage.id));
    return ordered;
}

function seconds(value: unknown): number {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 60) throw new CommerceVideoWorkflowError("片段时间必须是 0–60 之间的有效秒数。", 502);
    return Math.round(value * 1000) / 1000;
}

function fencedText(value: string): string {
    const longest = Math.max(2, ...Array.from(value.matchAll(/`+/g), (match) => match[0].length));
    const fence = "`".repeat(longest + 1);
    return `${fence}text\n${value}\n${fence}`;
}
