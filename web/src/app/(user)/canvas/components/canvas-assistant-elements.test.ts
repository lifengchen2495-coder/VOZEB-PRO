import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { CanvasNodeType } from "../types";
import { assistantMessageToChatMessage, canvasRunSelectedNodeIds, compactMetadata, compactSnapshot, removeCanvasAssistantSessions } from "./canvas-assistant-elements";

describe("Canvas Agent session deletion", () => {
    const sessions = [
        { id: "active", title: "当前对话", messages: [], createdAt: "2026-08-06T00:00:00.000Z", updatedAt: "2026-08-06T00:00:00.000Z" },
        { id: "history", title: "历史对话", messages: [], createdAt: "2026-08-05T00:00:00.000Z", updatedAt: "2026-08-05T00:00:00.000Z" },
    ];

    it("keeps the current chat when deleting another history entry", () => {
        expect(removeCanvasAssistantSessions(sessions, "active", ["history"])).toMatchObject({ sessions: [{ id: "active" }], activeSessionId: "active" });
    });

    it("selects the next chat when deleting the active entry", () => {
        expect(removeCanvasAssistantSessions(sessions, "active", ["active"])).toMatchObject({ sessions: [{ id: "history" }], activeSessionId: "history" });
    });

    it("keeps a fresh active chat after deleting the final conversation", () => {
        const result = removeCanvasAssistantSessions(
            [
                {
                    id: "only-session",
                    title: "待删除对话",
                    messages: [{ id: "message", role: "user", text: "保留输入区" }],
                    createdAt: "2026-08-06T00:00:00.000Z",
                    updatedAt: "2026-08-06T00:00:00.000Z",
                },
            ],
            "only-session",
            ["only-session"],
        );

        expect(result.sessions).toHaveLength(1);
        expect(result.sessions[0]).toMatchObject({ title: "新对话", messages: [] });
        expect(result.activeSessionId).toBe(result.sessions[0].id);
    });
});

describe("Canvas Agent current-turn references", () => {
    it("maps current-turn references to user message attachments", () => {
        const item = assistantMessageToChatMessage({ id: "message", role: "user", text: "修改颜色", references: [{ id: "reference", type: CanvasNodeType.Image, title: "参考图", dataUrl: "/api/reference-assets/reference.webp" }] });
        expect(item.attachments).toEqual([{ id: "reference", name: "参考图", type: "image", url: "/api/reference-assets/reference.webp" }]);
    });

    it("clears submitted references before creating the backend run", async () => {
        const source = await readFile(resolve(process.cwd(), "src/app/(user)/canvas/components/canvas-assistant-panel.tsx"), "utf8");
        const sendSource = source.slice(source.indexOf("const sendMessage"), source.indexOf("const waitForBackendAgent"));

        expect(sendSource.indexOf("setRemovedReferenceIds")).toBeGreaterThanOrEqual(0);
        expect(sendSource.indexOf("setRemovedReferenceIds")).toBeLessThan(sendSource.indexOf("createCreativeAgentRun"));
    });

    it("uses each Canvas chat's persisted backend conversation identity", async () => {
        const source = await readFile(resolve(process.cwd(), "src/app/(user)/canvas/components/canvas-assistant-panel.tsx"), "utf8");

        expect(source).toContain("conversationId: session.conversationId");
        expect(source).toContain("preferences: generationPreferences.mode ? generationPreferences : undefined");
        expect(source).toContain("<CanvasAgentGenerationSettings preferences={generationPreferences} models={selectedModels} onChange={setGenerationPreferences}");
        expect(source).toContain("controlCreativeAgentRun(run.runId, action, session.conversationId)");
        expect(source).toContain("retryCreativeAgentTask(runId, taskId, session.conversationId)");
        expect(source).toContain("conversationId: run.conversationId");
    });

    it("keeps an uploaded canvas image as a stable Run reference URL", () => {
        expect(
            compactMetadata(CanvasNodeType.Image, {
                content: "/api/reference-assets/permanent/2026/07/28/images/person.png",
                storageKey: "permanent/2026/07/28/images/person.png",
                mimeType: "image/png",
            }),
        ).toMatchObject({ url: "/api/reference-assets/permanent/2026/07/28/images/person.png" });
    });

    it("preserves the generation-media scope instead of rebuilding the image as a reference upload", () => {
        expect(
            compactMetadata(CanvasNodeType.Image, {
                content: "/api/generation-log-assets/permanent/2026/07/28/images/person.png",
                storageKey: "permanent/2026/07/28/images/person.png",
            }),
        ).toMatchObject({ url: "/api/generation-log-assets/permanent/2026/07/28/images/person.png" });
    });

    it("keeps media prompts but never serializes data or blob media bodies", () => {
        const largePayload = `data:image/png;base64,${"canvas-binary-marker".repeat(40_000)}`;
        const large = compactMetadata(CanvasNodeType.Image, { content: largePayload, prompt: "保留人物并改成夜景", status: "success", model: "image-model" });
        const small = compactMetadata(CanvasNodeType.Image, { content: "data:image/png;base64,short", prompt: "保留人物并改成夜景", status: "success", model: "image-model" });

        expect(large).toEqual(small);
        expect(large).toEqual({ content: "保留人物并改成夜景", size: undefined, naturalWidth: undefined, naturalHeight: undefined, url: undefined });
        expect(JSON.stringify(large)).not.toContain("canvas-binary-marker");
        expect(compactMetadata(CanvasNodeType.Video, { content: "blob:http://localhost/video", prompt: "镜头缓慢推进" })).toMatchObject({ content: "镜头缓慢推进", url: undefined });
    });

    it("keeps text and exact config content while removing unused scene fields", () => {
        const snapshot = compactSnapshot({
            projectId: "canvas-one",
            title: "画布",
            imageSize: "1:1",
            nodes: [
                { id: "text", type: CanvasNodeType.Text, title: "文案", position: { x: 120, y: 240 }, width: 320, height: 180, metadata: { content: "完整文本内容", status: "success", model: "text-model" } },
                { id: "config", type: CanvasNodeType.Config, title: "生成配置", position: { x: 480, y: 240 }, width: 340, height: 220, metadata: { composerContent: "生成电影感海报", size: "1824x1024", generationMode: "image" } },
            ],
            connections: [],
            selectedNodeIds: ["text"],
            viewport: { x: 100, y: 200, k: 0.75 },
        });

        expect(snapshot.nodes).toEqual([
            { id: "text", type: CanvasNodeType.Text, title: "文案", width: 320, height: 180, metadata: { content: "完整文本内容", size: undefined, naturalWidth: undefined, naturalHeight: undefined, url: undefined } },
            { id: "config", type: CanvasNodeType.Config, title: "生成配置", width: 340, height: 220, metadata: { content: "生成电影感海报", size: "1824x1024", naturalWidth: undefined, naturalHeight: undefined, url: undefined } },
        ]);
        expect(snapshot).not.toHaveProperty("viewport");
        expect(snapshot.nodes[0]).not.toHaveProperty("position");
        expect(snapshot.nodes[0].metadata).not.toHaveProperty("status");
        expect(snapshot.nodes[0].metadata).not.toHaveProperty("model");
        expect(snapshot.nodes[1].metadata).not.toHaveProperty("generationMode");
    });

    it("keeps the current custom image dimensions in the backend Run snapshot", () => {
        expect(
            compactSnapshot({
                projectId: "canvas-one",
                title: "画布",
                imageSize: "1824x1024",
                nodes: [],
                connections: [],
                selectedNodeIds: [],
                viewport: { x: 0, y: 0, k: 1 },
            }),
        ).toMatchObject({ imageSize: "1824x1024" });
    });

    it("keeps selected config nodes while replacing stale media references", () => {
        const snapshot = {
            projectId: "canvas-one",
            title: "画布",
            nodes: [
                { id: "config", type: CanvasNodeType.Config, title: "生成配置", position: { x: 0, y: 0 }, width: 320, height: 240, metadata: { size: "1824x1024" } },
                { id: "old-image", type: CanvasNodeType.Image, title: "旧参考图", position: { x: 0, y: 0 }, width: 320, height: 240, metadata: { content: "/old.webp" } },
                { id: "current-image", type: CanvasNodeType.Image, title: "本轮参考图", position: { x: 0, y: 0 }, width: 320, height: 240, metadata: { content: "/current.webp" } },
            ],
            connections: [],
            selectedNodeIds: ["config", "old-image"],
            viewport: { x: 0, y: 0, k: 1 },
        };

        expect(canvasRunSelectedNodeIds(snapshot, new Set(["current-image"]))).toEqual(["config", "current-image"]);
    });
});
