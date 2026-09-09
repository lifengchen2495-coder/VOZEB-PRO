import type { DramaCharacter, DramaProject, DramaShot } from "@/lib/drama-project-contract";
import type { DramaWorkflowArtifact, DramaWorkflowArtifactFor } from "@/lib/drama-workflow-contract";
import { adoptDramaWorkflowArtifact, dramaWorkflowArtifactIsStale, DramaWorkflowError, normalizeDramaWorkflow } from "@/lib/drama-workflow";

export class DramaWorkflowMergeConflict extends DramaWorkflowError {
    constructor(
        message: string,
        readonly project: DramaProject,
    ) {
        super(`${message}。分析产物已保留，请核对人物身份后继续`, 409);
        this.name = "DramaWorkflowMergeConflict";
    }
}

// 只合并本次产物，让请求期间的本地编辑和媒体任务结果继续保留。
export function mergeDramaWorkflowArtifactResult(current: DramaProject, artifact: DramaWorkflowArtifact): DramaProject {
    const existing = current.workflow?.artifacts.find((item) => item.id === artifact.id);
    if (existing && (existing.stage !== artifact.stage || existing.episodeId !== artifact.episodeId || existing.version !== artifact.version)) throw new DramaWorkflowError("分析结果版本冲突，请刷新项目后重试", 409);
    if (existing?.status === "adopted" && artifact.status !== "adopted") return current;
    const others = (current.workflow?.artifacts || []).filter((item) => item.id !== artifact.id);
    const workflow = normalizeDramaWorkflow({ schemaVersion: 1, artifacts: [...others, artifact] })!;
    const merged = { ...current, workflow };
    if (artifact.status !== "adopted") return merged;
    const analyzeCharacters = artifact.intent === "analysis" && artifact.stage === "characters";
    if (existing?.status === "adopted") {
        if (!analyzeCharacters || dramaWorkflowArtifactIsStale(merged, artifact)) return current;
        const aligned = alignAnalyzedCharacterIds(current, artifact, merged, true);
        // 已采用且身份一致时，不重新应用小传或重置已完成分镜的状态。
        return aligned === current && JSON.stringify(existing) === JSON.stringify(artifact) ? current : { ...aligned, workflow };
    }
    const pending = { ...current, workflow: normalizeDramaWorkflow({ schemaVersion: 1, artifacts: [...others, { ...artifact, status: "candidate", adoptedFingerprint: undefined }] })! };
    // 服务端已采用但本地刚改稿时，保留采用记录以便后续保存，同时不覆盖本地内容。
    if (dramaWorkflowArtifactIsStale(pending, pending.workflow.artifacts.at(-1)!)) return merged;
    const aligned = analyzeCharacters ? alignAnalyzedCharacterIds(pending, artifact, merged, false) : pending;
    let applied: DramaProject;
    try {
        applied = adoptDramaWorkflowArtifact(aligned, artifact.id);
    } catch (error) {
        if (analyzeCharacters && error instanceof DramaWorkflowError) throw new DramaWorkflowMergeConflict(error.message, merged);
        throw error;
    }
    return { ...applied, workflow };
}

function alignAnalyzedCharacterIds(current: DramaProject, artifact: DramaWorkflowArtifactFor<"characters">, recoverable: DramaProject, alreadyAdopted: boolean): DramaProject {
    const previous = current.workflow?.artifacts.filter((item): item is DramaWorkflowArtifactFor<"characters"> => item.stage === "characters" && item.status === "adopted" && item.id !== artifact.id).sort((left, right) => right.version - left.version)[0];
    const localNames = (character: DramaCharacter) => {
        const biography = previous?.data.characters.find((item) => item.id === character.id);
        return new Set([character.name, ...(biography ? [biography.name, ...biography.aliases] : [])].map(nameKey));
    };
    const remapped = new Map<string, string>();
    for (const biography of artifact.data.characters) {
        const names = new Set([biography.name, ...biography.aliases].map(nameKey));
        const matches = current.characters.filter((character) => [...localNames(character)].some((name) => names.has(name)));
        if (matches.length > 1) throw new DramaWorkflowMergeConflict(`“${biography.name}”对应多个本地人物，无法确定应保留哪一套角色资产`, recoverable);
        const occupied = current.characters.find((character) => character.id === biography.id);
        const match = matches[0];
        if (occupied && occupied !== match) throw new DramaWorkflowMergeConflict(`服务端人物“${biography.name}”的 ID 已被本地人物“${occupied.name}”使用`, recoverable);
        if (!match) {
            if (alreadyAdopted) throw new DramaWorkflowMergeConflict(`已采用人物“${biography.name}”缺少本地角色，请补充角色或重新分析人物`, recoverable);
            continue;
        }
        const target = remapped.get(match.id);
        if (target && target !== biography.id) throw new DramaWorkflowMergeConflict(`本地人物“${match.name}”同时对应多个服务端人物`, recoverable);
        remapped.set(match.id, biography.id);
    }
    if (![...remapped].some(([id, target]) => id !== target)) return current;
    const characters = current.characters.map((character) => {
        const id = remapped.get(character.id);
        return id && id !== character.id ? { ...character, id } : character;
    });
    if (new Set(characters.map((character) => character.id)).size !== characters.length) throw new DramaWorkflowMergeConflict("角色 ID 合并后发生重复，无法安全应用分析结果", recoverable);
    const remapShot = (shot: DramaShot): DramaShot => {
        if (!shot.characterIds.some((id) => remapped.has(id) && remapped.get(id) !== id)) return shot;
        return { ...shot, characterIds: [...new Set(shot.characterIds.map((id) => remapped.get(id) || id))] };
    };
    return {
        ...current,
        characters,
        episodes: current.episodes.map((episode) => ({
            ...episode,
            shots: episode.shots.map(remapShot),
            shotArchives: episode.shotArchives?.map((archive) => ({ ...archive, shot: remapShot(archive.shot) })),
        })),
    };
}

function nameKey(value: string): string {
    return value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
}
