import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { getRemakeAnalysisTaskForUser, publicRemakeAnalysisTask } from "@/lib/server/remake15-analysis-task-store";

type Context = { params: Promise<{ id: string }> };

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: Context) {
    const user = await getCurrentUser(request);
    if (!user) return NextResponse.json({ code: 401, data: null, msg: "请先登录" }, { status: 401 });
    const task = await getRemakeAnalysisTaskForUser(user.id, (await context.params).id);
    if (!task) return NextResponse.json({ code: 404, data: null, msg: "分析任务不存在或已过期" }, { status: 404 });
    return NextResponse.json({ code: 0, data: { task: publicRemakeAnalysisTask(task) }, msg: "OK" });
}
