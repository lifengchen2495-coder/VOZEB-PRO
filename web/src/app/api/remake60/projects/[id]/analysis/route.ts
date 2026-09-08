import { after, NextResponse } from "next/server";

import { readJsonBodyResult } from "@/lib/auth/request";
import { getCurrentUser } from "@/lib/auth/session";
import { runGenerationTaskRecoveryBatch } from "@/lib/server/generation-task-recovery-service";
import { publicRemakeAnalysisTask } from "@/lib/server/remake60-analysis-task-store";
import { resolveInternalOrigin } from "@/lib/server/internal-origin";
import { RemakeProjectServiceError, startRemakeAnalysisForUser } from "@/lib/server/remake60-project-service";

type Context = { params: Promise<{ id: string }> };

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 2_400;

export async function POST(request: Request, context: Context) {
    const user = await getCurrentUser(request);
    if (!user) return NextResponse.json({ code: 401, data: null, msg: "请先登录" }, { status: 401 });
    const parsed = await readJsonBodyResult<{ retry?: boolean }>(request, 16 * 1024);
    if (!parsed.ok) return NextResponse.json({ code: parsed.status, data: null, msg: parsed.message }, { status: parsed.status });
    try {
        const result = await startRemakeAnalysisForUser(user.id, (await context.params).id);
        const origin = resolveInternalOrigin(new URL(request.url).origin);
        const cookie = request.headers.get("cookie") || "";
        after(() => runGenerationTaskRecoveryBatch({ origin, cookie, limit: 1, taskIds: [result.task.id], userRequested: true }));
        return NextResponse.json({ code: 0, data: { project: result.project, task: publicRemakeAnalysisTask(result.task) }, msg: result.reused ? "分析任务已在运行" : "分析任务已创建" }, { status: 202 });
    } catch (error) {
        if (error instanceof RemakeProjectServiceError) return NextResponse.json({ code: error.status, data: null, msg: error.message }, { status: error.status });
        throw error;
    }
}
