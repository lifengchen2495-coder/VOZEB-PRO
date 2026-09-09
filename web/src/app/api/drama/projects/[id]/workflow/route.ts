import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { readJsonBodyResult } from "@/lib/auth/request";
import { DramaWorkflowError } from "@/lib/drama-workflow";
import { DramaProjectServiceError } from "@/lib/server/drama-project-service";
import { DramaProjectStoreError } from "@/lib/server/drama-project-store";
import { generateDramaWorkflowData } from "@/lib/server/drama-workflow-generation";
import { parseDramaWorkflowRequest, runDramaWorkflowAction } from "@/lib/server/drama-workflow-service";
import { checkRateLimit } from "@/lib/server/security";
import { TextPlanningRequestError } from "@/lib/server/text-planning-runtime";

export const maxDuration = 300;

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ code: 401, data: null, msg: "请先登录" }, { status: 401 });
    const parsed = await readJsonBodyResult<unknown>(request, 2 * 1024 * 1024);
    if (!parsed.ok) return NextResponse.json({ code: parsed.status, data: null, msg: parsed.message }, { status: parsed.status });
    try {
        const input = parseDramaWorkflowRequest(parsed.data);
        if (input.action === "generate" && !(await checkRateLimit(`drama-workflow:${user.id}`, { maxRequests: 10, windowMs: 60000 })).allowed) return NextResponse.json({ code: 429, data: null, msg: "创作请求过于频繁，请稍后重试" }, { status: 429 });
        const result = await runDramaWorkflowAction(user.id, (await context.params).id, input, (project, requestId) => {
            if (input.action !== "generate") throw new DramaWorkflowError("创作操作无效");
            return generateDramaWorkflowData({ request, userId: user.id, project, ...input, requestId });
        });
        const headers = new Headers();
        const points = result.headers?.get("x-vozeb-pro-points-remaining");
        if (points) headers.set("x-vozeb-pro-points-remaining", points);
        return NextResponse.json({ code: 0, data: { project: result.project, artifact: result.artifact }, msg: input.action === "adopt" ? "已采用" : "候选稿已保存" }, { headers });
    } catch (error) {
        if (error instanceof DramaWorkflowError || error instanceof DramaProjectServiceError || error instanceof DramaProjectStoreError || error instanceof TextPlanningRequestError)
            return NextResponse.json({ code: error.status, data: null, msg: error.message }, { status: error.status });
        console.error("[drama-workflow] request failed", error);
        return NextResponse.json({ code: 500, data: null, msg: "创作操作失败，请稍后重试" }, { status: 500 });
    }
}
