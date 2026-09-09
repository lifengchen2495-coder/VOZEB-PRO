import { nanoid } from "nanoid";

import type { DramaCharacter, DramaEpisode, DramaProject } from "@/lib/drama-project-contract";
import type { DramaCharacterBiography, DramaCharactersData, DramaScriptData, DramaWorkflow, DramaWorkflowArtifact, DramaWorkflowArtifactFor, DramaWorkflowDataByStage, DramaWorkflowStage } from "@/lib/drama-workflow-contract";

export const DRAMA_WORKFLOW_METHOD_VERSION = "drama-writing-v1";
export const DRAMA_WORKFLOW_STAGES: DramaWorkflowStage[] = ["story", "characters", "beats", "script"];

export class DramaWorkflowError extends Error {
    constructor(
        message: string,
        readonly status: 400 | 409 = 400,
    ) {
        super(message);
        this.name = "DramaWorkflowError";
    }
}

export function validateDramaWorkflowData<S extends DramaWorkflowStage>(stage: S, value: unknown): DramaWorkflowDataByStage[S] {
    const input = record(value, "创作内容必须是对象");
    let data: DramaWorkflowDataByStage[DramaWorkflowStage];
    switch (stage) {
        case "story":
            if (!["original", "faithful", "free"].includes(String(input.adaptationMode))) throw new DramaWorkflowError("请选择有效的改编方式");
            data = {
                logline: requiredText(input.logline, "请填写故事梗概"),
                genre: text(input.genre),
                audience: text(input.audience),
                worldRules: text(input.worldRules),
                coreConflict: text(input.coreConflict),
                adaptationMode: input.adaptationMode as "original" | "faithful" | "free",
                lockedFacts: text(input.lockedFacts),
                targetDuration: positiveNumber(input.targetDuration, "单集目标时长必须大于 0"),
                episodeCount: positiveInteger(input.episodeCount, "计划集数必须为正整数"),
            };
            break;
        case "characters": {
            const characters = requiredArray(input.characters, "请至少填写一个人物").map((value) => {
                const item = record(value, "人物格式无效");
                const name = requiredText(item.name, "人物姓名不能为空");
                if (item.aliases !== undefined && !Array.isArray(item.aliases)) throw new DramaWorkflowError("人物别名必须是数组");
                return {
                    id: text(item.id) || `character-${stableHash(nameKey(name))}`,
                    name,
                    aliases: Array.from(new Set(((item.aliases as unknown[] | undefined) || []).map((alias) => requiredText(alias, "人物别名不能为空")))),
                    role: text(item.role),
                    background: text(item.background),
                    motivation: text(item.motivation),
                    personality: text(item.personality),
                    relationships: text(item.relationships),
                    arc: text(item.arc),
                    visualIdentity: text(item.visualIdentity),
                    voiceStyle: text(item.voiceStyle),
                    signatureAction: text(item.signatureAction),
                };
            });
            assertUniqueIds(characters, "人物 ID 重复");
            assertCharacterNames(characters);
            data = { characters };
            break;
        }
        case "beats": {
            const beats = requiredArray(input.beats, "请至少填写一个节拍").map((value, index) => {
                const item = record(value, "节拍格式无效");
                return {
                    id: text(item.id) || `beat-${index + 1}`,
                    title: requiredText(item.title, `第 ${index + 1} 个节拍缺少标题`),
                    duration: positiveNumber(item.duration, `第 ${index + 1} 个节拍的时长必须大于 0`),
                    description: requiredText(item.description, `第 ${index + 1} 个节拍缺少剧情描述`),
                    emotion: text(item.emotion),
                    payoff: text(item.payoff),
                };
            });
            assertUniqueIds(beats, "节拍 ID 重复");
            data = { outline: text(input.outline), hook: text(input.hook), nextPreview: text(input.nextPreview), beats };
            break;
        }
        case "script": {
            const scenes = requiredArray(input.scenes, "请至少填写一个场次").map((value, index) => {
                const item = record(value, "场次格式无效");
                const blocks = requiredArray(item.blocks, `第 ${index + 1} 场缺少动作、对白或旁白`).map((value, blockIndex) => {
                    const block = record(value, "剧本段落格式无效");
                    if (!["action", "dialogue", "narration"].includes(String(block.type))) throw new DramaWorkflowError("剧本段落类型无效");
                    const type = block.type as "action" | "dialogue" | "narration";
                    return {
                        id: text(block.id) || `block-${index + 1}-${blockIndex + 1}`,
                        type,
                        speaker: type === "dialogue" ? requiredText(block.speaker, `第 ${index + 1} 场第 ${blockIndex + 1} 段对白缺少说话人`) : text(block.speaker),
                        text: requiredText(block.text, `第 ${index + 1} 场第 ${blockIndex + 1} 段内容不能为空`),
                    };
                });
                assertUniqueIds(blocks, "同一场次的段落 ID 重复");
                return {
                    id: text(item.id) || `scene-${index + 1}`,
                    title: requiredText(item.title, `第 ${index + 1} 场缺少标题`),
                    location: requiredText(item.location, `第 ${index + 1} 场缺少地点`),
                    time: text(item.time),
                    lighting: text(item.lighting),
                    blocks,
                };
            });
            assertUniqueIds(scenes, "场次 ID 重复");
            data = { scenes };
            break;
        }
        default:
            throw new DramaWorkflowError("创作阶段无效");
    }
    return data as DramaWorkflowDataByStage[S];
}

export function normalizeDramaWorkflow(value: unknown): DramaWorkflow | undefined {
    if (value === undefined || value === null) return undefined;
    const input = record(value, "创作流程格式无效");
    if (input.schemaVersion !== 1 || !Array.isArray(input.artifacts)) throw new DramaWorkflowError("创作流程版本或产物列表无效");
    const artifacts = input.artifacts.map((value): DramaWorkflowArtifact => {
        const item = record(value, "创作产物格式无效");
        const stage = parseStage(item.stage);
        const episodeId = text(item.episodeId) || undefined;
        assertScope(stage, episodeId);
        if (item.source !== "manual" && item.source !== "ai") throw new DramaWorkflowError("创作产物来源无效");
        if (item.status !== "candidate" && item.status !== "adopted") throw new DramaWorkflowError("创作产物状态无效");
        const createdAt = text(item.createdAt);
        if (!createdAt || !Number.isFinite(Date.parse(createdAt))) throw new DramaWorkflowError("创作产物时间无效");
        return {
            id: requiredText(item.id, "创作产物 ID 不能为空"),
            stage,
            episodeId,
            version: positiveInteger(item.version, "创作产物版本必须为正整数"),
            createdAt,
            source: item.source,
            methodVersion: requiredText(item.methodVersion, "创作方法版本不能为空"),
            status: item.status,
            inputFingerprint: requiredText(item.inputFingerprint, "创作产物缺少输入快照"),
            adoptedFingerprint: item.status === "adopted" ? requiredText(item.adoptedFingerprint, "采用稿缺少输入快照") : undefined,
            instructions: text(item.instructions) || undefined,
            data: validateDramaWorkflowData(stage, item.data),
        } as DramaWorkflowArtifact;
    });
    assertUniqueIds(artifacts, "创作产物 ID 重复");
    const versions = new Set<string>();
    for (const artifact of artifacts) {
        const key = JSON.stringify([artifact.stage, artifact.episodeId, artifact.version]);
        if (versions.has(key)) throw new DramaWorkflowError("同一阶段的创作产物版本重复");
        versions.add(key);
    }
    return { schemaVersion: 1, artifacts };
}

export function latestDramaWorkflowArtifact<S extends DramaWorkflowStage>(project: DramaProject, stage: S, episodeId?: string, status?: DramaWorkflowArtifact["status"]): DramaWorkflowArtifactFor<S> | undefined {
    return project.workflow?.artifacts
        .filter((artifact) => artifact.stage === stage && artifact.episodeId === episodeId && (!status || artifact.status === status))
        .reduce<DramaWorkflowArtifactFor<S> | undefined>((latest, artifact) => (!latest || artifact.version > latest.version ? (artifact as DramaWorkflowArtifactFor<S>) : latest), undefined);
}

export function dramaWorkflowInput(project: DramaProject, stage: DramaWorkflowStage, episodeId?: string): Record<string, unknown> {
    parseStage(stage);
    const episode = resolveEpisode(project, stage, episodeId);
    const input: Record<string, unknown> = {
        project: { id: project.id, title: project.title, summary: project.summary, style: project.style },
        sourceAssets: (project.sourceAssets || []).map((asset) => ({
            id: asset.id,
            type: asset.type,
            title: asset.title,
            textContent: asset.textContent || "",
            storageKey: asset.storageKey || "",
            remoteUrl: asset.remoteUrl || "",
            serverUrl: asset.serverUrl || "",
        })),
    };
    const current = latestDramaWorkflowArtifact(project, stage, episodeId, "adopted");
    input.currentRevision = current ? { id: current.id, version: current.version } : null;
    if (stage !== "story") {
        const story = latestDramaWorkflowArtifact(project, "story", undefined, "adopted");
        input.story = story?.data || null;
        input.storyState = upstreamState(project, story);
        input.characters = project.characters.map((character) => ({ id: character.id, name: character.name, description: character.description, visualIdentity: character.profile?.visualIdentity || "" }));
        if (stage !== "characters") {
            const biographies = latestDramaWorkflowArtifact(project, "characters", undefined, "adopted");
            input.characterBiographies = biographies?.data || null;
            input.charactersState = upstreamState(project, biographies);
        }
    }
    if (episode) {
        input.episode = {
            id: episode.id,
            title: episode.title,
            episodeNumber: episode.episodeNumber || project.episodes.indexOf(episode) + 1,
            outline: episode.outline,
            hook: episode.hook,
            nextPreview: episode.nextPreview,
            sourceRange: episode.sourceRange,
        };
        if (stage !== "beats") {
            const beats = latestDramaWorkflowArtifact(project, "beats", episode.id, "adopted");
            input.beats = beats?.data || null;
            input.beatsState = upstreamState(project, beats);
        }
    }
    if (stage === "script" && episode) {
        input.currentScript = episode.script;
    }
    return input;
}

export function dramaWorkflowFingerprint(project: DramaProject, stage: DramaWorkflowStage, episodeId?: string): string {
    return stableHash(JSON.stringify(dramaWorkflowInput(project, stage, episodeId)));
}

export function createDramaWorkflowArtifact(project: DramaProject, input: { stage: DramaWorkflowStage; episodeId?: string; data: unknown; source: "manual" | "ai"; instructions?: string }): DramaWorkflowArtifact {
    const stage = parseStage(input.stage);
    resolveEpisode(project, stage, input.episodeId);
    if (input.source !== "manual" && input.source !== "ai") throw new DramaWorkflowError("创作产物来源无效");
    let data = validateDramaWorkflowData(stage, input.data);
    if (stage === "characters") data = resolveCharacterIds(project, data as DramaCharactersData, input.data);
    return {
        id: `artifact-${nanoid()}`,
        stage,
        episodeId: input.episodeId,
        version: (latestDramaWorkflowArtifact(project, stage, input.episodeId)?.version || 0) + 1,
        createdAt: new Date().toISOString(),
        source: input.source,
        methodVersion: DRAMA_WORKFLOW_METHOD_VERSION,
        status: "candidate",
        inputFingerprint: dramaWorkflowFingerprint(project, stage, input.episodeId),
        instructions: text(input.instructions) || undefined,
        data,
    } as DramaWorkflowArtifact;
}

export function appendDramaWorkflowArtifact(project: DramaProject, artifact: DramaWorkflowArtifact): DramaProject {
    const validated = normalizeDramaWorkflow({ schemaVersion: 1, artifacts: [artifact] })!.artifacts[0];
    resolveEpisode(project, validated.stage, validated.episodeId);
    if (validated.status !== "candidate") throw new DramaWorkflowError("只能新增候选稿");
    if (project.workflow?.artifacts.some((item) => item.id === validated.id)) throw new DramaWorkflowError("候选稿已存在", 409);
    const version = (latestDramaWorkflowArtifact(project, validated.stage, validated.episodeId)?.version || 0) + 1;
    return {
        ...project,
        workflow: { schemaVersion: 1, artifacts: [...(project.workflow?.artifacts || []), { ...validated, version }] },
    };
}

export function adoptDramaWorkflowArtifact(project: DramaProject, artifactId: string): DramaProject {
    const artifact = project.workflow?.artifacts.find((item) => item.id === artifactId);
    if (!artifact) throw new DramaWorkflowError("候选稿不存在", 409);
    if (artifact.status === "adopted") {
        if (latestDramaWorkflowArtifact(project, artifact.stage, artifact.episodeId, "adopted")?.id === artifact.id && !dramaWorkflowArtifactIsStale(project, artifact)) return project;
        throw new DramaWorkflowError("历史采用稿不能直接覆盖当前内容，请以此创建新候选稿", 409);
    }
    if (dramaWorkflowArtifactIsStale(project, artifact)) throw new DramaWorkflowError("相关内容已改变，请基于最新内容重新生成或保存候选稿", 409);
    resolveEpisode(project, artifact.stage, artifact.episodeId);
    validateDramaWorkflowData(artifact.stage, artifact.data);
    const next: DramaProject = { ...project };
    if (artifact.stage === "story") next.summary = artifact.data.logline;
    if (artifact.stage === "characters") next.characters = applyCharacters(project, resolveCharacterIds(project, artifact.data, artifact.data));
    next.episodes = project.episodes.map((episode) => {
        if (artifact.episodeId && episode.id !== artifact.episodeId) return episode;
        const updated = markEpisodeForReview(episode);
        if (artifact.stage === "beats") return { ...updated, outline: artifact.data.outline, hook: artifact.data.hook, nextPreview: artifact.data.nextPreview };
        if (artifact.stage === "script") return { ...updated, script: renderDramaWorkflowScript(artifact.data), scriptRichContent: undefined };
        return updated;
    });
    next.workflow = { schemaVersion: 1, artifacts: project.workflow!.artifacts.map((item) => (item.id === artifact.id ? { ...item, status: "adopted" } : item)) };
    const adoptedFingerprint = dramaWorkflowFingerprint(next, artifact.stage, artifact.episodeId);
    next.workflow = { ...next.workflow, artifacts: next.workflow.artifacts.map((item) => (item.id === artifact.id ? { ...item, adoptedFingerprint } : item)) };
    return next;
}

export function dramaWorkflowArtifactIsStale(project: DramaProject, artifact: DramaWorkflowArtifact): boolean {
    if (artifact.episodeId && !project.episodes.some((episode) => episode.id === artifact.episodeId)) return true;
    const expected = artifact.status === "adopted" ? artifact.adoptedFingerprint : artifact.inputFingerprint;
    return expected !== dramaWorkflowFingerprint(project, artifact.stage, artifact.episodeId);
}

export function renderDramaWorkflowScript(data: DramaScriptData): string {
    return data.scenes
        .map((scene, index) => {
            const heading = [`第 ${index + 1} 场：${scene.title}`, `地点：${scene.location}`, scene.time && `时间：${scene.time}`, scene.lighting && `光线：${scene.lighting}`].filter(Boolean).join("\n");
            const body = scene.blocks.map((block) => (block.type === "dialogue" ? `${block.speaker}：${block.text}` : block.type === "narration" ? `旁白${block.speaker ? `（${block.speaker}）` : ""}：${block.text}` : `动作：${block.text}`)).join("\n");
            return `${heading}\n${body}`;
        })
        .join("\n\n");
}

function upstreamState(project: DramaProject, artifact: DramaWorkflowArtifact | undefined) {
    return artifact ? { id: artifact.id, version: artifact.version, stale: dramaWorkflowArtifactIsStale(project, artifact) } : null;
}

function resolveCharacterIds(project: DramaProject, data: DramaCharactersData, rawData: unknown): DramaCharactersData {
    const previous = latestDramaWorkflowArtifact(project, "characters", undefined, "adopted")?.data.characters || [];
    const known = project.characters.map((character) => ({ ...character, aliases: previous.find((item) => item.id === character.id)?.aliases || [] }));
    const raw = (rawData as DramaCharactersData).characters;
    const characters = data.characters.map((character, index) => {
        const suppliedId = text(raw[index]?.id);
        const matching = known.filter((item) => [item.name, ...item.aliases].some((name) => [character.name, ...character.aliases].some((alias) => nameKey(alias) === nameKey(name))));
        if (matching.length > 1 || (suppliedId && matching.some((item) => item.id !== suppliedId))) throw new DramaWorkflowError(`人物“${character.name}”的姓名或别名与已有角色冲突`);
        return { ...character, id: suppliedId || matching[0]?.id || character.id };
    });
    assertUniqueIds(characters, "多个人物指向同一个角色 ID");
    const all = [...known.filter((item) => !characters.some((character) => character.id === item.id)), ...characters];
    assertCharacterNames(all);
    return { characters };
}

function applyCharacters(project: DramaProject, data: DramaCharactersData): DramaCharacter[] {
    const previous = new Map(project.characters.map((character) => [character.id, character]));
    const updates = data.characters.map((biography) => {
        const character = previous.get(biography.id);
        return {
            ...character,
            id: biography.id,
            name: biography.name,
            description: renderBiography(biography),
            profile: { styling: "", colorPalette: "", consistencyRules: "", ...character?.profile, visualIdentity: biography.visualIdentity },
        };
    });
    const byId = new Map(updates.map((character) => [character.id, character]));
    return [...project.characters.map((character) => byId.get(character.id) || character), ...updates.filter((character) => !previous.has(character.id))];
}

function renderBiography(value: DramaCharacterBiography): string {
    return [
        ["身份", value.role],
        ["背景", value.background],
        ["动机", value.motivation],
        ["性格", value.personality],
        ["关系", value.relationships],
        ["成长弧线", value.arc],
        ["声音", value.voiceStyle],
        ["标志动作", value.signatureAction],
        ["别名", value.aliases.join("、")],
    ]
        .filter(([, value]) => value)
        .map(([label, value]) => `${label}：${value}`)
        .join("\n");
}

function markEpisodeForReview(episode: DramaEpisode): DramaEpisode {
    return { ...episode, reviewStatus: "draft", contentStale: true, renderStale: true, shots: episode.shots.map((shot) => ({ ...shot, productionStale: true, storyboardStale: true, storyboardEndStale: true })) };
}

function resolveEpisode(project: DramaProject, stage: DramaWorkflowStage, episodeId?: string): DramaEpisode | undefined {
    assertScope(stage, episodeId);
    if (!episodeId) return undefined;
    const episode = project.episodes.find((item) => item.id === episodeId);
    if (!episode) throw new DramaWorkflowError("创作产物关联的剧集不存在", 409);
    return episode;
}

function assertScope(stage: DramaWorkflowStage, episodeId?: string) {
    if ((stage === "beats" || stage === "script") && !episodeId) throw new DramaWorkflowError("该创作阶段需要指定剧集");
    if ((stage === "story" || stage === "characters") && episodeId) throw new DramaWorkflowError("故事设定和人物小传属于整个项目");
}

function assertCharacterNames(characters: Array<{ id: string; name: string; aliases: string[] }>) {
    const owners = new Map<string, string>();
    for (const character of characters) {
        for (const name of [character.name, ...character.aliases]) {
            const key = nameKey(name);
            const owner = owners.get(key);
            if (owner && owner !== character.id) throw new DramaWorkflowError(`人物姓名或别名“${name}”存在冲突`);
            owners.set(key, character.id);
        }
    }
}

function assertUniqueIds(items: Array<{ id: string }>, message: string) {
    if (new Set(items.map((item) => item.id)).size !== items.length) throw new DramaWorkflowError(message);
}

function parseStage(value: unknown): DramaWorkflowStage {
    if (!DRAMA_WORKFLOW_STAGES.includes(value as DramaWorkflowStage)) throw new DramaWorkflowError("创作阶段无效");
    return value as DramaWorkflowStage;
}

function record(value: unknown, message: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new DramaWorkflowError(message);
    return value as Record<string, unknown>;
}

function text(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function requiredText(value: unknown, message: string): string {
    const result = text(value);
    if (!result) throw new DramaWorkflowError(message);
    return result;
}

function requiredArray(value: unknown, message: string): unknown[] {
    if (!Array.isArray(value) || !value.length) throw new DramaWorkflowError(message);
    return value;
}

function positiveNumber(value: unknown, message: string): number {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new DramaWorkflowError(message);
    return value;
}

function positiveInteger(value: unknown, message: string): number {
    const number = positiveNumber(value, message);
    if (!Number.isSafeInteger(number)) throw new DramaWorkflowError(message);
    return number;
}

function nameKey(value: string): string {
    return value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

function stableHash(value: string): string {
    // 两组独立的 32 位散列用于变更检测，避免保存原文快照导致历史产物指数增长。
    let first = 0x811c9dc5;
    let second = 0x9e3779b9;
    for (let index = 0; index < value.length; index += 1) {
        first = Math.imul(first ^ value.charCodeAt(index), 0x01000193);
        second = Math.imul(second ^ value.charCodeAt(index), 0x85ebca6b);
    }
    return `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}`;
}
