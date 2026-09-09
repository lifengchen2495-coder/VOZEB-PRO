import { after, NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { getAuthSettings } from "@/lib/auth/store";
import { readJsonBodyResult } from "@/lib/auth/request";
import { DramaWorkflowError } from "@/lib/drama-workflow";
import { DramaProjectServiceError } from "@/lib/server/drama-project-service";
import { DramaProjectStoreError } from "@/lib/server/drama-project-store";
import { createDramaAnalysisTask, DramaAnalysisTaskError, publicDramaAnalysisTask } from "@/lib/server/drama-analysis-task-store";
import { runGenerationTaskRecoveryBatch } from "@/lib/server/generation-task-recovery-service";
import { resolveInternalOrigin } from "@/lib/server/internal-origin";
import { parseDramaWorkflowRequest, runDramaWorkflowAction } from "@/lib/server/drama-workflow-service";
import { checkRateLimit } from "@/lib/server/security";
import { TextPlanningRequestError } from "@/lib/server/text-planning-runtime";
import { DramaTextModelError, resolveDramaTextModel } from "@/lib/server/drama-text-model";

export const maxDuration = 300;

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
    const user = await getCurrentUser(request);
    if (!user) return NextResponse.json({ code: 401, data: null, msg: "请先登录" }, { status: 401 });
    const parsed = await readJsonBodyResult<unknown>(request, 2 * 1024 * 1024);
    if (!parsed.ok) return NextResponse.json({ code: parsed.status, data: null, msg: parsed.message }, { status: parsed.status });
    try {
        const input = parseDramaWorkflowRequest(parsed.data);
        if ((input.action === "generate" || input.action === "analyze") && !(await checkRateLimit(`drama-workflow:${user.id}`, { maxRequests: 10, windowMs: 60000 })).allowed)
            return NextResponse.json({ code: 429, data: null, msg: "创作请求过于频繁，请稍后重试" }, { status: 429 });
        const projectId = (await context.params).id;
        if (input.action === "generate" || input.action === "analyze") {
            if (input.textModel !== undefined) resolveDramaTextModel(await getAuthSettings(), input.textModel);
            const body = input.action === "analyze" ? input : { ...input, action: "generate" as const };
            const task = await createDramaAnalysisTask(user.id, { operation: "workflow", projectId, body });
            const origin = resolveInternalOrigin(new URL(request.url).origin);
            if (task.status === "pending") after(() => runGenerationTaskRecoveryBatch({ origin, limit: 1, taskIds: [task.id] }));
            return NextResponse.json({ code: 0, data: { task: publicDramaAnalysisTask(task) }, msg: "分析任务已创建" }, { status: 202 });
        }
        const result = await runDramaWorkflowAction(user.id, projectId, input, async () => {
            throw new DramaWorkflowError("创作操作无效");
        });
        const headers = new Headers();
        const points = result.headers?.get("x-vozeb-pro-points-remaining");
        if (points) headers.set("x-vozeb-pro-points-remaining", points);
        const msg = result.artifact.status === "adopted" ? (result.artifact.intent === "analysis" ? "分析结果已更新" : "已采用") : result.artifact.intent === "analysis" ? "原稿或分析结果已更新，本次结果已保留为待核对稿" : "候选稿已保存";
        return NextResponse.json({ code: 0, data: { project: result.project, artifact: result.artifact }, msg }, { headers });
    } catch (error) {
        if (
            error instanceof DramaTextModelError ||
            error instanceof DramaAnalysisTaskError ||
            error instanceof DramaWorkflowError ||
            error instanceof DramaProjectServiceError ||
            error instanceof DramaProjectStoreError ||
            error instanceof TextPlanningRequestError
        )
            return NextResponse.json({ code: error.status, data: null, msg: error.message }, { status: error.status });
        console.error("[drama-workflow] request failed", error);
        return NextResponse.json({ code: 500, data: null, msg: "创作操作失败，请稍后重试" }, { status: 500 });
    }
}
