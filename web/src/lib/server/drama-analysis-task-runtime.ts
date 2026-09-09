import { executeDramaAnalyze } from "@/lib/server/drama-analyze-execution";
import { getDramaAnalysisTask, transitionDramaAnalysisTask, type StoredDramaAnalysisTask } from "@/lib/server/drama-analysis-task-store";
import { generateDramaWorkflowData } from "@/lib/server/drama-workflow-generation";
import { runDramaWorkflowAction } from "@/lib/server/drama-workflow-service";
import { toSafeGenerationErrorMessage } from "@/lib/server/generation-errors";
import { resolveInternalOrigin } from "@/lib/server/internal-origin";
import { maintenanceWorkerHeaders } from "@/lib/server/maintenance-auth";
import { getStoredGenerationTaskRecord } from "@/lib/server/generation-task-store";
import { scheduleGenerationTask } from "@/lib/server/generation-task-scheduler";

export async function runDramaAnalysisTask(input: { task: StoredDramaAnalysisTask; origin: string }): Promise<"completed" | "failed" | "pending"> {
    const current = await getDramaAnalysisTask(input.task.id);
    if (!current || current.userId !== input.task.userId || current.inputHash !== input.task.inputHash) return "failed";
    if (current.status === "success") return "completed";
    if (current.status === "error" || current.status === "cancelled") return "failed";
    const stored = await getStoredGenerationTaskRecord("drama", current.id);
    if (stored?.executionPhase === "result_ready" && stored.resultPayload && "result" in stored.resultPayload) return persistDramaResult(current, stored.resultPayload.result, true);
    // 租约被接管时无法判断同步文本调用是否已计费，保留明确失败，绝不盲目重跑。
    if (current.status === "running" || current.executionStartedAt) {
        await transitionDramaAnalysisTask(current, ["pending", "running"], { status: "error", error: "分析执行曾中断，无法确认上游结果，未自动重复调用。请检查已保存结果后手动重新分析。" });
        return "failed";
    }
    const task = await transitionDramaAnalysisTask(current, ["pending"], { status: "running", executionStartedAt: Date.now(), error: undefined });
    if (!task) return "failed";
    try {
        const origin = resolveInternalOrigin(input.origin);
        const headers = new Headers(maintenanceWorkerHeaders(task.userId));
        headers.set("content-type", "application/json");
        const request = new Request(`${origin}/api/drama/analyze`, { method: "POST", headers });
        let result: unknown;
        if (task.input.operation === "workflow") {
            const body = task.input.body;
            const completed = await runDramaWorkflowAction(task.userId, task.input.projectId, body, (project, requestId) =>
                generateDramaWorkflowData({ request, userId: task.userId, project, ...body, intent: body.action === "analyze" ? "analysis" : body.intent, requestId }),
            );
            result = { project: completed.project, artifact: completed.artifact };
        } else {
            const response = await executeDramaAnalyze(request, task.userId, task.input.body);
            const payload = (await response.json()) as { data?: unknown; msg?: string };
            if (!response.ok || payload.data === undefined || payload.data === null) throw new Error(payload.msg || "剧本分析失败，请重试");
            result = payload.data;
        }
        return await persistDramaResult(task, result);
    } catch (error) {
        await transitionDramaAnalysisTask(task, ["running"], { status: "error", error: toSafeGenerationErrorMessage(error, "剧本分析失败，请重试").slice(0, 1000) });
        return "failed";
    }
}

async function persistDramaResult(task: StoredDramaAnalysisTask, result: unknown, hasCheckpoint = false): Promise<"completed" | "failed" | "pending"> {
    let checkpoint = hasCheckpoint;
    if (!checkpoint) {
        try {
            const saved = await retryPersistence(() => scheduleGenerationTask("drama", task.id, { executionPhase: "result_ready", nextPollAt: Date.now(), resultPayload: { result }, lastUpstreamStatus: "result_ready" }));
            checkpoint = saved?.executionPhase === "result_ready" && saved.resultPayload !== undefined && "result" in saved.resultPayload;
        } catch {
            // 检查点写入暂时失败时，仍尝试直接保存终态，整个过程不再调用模型。
        }
    }
    try {
        const completed = await retryPersistence(() => transitionDramaAnalysisTask(task, ["pending", "running"], { status: "success", result, error: undefined }));
        return completed?.status === "success" ? "completed" : "failed";
    } catch {
        if (checkpoint) return "pending";
        throw new Error("模型已完成分析，但结果保存失败，未自动重复调用。请检查已保存结果后手动重试。");
    }
}

async function retryPersistence<T>(write: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
        try {
            return await write();
        } catch (error) {
            if (attempt >= 2) throw error;
            await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
        }
    }
}
