import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REMAKE_FEISHU_IMAGE_PROMPT, REMAKE_FEISHU_VIDEO_PROMPTS } from "@/lib/remake-person-feishu-prompts";
import { remakeStoryboardPromptReferences } from "@/lib/remake-person-image-prompt";
import { normalizeRemakeProject } from "@/app/(user)/remake-person/remake-contract";
import { saveRemakeProject } from "@/app/(user)/remake-person/remake-api";
import { remakeGroupReferenceImages, remakeVideoReferenceImages } from "@/app/(user)/remake-person/[id]/remake-production-utils";
import { remakeGroupInputVersion, remakeVideoInputVersion } from "@/app/(user)/remake-person/[id]/remake-workspace-state";
import { remakeProductionInputSnapshot } from "@/lib/remake-person-production-input";
import { normalizeRemakeProjectWorkflow, normalizeRemakeReferences, type HydratedRemakeProject } from "./remake-person-project-contract";

const mocks = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn(), create: vi.fn(), task: vi.fn(), fetchImage: vi.fn() }));
vi.mock("./remake-person-project-store", async (importOriginal) => ({
    ...await importOriginal<typeof import("./remake-person-project-store")>(),
    getRemakeProject: mocks.get, updateRemakeProject: mocks.save, createRemakeProject: mocks.create,
}));
vi.mock("./generation-task-store", async (importOriginal) => ({
    ...await importOriginal<typeof import("./generation-task-store")>(), getStoredGenerationTaskRecord: mocks.task,
}));
vi.mock("./local-media-storage", async (importOriginal) => ({
    ...await importOriginal<typeof import("./local-media-storage")>(), deleteUserLocalMediaAssets: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./remake-production-image-fetch", () => ({ fetchRemakeProductionImage: mocks.fetchImage }));

import { assertRemakeImageGenerationsForUser, createRemakeProjectForUser, updateRemakeProjectForUser } from "./remake-person-project-service";
import { buildRemakeProductionVisualBoards } from "./remake-person-production-vision-runtime";
import { remakeProductionMessages } from "./remake-person-production-prompt";

const asset = (name: string) => ({ url: `/api/reference-assets/${name}.png`, mimeType: "image/png" });
let project: HydratedRemakeProject;

afterEach(() => vi.unstubAllGlobals());

beforeEach(() => {
    vi.clearAllMocks();
    project = normalizeRemakeProjectWorkflow({
        id: "remake-person-product-test", title: "牙膏", status: "active", revision: 1, sourceCopy: "", productInfo: "", copyStrategy: "keep", voice: "source",
        analysis: { status: "completed", mode: "video" }, sourceVideo: { url: "/api/reference-assets/source.mp4", mimeType: "video/mp4" },
        frames: Array.from({ length: 48 }, (_, i) => ({ ordinal: i + 1, time: i * 0.75, endTime: (i + 1) * 0.75, frameUrl: asset(`frame-${i + 1}`).url, analysisStatus: "available", subtitle: "-", sellingPoint: "外观", shotType: "产品特写", description: "手持牙膏", subjectRatio: "仅手部" })),
        copyBlocks: [], references: { background: asset("background") }, createdAt: "2026-09-20", updatedAt: "2026-09-20",
    });
    project.groups = project.groups.map((group) => ({ ...group,
        sourceContactSheet: asset(`source-${group.id}`),
        imageGeneration: { status: "completed", taskId: `image-${group.id}`, prompt: REMAKE_FEISHU_IMAGE_PROMPT, result: { ...asset(`result-${group.id}`), width: 720, height: 1280 } },
        videoPrompt: "旧视频提示词", videoGeneration: { status: "completed", result: { url: "/api/reference-assets/old-video.mp4", mimeType: "video/mp4" } },
    }));
    project.mergedVideo = { url: "/api/reference-assets/merged.mp4", mimeType: "video/mp4" };
    mocks.get.mockImplementation(async () => project);
    mocks.save.mockImplementation(async (_userId, next) => { project = next; return next; });
    mocks.create.mockImplementation(async (_userId, next) => next);
    mocks.task.mockImplementation(async (_kind, id: string) => {
        const group = project.groups.find((item) => item.imageGeneration.taskId === id)!;
        return { attemptNo: 0, payload: {
            id, userId: "user-test", projectId: project.id, generationSlotId: `remake-person:${group.id}:storyboard`,
            status: "success", kind: "edit", config: { size: "9:16", model: "banana-pro" }, prompt: REMAKE_FEISHU_IMAGE_PROMPT,
            references: remakeStoryboardPromptReferences({ frames: project.frames.filter((frame) => group.frameOrdinals.includes(frame.ordinal)).map((frame) => ({ url: frame.frameUrl })), ...project.references }).map(({ asset: image }) => ({ serverUrl: image.url })),
            result: { serverUrl: group.imageGeneration.result!.url, width: 720, height: 1280, mimeType: "image/png" },
        } };
    });
});

describe("original product reference", () => {
    it("accepts a product photo when creating a project while rejecting product replacement instructions", async () => {
        const created = await createRemakeProjectForUser("user-test", { references: { product: asset("product") } });
        expect(created.references?.product).toEqual(asset("product"));
        await expect(createRemakeProjectForUser("user-test", { productInfo: "替换成别的产品" })).rejects.toThrow("不接受产品替换信息");
    });

    it("saves the product photo through the API service and frontend normalization and invalidates old outputs", async () => {
        const previousFrames = project.frames;
        const saved = await updateRemakeProjectForUser("user-test", project.id, { references: { product: asset("product") } });
        const displayed = normalizeRemakeProject(saved);
        expect(displayed.references.product?.url).toBe(asset("product").url);
        expect(saved.references?.background).toEqual(asset("background"));
        expect(saved.analysis.status).toBe("completed");
        expect(saved.frames).toEqual(previousFrames);
        expect(saved.groups?.every((group) => group.sourceContactSheet?.url && group.imageGeneration.status === "idle" && !group.imageGeneration.result && !group.videoPrompt && group.videoGeneration.status === "idle")).toBe(true);
        expect(saved.mergedVideo).toBeUndefined();
    });

    it.each([asset("other-product"), null])("invalidates previously generated images when replacing or removing the product photo %#", async (product) => {
        project.references.product = asset("product");
        const saved = await updateRemakeProjectForUser("user-test", project.id, { references: { product } });
        expect(saved.references?.product?.url).toBe(product?.url);
        expect(saved.groups?.every((group) => group.imageGeneration.status === "idle")).toBe(true);
    });

    it("persists removal from the browser API instead of silently restoring the previous photo", async () => {
        project.references.product = asset("product");
        vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
            const patch = JSON.parse(String(init.body));
            expect(patch.references.product).toBeNull();
            const saved = await updateRemakeProjectForUser("user-test", project.id, patch);
            return Response.json({ code: 0, data: { project: saved } });
        }));
        const saved = await saveRemakeProject(project.id, project.revision, { references: { ...project.references, product: undefined } });
        expect(saved.references.product).toBeUndefined();
        expect(saved.references.background?.url).toBe(asset("background").url);
    });

    it("sends all twelve frames in order plus the product photo, and carries it into video generation", () => {
        project.references.product = asset("product");
        const displayed = normalizeRemakeProject(project);
        const references = remakeGroupReferenceImages(displayed.groups[1], displayed.references, displayed.frames);
        expect(references.map((image) => image.url)).toEqual([...project.frames.slice(12, 24).map((frame) => frame.frameUrl), asset("background").url, asset("product").url]);
        expect(remakeVideoReferenceImages(displayed.groups[1], displayed.references).at(-1)?.url).toBe(asset("product").url);
        expect(normalizeRemakeReferences({}, project.references).product).toEqual(asset("product"));
    });

    it("includes the product in image, video, and production input identities", () => {
        const before = normalizeRemakeProject(project);
        const after = { ...before, references: { ...before.references, product: asset("product") } };
        expect(remakeGroupInputVersion(before.groups[0], before.references)).not.toBe(remakeGroupInputVersion(after.groups[0], after.references));
        expect(remakeVideoInputVersion(before, "1-12")).not.toBe(remakeVideoInputVersion(after, "1-12"));
        expect(remakeProductionInputSnapshot(before)).not.toBe(remakeProductionInputSnapshot(after));
    });

    it("accepts generated results using the saved product photo and rejects results from a different photo", async () => {
        project.references.product = asset("product");
        await expect(assertRemakeImageGenerationsForUser("user-test", project)).resolves.toBeUndefined();
        const changed = { ...project, references: { ...project.references, product: asset("other-product") } };
        await expect(assertRemakeImageGenerationsForUser("user-test", changed)).rejects.toThrow("图片任务输入与当前参考素材不一致");
    });

    it("includes product pixels and their location in the production visual board without editing the original prompt", async () => {
        const photo = await sharp({ create: { width: 720, height: 1280, channels: 3, background: "#00ff00" } }).png().toBuffer();
        const background = await sharp({ create: { width: 720, height: 1280, channels: 3, background: "#ff0000" } }).png().toBuffer();
        mocks.fetchImage.mockImplementation(async (url: string) => new Response(new Uint8Array(new URL(url).pathname === asset("product").url ? photo : background), { headers: { "content-type": "image/png" } }));
        const boards = await buildRemakeProductionVisualBoards({ origin: "https://example.test", cookie: "", background: asset("background"), product: asset("product"), redrawnContactSheets: project.groups.map((group) => ({ groupOrdinal: group.ordinal, frameOrdinals: group.frameOrdinals, asset: group.imageGeneration.result! })) });
        expect(boards[0].layout.at(-1)).toMatchObject({ role: "product", position: "right", provided: true });
        const pixel = await sharp(boards[0].bytes).extract({ left: 1000, top: 350, width: 1, height: 1 }).raw().toBuffer();
        expect(pixel[1]).toBeGreaterThan(240);
        expect(pixel[0]).toBeLessThan(15);
        const messages = remakeProductionMessages({ title: "牙膏", productInfo: "", hasNarration: false, frames: project.frames, copyBlocks: project.copyBlocks, referenceAssets: { product: { available: true }, character: { available: false }, characterSupplement: { available: false }, background: { available: true }, audio: { available: false } }, contactSheets: [], visualBoards: boards }, "1-12");
        expect(messages[0].content).toBe(REMAKE_FEISHU_VIDEO_PROMPTS["1-12"]);
        expect(JSON.parse(messages[1].content)["原产品参考图（可选）"]).toEqual({ available: true });
    });
});
