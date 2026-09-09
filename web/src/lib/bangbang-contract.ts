export const BANGBANG_STEPS = ["transcript", "understanding", "traffic", "frames", "directions", "script", "characters", "storyboard", "expand", "optimize", "video-prompts"] as const;
export type BangbangStep = (typeof BANGBANG_STEPS)[number];
export type BangbangCreationMode = "product" | "reference";
export const BANGBANG_REFERENCE_STEPS: readonly BangbangStep[] = ["transcript", "understanding", "traffic", "frames"];
export const BANGBANG_STEP_LABELS: Record<BangbangStep, string> = {
    transcript: "语音转文字", understanding: "视频理解", traffic: "流量逻辑分析", frames: "关键画面拆帧", directions: "裂变方向", script: "完整剧本", characters: "人物需求清单", storyboard: "分镜规划表", expand: "九格分镜展开", optimize: "生图提示词优化", "video-prompts": "视频提示词",
};
export type BangbangMedia = { url: string; storageKey?: string; mimeType: string; originalName?: string; bytes?: number; duration?: number; width?: number; height?: number };
export type BangbangReference = { id: string; label: string; media: BangbangMedia };
export type BangbangCharacter = { id: string; name: string; gender: string; age: string; role: string; appearance: string; imageId?: string };
export type BangbangDirection = { id: string; title: string; description: string };
export type BangbangFrame = { number: number; description: string; characterRatio: string; productPosition: string; reference: string };
export type BangbangImageState = {
    status: "idle" | "queued" | "running" | "review" | "approved" | "error";
    attemptNo: number;
    clientRequestId?: string;
    taskId?: string;
    prompt?: string;
    referenceUrls?: string[];
    anchorGroupId?: string;
    result?: BangbangMedia;
    approvedAt?: string;
    error?: string;
};
export type BangbangGroup = {
    id: string; number: number; start: number; end: number; scene: string;
    characterIds: string[]; characterState: string; goal: string; dialogue: string; beats: string; productVisible: boolean; continuity: string;
    frames: BangbangFrame[]; optimizedPrompt: string; image: BangbangImageState;
};
export type BangbangVideoSegment = { id: string; groupIds: string[]; duration: number; prompt: string };
export type BangbangOutput = { text: string; createdAt: string; source: "model" | "import" | "media" };
export type BangbangOperation = { id: string; step: BangbangStep; startedAt: string };
export type BangbangProject = {
    id: string; title: string; status: "active" | "archived"; revision: number; createdAt: string; updatedAt: string;
    sourceVideo?: BangbangMedia;
    creationMode?: BangbangCreationMode;
    product: { name: string; appearance: string; sellingPoints: string; price: string };
    instructions: string; targetDuration: number; maxSegmentSeconds: number;
    references: Record<"product" | "character" | "scene", BangbangReference[]>;
    modelSelection: { analysis: string; prompt: string; image: string };
    outputs: Partial<Record<BangbangStep, BangbangOutput>>;
    directions: BangbangDirection[]; selectedDirectionId: string; customDirection: string;
    characters: BangbangCharacter[]; groups: BangbangGroup[]; sourceFrames: BangbangMedia[]; videoSegments: BangbangVideoSegment[];
    storyboardImport: string;
    videoPromptInstructions?: string;
    operation?: BangbangOperation; error?: string;
};
export type BangbangProjectList = { items: BangbangProject[]; total: number; page: number; pageSize: number };
export type BangbangStepResult = {
    text: string; source?: BangbangOutput["source"]; sourceVideo?: BangbangMedia; sourceFrames?: BangbangMedia[];
    directions?: BangbangDirection[]; characters?: BangbangCharacter[]; groups?: BangbangGroup[]; videoSegments?: BangbangVideoSegment[];
};
export type BangbangInputPatch = Partial<Pick<BangbangProject, "title" | "creationMode" | "product" | "instructions" | "targetDuration" | "maxSegmentSeconds" | "references" | "modelSelection" | "selectedDirectionId" | "customDirection" | "storyboardImport" | "videoPromptInstructions">> & {
    sourceVideo?: BangbangMedia | null;
    transcriptText?: string;
    scriptText?: string;
    characterImages?: Array<{ characterId: string; imageId: string }>;
    groupPrompt?: { groupId: string; text: string };
};
export function createBangbangProject(id: string, title: string, now = new Date().toISOString()): BangbangProject {
    return {
        id, title: title.trim().slice(0, 160) || "未命名带货短剧", status: "active", revision: 1, createdAt: now, updatedAt: now,
        creationMode: "product", product: { name: "", appearance: "", sellingPoints: "", price: "" }, instructions: "", targetDuration: 120, maxSegmentSeconds: 30,
        references: { product: [], character: [], scene: [] }, modelSelection: { analysis: "", prompt: "", image: "" },
        outputs: {}, directions: [], selectedDirectionId: "", customDirection: "", characters: [], groups: [], sourceFrames: [], videoSegments: [], storyboardImport: "",
    };
}
export function isBangbangStep(value: unknown): value is BangbangStep { return typeof value === "string" && (BANGBANG_STEPS as readonly string[]).includes(value); }
export function bangbangCreationMode(project: Pick<BangbangProject, "creationMode" | "sourceVideo">): BangbangCreationMode {
    return project.creationMode || (project.sourceVideo ? "reference" : "product");
}
export function bangbangActiveSteps(project: BangbangProject): readonly BangbangStep[] {
    return bangbangCreationMode(project) === "product" ? BANGBANG_STEPS.filter((step) => !BANGBANG_REFERENCE_STEPS.includes(step)) : BANGBANG_STEPS;
}
export function bangbangBusy(project: BangbangProject) { return Boolean(project.operation || project.groups.some((group) => group.image.status === "queued" || group.image.status === "running")); }
export function bangbangStepBlockReason(project: BangbangProject, step: BangbangStep): string | undefined {
    if (bangbangBusy(project)) return "项目正在处理中，请等待当前任务完成";
    const productMode = bangbangCreationMode(project) === "product";
    if (productMode && BANGBANG_REFERENCE_STEPS.includes(step)) return "产品原创无需对标视频，请从创作方向开始";
    if (step === "storyboard" && project.storyboardImport.trim()) return undefined;
    if (productMode && step === "directions") return project.references.product.length ? undefined : "请先上传产品参考图，即可开始原创剧本";
    if (step === "transcript") return project.sourceVideo ? undefined : "请先上传对标视频，或导入已有字幕";
    const steps = bangbangActiveSteps(project);
    const index = steps.indexOf(step);
    const previous = steps[index - 1];
    if (!project.outputs[previous]?.text) return `请先完成${BANGBANG_STEP_LABELS[previous]}`;
    if (step === "understanding" && !project.sourceVideo) return "视频理解需要对标视频";
    if (step === "directions" && (!project.product.name.trim() || !project.references.product.length)) return "请填写产品名称并上传产品参考图";
    if (step === "script" && !project.customDirection.trim() && !project.directions.some((direction) => direction.id === project.selectedDirectionId)) return "请先选择创作方向，或填写自定义方向";
    if (["storyboard", "expand", "optimize"].includes(step) && project.characters.some((character) => !project.references.character.some((reference) => reference.id === character.imageId))) return "请为每个人物绑定参考图";
    if (step === "video-prompts" && (!project.groups.length || project.groups.some((group) => group.image.status !== "approved"))) return "请先逐张确认全部九宫格图片";
    return undefined;
}
export function bangbangSceneAnchor(project: BangbangProject, group: BangbangGroup): BangbangGroup | undefined {
    const index = project.groups.findIndex((item) => item.id === group.id);
    if (index < 1) return undefined;
    if (project.groups[index - 1].scene !== group.scene) return project.groups[index - 1];
    // 每个连续场景段锚定首图；回到同名场景时重新建立场景锚点。
    let first = index - 1;
    while (first > 0 && project.groups[first - 1].scene === group.scene) first--;
    return project.groups[first];
}
export function bangbangImageBlockReason(project: BangbangProject, groupId: string): string | undefined {
    if (project.operation) return "项目正在处理中";
    const index = project.groups.findIndex((group) => group.id === groupId);
    if (index < 0) return "分镜组不存在";
    const group = project.groups[index];
    if (project.groups.some((item) => item.id !== groupId && ["queued", "running"].includes(item.image.status))) return "请等待当前九宫格生成完成";
    if (group.image.status === "running") return "当前九宫格仍在生成";
    if (!group.optimizedPrompt.trim() || group.frames.length !== 9) return "请先完成九格分镜展开和提示词优化";
    if (project.groups.slice(0, index).some((item) => item.image.status !== "approved")) return "请先确认前面的九宫格，再生成这一组";
    if (group.productVisible && !project.references.product.length) return "本组有产品出镜，请上传产品参考图";
    if (group.characterIds.some((id) => !project.characters.find((character) => character.id === id)?.imageId)) return "请为本组人物绑定参考图";
    return undefined;
}
