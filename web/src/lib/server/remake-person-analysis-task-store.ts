import { nanoid } from "nanoid";

import { scheduleGenerationTask } from "@/lib/server/generation-task-scheduler";
import { createStoredGenerationTask, getStoredGenerationTask, queryStoredGenerationTasks, transitionStoredGenerationTask } from "@/lib/server/generation-task-store";

export type RemakeAnalysisTaskStatus = "pending" | "running" | "success" | "error";
export type RemakeAnalysisTaskStage = "queued" | "preparing" | "transcoding" | "video-understanding" | "extracting" | "analyzing" | "contact-sheets" | "copy-planning" | "saving" | "completed" | "failed";

export type RemakeAnalysisTask = {
    id: string;
    userId: string;
    projectId: string;
    runId: string;
    status: RemakeAnalysisTaskStatus;
    stage: RemakeAnalysisTaskStage;
    progress: number;
    attemptNo: number;
    clientRequestId: string;
    error?: string;
    warning?: string;
    createdAt: number;
    updatedAt: number;
};

export type PublicRemakeAnalysisTask = Omit<RemakeAnalysisTask, "userId" | "clientRequestId">;

const TASK_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

export async function createRemakeAnalysisTask(input: { userId: string; projectId: string; attemptNo?: number }) {
    const now = Date.now();
    const id = `remake-person-analysis-${nanoid()}`;
    const task: RemakeAnalysisTask = {
        id,
        userId: input.userId,
        projectId: input.projectId,
        runId: `remake-person-run-${nanoid()}`,
        status: "pending",
        stage: "queued",
        progress: 0,
        attemptNo: Math.max(0, Math.floor(Number(input.attemptNo) || 0)),
        clientRequestId: id,
        createdAt: now,
        updatedAt: now,
    };
    return createStoredGenerationTask("remake", task, TASK_TTL_MS);
}

export async function queueRemakeAnalysisTask(task: RemakeAnalysisTask) {
    await scheduleGenerationTask("remake", task.id, { executionPhase: "created", nextPollAt: Date.now(), lastUpstreamStatus: "queued" });
    return task;
}

export async function getRemakeAnalysisTask(id: string) {
    if (!id.startsWith("remake-person-analysis-")) return null;
    return getStoredGenerationTask<RemakeAnalysisTask>("remake", id);
}

export async function getRemakeAnalysisTaskForUser(userId: string, id: string) {
    const task = await getRemakeAnalysisTask(id);
    return task?.userId === userId ? task : null;
}

export async function findActiveRemakeAnalysisTask(userId: string, projectId: string) {
    const tasks = await queryStoredGenerationTasks<RemakeAnalysisTask>("remake", { userId, projectId, statuses: ["pending", "running"], limit: 1 });
    return tasks[0] || null;
}

export async function markRemakeAnalysisTaskRunning(task: RemakeAnalysisTask) {
    return transitionStoredGenerationTask<RemakeAnalysisTask>("remake", task.id, task.userId, ["pending", "running"], { status: "running", stage: "preparing", progress: Math.max(1, task.progress), error: undefined }, TASK_TTL_MS);
}

export async function updateRemakeAnalysisTaskProgress(task: Pick<RemakeAnalysisTask, "id" | "userId">, patch: { stage: RemakeAnalysisTaskStage; progress: number; warning?: string }) {
    return transitionStoredGenerationTask<RemakeAnalysisTask>("remake", task.id, task.userId, ["running"], { status: "running", stage: patch.stage, progress: clampProgress(patch.progress), warning: patch.warning }, TASK_TTL_MS);
}

export async function completeRemakeAnalysisTask(task: Pick<RemakeAnalysisTask, "id" | "userId">, warning?: string) {
    return transitionStoredGenerationTask<RemakeAnalysisTask>("remake", task.id, task.userId, ["pending", "running"], { status: "success", stage: "completed", progress: 100, error: undefined, warning }, TASK_TTL_MS);
}

export async function failRemakeAnalysisTask(task: Pick<RemakeAnalysisTask, "id" | "userId">, error: string) {
    return transitionStoredGenerationTask<RemakeAnalysisTask>("remake", task.id, task.userId, ["pending", "running"], { status: "error", stage: "failed", error: error.trim().slice(0, 500) || "视频分析失败" }, TASK_TTL_MS);
}

export function publicRemakeAnalysisTask(task: RemakeAnalysisTask): PublicRemakeAnalysisTask {
    const { userId, clientRequestId, ...publicTask } = task;
    void userId;
    void clientRequestId;
    return publicTask;
}

function clampProgress(value: number) {
    return Math.max(0, Math.min(100, Math.floor(Number(value) || 0)));
}
