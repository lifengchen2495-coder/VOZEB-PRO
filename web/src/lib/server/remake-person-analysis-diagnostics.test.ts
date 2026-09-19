import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RemakeAnalysisTask } from "./remake-person-analysis-task-store";
import { normalizeRemakeProjectWorkflow, type RemakeProject } from "./remake-person-project-contract";
import { normalizeRemakeProject } from "@/app/(user)/remake-person/remake-contract";

const store = vi.hoisted(() => ({ mutate: vi.fn() }));
vi.mock("./remake-person-project-store", async (importOriginal) => ({
    ...await importOriginal<typeof import("./remake-person-project-store")>(),
    mutateRemakeProject: store.mutate,
}));

import { failRemakeProjectAnalysis, markRemakeProjectAnalysisRunning } from "./remake-person-project-service";

const task: RemakeAnalysisTask = {
    id: "remake-person-analysis-test", projectId: "remake-person-test", userId: "user-test", runId: "run-test",
    status: "running", stage: "video-understanding", progress: 25, attemptNo: 0, clientRequestId: "request-test", createdAt: 1, updatedAt: 1,
};
let project: RemakeProject;

beforeEach(() => {
    project = {
        id: task.projectId, title: "36秒牙膏视频", status: "active", revision: 1, sourceCopy: "", productInfo: "", copyStrategy: "keep", voice: "source",
        analysis: { status: "running", taskId: task.id, runId: task.runId, raw: "旧返回" }, frames: [], copyBlocks: [], createdAt: "2026-09-19", updatedAt: "2026-09-19",
    };
    store.mutate.mockReset().mockImplementation(async (_userId: string, _projectId: string, mutate: (value: RemakeProject) => RemakeProject) => {
        project = mutate(project);
        return project;
    });
});

describe("failed person analysis diagnostics", () => {
    it("persists the actual failure and model response for the owning project", async () => {
        const raw = "\n### 分镜1\n时间：0:00-0:00.750\n";
        await failRemakeProjectAnalysis(task, "模型返回了1个分镜，要求48个", raw);
        expect(store.mutate).toHaveBeenCalledWith(task.userId, task.projectId, expect.any(Function));
        expect(project.analysis).toMatchObject({ status: "error", error: "模型返回了1个分镜，要求48个", raw });
        expect(normalizeRemakeProjectWorkflow(project).analysis.raw).toBe(raw);
    });

    it("does not overwrite a newer analysis with a late failure", async () => {
        project.analysis = { status: "running", taskId: "new-task", runId: "new-run", raw: "新任务返回", transcriptionRaw: "新转录返回" };
        const previous = project;
        await failRemakeProjectAnalysis(task, "旧任务失败", "旧模型返回", "旧转录返回");
        expect(project).toBe(previous);
    });

    it("clears previous response text when starting a new attempt", async () => {
        project.analysis.status = "error";
        project.analysis.transcriptionRaw = "旧转录返回";
        await markRemakeProjectAnalysisRunning(task);
        expect(project.analysis).toMatchObject({ status: "running", raw: "" });
        await failRemakeProjectAnalysis(task, "本次连接失败，未收到返回");
        expect(project.analysis.raw).toBe("");
        expect(project.analysis.transcriptionRaw).toBeUndefined();
    });

    it("bounds the diagnostic text stored on the project", async () => {
        await failRemakeProjectAnalysis(task, "分析不完整", "x".repeat(500_001), "y".repeat(500_001));
        expect(project.analysis.raw).toHaveLength(500_000);
        expect(project.analysis.transcriptionRaw).toHaveLength(500_000);
    });

    it("keeps the failed transcription distinct from the successful shot analysis through to the UI", async () => {
        const raw = "\n分镜1:\n时间: 0:00-0:00.75\n";
        const transcriptionRaw = '\n```json\n{"sourceCopy":"被截断的口播';
        await failRemakeProjectAnalysis(task, "原文案转录未返回完整 JSON", raw, transcriptionRaw);
        const hydrated = normalizeRemakeProjectWorkflow(project);
        const displayed = normalizeRemakeProject(hydrated);
        expect(displayed.analysis).toMatchObject({ status: "error", raw, transcriptionRaw });
        expect(project.sourceCopy).toBe("");
    });
});
