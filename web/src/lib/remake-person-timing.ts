import { remakePersonFrameGroups } from "./remake-person-layout";
export const REMAKE_PERSON_OUTPUT_FPS = 30;

export type RemakePersonTiming = {
    version: 1 | 2;
    frameOrdinals?: number[];
    groupId: string;
    sourceDurationMs: number;
    startMs: number;
    endMs: number;
    durationMs: number;
    outputFrames: number;
    requestSeconds: number;
};

export type RemakePersonTimelineInput = {
    sourceVideo?: { durationMs?: number };
    frames: Array<{ ordinal: number; time: number; endTime: number; segmentIndex?: number }>;
};

export function remakePersonTimings(project: RemakePersonTimelineInput): RemakePersonTiming[] {
    const frames = [...project.frames].sort((left, right) => left.ordinal - right.ordinal);
    const groups = remakePersonFrameGroups(frames);
    if (!groups.length) return [];
    const durationMs = Math.round(project.sourceVideo?.durationMs || frames.at(-1)!.endTime * 1000);
    if (!Number.isSafeInteger(durationMs) || durationMs <= 0) return [];
    let previousEnd = 0;
    for (const [index, frame] of frames.entries()) {
        const start = Math.round(frame.time * 1000);
        const end = Math.round(frame.endTime * 1000);
        if (frame.ordinal !== index + 1 || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || Math.abs(start - previousEnd) > 2 || end > durationMs + 2) return [];
        previousEnd = end;
    }
    if (Math.abs(previousEnd - durationMs) > 2) return [];
    const timings: RemakePersonTiming[] = groups.map((group, index) => {
        const first = group.startFrame - 1;
        const startMs = index === 0 ? 0 : Math.round(frames[first].time * 1000);
        const endMs = index === groups.length - 1 ? durationMs : Math.round(frames[group.endFrame].time * 1000);
        const outputFrames = Math.max(1, Math.round(endMs * REMAKE_PERSON_OUTPUT_FPS / 1000) - Math.round(startMs * REMAKE_PERSON_OUTPUT_FPS / 1000));
        const segmented = frames[0].segmentIndex !== undefined;
        return { version: segmented ? 2 : 1, ...(segmented ? { frameOrdinals: frames.slice(first, group.endFrame).map((frame) => frame.ordinal) } : {}), groupId: group.id, sourceDurationMs: durationMs, startMs, endMs, durationMs: endMs - startMs, outputFrames, requestSeconds: Math.max(1, Math.ceil((endMs - startMs) / 1000)) };
    });
    return timings.every((timing) => timing.outputFrames > 0) ? timings : [];
}

export function remakePersonGroupTiming(project: RemakePersonTimelineInput, groupId: string) {
    return remakePersonTimings(project).find((timing) => timing.groupId === groupId);
}

export function remakePersonTimingKey(timing?: RemakePersonTiming) {
    return timing ? JSON.stringify(timing) : "";
}

export function remakePersonSeconds(durationMs: number) {
    return String(Number((durationMs / 1000).toFixed(3)));
}

export function remakePersonOutputSeconds(timing: RemakePersonTiming) {
    return timing.outputFrames / REMAKE_PERSON_OUTPUT_FPS;
}

export function remakePersonResultMatches(timing: RemakePersonTiming | undefined, result?: { durationMs?: number } | null) {
    return Boolean(timing && result?.durationMs && Math.abs(result.durationMs - remakePersonOutputSeconds(timing) * 1000) < 70);
}

export function remakePersonPromptDurationError(prompt: string, timing?: RemakePersonTiming) {
    if (!timing) return "原视频分镜时间轴不完整，请重新分析后再生成视频";
    const declared = prompt.match(/(\d+(?:\.\d+)?)\s*秒\s*(?:的)?(?:抖音)?(?:短)?视频/u)
        || prompt.match(/(?:总时长|视频时长)\s*[:：为]?\s*(\d+(?:\.\d+)?)\s*秒/u);
    if (declared && Math.abs(Number(declared[1]) * 1000 - timing.durationMs) > 2) {
        return `本组对应原视频 ${remakePersonSeconds(timing.durationMs)} 秒，当前 Prompt 仍写 ${declared[1]} 秒，请编辑时长或重新生成 Prompt`;
    }
    return "";
}

export function remakePersonTaskTimingMatches(timing: RemakePersonTiming, task: { remakePersonTiming?: RemakePersonTiming; requestedDurationSeconds?: number }) {
    if (task.remakePersonTiming) return remakePersonTimingKey(task.remakePersonTiming) === remakePersonTimingKey(timing) && (task.requestedDurationSeconds || 0) >= timing.requestSeconds;
    return timing.durationMs === 15_000 && task.requestedDurationSeconds === 15;
}
