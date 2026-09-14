import { writeFile } from "node:fs/promises";
import sharp from "sharp";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { SystemModelChannel } from "@/lib/auth/store";
import { createBangbangProject, type BangbangMedia, type BangbangStep } from "@/lib/bangbang-contract";
import { emptyAdvancedConfig } from "@/lib/channel-protocol-registry";
import { executeBangbangStep } from "./bangbang-runtime";
import { toSafeGenerationErrorMessage } from "./generation-errors";
import { resolveLogicalModelCandidates } from "./logical-model-router";
import { requestRemakeVisionPrompt } from "./remake-vision-request";

const mocks = vi.hoisted(() => ({ settings: vi.fn(), refund: vi.fn(), fetch: vi.fn(), download: vi.fn() }));
vi.mock("@/lib/auth/store", () => ({ getAuthSettings: mocks.settings, refundUserPoints: mocks.refund }));
vi.mock("./internal-origin", () => ({ fetchInternalApi: mocks.fetch }));
vi.mock("./bangbang-project-service", () => ({ ownedBangbangMedia: async (_user: string, media: BangbangMedia) => media }));
vi.mock("./media-download", () => ({ downloadMediaToFile: mocks.download }));
vi.mock("./local-media-storage", () => ({ deleteUserLocalMediaAssets: vi.fn() }));
vi.mock("./reference-asset-store", () => ({ writePersistentMediaDataUrl: vi.fn() }));
vi.mock("./bangbang-asr", () => ({ probeBangbangVideo: vi.fn(), transcribeBangbangVideo: vi.fn() }));
vi.mock("./bangbang-runtime-video", () => ({ BANGBANG_VIDEO_MODEL: "video-model", requestBangbangFullVideo: vi.fn(), supportsBangbangFullVideo: () => false }));

const MINUTE = 60_000;
const output = {
    text: "完整创作方向及对照",
    directions: [
        { id: "D1", title: "礼物误会（推荐）", description: "围绕产品包装的送礼故事" },
        { id: "D2", title: "收纳任务", description: "围绕产品外观的家庭故事" },
    ],
};
let productImage: Buffer;

beforeAll(async () => {
    productImage = await sharp({ create: { width: 8, height: 8, channels: 3, background: "white" } })
        .png()
        .toBuffer();
});

beforeEach(() => {
    vi.useFakeTimers();
    // Node 的原生 AbortSignal.timeout 不使用被替换的全局计时器。
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(new DOMException("The operation timed out", "TimeoutError")), ms);
        return controller.signal;
    });
    mocks.fetch.mockReset();
    mocks.refund.mockReset().mockResolvedValue(undefined);
    mocks.download.mockImplementation(async (_url: string, path: string) => writeFile(path, productImage));
    configure();
});

afterEach(() => {
    vi.clearAllTimers();
    vi.restoreAllMocks();
    vi.useRealTimers();
});

function configure(timeoutMs?: number, model = "gpt-6") {
    const channel: SystemModelChannel = {
        id: "test-channel",
        name: "Test channel",
        baseUrl: "https://model.invalid",
        apiKey: "test-only",
        apiFormat: "openai",
        models: [model],
        enabled: true,
        advancedConfig: {
            ...emptyAdvancedConfig(),
            protocol: "custom",
            supportsReferenceImage: true,
            createPath: "/v1/chat/completions",
            resultField: "choices[0].message.content",
            requestTemplate: JSON.stringify({ model: "{{model}}", messages: "{{messages}}", reasoning_effort: "xhigh", stream: false }),
        },
    };
    const settings = {
        defaultModels: { textModel: model },
        systemChannels: [channel],
        logicalModels: [{ id: model, name: model, capability: "text" as const, enabled: true, bindings: [{ id: "binding", channelId: channel.id, upstreamModel: model, enabled: true, priority: 1, capabilityProfile: { timeoutMs } }] }],
    };
    mocks.settings.mockResolvedValue(settings);
    return settings;
}

function run(step: BangbangStep = "directions") {
    const project = createBangbangProject("bangbang-timeout-test", "产品创作");
    if (step === "traffic") project.creationMode = "reference";
    project.operation = { id: "operation-test", step, startedAt: new Date().toISOString() };
    if (step === "directions") project.references.product = [{ id: "product", label: "产品", media: { url: "/api/reference-assets/test.png", mimeType: "image/png" } }];
    return executeBangbangStep({ project, userId: "test-user", origin: "http://localhost:3000", credential: "" });
}

function delayedModel(delay: number, options: { waitForHeaders?: boolean; billing?: boolean } = {}) {
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
        started = resolve;
    });
    mocks.fetch.mockImplementation(async (_url: string, init: RequestInit) => {
        const signal = init.signal!;
        const request = JSON.parse(String(init.body));
        started();
        if (options.waitForHeaders)
            await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(resolve, delay);
                signal.addEventListener(
                    "abort",
                    () => {
                        clearTimeout(timer);
                        reject(signal.reason);
                    },
                    { once: true },
                );
            });
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                const encoder = new TextEncoder();
                const enqueue = (value: string) => controller.enqueue(encoder.encode(value));
                const heartbeat = request.stream ? setInterval(() => enqueue(": thinking\n\n"), MINUTE) : undefined;
                if (options.billing) enqueue(`data: ${JSON.stringify({ type: "vozeb.billing", recordId: "charge-test", cost: 7, remaining: 93, status: "settled" })}\n\n`);
                const timer = setTimeout(
                    () => {
                        clearInterval(heartbeat);
                        signal.removeEventListener("abort", abort);
                        const choice = { index: 0, finish_reason: "stop", [request.stream ? "delta" : "message"]: { content: JSON.stringify(output) } };
                        enqueue(request.stream ? `data: ${JSON.stringify({ choices: [choice] })}\n\ndata: [DONE]\n\n` : JSON.stringify({ choices: [choice] }));
                        controller.close();
                    },
                    options.waitForHeaders ? 0 : delay,
                );
                const abort = () => {
                    clearTimeout(timer);
                    clearInterval(heartbeat);
                    controller.error(signal.reason);
                };
                signal.addEventListener("abort", abort, { once: true });
            },
        });
        return new Response(body, {
            headers: {
                "content-type": request.stream ? "text/event-stream" : "application/json",
                ...(options.billing ? { "x-vozeb-pro-billing-mode": "token", "x-vozeb-pro-points-record-id": "charge-test", "x-vozeb-pro-points-cost": "10" } : {}),
            },
        });
    });
    return ready;
}

describe("Bangbang model deadlines", () => {
    it("delivers complete product directions after four minutes without a configured timeout", async () => {
        const ready = delayedModel(4 * MINUTE);
        const pending = run();
        await Promise.race([ready, pending]);
        await vi.advanceTimersByTimeAsync(4 * MINUTE);
        const transaction = await pending;
        await transaction.accept();
        expect(transaction.result).toMatchObject(output);
        const request = JSON.parse(mocks.fetch.mock.calls[0][1].body);
        expect(request).toMatchObject({ model: "gpt-6", stream: true, reasoning_effort: "xhigh" });
        expect(request.messages[1].content).toEqual(expect.arrayContaining([expect.objectContaining({ type: "image_url" })]));
        expect(mocks.fetch).toHaveBeenCalledTimes(1);
        expect(mocks.refund).not.toHaveBeenCalled();
    });

    it("honors an explicit three-minute deadline and refunds the received settlement", async () => {
        configure(3 * MINUTE);
        const ready = delayedModel(4 * MINUTE, { billing: true });
        const failure = run().catch((error: unknown) => error);
        await Promise.race([ready, failure]);
        await vi.advanceTimersByTimeAsync(3 * MINUTE);
        const error = await failure;
        expect(error).toMatchObject({ status: 504, message: expect.stringContaining("180 秒") });
        expect(toSafeGenerationErrorMessage(error, "failed")).toContain("180 秒");
        expect(mocks.refund).toHaveBeenCalledExactlyOnceWith("test-user", "gpt-6", 7, "text", 1, undefined, "charge-test");
        expect(mocks.fetch).toHaveBeenCalledTimes(1);
    });

    it("stops at fifteen minutes even while the upstream keeps sending heartbeats", async () => {
        const ready = delayedModel(16 * MINUTE);
        const failure = run().catch((error: unknown) => error);
        await Promise.race([ready, failure]);
        await vi.advanceTimersByTimeAsync(15 * MINUTE);
        expect(await failure).toMatchObject({ status: 504, message: expect.stringContaining("900 秒") });
        expect(mocks.fetch).toHaveBeenCalledTimes(1);
    });

    it("allows an explicitly configured longer request", async () => {
        configure(20 * MINUTE);
        const ready = delayedModel(16 * MINUTE);
        const pending = run();
        await Promise.race([ready, pending]);
        await vi.advanceTimersByTimeAsync(16 * MINUTE);
        const transaction = await pending;
        await transaction.accept();
        expect(transaction.result.directions).toEqual(output.directions);
    });

    it("keeps the twenty-five-minute operation limit above a longer model deadline", async () => {
        configure(30 * MINUTE);
        const ready = delayedModel(29 * MINUTE);
        const failure = run().catch((error: unknown) => error);
        await Promise.race([ready, failure]);
        await vi.advanceTimersByTimeAsync(25 * MINUTE);
        expect(await failure).toMatchObject({ message: expect.stringContaining("25 分钟") });
    });

    it("also allows slow text-only steps on the structured request path", async () => {
        const settings = configure(undefined, "gpt-5");
        settings.systemChannels[0].advancedConfig = { ...emptyAdvancedConfig(), protocol: "openai" };
        const ready = delayedModel(4 * MINUTE);
        const pending = run("traffic");
        await Promise.race([ready, pending]);
        await vi.advanceTimersByTimeAsync(4 * MINUTE);
        const transaction = await pending;
        await transaction.accept();
        expect(transaction.result.text).toBe(output.text);
        expect(JSON.parse(mocks.fetch.mock.calls[0][1].body).stream).not.toBe(true);
    });
});

describe("vision deadline diagnostics", () => {
    function request(signal?: AbortSignal) {
        const settings = configure();
        const candidate = resolveLogicalModelCandidates(settings, "text", "gpt-6")[0];
        return requestRemakeVisionPrompt({ origin: "http://localhost:3000", cookie: "", candidate, messages: [{ role: "user", content: "生成创意" }], boards: [], allowTextOnly: true, signal });
    }

    it.each([false, true])("retains the three-minute default outside Bangbang (waiting for headers: %s)", async (waitForHeaders) => {
        const ready = delayedModel(4 * MINUTE, { waitForHeaders });
        const failure = request().catch((error: unknown) => error);
        await Promise.race([ready, failure]);
        await vi.advanceTimersByTimeAsync(3 * MINUTE);
        expect(await failure).toMatchObject({ status: 504, message: expect.stringContaining("180 秒") });
    });

    it("reports caller cancellation without mislabeling it as a model timeout", async () => {
        const controller = new AbortController();
        const ready = delayedModel(4 * MINUTE);
        const failure = request(controller.signal).catch((error: unknown) => error);
        await Promise.race([ready, failure]);
        await vi.advanceTimersByTimeAsync(MINUTE);
        controller.abort();
        expect(await failure).toMatchObject({ status: 499, message: expect.stringContaining("取消") });
    });

    it("preserves an upstream gateway 504 instead of claiming the local deadline expired", async () => {
        mocks.fetch.mockResolvedValue(new Response("<html>504 Gateway Time-out</html>", { status: 504 }));
        await expect(request()).rejects.toMatchObject({ status: 504, message: expect.stringContaining("网关等待响应超时（HTTP 504）") });
    });
});
