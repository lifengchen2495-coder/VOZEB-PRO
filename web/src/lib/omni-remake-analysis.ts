import type { OmniProject, OmniSegment } from "./omni-remake-contract";

function object(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function parseOmniAnalysis(raw: string, duration: number, audioMode: OmniProject["audioMode"]): { summary: string; segments: OmniSegment[] } {
    if (!Number.isFinite(duration) || duration <= 0) throw new Error("原视频时长不正确");
    const payload = object(JSON.parse(raw));
    const rows = payload.segments;
    if (!Array.isArray(rows) || !rows.length || rows.length > 200) throw new Error("视频分析必须包含 1 至 200 个连续片段");
    const summary = object(payload.video_summary);
    if (summary.total_segments !== undefined && summary.total_segments !== rows.length) throw new Error("分析总段数与实际片段数量不一致");
    if (summary.duration_seconds !== undefined && (typeof summary.duration_seconds !== "number" || Math.abs(summary.duration_seconds - duration) > 0.05)) throw new Error("分析总时长与原视频实际时长不一致");
    let previousEnd = 0;
    const ids = new Set<string>();
    const originalAudio: string[] = [];
    const segments = rows.map((rawRow, index) => {
        const row = object(rawRow);
        const start = row.start;
        const end = row.end;
        if (typeof start !== "number" || typeof end !== "number" || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end - start > 10.02 || end > duration + 0.05 || Math.abs(start - previousEnd) > 0.05)
            throw new Error(`片段 ${index + 1} 的时间必须连续且不超过 10 秒`);
        if (row.duration !== undefined && (typeof row.duration !== "number" || Math.abs(row.duration - (end - start)) > 0.05)) throw new Error(`片段 ${index + 1} 的 duration 与起止时间不一致`);
        const nested = row.person_info !== undefined || row.audio_judgement !== undefined;
        const person = object(row.person_info);
        const audio = object(row.audio_judgement);
        const people = Array.isArray(person.person_list) ? person.person_list.map(object) : [];
        const personCount = nested ? person.person_count : row.personCount;
        const hasFace = nested ? people.some((item) => ["face", "upper_body", "full_body"].includes(String(item.visible_range))) : row.hasFace;
        const speaking = nested ? people.some((item) => item.mouth_visible === true && item.mouth_movement_status === "speaking") : row.speaking;
        const needsSecondCheck = nested ? audio.needs_second_check : row.needsSecondCheck;
        const rawAudio = nested ? audio.audio_strategy : row.audioStrategy;
        const description = nested
            ? [row.scene_description, row.main_action, ...(Array.isArray(row.action_sequence) ? row.action_sequence : [])].filter((item): item is string => typeof item === "string" && Boolean(item.trim())).join("\n").trim()
            : typeof row.description === "string" ? row.description.trim() : "";
        if (!description || description.length > 12000 || typeof hasFace !== "boolean" || typeof speaking !== "boolean" || !Number.isInteger(personCount) || Number(personCount) < 0 || Number(personCount) > 20 || typeof needsSecondCheck !== "boolean" || (nested && (!Array.isArray(person.person_list) || people.length !== personCount || typeof audio.needs_lip_sync !== "boolean")))
            throw new Error(`片段 ${index + 1} 的画面和口型分析不完整`);
        if (rawAudio !== "keep_audio" && rawAudio !== "preserve_audio" && rawAudio !== "remove_audio") throw new Error(`片段 ${index + 1} 缺少有效音频策略`);
        const id = row.segment_id === undefined ? `S${String(index + 1).padStart(2, "0")}` : row.segment_id;
        if (typeof id !== "string" || !/^S\d{1,4}$/.test(id) || ids.has(id)) throw new Error(`片段 ${index + 1} 的编号无效或重复`);
        ids.add(id);
        originalAudio.push(rawAudio === "remove_audio" ? "remove_audio" : "keep_audio");
        const roundedStart = Math.round(previousEnd * 1000) / 1000;
        const roundedEnd = Math.round((index === rows.length - 1 && Math.abs(end - duration) <= 0.05 ? duration : end) * 1000) / 1000;
        if (roundedEnd <= roundedStart || roundedEnd - roundedStart > 10.0001) throw new Error(`片段 ${index + 1} 校正后的时长超过 10 秒`);
        previousEnd = roundedEnd;
        return {
            id, start: roundedStart, end: roundedEnd,
            duration: Math.round((roundedEnd - roundedStart) * 1000) / 1000,
            description, hasFace, speaking, personCount: Number(personCount), needsSecondCheck,
            // 自动模式执行上游最终音频策略，显式覆盖选项单独处理。
            audioStrategy: audioMode === "silent" ? "remove_audio" : audioMode === "source" ? "preserve_audio" : rawAudio === "remove_audio" ? "remove_audio" : "preserve_audio",
            needsLipSync: nested ? audio.needs_lip_sync as boolean : speaking,
            audioStrategyReason: typeof audio.audio_strategy_reason === "string" ? audio.audio_strategy_reason : undefined,
            secondCheckReason: typeof audio.second_check_reason === "string" ? audio.second_check_reason : undefined,
            riskNotes: Array.isArray(row.segment_risk_notes) ? row.segment_risk_notes.filter((item): item is string => typeof item === "string") : undefined,
            productVisible: typeof object(row.product_info).product_visible === "boolean" ? object(row.product_info).product_visible as boolean : undefined,
            prompt: "", promptZh: "", video: { status: "idle", attemptNo: 0 },
        } as OmniSegment;
    });
    if (Math.abs(previousEnd - duration) > 0.05) throw new Error("分析片段没有覆盖完整视频结尾");
    const counts = object(summary.audio_summary);
    const expected = { speaking_segments_count: originalAudio.filter((value) => value === "keep_audio").length, silent_segments_count: originalAudio.filter((value) => value === "remove_audio").length, needs_second_check_count: segments.filter((segment) => segment.needsSecondCheck).length };
    for (const key of Object.keys(expected) as Array<keyof typeof expected>) if (counts[key] !== undefined && counts[key] !== expected[key]) throw new Error("分析音频统计与实际片段不一致");
    return { summary: typeof summary.overall_scene === "string" ? summary.overall_scene.slice(0, 10000) : typeof payload.summary === "string" ? payload.summary.slice(0, 10000) : "", segments };
}
