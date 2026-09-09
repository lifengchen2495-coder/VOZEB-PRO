import { nanoid } from "nanoid";

import type { DramaContentAnalysis, DramaEpisode, DramaProject, DramaShot, DramaVisualAnalysis } from "@/lib/drama-project-contract";
import { archiveDramaShots } from "@/lib/drama-shot-archive";

const contentKeys = ["title", "description", "sourceText", "shotBoundary", "dialogue", "narration", "subtitle", "duration", "characterIds", "sceneId", "propIds", "clueIds"] as const;
const visualKeys = ["imagePrompt", "videoPrompt", "cameraMotion", "startFramePrompt", "endFramePrompt", "negativePrompt", "continuity"] as const;

function stable(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
    if (value && typeof value === "object")
        return (
            "{" +
            Object.entries(value)
                .filter(([, item]) => item !== undefined)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
                .join(",") +
            "}"
        );
    return JSON.stringify(value) ?? "null";
}

function pick<T, K extends keyof T>(shot: T, keys: readonly K[]) {
    return Object.fromEntries(keys.map((key) => [key, shot[key]]));
}

function content(shot: DramaShot) {
    return { ...pick(shot, contentKeys), subtitle: shot.subtitle ?? [shot.dialogue, shot.narration].filter(Boolean).join("\n"), utterances: shot.utterances.map(({ order, type, speaker, text }) => ({ order, type, speaker, text })) };
}

export function dramaShotProductionFingerprint(shot: DramaShot) {
    return stable({ ...content(shot), ...pick(shot, visualKeys), videoMode: shot.videoMode, storyboardFrameMode: shot.storyboardFrameMode, audioMode: shot.audioMode });
}

export function dramaShotFrameInputFingerprint(shot: DramaShot, frame: "start" | "end") {
    return stable({
        ...content(shot),
        negativePrompt: shot.negativePrompt,
        continuity: shot.continuity,
        framePrompt: frame === "start" ? [shot.imagePrompt, shot.startFramePrompt] : shot.endFramePrompt || shot.videoPrompt || shot.imagePrompt,
    });
}

function analysisInput(project: DramaProject, episodeId: string) {
    const episode = project.episodes.find((item) => item.id === episodeId);
    if (!episode) throw new Error("短剧分集不存在");
    return {
        title: project.title,
        summary: project.summary,
        style: project.style,
        ratio: project.ratio,
        defaultVideoMode: project.defaultVideoMode,
        characters: project.characters,
        scenes: project.scenes,
        props: project.props,
        clues: project.clues,
        adoptedWorkflow: project.workflow?.artifacts.filter((item) => item.status === "adopted" && (!item.episodeId || item.episodeId === episodeId)),
        episode: { id: episode.id, title: episode.title, script: episode.script, outline: episode.outline, hook: episode.hook, nextPreview: episode.nextPreview, sourceRange: episode.sourceRange, contentStale: episode.contentStale },
        shots: episode.shots.map((shot) => ({ id: shot.id, order: shot.order, input: dramaShotProductionFingerprint(shot) })),
    };
}

export function dramaContentAnalysisFingerprint(project: DramaProject, episodeId: string) {
    return stable(analysisInput(project, episodeId));
}

export function dramaVisualAnalysisFingerprint(project: DramaProject, episodeId: string) {
    return stable(analysisInput(project, episodeId));
}

export function dramaShotHasActiveMedia(shot: DramaShot) {
    return [shot.storyboardStatus, shot.storyboardEndStatus, shot.generationStatus, shot.audioStatus].some((status) => status === "queued" || status === "running");
}

function normalized(value: string) {
    return value.trim().replace(/\s+/gu, " ");
}
function normalizedName(value: string) {
    return normalized(value).toLocaleLowerCase();
}

function mergeNamedItems<T extends { id: string; name: string; description: string }>(existing: T[], incoming: Array<Omit<T, "id">>, prefix: string) {
    const items = [...existing];
    const existingNames = new Set(existing.map((item) => normalizedName(item.name)));
    const added = new Set<string>();
    for (const asset of incoming) {
        const name = normalizedName(asset.name);
        const identity = stable({ ...asset, name });
        if (!name || existingNames.has(name) || added.has(identity)) continue;
        items.push({ ...asset, id: `${prefix}-${nanoid()}` } as T);
        added.add(identity);
    }
    const groups = new Map<string, T[]>();
    for (const item of items) groups.set(normalizedName(item.name), [...(groups.get(normalizedName(item.name)) || []), item]);
    // 同名资产无法由模型的名称引用确定身份，留待人工选择。
    const ids = new Map([...groups].filter(([, values]) => values.length === 1).map(([name, values]) => [name, values[0].id]));
    return { items, ids };
}

function matchShots(previous: DramaShot[], incoming: DramaShot[]) {
    const matches = new Map<number, number>();
    const consumed = new Set<number>();
    const matchUnique = (key: (shot: DramaShot) => string) => {
        const oldGroups = new Map<string, number[]>();
        const newGroups = new Map<string, number[]>();
        previous.forEach((shot, index) => {
            if (!consumed.has(index)) oldGroups.set(key(shot), [...(oldGroups.get(key(shot)) || []), index]);
        });
        incoming.forEach((shot, index) => {
            if (!matches.has(index)) newGroups.set(key(shot), [...(newGroups.get(key(shot)) || []), index]);
        });
        for (const [value, next] of newGroups) {
            const old = oldGroups.get(value);
            if (value && old?.length === 1 && next.length === 1) {
                matches.set(next[0], old[0]);
                consumed.add(old[0]);
            }
        }
    };
    matchUnique((shot) => (normalized(shot.sourceText) ? stable([normalized(shot.sourceText), normalized(shot.shotBoundary)]) : ""));
    matchUnique((shot) => (normalized(shot.sourceText) ? stable([normalized(shot.sourceText), content(shot)]) : ""));
    matchUnique((shot) => normalized(shot.sourceText));
    // 只有稳定锚点之间恰好各剩一个镜头时，才能把改写视为原镜头的新版本。
    const anchors = [[-1, -1], ...[...matches].sort(([a], [b]) => a - b), [incoming.length, previous.length]];
    for (let index = 1; index < anchors.length; index++) {
        const [nextEnd, oldEnd] = anchors[index];
        const [nextStart, oldStart] = anchors[index - 1];
        if (nextEnd - nextStart === 2 && oldEnd - oldStart === 2 && !matches.has(nextStart + 1) && !consumed.has(oldStart + 1)) {
            matches.set(nextStart + 1, oldStart + 1);
            consumed.add(oldStart + 1);
        }
    }
    return matches;
}

export function reconcileDramaContentAnalysis(project: DramaProject, episodeId: string, analysis: DramaContentAnalysis, expectedInput?: string): DramaProject {
    if (expectedInput !== undefined && dramaContentAnalysisFingerprint(project, episodeId) !== expectedInput) throw new Error("分析期间剧本、镜头或项目设定已修改，请按最新内容重新分析");
    const episode = project.episodes.find((item) => item.id === episodeId);
    if (!episode) throw new Error("短剧分集不存在");
    const { items: characters, ids: characterIds } = mergeNamedItems(project.characters, analysis.characters, "character");
    const { items: scenes, ids: sceneIds } = mergeNamedItems(project.scenes, analysis.scenes, "scene");
    const { items: props, ids: propIds } = mergeNamedItems(project.props, analysis.props, "prop");
    const { items: clues, ids: clueIds } = mergeNamedItems(project.clues, analysis.clues, "clue");
    const idsFor = (names: string[], ids: Map<string, string>) => [...new Set(names.map((name) => ids.get(normalizedName(name))).filter((id): id is string => Boolean(id)))];
    const incoming = analysis.shots.map<DramaShot>((shot, index) => ({
        id: `shot-${nanoid()}`,
        order: index + 1,
        title: shot.title,
        description: shot.description,
        sourceText: shot.sourceText,
        shotBoundary: shot.shotBoundary,
        dialogue: shot.dialogue,
        narration: shot.narration,
        utterances: shot.utterances,
        subtitle: [shot.dialogue, shot.narration].filter(Boolean).join("\n"),
        duration: shot.duration,
        imagePrompt: "",
        videoPrompt: "",
        cameraMotion: "",
        startFramePrompt: "",
        endFramePrompt: "",
        negativePrompt: "",
        characterIds: idsFor(shot.characterNames, characterIds),
        sceneId: sceneIds.get(normalizedName(shot.sceneName)),
        propIds: idsFor(shot.propNames, propIds),
        clueIds: idsFor(shot.clueNames, clueIds),
        videoMode: project.defaultVideoMode,
        storyboardFrameMode: "single",
        storyboardStatus: "idle",
        generationStatus: "idle",
        audioMode: "source",
        audioStatus: "idle",
    }));
    const matches = matchShots(episode.shots, incoming);
    const shots = incoming.map((shot, index) => {
        const previousIndex = matches.get(index);
        if (previousIndex === undefined) return shot;
        const previous = episode.shots[previousIndex];
        const changed = stable(content(previous)) !== stable(content(shot)) || previous.order !== shot.order;
        if (changed && dramaShotHasActiveMedia(previous)) throw new Error("有镜头的媒体任务仍在运行，请完成后再采用修改后的分析");
        return {
            ...previous,
            ...pick(shot, contentKeys),
            utterances: changed ? shot.utterances : previous.utterances,
            id: previous.id,
            order: shot.order,
            productionStale: previous.productionStale || changed,
            storyboardStale: Boolean(previous.storyboardStale ?? previous.productionStale) || changed,
            storyboardEndStale: Boolean(previous.storyboardEndStale ?? previous.productionStale) || changed,
        } as DramaShot;
    });
    if (episode.shots.some((shot) => dramaShotHasActiveMedia(shot) && !shots.some((next) => next.id === shot.id))) throw new Error("仍有媒体任务的镜头将被拆分或删除，请完成后再重新分析");
    const changed = stable(episode.shots.map((shot) => [shot.id, shot.order, content(shot)])) !== stable(shots.map((shot) => [shot.id, shot.order, content(shot)]));
    assertRenderCanChange(episode, changed);
    const archive = archiveDramaShots(
        episode,
        episode.shots.filter((shot) => !shots.some((next) => next.id === shot.id) || (!shot.productionStale && shots.some((next) => next.id === shot.id && next.productionStale))),
        "内容分析更新前",
    );
    return {
        ...project,
        characters,
        scenes,
        props,
        clues,
        episodes: project.episodes.map((item) => (item.id === episodeId ? { ...archive, ...analysis.episode, reviewStatus: "content_review", contentStale: false, renderStale: item.renderStale || changed, shots } : item)),
    };
}

export function reconcileDramaVisualAnalysis(project: DramaProject, episodeId: string, analysis: DramaVisualAnalysis, expectedInput?: string): DramaProject {
    if (expectedInput !== undefined && dramaVisualAnalysisFingerprint(project, episodeId) !== expectedInput) throw new Error("分析期间剧本、镜头或项目设定已修改，请按最新内容重新生成视觉方案");
    const episode = project.episodes.find((item) => item.id === episodeId);
    if (!episode) throw new Error("短剧分集不存在");
    if (episode.contentStale) throw new Error("剧本已修改，请先重新分析并审核分镜内容");
    const byId = new Map(analysis.shots.map((shot) => [shot.shotId, shot]));
    if (analysis.shots.length !== episode.shots.length || byId.size !== episode.shots.length || episode.shots.some((shot) => !byId.has(shot.id))) throw new Error("视觉方案未准确覆盖全部镜头，请重新生成");
    let changed = false;
    const shots = episode.shots.map((shot) => {
        const visual = byId.get(shot.id)!;
        const next = { ...shot, ...pick(visual, visualKeys) } as DramaShot;
        if (dramaShotProductionFingerprint(shot) === dramaShotProductionFingerprint(next)) return shot;
        if (dramaShotHasActiveMedia(shot)) throw new Error("镜头媒体任务仍在运行，请完成后再采用新的视觉方案");
        changed = true;
        return {
            ...next,
            productionStale: true,
            storyboardStale: Boolean(shot.storyboardStale ?? shot.productionStale) || dramaShotFrameInputFingerprint(shot, "start") !== dramaShotFrameInputFingerprint(next, "start"),
            storyboardEndStale: Boolean(shot.storyboardEndStale ?? shot.productionStale) || dramaShotFrameInputFingerprint(shot, "end") !== dramaShotFrameInputFingerprint(next, "end"),
        };
    });
    assertRenderCanChange(episode, changed);
    const archive = archiveDramaShots(
        episode,
        episode.shots.filter((shot, index) => !shot.productionStale && shots[index].productionStale),
        "视觉方案更新前",
    );
    return { ...project, episodes: project.episodes.map((item) => (item.id === episodeId ? { ...archive, reviewStatus: "visual_ready", renderStale: item.renderStale || changed, shots } : item)) };
}

function assertRenderCanChange(episode: DramaEpisode, changed: boolean) {
    if (changed && (episode.renderTask?.status === "pending" || episode.renderTask?.status === "running")) throw new Error("整集合成仍在运行，请完成后再采用修改后的分析");
}
