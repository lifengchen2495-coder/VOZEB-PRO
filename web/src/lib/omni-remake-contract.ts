import type { VideoGenerationReference } from "@/lib/video-reference-contract";

export type OmniMedia = { url: string; storageKey?: string; mimeType: string; originalName?: string; bytes?: number; duration?: number; width?: number; height?: number };
export type OmniVideoState = { status: "idle" | "queued" | "running" | "completed" | "error"; attemptNo: number; generationDurationSeconds?: number; taskId?: string; clientRequestId?: string; result?: OmniMedia; error?: string; needsReview?: boolean };
export type OmniSegment = {
    id: string;
    start: number;
    end: number;
    duration: number;
    description: string;
    hasFace: boolean;
    speaking: boolean;
    personCount: number;
    needsSecondCheck: boolean;
    audioStrategy: "preserve_audio" | "remove_audio";
    sourceClip?: OmniMedia;
    prompt: string;
    promptZh: string;
    video: OmniVideoState;
};
export type OmniProject = {
    id: string;
    title: string;
    status: "active" | "archived";
    revision: number;
    createdAt: string;
    updatedAt: string;
    sourceVideo?: OmniMedia;
    productName: string;
    instructions: string;
    productStrategy: "replace" | "preserve";
    replaceCharacter: boolean;
    replaceBackground: boolean;
    audioMode: "auto" | "silent" | "source";
    references: { product: OmniMedia[]; character: OmniMedia[]; background: OmniMedia[] };
    modelSelection: { analysis: string; prompt: string; video: string };
    analysisRaw: string;
    analysisSummary: string;
    materialAnalysis: string;
    plan: string;
    segments: OmniSegment[];
    operation?: { id: string; kind: "analysis" | "prepare" | "merge"; startedAt: string };
    error?: string;
    mergedVideo?: OmniMedia;
};
export type OmniProjectList = { items: OmniProject[]; total: number; page: number; pageSize: number };
export type OmniInputPatch = Partial<Pick<OmniProject, "title" | "sourceVideo" | "productName" | "instructions" | "productStrategy" | "replaceCharacter" | "replaceBackground" | "audioMode" | "references" | "modelSelection">>;
export const OMNI_SOURCE_TABLE_ID = "tblD8YooqpAn5SxW";
export const OMNI_SOURCE_URL = `https://ocn18sf3pb4v.feishu.cn/base/ScUYbyoAbaJptZsnuTbcg6WwnN3?table=${OMNI_SOURCE_TABLE_ID}`;
export const OMNI_MAX_SEGMENT_SECONDS = 10;

export function createOmniProject(id: string, title: string): OmniProject {
    const now = new Date().toISOString();
    return {
        id,
        title: title.trim().slice(0, 120) || "Omni 全品类复刻",
        status: "active",
        revision: 0,
        createdAt: now,
        updatedAt: now,
        productName: "",
        instructions: "",
        productStrategy: "replace",
        replaceCharacter: false,
        replaceBackground: false,
        audioMode: "auto",
        references: { product: [], character: [], background: [] },
        modelSelection: { analysis: "", prompt: "", video: "" },
        analysisRaw: "",
        analysisSummary: "",
        materialAnalysis: "",
        plan: "",
        segments: [],
    };
}

export function parseOmniAnalysis(raw: string, duration: number, audioMode: OmniProject["audioMode"]): { summary: string; segments: OmniSegment[] } {
    if (!Number.isFinite(duration) || duration <= 0) throw new Error("原视频时长不正确");
    const payload = JSON.parse(raw) as Record<string, unknown>;
    const rows = payload.segments;
    if (!Array.isArray(rows) || !rows.length || rows.length > 200) throw new Error("视频分析必须包含 1 至 200 个连续片段");
    let previousEnd = 0;
    const segments = rows.map((rawRow, index) => {
        const row = object(rawRow);
        const start = Number(row.start);
        const end = Number(row.end);
        if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end - start > OMNI_MAX_SEGMENT_SECONDS + 0.02 || end > duration + 0.05 || Math.abs(start - previousEnd) > 0.05)
            throw new Error(`片段 ${index + 1} 的时间必须连续且不超过 10 秒`);
        const description = typeof row.description === "string" ? row.description.trim() : "";
        if (
            !description ||
            description.length > 6000 ||
            typeof row.hasFace !== "boolean" ||
            typeof row.speaking !== "boolean" ||
            !Number.isInteger(row.personCount) ||
            Number(row.personCount) < 0 ||
            Number(row.personCount) > 20 ||
            typeof row.needsSecondCheck !== "boolean"
        )
            throw new Error(`片段 ${index + 1} 的画面和口型分析不完整`);
        if (row.audioStrategy !== "preserve_audio" && row.audioStrategy !== "remove_audio") throw new Error(`片段 ${index + 1} 缺少有效音频策略`);
        const roundedStart = Math.round(previousEnd * 1000) / 1000;
        const roundedEnd = Math.round((index === rows.length - 1 && Math.abs(end - duration) <= 0.05 ? duration : end) * 1000) / 1000;
        if (roundedEnd <= roundedStart || roundedEnd - roundedStart > OMNI_MAX_SEGMENT_SECONDS + 0.0001) throw new Error(`片段 ${index + 1} 校正后的时长超过 10 秒`);
        previousEnd = roundedEnd;
        return {
            id: `S${String(index + 1).padStart(2, "0")}`,
            start: roundedStart,
            end: roundedEnd,
            duration: Math.round((roundedEnd - roundedStart) * 1000) / 1000,
            description,
            hasFace: row.hasFace,
            speaking: row.speaking,
            personCount: Number(row.personCount),
            needsSecondCheck: row.needsSecondCheck,
            audioStrategy: audioMode === "silent" ? "remove_audio" : audioMode === "source" ? "preserve_audio" : row.hasFace && row.speaking && row.personCount === 1 && !row.needsSecondCheck ? "preserve_audio" : "remove_audio",
            prompt: "",
            promptZh: "",
            video: { status: "idle", attemptNo: 0 },
        } as OmniSegment;
    });
    if (Math.abs(previousEnd - duration) > 0.05) throw new Error("分析片段没有覆盖完整视频结尾");
    return { summary: typeof payload.summary === "string" ? payload.summary.slice(0, 10000) : "", segments };
}

export function omniVideoReferences(project: OmniProject, segment: OmniSegment): VideoGenerationReference[] {
    if (!segment.sourceClip?.url) return [];
    return [
        { type: "video", role: "reference", url: segment.sourceClip.url },
        ...project.references.product.map((asset) => ({ type: "image" as const, role: "reference" as const, url: asset.url })),
        ...(project.replaceCharacter ? project.references.character.map((asset) => ({ type: "image" as const, role: "reference" as const, url: asset.url })) : []),
        ...(project.replaceBackground ? project.references.background.map((asset) => ({ type: "image" as const, role: "reference" as const, url: asset.url })) : []),
    ];
}

export function omniVideoSize(project: OmniProject, segment: OmniSegment) {
    const width = segment.sourceClip?.width || project.sourceVideo?.width;
    const height = segment.sourceClip?.height || project.sourceVideo?.height;
    if (!width || !height) throw new Error("片段缺少画幅信息，请重新准备片段");
    return `${width}x${height}`;
}

export function omniInputVersion(project: OmniProject) {
    return JSON.stringify([
        project.sourceVideo?.url,
        project.productName,
        project.instructions,
        project.productStrategy,
        project.replaceCharacter,
        project.replaceBackground,
        project.audioMode,
        Object.fromEntries(Object.entries(project.references).map(([role, assets]) => [role, assets.map((asset) => asset.url)])),
    ]);
}

export function omniAnalysisPrompt(duration: number) {
    return `完整观看参考视频，按自然动作与人物切换边界拆成连续视频编辑片段，总时长 ${duration} 秒。单段理想 6—9 秒、可接受 4—10 秒，绝不超过 10 秒；低于 4 秒优先与相邻同人物片段合并。同一人物说话/展示、持品/无产品的自然过渡不切分；不同人物或人数变化必须切分，其优先级高于 4 秒下限。超过 10 秒在动作自然断点或 7—9 秒处拆开，不能只建议拆分。最后一段可因总时长或强制人物切换更短。起点 0，终点严格等于实际时长，无间隙、重叠、遗漏。每段保留全部动作与镜头变化，只描述实际看到的画面，手部不能推断为完整人物。判断是否出现脸、是否有实际说话口型。仅当单人出现、嘴部清晰且持续开合说话时 preserve_audio；双人/多人、手部、空镜、嘴部被遮挡或需二次检查时 remove_audio。咀嚼、微笑、短暂张嘴、背景旁白不算 speaking。不编造口播。口型不清时 needsSecondCheck=true。输出且仅输出 JSON：{"summary":"视频整体描述","segments":[{"start":0,"end":8,"description":"依次描述构图、动作路径、产品位置、人物可见部分与背景","hasFace":false,"speaking":false,"personCount":0,"needsSecondCheck":false,"audioStrategy":"remove_audio"}]}。`;
}

export function omniPlanningPrompt(project: OmniProject) {
    return `你正在准备 Omni 全品类局部视频编辑。输出 JSON，包含 materialAnalysis（根据参考图锁定产品/人物/背景真实特征）、plan（总计划）和 segments 数组，每项 {id,prompt,promptZh}，必须逐一覆盖输入片段且顺序一致。prompt 使用英文，promptZh 是完整中文对照，二者语义相同。源视频片段只提供真实镜头顺序、动作路径、时长、构图、接触和遮挡；禁止凭空增加没有的动作/人物/商品功能。产品策略：${project.productStrategy === "replace" ? "替换所有目标旧产品，目标外观以产品参考图为唯一来源。不同部件、包装、内料保持正确关系，不保留旧款特征。未出现目标产品的镜头不能新增产品。" : "原产品严格保持不变，产品参考图仅补充细节，不得强制替换或改款。"} 人物策略：${project.replaceCharacter ? "参考人物图，仅替换原片中实际可见部分；手部片段不能新增人脸或全身。" : "原人物身份、服装、手部和身体保持不变。"} 背景策略：${project.replaceBackground ? "按背景参考图替换背景，保留前景遮挡、动作与空间关系。" : "原背景、光线、色调和镜头保持不变。"} 每段按 audioStrategy 明确保留原声/口型同步，或无任何语音音乐音效。移除字幕、水印和屏幕叠加，保留实物产品参考图支持的结构与标识。将素材角色、产品锁定、具体逐段动作和禁止事项写清楚；不对模型假称已完成质检。`;
}

export function parseOmniPlan(raw: string, segments: OmniSegment[]) {
    const payload = object(JSON.parse(raw));
    const rows = payload.segments;
    if (!Array.isArray(rows) || rows.length !== segments.length) throw new Error("视频计划缺少片段，未保存不完整计划");
    const planned = segments.map((segment, index) => {
        const row = object(rows[index]);
        if (row.id !== segment.id || typeof row.prompt !== "string" || !row.prompt.trim() || row.prompt.length > 30000 || typeof row.promptZh !== "string" || !row.promptZh.trim() || row.promptZh.length > 30000)
            throw new Error(`片段 ${segment.id} 的中英文提示词缺失或顺序不正确`);
        return { ...segment, prompt: row.prompt.trim(), promptZh: row.promptZh.trim(), video: { status: "idle" as const, attemptNo: segment.video.attemptNo } };
    });
    if (typeof payload.materialAnalysis !== "string" || !payload.materialAnalysis.trim() || typeof payload.plan !== "string" || !payload.plan.trim()) throw new Error("缺少素材分析和视频总计划");
    return { materialAnalysis: payload.materialAnalysis.slice(0, 30000), plan: payload.plan.slice(0, 50000), segments: planned };
}
function object(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
