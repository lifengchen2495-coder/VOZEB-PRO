import { BANGBANG_STEP_LABELS, bangbangActiveSteps, bangbangCreationMode, type BangbangProject, type BangbangStep, type BangbangInputPatch } from "@/lib/bangbang-contract";
export type BangbangStage = "input" | BangbangStep | "images";
export const BANGBANG_STAGES: Array<{ id: BangbangStage; label: string; hint: string }> = [
    { id: "input", label: "素材输入", hint: "设置产品事实与对标素材" },
    { id: "transcript", label: BANGBANG_STEP_LABELS.transcript, hint: "提取口播和人物对白，支持导入字幕" },
    { id: "understanding", label: BANGBANG_STEP_LABELS.understanding, hint: "理解剧情、画面与人物关系" },
    { id: "traffic", label: BANGBANG_STEP_LABELS.traffic, hint: "拆解开头、冲突、节奏与成交逻辑" },
    { id: "frames", label: BANGBANG_STEP_LABELS.frames, hint: "提取关键画面并查看原片镜头" },
    { id: "directions", label: BANGBANG_STEP_LABELS.directions, hint: "选择一个方向，或填写自己的创意" },
    { id: "script", label: BANGBANG_STEP_LABELS.script, hint: "生成并编辑完整的新短剧脚本" },
    { id: "characters", label: "人物需求与素材", hint: "生成人物清单，为每个人物绑定参考图" },
    { id: "storyboard", label: BANGBANG_STEP_LABELS.storyboard, hint: "规划场景、台词和分镜组，也支持导入已有规划" },
    { id: "expand", label: BANGBANG_STEP_LABELS.expand, hint: "将每个分镜组展开成恰好 9 帧" },
    { id: "optimize", label: BANGBANG_STEP_LABELS.optimize, hint: "优化并逐组编辑九宫格生图提示词" },
    { id: "images", label: "九宫格逐张生图", hint: "从第一组开始，生成、检查、确认后继续下一组" },
    { id: "video-prompts", label: BANGBANG_STEP_LABELS["video-prompts"], hint: "生成可交给视频工具的分段提示词" },
];
export function bangbangWorkspaceStages(project: BangbangProject) {
    const activeSteps = bangbangActiveSteps(project);
    const productMode = bangbangCreationMode(project) === "product";
    return BANGBANG_STAGES.filter((stage) => stage.id === "input" || stage.id === "images" || activeSteps.includes(stage.id)).map((stage) => {
        if (productMode && stage.id === "input") return { ...stage, hint: "上传产品图，补充卖点与创作要求" };
        if (productMode && stage.id === "directions") return { ...stage, label: "创作方向", hint: "根据产品寻找故事创意，选择方向或填写自己的想法" };
        return stage;
    });
}
export function withBangbangDraft(project: BangbangProject, patch: BangbangInputPatch, prompts: Record<string, string> = {}): BangbangProject {
    const modeChanged = patch.creationMode !== undefined && patch.creationMode !== bangbangCreationMode(project);
    const source = modeChanged ? { ...project, outputs: {}, directions: [], selectedDirectionId: "", customDirection: "", characters: [], groups: [], sourceFrames: [], videoSegments: [], storyboardImport: "" } : project;
    const next = {
        ...source,
        ...patch,
        sourceVideo: patch.sourceVideo === null ? undefined : patch.sourceVideo || project.sourceVideo,
        outputs: { ...source.outputs },
        groups: source.groups.map((group) => ({ ...group, optimizedPrompt: prompts[group.id] ?? group.optimizedPrompt })),
    };
    if (patch.transcriptText !== undefined) next.outputs.transcript = { text: patch.transcriptText, source: "import", createdAt: project.updatedAt };
    if (patch.scriptText !== undefined) next.outputs.script = { text: patch.scriptText, source: "import", createdAt: project.updatedAt };
    if (patch.characterImages) next.characters = source.characters.map((character) => ({ ...character, imageId: patch.characterImages?.find((item) => item.characterId === character.id)?.imageId ?? character.imageId }));
    return next;
}
export function bangbangStageComplete(project: BangbangProject, id: BangbangStage) {
    if (id === "input") return Boolean(project.references.product.length && (bangbangCreationMode(project) === "product" || (project.sourceVideo && project.product.name.trim())));
    if (id === "images") return project.groups.length > 0 && project.groups.every((group) => group.image.status === "approved");
    if (id === "characters") return Boolean(project.outputs.characters?.text) && project.characters.every((character) => project.references.character.some((reference) => reference.id === character.imageId));
    return Boolean(project.outputs[id]?.text);
}
export function resumeBangbangStage(project: BangbangProject): BangbangStage {
    if (project.operation) return project.operation.step;
    if (project.groups.some((group) => ["queued", "running", "review", "error"].includes(group.image.status))) return "images";
    return bangbangWorkspaceStages(project).find((stage) => !bangbangStageComplete(project, stage.id))?.id || "video-prompts";
}
