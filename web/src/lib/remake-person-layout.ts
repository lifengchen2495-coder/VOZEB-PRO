export const REMAKE_PERSON_SEGMENT_MS = 15_000;
export const REMAKE_PERSON_ANALYSIS_FRAMES = 48;
export const REMAKE_PERSON_MAX_FRAMES = 600;
export type RemakeTimelineFrame = { ordinal: number; time: number; endTime: number; segmentIndex?: number };
export type RemakeFrameGroup = { id: string; ordinal: number; startFrame: number; endFrame: number };

export function isOriginalRemakePersonLayout(frames: RemakeTimelineFrame[]) {
    return frames.length === REMAKE_PERSON_ANALYSIS_FRAMES && frames.every((frame, index) => frame.ordinal === index + 1 && frame.segmentIndex === undefined);
}

export function splitRemakePersonShots<T extends RemakeTimelineFrame>(shots: T[], durationMs: number): T[] {
    if (!shots.length || !Number.isSafeInteger(durationMs) || durationMs <= 0) throw new Error("原视频分镜时间轴无效");
    const result: T[] = [];
    let previousEnd = 0;
    for (const [index, shot] of shots.entries()) {
        let start = Math.round(shot.time * 1000);
        const end = Math.round(shot.endTime * 1000);
        if (shot.ordinal !== index + 1 || start !== previousEnd || end <= start || end > durationMs) throw new Error("分镜时间轴必须连续覆盖原视频");
        while (start < end) {
            const segmentIndex = Math.floor(start / REMAKE_PERSON_SEGMENT_MS) + 1;
            const stop = Math.min(end, segmentIndex * REMAKE_PERSON_SEGMENT_MS);
            result.push({ ...shot, ordinal: result.length + 1, time: start / 1000, endTime: stop / 1000, segmentIndex });
            start = stop;
        }
        previousEnd = end;
    }
    if (previousEnd !== durationMs || result.length > REMAKE_PERSON_MAX_FRAMES) throw new Error("分镜时间轴未完整覆盖原视频或镜头数量超过上限");
    return result;
}

export function remakePersonFrameGroups(frames: RemakeTimelineFrame[]): RemakeFrameGroup[] {
    if (!frames.length || frames.length > REMAKE_PERSON_MAX_FRAMES || frames.some((frame, index) => frame.ordinal !== index + 1)) return [];
    if (!frames.some((frame) => frame.segmentIndex !== undefined)) {
        return frames.length === 48 ? Array.from({ length: 4 }, (_, i) => ({ id: `${i * 12 + 1}-${i * 12 + 12}`, ordinal: i + 1, startFrame: i * 12 + 1, endFrame: i * 12 + 12 })) : [];
    }
    const groups: RemakeFrameGroup[] = [];
    let previousEnd = 0;
    for (const frame of frames) {
        const start = Math.round(frame.time * 1000);
        const end = Math.round(frame.endTime * 1000);
        const index = Math.floor(start / REMAKE_PERSON_SEGMENT_MS) + 1;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start !== previousEnd || frame.segmentIndex !== index || end <= start || end > index * REMAKE_PERSON_SEGMENT_MS) return [];
        previousEnd = end;
        let group = groups.at(-1);
        if (group?.ordinal !== index) {
            if (index !== groups.length + 1 || start !== (index - 1) * REMAKE_PERSON_SEGMENT_MS) return [];
            group = { id: "", ordinal: index, startFrame: frame.ordinal, endFrame: frame.ordinal };
            groups.push(group);
        }
        group.endFrame = frame.ordinal;
        group.id = `${group.startFrame}-${group.endFrame}`;
    }
    return groups;
}

export function remakePersonCopyFrameGroups(frames: RemakeTimelineFrame[]): number[][] {
    return remakePersonFrameGroups(frames).flatMap((group) => {
        const ordinals = frames.filter((frame) => frame.ordinal >= group.startFrame && frame.ordinal <= group.endFrame).map((frame) => frame.ordinal);
        return Array.from({ length: Math.ceil(ordinals.length / 3) }, (_, index) => ordinals.slice(index * 3, index * 3 + 3));
    });
}

export function remakePersonGridLayout(count: number) {
    if (!Number.isSafeInteger(count) || count < 1 || count > REMAKE_PERSON_MAX_FRAMES) throw new Error("分镜拼图数量无效");
    const columns = Math.max(1, Math.ceil(Math.sqrt(count * 3 / 4)));
    return { columns, rows: Math.ceil(count / columns), count };
}
