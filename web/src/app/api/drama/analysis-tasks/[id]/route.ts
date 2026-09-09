import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { getDramaAnalysisTaskForUser, publicDramaAnalysisTask } from "@/lib/server/drama-analysis-task-store";
import { pointsResponseHeaders } from "@/lib/server/points-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
    const user = await getCurrentUser(request);
    if (!user) return NextResponse.json({ code: 401, data: null, msg: "请先登录" }, { status: 401 });
    const task = await getDramaAnalysisTaskForUser(user.id, (await context.params).id);
    if (!task) return NextResponse.json({ code: 404, data: null, msg: "分析任务不存在或已过期" }, { status: 404 });
    return NextResponse.json({ code: 0, data: { task: publicDramaAnalysisTask(task) }, msg: "OK" }, { headers: pointsResponseHeaders(user) });
}
