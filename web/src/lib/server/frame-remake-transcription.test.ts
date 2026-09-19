import { writeFile } from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedLogicalModel } from "./logical-model-router";

const requests = vi.hoisted(() => ({ chat: vi.fn(), video: vi.fn() }));
vi.mock("./remake-vision-request", async (importOriginal) => ({
    ...await importOriginal<typeof import("./remake-vision-request")>(),
    requestRemakeVisionPrompt: requests.chat,
}));
vi.mock("./frame-remake-original-gateway", () => ({ requestFrameOriginalText: requests.video }));
vi.mock("./ffmpeg", () => ({
    runFfmpeg: async (args: string[]) => { await writeFile(args.at(-1)!, Buffer.from("test audio")); },
}));

import { FRAME_REMAKE_TRANSCRIPTION_PROMPT, parseFrameRemakeTranscription, requestFrameRemakeTranscription } from "./frame-remake-transcription";
import { RemakeProductionVisionError } from "./remake-vision-request";

const text = '第一句保持原文。\nThe label says "BOP".\n第二句。';
const json = JSON.stringify({ sourceCopy: text });

describe("transcription response parsing", () => {
    it.each([
        json,
        `\uFEFF  ${json}\n`,
        `\`\`\`json\n${json}\n\`\`\``,
        `\`\`\`JSON\r\n${json}\r\n\`\`\``,
        `\`\`\`\n${json}\n\`\`\``,
        `~~~json\n${json}\n~~~`,
    ])("preserves the exact transcript in a complete response %#", (raw) => {
        expect(parseFrameRemakeTranscription(raw)).toEqual({ status: "transcribed", text });
    });

    it("accepts explicitly reported no speech", () => {
        expect(parseFrameRemakeTranscription('```json\n{"sourceCopy":""}\n```')).toEqual({ status: "no-speech", text: "" });
    });

    it("parses the actual toothpaste response with literal newlines inside the JSON string", () => {
        const transcript = `我买它不是
因为它能去嘴臭，也不是因为它是热巴代言的，实在是因为它太香了，刷一次就能
香24小时。每次刷完crush都忍不住想亲亲。夏天用它刷牙，嘴巴
就像开了空调，冰冰凉凉的。里面还添加了专利溶菌酶爆珠，一刷就
破，变成丰富又绵密的白色泡沫，覆盖到牙齿的角角落落，从根源溶解异
味。再搭配葡萄、蜜桃和柑橘多种口味，刷牙就像喝果汁，嘴巴也
变得香香的。关键现在有活动，到手三支，你看看才多少钱？真的很划算
。经常熬夜、爱吃重口、咖啡奶茶不离手的，一定要试试它。波普是
专研口腔护理的老牌子了，用的更放心。`;
        const raw = `{"sourceCopy":"${transcript}"}`;
        expect(() => JSON.parse(raw)).toThrow();
        expect(parseFrameRemakeTranscription(raw)).toEqual({ status: "transcribed", text: transcript });
    });

    it("preserves literal CRLF and tabs along with correctly escaped quotes, backslashes and newlines", () => {
        const raw = '{\n "sourceCopy": "第一行\r\n第二行\t产品\\"BOP\\"，路径C:\\\\tmp，已有转义\\n结尾"\n}';
        expect(parseFrameRemakeTranscription(raw)).toEqual({ status: "transcribed", text: '第一行\r\n第二行\t产品"BOP"，路径C:\\tmp，已有转义\n结尾' });
    });

    it.each([
        '{"sourceCopy":"第一行\n被截断',
        '{"sourceCopy":"第一行\n被截断"',
        '{"sourceCopy":"第一行\n错误转义\\q"}',
        '{"sourceCopy":"第一行\\\n错误转义"}',
        '{"sourceCopy":"第一行\n未转义的"引号""}',
    ])("does not use newline compatibility to accept other malformed JSON %#", (raw) => {
        expect(() => parseFrameRemakeTranscription(raw)).toThrow("原文案转录未返回完整 JSON");
    });

    it.each([
        "", "无法处理该视频", "没有口播", "未经结构化的口播文字。",
        '{"sourceCopy":"被截断的内容', '```json\n{"sourceCopy":"被截断的内容',
        '```json\n{"sourceCopy":"完整但代码框未结束"}',
        `${json}\n${json}`, `说明文字\n${json}`,
    ])("rejects incomplete or ambiguous output instead of inventing a transcript %#", (raw) => {
        expect(() => parseFrameRemakeTranscription(raw)).toThrow("原文案转录未返回完整 JSON");
    });

    it.each(['[]', 'null', '{}', '{"sourceCopy":null}', '{"sourceCopy":123}', '{"sourceCopy":"口播","extra":true}'])
        ("still validates the transcription fields %#", (raw) => {
            expect(() => parseFrameRemakeTranscription(raw)).toThrow();
        });
});

function input(upstreamModel = "gem-3-pro") {
    return {
        origin: "https://example.test", credential: "", idempotencyKey: "transcription-test",
        candidate: {
            logicalModelId: "audio-model", upstreamModel, channelId: "audio-channel",
            channel: { apiFormat: "openai", apiKey: "test-key", baseUrl: "https://example.test/v1" },
        } as ResolvedLogicalModel,
        video: { type: "video" as const, file_name: "source.mp4", content_type: "video/mp4", file_base64: Buffer.from("test video").toString("base64") },
        onResponse: vi.fn(),
    };
}

beforeEach(() => {
    requests.chat.mockReset();
    requests.video.mockReset();
});

describe("transcription request diagnostics", () => {
    it("requests JSON mode for audio, preserves the prompt, and captures the unmodified response", async () => {
        const raw = `\`\`\`json\n${json}\n\`\`\``;
        requests.chat.mockResolvedValue({ text: raw, headers: new Headers(), elapsedMs: 1 });
        const request = input();
        const result = await requestFrameRemakeTranscription(request);
        expect(result).toMatchObject({ status: "transcribed", text });
        expect(request.onResponse).toHaveBeenCalledWith(raw);
        expect(requests.chat).toHaveBeenCalledWith(expect.objectContaining({
            jsonMode: true, stream: false,
            messages: [{ role: "user", content: FRAME_REMAKE_TRANSCRIPTION_PROMPT }],
        }));
    });

    it("retains the failed response and billing headers for diagnostics and refunds", async () => {
        const raw = '{"sourceCopy":"被截断';
        const headers = new Headers({ "x-test-billing": "preserved" });
        requests.chat.mockResolvedValue({ text: raw, headers, elapsedMs: 1 });
        const request = input();
        const error = await requestFrameRemakeTranscription(request).catch((value: unknown) => value);
        expect(error).toBeInstanceOf(RemakeProductionVisionError);
        expect(error).toMatchObject({ responseHeaders: headers, status: 502 });
        expect(request.onResponse).toHaveBeenCalledExactlyOnceWith(raw);
    });

    it("accepts a literal newline response from the audio model without altering the raw diagnostic", async () => {
        const raw = '{"sourceCopy":"我买它不是\n因为它能去嘴臭。"}';
        requests.chat.mockResolvedValue({ text: raw, headers: new Headers(), elapsedMs: 1 });
        const request = input();
        expect(await requestFrameRemakeTranscription(request)).toMatchObject({ status: "transcribed", text: "我买它不是\n因为它能去嘴臭。" });
        expect(request.onResponse).toHaveBeenCalledExactlyOnceWith(raw);
    });

    it("also parses and captures fenced transcription from the video-audio route", async () => {
        const raw = `\`\`\`json\n${json}\n\`\`\``;
        requests.video.mockResolvedValue({ text: raw, headers: new Headers(), elapsedMs: 1 });
        const request = input("doubao-seed-2-0-lite-260428");
        expect(await requestFrameRemakeTranscription(request)).toMatchObject({ status: "transcribed", text });
        expect(request.onResponse).toHaveBeenCalledExactlyOnceWith(raw);
        expect(requests.video).toHaveBeenCalledWith(expect.objectContaining({ prompt: FRAME_REMAKE_TRANSCRIPTION_PROMPT }));
        expect(requests.chat).not.toHaveBeenCalled();
    });
});
