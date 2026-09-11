import { resolveGenerationReviewReason } from "./generation-task-review-reason";

type RemakeImageTaskRequest = { taskId?: string; status: string; needsReview?: boolean; error?: string };
type RemakeImageTaskExecution = { executionPhase?: string; reviewReason?: string; lastUpstreamStatus?: string; resultPayload?: unknown };

export function resolveRemakeActiveImageTaskState(input: {
    taskId: string;
    requested: RemakeImageTaskRequest;
    execution?: RemakeImageTaskExecution;
}): { status: "running" | "error"; needsReview?: boolean; error?: string } {
    if (input.execution?.executionPhase === "needs_review") {
        return {
            status: "error",
            needsReview: true,
            error: input.execution.reviewReason || resolveGenerationReviewReason(input.execution),
        };
    }
    // 查询暂停只属于原任务，不能让旧任务的错误阻止新的重试。
    if (input.requested.taskId === input.taskId && input.requested.status === "error") {
        return { status: "error", needsReview: true, error: input.requested.error || "图片任务查询已暂停，请检查原任务状态后再继续。" };
    }
    return { status: "running" };
}
