import { describe, expect, it } from "vitest";
import { REMAKE_FEISHU_ANALYSIS_PROMPT } from "@/lib/remake-person-feishu-prompts";

import { buildDoubaoVideoUnderstandingPrompt, parseVideoUnderstanding } from "./remake-person-analysis-runtime";

function videoAnalysis(endTime: string | number = "0:59.967") {
    return {
        sourceCopy: "原产品口播",
        frames: Array.from({ length: 48 }, (_, index) => ({
            ordinal: index + 1,
            startTime: (index * 1.25) as string | number,
            endTime: index === 47 ? endTime : (((index + 1) * 1.25) as string | number),
            subtitle: "产品字幕",
            sellingPoint: "产品卖点",
            shotType: "近景",
            description: "人物在桌前拿起原产品展示包装",
            subjectRatio: "50%",
            hasFace: true,
        })),
    };
}

describe("person remake video analysis timing", () => {
    it("preserves an exact, complete 48-shot timeline and its analysis", () => {
        const payload = videoAnalysis();
        const result = parseVideoUnderstanding(JSON.stringify(payload), 59_967);

        expect(result.sourceCopy).toBe(payload.sourceCopy);
        expect(result.frames).toHaveLength(48);
        expect(result.frames[0]).toMatchObject({ time: 0, endTime: 1.25 });
        expect(result.frames[47]).toEqual({
            ordinal: 48,
            time: 58.75,
            endTime: 59.967,
            subtitle: "产品字幕",
            sellingPoint: "产品卖点",
            shotType: "近景",
            description: "人物在桌前拿起原产品展示包装",
            subjectRatio: "50%",
            hasFace: true,
        });
    });

    it.each(["0:59.97", "1:00", "0:59.96", 60, "59.970"])("snaps a slightly rounded final timestamp %s to the source duration", (endTime) => {
        const result = parseVideoUnderstanding(JSON.stringify(videoAnalysis(endTime)), 59_967);

        expect(result.frames[47]).toMatchObject({ time: 58.75, endTime: 59.967 });
        expect(result.frames.every((frame, index) => frame.endTime > frame.time && (!index || frame.time === result.frames[index - 1].endTime))).toBe(true);
    });

    it("normalizes millisecond floating point noise before checking the video boundary", () => {
        const result = parseVideoUnderstanding(JSON.stringify(videoAnalysis(59.96700000000001)), 59_967);
        expect(result.frames[47].endTime).toBe(59.967);
    });

    it.each([59.867, 60.067])("accepts the 100 ms tolerance boundary at %s seconds", (endTime) => {
        const result = parseVideoUnderstanding(JSON.stringify(videoAnalysis(endTime)), 59_967);
        expect(result.frames[47].endTime).toBe(59.967);
    });

    it.each([59.866, 60.068])("rejects an ending just outside the tolerance at %s seconds", (endTime) => {
        expect(() => parseVideoUnderstanding(JSON.stringify(videoAnalysis(endTime)), 59_967)).toThrow();
    });

    it("uses the source duration and shot ordinal even for unordered results longer than one minute", () => {
        const payload = videoAnalysis("1:08.02");
        payload.frames.reverse();
        const result = parseVideoUnderstanding(JSON.stringify(payload), 68_017);

        expect(result.frames[0]).toMatchObject({ ordinal: 1, time: 0 });
        expect(result.frames[47]).toMatchObject({ ordinal: 48, endTime: 68.017 });
    });

    it.each(["1:01", "0:59", "invalid", -1, "0:58.75"])("rejects a genuinely invalid final timestamp %s", (endTime) => {
        expect(() => parseVideoUnderstanding(JSON.stringify(videoAnalysis(endTime)), 59_967)).toThrow();
    });

    it.each([1.24, 1.26])("still rejects internal gaps or overlaps at %s seconds", (startTime) => {
        const payload = videoAnalysis();
        payload.frames[1].startTime = startTime;
        expect(() => parseVideoUnderstanding(JSON.stringify(payload), 59_967)).toThrow("连续且无重叠");
    });

    it("rejects an internal shot extending beyond the video", () => {
        const payload = videoAnalysis();
        payload.frames[46].endTime = 60;
        expect(() => parseVideoUnderstanding(JSON.stringify(payload), 59_967)).toThrow("镜头 47 的时间字段不合格");
    });

    it("rejects a final shot starting after the source ends even when its end is within tolerance", () => {
        const payload = videoAnalysis(60);
        payload.frames[47].startTime = 59.98;
        expect(() => parseVideoUnderstanding(JSON.stringify(payload), 59_967)).toThrow("镜头 48");
    });

    it("rejects shots that collapse to zero duration at millisecond precision", () => {
        const payload = videoAnalysis();
        payload.frames[0].endTime = 0.0001;
        payload.frames[1].startTime = 0.0001;
        expect(() => parseVideoUnderstanding(JSON.stringify(payload), 59_967)).toThrow("镜头 1");
    });

    it("still requires all 48 distinct shots", () => {
        const payload = videoAnalysis();
        payload.frames[47].ordinal = 47;
        expect(() => parseVideoUnderstanding(JSON.stringify(payload), 59_967)).toThrow("重复或无效的镜头编号");
        payload.frames.pop();
        expect(() => parseVideoUnderstanding(JSON.stringify(payload), 59_967)).toThrow("48 条镜头分析");
    });

    it("sends the archived prompt without timestamp or JSON instructions", () => {
        expect(buildDoubaoVideoUnderstandingPrompt(59_967)).toBe(REMAKE_FEISHU_ANALYSIS_PROMPT);
    });
});
