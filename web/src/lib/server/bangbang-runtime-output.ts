import { bangbangCreationMode, type BangbangCharacter, type BangbangFrame, type BangbangGroup, type BangbangProject, type BangbangStep, type BangbangStepResult } from "@/lib/bangbang-contract";
import { strictJsonObjectText } from "./structured-model-output";

export function parseBangbangStepOutput(step: BangbangStep, raw: string, project: BangbangProject): BangbangStepResult {
    const data = parseObject(raw);
    required(data.text, "完整结果正文");
    const text = data.text as string;
    const result: BangbangStepResult = { text, source: "model" };
    if (step === "script") {
        const firstSection = bangbangCreationMode(project) === "product" ? "第一层：创作设定与时长安排" : "第一层：时长缩放说明";
        for (const section of [firstSection, "第二层：新脚本骨架", "第三层：产品展示方式前置声明", "第四层：脚本正文", "故事梗概", "人物表"]) if (!text.includes(section)) throw new Error(`完整剧本缺少“${section}”，未保存不完整结果`);
    }
    if (step === "directions") {
        result.directions = array(data.directions, "裂变方向").map((value) => ({ id: required(value.id, "方向 ID"), title: required(value.title, "方向名称"), description: required(value.description, "方向描述") }));
        unique(result.directions.map((item) => item.id), "方向 ID");
        if (bangbangCreationMode(project) === "product" && (result.directions.length < 2 || !result.directions[0].title.includes("推荐"))) throw new Error("产品原创需返回多个创意方向，并明确推荐第一个方向");
    }
    if (step === "characters" || step === "storyboard") {
        result.characters = array(data.characters, "人物清单").map((value) => parseCharacter(value, project));
        unique(result.characters.map((item) => item.id), "人物 ID");
        unique(result.characters.map((item) => item.name), "人物姓名");
    }
    if (step === "storyboard") {
        const characters = result.characters!;
        result.groups = array(data.groups, "分镜规划组").map((value, index) => parseGroup(value, index, characters, project));
        unique(result.groups.map((group) => group.id), "分镜组 ID");
        if (result.groups.length > 40) throw new Error("分镜规划超过 40 组上限");
        assertContinuousGroups(result.groups);
        if (!project.storyboardImport.trim() && Math.abs(result.groups.at(-1)!.end - project.targetDuration) > 0.05) throw new Error("分镜规划未完整覆盖目标时长");
        if (project.storyboardImport.trim()) { result.text = `${project.storyboardImport}\n\n---\n\n${text}`; result.source = "import"; }
    }
    if (step === "expand" || step === "optimize") {
        const values = array(data.groups, "九格分镜组");
        const ids = values.map((item) => required(item.id, "分镜组 ID"));
        unique(ids, "分镜组 ID");
        if (ids.length !== project.groups.length || ids.some((id, index) => id !== project.groups[index].id)) throw new Error("模型没有按原顺序完整返回全部分镜组");
        result.groups = project.groups.map((group, index) => ({
            ...group,
            frames: parseFrames(values[index].frames, group.number),
            ...(step === "optimize" ? { optimizedPrompt: required(values[index].optimizedPrompt, `第 ${group.number} 组完整优化提示词`) } : {}),
        }));
    }
    if (step === "video-prompts") {
        if (!project.groups.length || project.groups.some((group) => group.image.status !== "approved" || !group.image.result)) throw new Error("视频提示词需要全部已批准的九宫格图片");
        result.videoSegments = array(data.videoSegments, "视频提示词片段").map((value) => {
            const groupIds = strings(value.groupIds, "片段组号");
            const groups = groupIds.map((id) => project.groups.find((group) => group.id === id));
            if (groups.some((group) => !group) || new Set(groups.map((group) => group!.scene)).size !== 1) throw new Error("视频片段包含未知分镜组或跨场景分镜");
            const duration = number(value.duration, "视频片段时长");
            const expectedDuration = groups.reduce((sum, group) => sum + group!.end - group!.start, 0);
            if (duration <= 0 || duration > project.maxSegmentSeconds || Math.abs(duration - expectedDuration) > 0.05) throw new Error("视频片段时长超过模型上限或与分镜规划不一致");
            const prompt = required(value.prompt, "片段完整提示词");
            for (const section of ["开场声明", "人物设定", "声音设定", "分段内容", "镜头与画面设计", "禁止项"]) if (!prompt.includes(section)) throw new Error(`视频提示词缺少“${section}”段`);
            return { id: required(value.id, "片段 ID"), groupIds, duration, prompt };
        });
        const coverage = result.videoSegments.flatMap((segment) => segment.groupIds);
        if (coverage.length !== project.groups.length || coverage.some((id, index) => id !== project.groups[index].id)) throw new Error("视频提示词未按顺序完整覆盖全部分镜组，或存在重复组");
        unique(result.videoSegments.map((segment) => segment.id), "视频片段 ID");
    }
    return result;
}

export function parseBangbangSourceFrameTimes(raw: string, duration: number) {
    const groups = array(parseObject(raw).sourceFrameGroups, "源视频拆帧时间码");
    if (groups.length > 40) throw new Error("源视频拆帧超过 40 组上限");
    let previousEnd = -1;
    return groups.map((group, index) => {
        if (group.number !== index + 1 || !Array.isArray(group.timestamps) || group.timestamps.length !== 9) throw new Error("每组源视频拆帧必须包含按顺序编号的 9 个时间码");
        const timestamps = group.timestamps.map((time) => number(time, "拆帧时间码"));
        if (timestamps.some((time, position) => time < 0 || time >= duration || (position > 0 && time <= timestamps[position - 1]))) throw new Error("源视频拆帧时间码越界或没有严格递增");
        if (timestamps[0] <= previousEnd) throw new Error("源视频拆帧组必须按真实时间连续排序，不能回退或重复");
        previousEnd = timestamps.at(-1)!;
        return { number: index + 1, timestamps };
    });
}

function parseCharacter(value: Record<string, unknown>, project: BangbangProject): BangbangCharacter {
    const id = required(value.id, "人物 ID");
    const name = required(value.name, "人物姓名");
    const existing = project.characters.find((character) => character.id === id || character.name === name);
    const requested = typeof value.imageId === "string" && value.imageId.trim() ? value.imageId.trim() : existing?.imageId;
    const imageId = requested && project.references.character.some((reference) => reference.id === requested) ? requested : undefined;
    if (requested && !imageId) throw new Error(`人物 ${name} 引用了不存在的人物参考图`);
    return { id, name, gender: required(value.gender, "人物性别"), age: required(value.age, "人物年龄段"), role: required(value.role, "人物身份"), appearance: required(value.appearance, "人物外观"), ...(imageId ? { imageId } : {}) };
}
function parseGroup(value: Record<string, unknown>, index: number, characters: BangbangCharacter[], project: BangbangProject): BangbangGroup {
    if (value.number !== index + 1) throw new Error("分镜组编号必须从 1 开始连续排列");
    const start = number(value.start, "分镜开始时间");
    const end = number(value.end, "分镜结束时间");
    if (start < 0 || end <= start || end - start > project.maxSegmentSeconds + 0.001) throw new Error("分镜组时长无效或超过视频片段上限");
    const characterIds = strings(value.characterIds, "本组出场人物", true);
    unique(characterIds, "组内人物 ID");
    if (characterIds.some((id) => !characters.some((character) => character.id === id))) throw new Error("分镜组引用了人物清单以外的角色");
    if (typeof value.productVisible !== "boolean") throw new Error("分镜组缺少明确的产品出镜状态");
    return { id: required(value.id, "分镜组 ID"), number: index + 1, start, end, scene: required(value.scene, "场景"), characterIds, characterState: required(value.characterState, "人物状态"), goal: required(value.goal, "剧情目标"), dialogue: required(value.dialogue, "完整台词范围"), beats: required(value.beats, "画面节拍"), productVisible: value.productVisible, continuity: required(value.continuity, "连续性"), frames: [], optimizedPrompt: "", image: { status: "idle", attemptNo: 0 } };
}
function parseFrames(value: unknown, group: number): BangbangFrame[] {
    const frames = array(value, `第 ${group} 组分镜帧`);
    if (frames.length !== 9) throw new Error(`第 ${group} 组必须恰好包含 9 帧`);
    return frames.map((frame, index) => {
        if (frame.number !== index + 1) throw new Error(`第 ${group} 组帧号必须从 1 至 9 连续排列`);
        return { number: index + 1, description: required(frame.description, "画面描述"), characterRatio: required(frame.characterRatio, "人物占比"), productPosition: required(frame.productPosition, "产品位置"), reference: required(frame.reference, "引用参考图") };
    });
}
function assertContinuousGroups(groups: BangbangGroup[]) {
    if (Math.abs(groups[0].start) > 0.001 || groups.some((group, index) => index > 0 && Math.abs(group.start - groups[index - 1].end) > 0.001)) throw new Error("分镜时间线必须从 0 开始连续覆盖，不能重叠或遗漏");
}
function parseObject(raw: string): Record<string, unknown> {
    const text = strictJsonObjectText(raw);
    if (!text) throw new Error("模型未返回完整 JSON，未保存不完整结果");
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("模型结果必须是 JSON 对象");
    return value as Record<string, unknown>;
}
function required(value: unknown, label: string) { if (typeof value !== "string" || !value.trim()) throw new Error(`模型结果缺少${label}`); return value.trim(); }
function number(value: unknown, label: string) { if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label}必须为有效数字`); return value; }
function array(value: unknown, label: string): Record<string, unknown>[] { if (!Array.isArray(value) || !value.length || value.some((item) => !item || typeof item !== "object" || Array.isArray(item))) throw new Error(`模型结果缺少完整${label}`); return value as Record<string, unknown>[]; }
function strings(value: unknown, label: string, allowEmpty = false) { if (!Array.isArray(value) || (!allowEmpty && !value.length)) throw new Error(`模型结果缺少${label}`); return value.map((item) => required(item, label)); }
function unique(values: string[], label: string) { if (new Set(values).size !== values.length) throw new Error(`${label}不能重复`); }
