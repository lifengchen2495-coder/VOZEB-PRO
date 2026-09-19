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
