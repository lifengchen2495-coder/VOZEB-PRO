import { createHash } from "node:crypto";

import type { DramaAnalysisTask, DramaAnalysisTaskStatus } from "@/lib/drama-analysis-task-contract";
import type { DramaWorkflowRequest } from "@/lib/drama-workflow-request";
import type { DramaAnalyzeBody } from "@/lib/server/drama-analysis-input";
import { getDramaProjectForUser } from "@/lib/server/drama-project-service";
import { createStoredGenerationTask, getStoredGenerationTask, transitionStoredGenerationTask } from "@/lib/server/generation-task-store";
import { scheduleGenerationTask } from "@/lib/server/generation-task-scheduler";
import { GENERATION_TASK_RETENTION_MS } from "@/lib/server/generation-task-retention";

export type DramaAnalysisTaskInput =
    | { operation: "workflow"; projectId: string; body: (Omit<Extract<DramaWorkflowRequest, { action: "generate" | "save" }>, "action"> & { action: "generate" }) | Extract<DramaWorkflowRequest, { action: "analyze" }> }
    | { operation: "analyze"; body: DramaAnalyzeBody & { requestId: string } };

export type StoredDramaAnalysisTask = DramaAnalysisTask & {
    userId: string;
    surface: "drama";
    projectId?: string;
    clientRequestId: string;
    attemptNo: number;
    inputHash: string;
    input: DramaAnalysisTaskInput;
    executionStartedAt?: number;
};

export class DramaAnalysisTaskError extends Error {
    constructor(
        message: string,
        readonly status = 400,
    ) {
        super(message);
    }
}

export async function createDramaAnalysisTask(userId: string, input: DramaAnalysisTaskInput): Promise<StoredDramaAnalysisTask> {
    const requestId = input.body.requestId;
    if (typeof requestId !== "string" || !/^[\w:-]{1,150}$/.test(requestId)) throw new DramaAnalysisTaskError("请求编号无效");
    const projectId = input.operation === "workflow" ? input.projectId : input.body.projectId;
    if (projectId !== undefined && (typeof projectId !== "string" || !projectId.trim() || projectId.length > 160)) throw new DramaAnalysisTaskError("短剧项目编号无效");
    if (projectId) await getDramaProjectForUser(userId, projectId);
    const serialized = JSON.stringify(canonical(input));
    if (Buffer.byteLength(serialized, "utf8") > (input.operation === "analyze" ? 8 : 2) * 1024 * 1024) throw new DramaAnalysisTaskError("分析输入过大，请精简后重试");
    const inputHash = hash(serialized);
    const now = Date.now();
    // 请求身份不包含正文，同一编号的不同正文必须冲突，不能各自启动付费任务。
    const task = await createStoredGenerationTask<StoredDramaAnalysisTask>(
        "drama",
        {
            id: `drama-analysis-${hash(JSON.stringify([userId, requestId])).slice(0, 40)}`,
            userId,
            surface: "drama",
            ...(projectId ? { projectId } : {}),
            clientRequestId: requestId,
            attemptNo: 0,
            inputHash,
            input: JSON.parse(serialized) as DramaAnalysisTaskInput,
            status: "pending",
            createdAt: now,
            updatedAt: now,
        },
        GENERATION_TASK_RETENTION_MS,
    );
    if (task.userId !== userId || task.inputHash !== inputHash) throw new DramaAnalysisTaskError("请求编号已用于不同分析内容，请重新发起分析", 409);
    // 重复提交可以补齐创建后尚未排期的任务，但不重置正在执行或已经完成的任务。
    if (task.status === "pending") await scheduleGenerationTask("drama", task.id, { executionPhase: "created", nextPollAt: Date.now(), lastUpstreamStatus: "queued" }, { onlyIfUnscheduled: true });
    return task;
}

export function getDramaAnalysisTask(id: string) {
    return getStoredGenerationTask<StoredDramaAnalysisTask>("drama", id);
}

export async function getDramaAnalysisTaskForUser(userId: string, id: string) {
    const task = await getDramaAnalysisTask(id);
    return task?.userId === userId ? task : null;
}

export function transitionDramaAnalysisTask(
    task: Pick<StoredDramaAnalysisTask, "id" | "userId">,
    allowedStatuses: DramaAnalysisTaskStatus[],
    patch: Partial<Pick<StoredDramaAnalysisTask, "result" | "error" | "executionStartedAt">> & { status: DramaAnalysisTaskStatus },
) {
    return transitionStoredGenerationTask<StoredDramaAnalysisTask>("drama", task.id, task.userId, allowedStatuses, patch, GENERATION_TASK_RETENTION_MS);
}

export function publicDramaAnalysisTask(task: StoredDramaAnalysisTask): DramaAnalysisTask {
    return { id: task.id, status: task.status, ...(task.status === "success" ? { result: task.result } : {}), ...(task.error ? { error: task.error } : {}), createdAt: task.createdAt, updatedAt: task.updatedAt };
}

function hash(value: string) {
    return createHash("sha256").update(value).digest("hex");
}

function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object")
        return Object.fromEntries(
            Object.entries(value)
                .filter(([, item]) => item !== undefined)
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([key, item]) => [key, canonical(item)]),
        );
    return value;
}
