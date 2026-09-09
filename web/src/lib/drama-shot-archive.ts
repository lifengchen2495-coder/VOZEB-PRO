import { nanoid } from "nanoid";

import type { DramaEpisode, DramaShot } from "@/lib/drama-project-contract";

const mediaKeys = [
    "storyboardTaskId",
    "storyboardImageUrl",
    "storyboardAttempt",
    "storyboardEndTaskId",
    "storyboardEndImageUrl",
    "storyboardEndAttempt",
    "generationTaskId",
    "videoUrl",
    "generationAttempt",
    "audioTaskId",
    "audioUrl",
    "audioAttempt",
] as const;
const mediaReferences = ["storyboardTaskId", "storyboardImageUrl", "storyboardEndTaskId", "storyboardEndImageUrl", "generationTaskId", "videoUrl", "audioTaskId", "audioUrl"] as const;

export function dramaShotMediaChanged(before: DramaShot, after: DramaShot) {
    return mediaReferences.some((key) => Boolean(before[key]) && before[key] !== after[key]);
}

export function archiveDramaShots(episode: DramaEpisode, shots: DramaShot[], reason: string): DramaEpisode {
    const existing = episode.shotArchives || [];
    const archived = new Set(existing.map((item) => mediaKey(item.shot)));
    const additions: NonNullable<DramaEpisode["shotArchives"]> = [];
    for (const shot of shots) {
        const key = mediaKey(shot);
        if (!mediaReferences.some((field) => shot[field]) || archived.has(key)) continue;
        archived.add(key);
        additions.push({ id: `shot-archive-${nanoid()}`, shotId: shot.id, archivedAt: new Date().toISOString(), reason, shot: structuredClone(shot) });
    }
    return additions.length ? { ...episode, shotArchives: [...existing, ...additions] } : episode;
}

function mediaKey(shot: DramaShot) {
    return JSON.stringify([shot.id, ...mediaKeys.map((key) => shot[key] ?? null)]);
}
