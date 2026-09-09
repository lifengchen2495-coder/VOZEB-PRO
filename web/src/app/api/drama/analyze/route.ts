import { after, NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { readJsonBody } from "@/lib/auth/request";
import { getAuthSettings, isAuthInputError } from "@/lib/auth/store";
import type { DramaAnalyzeBody } from "@/lib/server/drama-analysis-input";
import { createDramaAnalysisTask, DramaAnalysisTaskError, publicDramaAnalysisTask } from "@/lib/server/drama-analysis-task-store";
import { runGenerationTaskRecoveryBatch } from "@/lib/server/generation-task-recovery-service";
import { resolveInternalOrigin } from "@/lib/server/internal-origin";
import { DramaProjectServiceError } from "@/lib/server/drama-project-service";
import { checkRateLimit } from "@/lib/server/security";
import { DramaTextModelError, resolveDramaTextModel } from "@/lib/server/drama-text-model";

export const runtime = "nodejs";

export async function POST(request: Request) {
    const user = await getCurrentUser(request);
    if (!user) return NextResponse.json({ code: 401, data: null, msg: "请先登录" }, { status: 401 });
    if (!(await checkRateLimit(`drama-analyze:${user.id}`, { maxRequests: 10, windowMs: 60_000 })).allowed) return NextResponse.json({ code: 429, data: null, msg: "剧本解析过于频繁，请稍后重试" }, { status: 429 });
    try {
        const body = await readJsonBody<DramaAnalyzeBody>(request, 8 * 1024 * 1024);
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new DramaAnalysisTaskError("分析请求格式无效");
        if (typeof body.requestId !== "string" || !/^[\w:-]{1,150}$/.test(body.requestId)) throw new DramaAnalysisTaskError("请求编号无效");
        if (body.phase !== undefined && body.phase !== "content" && body.phase !== "visual" && body.phase !== "video-prompts") throw new DramaAnalysisTaskError("分析阶段无效");
        for (const key of ["script", "summary", "style", "textModel", "videoModel", "videoPromptInstructions"] as const) {
            if (body[key] !== undefined && typeof body[key] !== "string") throw new DramaAnalysisTaskError("分析文本格式无效");
        }
        if (body.phase !== undefined && body.phase !== "content" && !Array.isArray(body.shots)) throw new DramaAnalysisTaskError("请先完成内容审核");
        if (body.textModel !== undefined) resolveDramaTextModel(await getAuthSettings(), body.textModel);
        const task = await createDramaAnalysisTask(user.id, { operation: "analyze", body: { ...body, requestId: body.requestId } });
        const origin = resolveInternalOrigin(new URL(request.url).origin);
        if (task.status === "pending") after(() => runGenerationTaskRecoveryBatch({ origin, limit: 1, taskIds: [task.id] }));
        return NextResponse.json({ code: 0, data: { task: publicDramaAnalysisTask(task) }, msg: "分析任务已创建" }, { status: 202 });
    } catch (error) {
        if (error instanceof DramaAnalysisTaskError || error instanceof DramaProjectServiceError || error instanceof DramaTextModelError || isAuthInputError(error))
            return NextResponse.json({ code: error.status, data: null, msg: error.message }, { status: error.status });
        throw error;
    }
}
