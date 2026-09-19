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

describe("36-second video analysis in the original prompt format", () => {
    function originalAnalysis(count = 48) {
        return Array.from({ length: count }, (_, index) => [
            `分镜${index + 1}:`,
            `时间: "0:${(index * 0.75).toFixed(3)}-0:${((index + 1) * 0.75).toFixed(3)}"`,
            '字幕: "-"',
            '卖点: "产品外观"',
            '镜头类型: "产品特写"',
            '画面描述: "特写镜头，牙膏位于桌面中心。"',
            '人物占比: "-"',
            '是否包含人脸: "否"',
        ].join("\n")).join("\n\n");
    }

    it("keeps all 48 subsecond shots within the actual 36 seconds", () => {
        const result = parseVideoUnderstanding(originalAnalysis(), 36_000);
        expect(result.frames).toHaveLength(48);
        expect(result.frames.every((frame) => frame.endTime - frame.time === 0.75)).toBe(true);
        expect(result.frames[0].time).toBe(0);
        expect(result.frames.at(-1)?.endTime).toBe(36);
        expect(buildDoubaoVideoUnderstandingPrompt(36_000)).toBe(REMAKE_FEISHU_ANALYSIS_PROMPT);
    });

    it.each(["heading", "bold", "underline", "code-fence", "crlf"])("accepts %s presentation without changing the shot content", (style) => {
        let raw = originalAnalysis();
        if (style === "heading") raw = raw.replace(/^分镜(\d+):/gm, "### 分镜 $1");
        if (style === "bold") raw = raw.replace(/^分镜(\d+):/gm, "**分镜$1：**").replace(/^(时间|字幕|卖点|镜头类型|画面描述|人物占比|是否包含人脸):/gm, "- **$1：**");
        if (style === "underline") raw = raw.replace(/^分镜(\d+):/gm, "__分镜$1__").replace(/^(时间|字幕|卖点|镜头类型|画面描述|人物占比|是否包含人脸):/gm, "__$1__：");
        if (style === "code-fence") raw = `\`\`\`text\n${raw}\n\`\`\``;
        if (style === "crlf") raw = raw.replaceAll("\n", "\r\n");
        expect(parseVideoUnderstanding(raw, 36_000).frames).toEqual(parseVideoUnderstanding(originalAnalysis(), 36_000).frames);
    });

    it("accepts decimal seconds with Chinese punctuation and units", () => {
        const raw = originalAnalysis().replace(/0:(\d+\.\d+)/g, "0：$1秒");
        expect(parseVideoUnderstanding(raw, 36_000).frames.at(-1)?.endTime).toBe(36);
    });

    it("reports the actual shot count instead of blaming JSON", () => {
        expect(() => parseVideoUnderstanding(originalAnalysis(36), 36_000)).toThrow("返回了 36 个分镜");
        expect(() => parseVideoUnderstanding("该视频时长不足60秒。", 36_000)).toThrow("返回了 0 个分镜");
    });

    it("identifies a missing field and its shot", () => {
        const raw = originalAnalysis().replace('画面描述: "特写镜头，牙膏位于桌面中心。"\n', "");
        expect(() => parseVideoUnderstanding(raw, 36_000)).toThrow("分镜1缺少「画面描述」字段");
    });

    it("does not consume the next field as an empty subtitle", () => {
        const raw = originalAnalysis().replace('字幕: "-"', "字幕:");
        expect(parseVideoUnderstanding(raw, 36_000).frames[0]).toMatchObject({ subtitle: "", sellingPoint: "产品外观" });
    });

    it("rejects timecodes beyond 36 seconds instead of extending the source", () => {
        const raw = originalAnalysis().replace('0:35.250-0:36.000', '0:35.250-1:00.000');
        expect(() => parseVideoUnderstanding(raw, 36_000)).toThrow("视频时长 36 秒");
    });

    it("accepts fenced legacy JSON with optional sourceCopy and diagnoses malformed JSON separately", () => {
        const payload = videoAnalysis();
        payload.frames.forEach((frame, index) => { frame.startTime = index * 0.75; frame.endTime = (index + 1) * 0.75; });
        const raw = JSON.stringify({ frames: payload.frames });
        expect(parseVideoUnderstanding(`\`\`\`json\n${raw}\n\`\`\``, 36_000)).toMatchObject({ sourceCopy: "" });
        expect(() => parseVideoUnderstanding('{"frames":', 36_000)).toThrow("JSON 格式不完整");
        expect(() => parseVideoUnderstanding("[]", 36_000)).toThrow("包含 frames 的对象");
    });
});
