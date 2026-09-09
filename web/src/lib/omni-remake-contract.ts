import type { VideoGenerationReference } from "@/lib/video-reference-contract";

export type OmniMedia = { url: string; storageKey?: string; mimeType: string; originalName?: string; bytes?: number; duration?: number; width?: number; height?: number };
export type OmniVideoState = { status: "idle" | "queued" | "running" | "completed" | "error"; attemptNo: number; generationDurationSeconds?: number; taskId?: string; clientRequestId?: string; manualUploadId?: string; result?: OmniMedia; error?: string; needsReview?: boolean };
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
    videoPromptInstructions?: string;
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
    operation?: { id: string; kind: "analysis" | "prepare" | "merge"; startedAt: string; promptMode?: "template" | "ai" };
    error?: string;
    mergedVideo?: OmniMedia;
};
export type OmniProjectList = { items: OmniProject[]; total: number; page: number; pageSize: number };
export type OmniInputPatch = Partial<Pick<OmniProject, "title" | "sourceVideo" | "productName" | "instructions" | "videoPromptInstructions" | "productStrategy" | "replaceCharacter" | "replaceBackground" | "audioMode" | "references" | "modelSelection">>;
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
        project.videoPromptInstructions?.trim() || "",
        project.productStrategy,
        project.replaceCharacter,
        project.replaceBackground,
        project.audioMode,
        Object.fromEntries(Object.entries(project.references).map(([role, assets]) => [role, assets.map((asset) => asset.url)])),
    ]);
}

export function omniAnalysisPrompt(duration?: number) {
    const durationText = typeof duration === "number" && Number.isFinite(duration) && duration > 0 ? `总时长 ${duration} 秒` : "先读取上传原片的实际总时长";
    return `完整观看参考视频，按自然动作与人物切换边界拆成连续视频编辑片段，${durationText}。单段理想 6—9 秒、可接受 4—10 秒，绝不超过 10 秒；低于 4 秒优先与相邻同人物片段合并。同一人物说话/展示、持品/无产品的自然过渡不切分；不同人物或人数变化必须切分，其优先级高于 4 秒下限。超过 10 秒在动作自然断点或 7—9 秒处拆开，不能只建议拆分。最后一段可因总时长或强制人物切换更短。起点 0，终点严格等于实际时长，无间隙、重叠、遗漏。每段保留全部动作与镜头变化，只描述实际看到的画面，手部不能推断为完整人物。判断是否出现脸、是否有实际说话口型。仅当单人出现、嘴部清晰且持续开合说话时 preserve_audio；双人/多人、手部、空镜、嘴部被遮挡或需二次检查时 remove_audio。咀嚼、微笑、短暂张嘴、背景旁白不算 speaking。不编造口播。口型不清时 needsSecondCheck=true。输出且仅输出 JSON：{"summary":"视频整体描述","segments":[{"start":0,"end":8,"description":"依次描述构图、动作路径、产品位置、人物可见部分与背景","hasFace":false,"speaking":false,"personCount":0,"needsSecondCheck":false,"audioStrategy":"remove_audio"}]}。`;
}

export function omniManualSegmentPrompts(project: OmniProject, segment: OmniSegment) {
    const roles = [
        `Source video: this exact ${segment.duration}-second segment supplies timing, shot order, camera motion, hand paths, contact and occlusion.`,
        ...(project.references.product.length ? [`Product images (${project.references.product.length}): ${project.productStrategy === "replace" ? "the sole appearance reference for the target product" : "details of the original product; do not redesign it"}.`] : []),
        ...(project.replaceCharacter ? [`Character images (${project.references.character.length}): appearance references only for people or body parts already visible in the source.`] : []),
        ...(project.replaceBackground ? [`Background images (${project.references.background.length}): the target environment, while preserving foreground geometry and occlusion.`] : []),
    ];
    const prompt = [
        "Edit the supplied source video segment as a localized video edit. Preserve its original action timing and shot sequence.",
        `Material roles:\n${roles.map((role) => `- ${role}`).join("\n")}`,
        project.productStrategy === "replace"
            ? `Replace only the existing target product with ${project.productName || "the product in the reference images"}. Match its color, shape, structure, material, texture, packaging and visible details. Keep packaging and contents distinct and consistent in open, closed, held and used states. Never introduce a product where none exists in the source.`
            : "Keep the original product, packaging, contents and all visible details unchanged.",
        project.replaceCharacter
            ? "Apply the character references only to the visible person or body parts. Keep the original pose, body movement and contact points. Do not add a face or full body to hand-only shots."
            : "Keep the original person's face, hairstyle, outfit, hands and body unchanged.",
        project.replaceBackground
            ? "Replace the background using the background references. Preserve the camera angle, foreground layout, realistic lighting, shadows and reflections."
            : "Keep the original background, camera angle, framing, color tone and lighting unchanged.",
        `Keep the same walking, turning, holding and hand paths at the same times. Preserve the complete ${segment.duration}-second action without speed changes or invented motions.`,
        segment.audioStrategy === "preserve_audio"
            ? "Keep the original audio and mouth movements aligned with the original timing. Do not invent dialogue, music or new audio."
            : "The source segment has no audio. Do not generate speech, music or sound effects. Output a silent video.",
        "Remove screen subtitles, overlays and watermarks. Preserve genuine product details supported by the target references. Do not add people, products, props, extra limbs or text.",
        `Source shot notes: ${segment.description}`,
        ...(project.instructions.trim() ? [`Additional target requirements: ${project.instructions.trim()}`] : []),
    ].join("\n\n");
    const promptZh = [
        `对提供的 ${segment.duration} 秒原视频片段做局部编辑，保留完整动作时序、镜头顺序、接触和遮挡关系。原片时间范围：${segment.start}–${segment.end} 秒。`,
        `本段画面：${segment.description}`,
        project.productStrategy === "replace" ? `仅把原片中已有的目标产品替换为“${project.productName}”。产品参考图是目标外观的唯一依据，锁定颜色、结构、材质、包装、内料及打开／关闭／使用状态，不在无产品处添加产品。` : "保留原产品、包装、内料和全部可见细节，参考图仅补充细节。",
        project.replaceCharacter ? "人物参考图仅用于替换原片中实际可见的人物或身体局部。保留姿态、动作及接触点，手部镜头不得新增人脸或全身。" : "保留原人物的脸、发型、服装、手部及身体。",
        project.replaceBackground ? "按背景图替换环境，保留镜头视角、前景布局、遮挡及真实光影关系。" : "保留原背景、镜头角度、构图、色调和光线。",
        "保持行走、转身、拿取和手部动作的路径与发生时间，不变速，不凭空增加动作。",
        segment.audioStrategy === "preserve_audio" ? "保留原音频及口型节奏，不新增口播、音乐或音效。" : "本段源片已移除音频，输出静音视频，不生成语音、音乐或音效。",
        "去除屏幕字幕、叠加和水印；保留参考图支持的实物产品细节。不得新增人物、产品、道具、多余肢体或文字。",
        ...(project.instructions.trim() ? [`补充要求：${project.instructions.trim()}`] : []),
    ].join("\n\n");
    return { prompt, promptZh };
}

export function omniDefaultPlanningPrompt(project: OmniProject) {
    return `你正在准备 Omni 全品类局部视频编辑。输出 JSON，包含 materialAnalysis（根据参考图锁定产品/人物/背景真实特征）、plan（总计划）和 segments 数组，每项 {id,prompt,promptZh}，必须逐一覆盖输入片段且顺序一致。prompt 使用英文，promptZh 是完整中文对照，二者语义相同。源视频片段只提供真实镜头顺序、动作路径、时长、构图、接触和遮挡；禁止凭空增加没有的动作/人物/商品功能。产品策略：${project.productStrategy === "replace" ? "替换所有目标旧产品，目标外观以产品参考图为唯一来源。不同部件、包装、内料保持正确关系，不保留旧款特征。未出现目标产品的镜头不能新增产品。" : "原产品严格保持不变，产品参考图仅补充细节，不得强制替换或改款。"} 人物策略：${project.replaceCharacter ? "参考人物图，仅替换原片中实际可见部分；手部片段不能新增人脸或全身。" : "原人物身份、服装、手部和身体保持不变。"} 背景策略：${project.replaceBackground ? "按背景参考图替换背景，保留前景遮挡、动作与空间关系。" : "原背景、光线、色调和镜头保持不变。"} 每段按 audioStrategy 明确保留原声/口型同步，或无任何语音音乐音效。移除字幕、水印和屏幕叠加，保留实物产品参考图支持的结构与标识。将素材角色、产品锁定、具体逐段动作和禁止事项写清楚；不对模型假称已完成质检。`;
}

export function omniPlanningPrompt(project: OmniProject) {
    return `${project.videoPromptInstructions?.trim() || omniDefaultPlanningPrompt(project)}\n\n【输出要求】只返回 JSON 对象，包含非空 materialAnalysis、plan 和 segments。segments 必须按原顺序恰好覆盖所有输入片段，每项包含原 id、非空英文 prompt 及完整中文对照 promptZh。只使用本项目提供的素材与片段，遵守各段的时长和 audioStrategy；不得从其他案例虚构项目事实。`;
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
