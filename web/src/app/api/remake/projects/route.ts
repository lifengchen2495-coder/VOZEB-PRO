import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { readJsonBodyResult } from "@/lib/auth/request";
import { createRemakeProjectForUser, listRemakeProjectSummariesForUser, RemakeProjectServiceError } from "@/lib/server/remake-project-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
    const user = await getCurrentUser(request);
    if (!user) return NextResponse.json({ code: 401, data: null, msg: "请先登录" }, { status: 401 });
    const params = new URL(request.url).searchParams;
    const result = await listRemakeProjectSummariesForUser(user.id, {
        page: Math.max(1, Number(params.get("page")) || 1),
        pageSize: Math.max(1, Math.min(100, Number(params.get("pageSize")) || 20)),
    });
    return NextResponse.json({ code: 0, data: { projects: result.items, total: result.total, page: result.page, pageSize: result.pageSize }, msg: "OK" });
}

export async function POST(request: Request) {
    const user = await getCurrentUser(request);
    if (!user) return NextResponse.json({ code: 401, data: null, msg: "请先登录" }, { status: 401 });
    const parsed = await readJsonBodyResult<unknown>(request, 5 * 1024 * 1024);
    if (!parsed.ok) return NextResponse.json({ code: parsed.status, data: null, msg: parsed.message }, { status: parsed.status });
    try {
        const project = await createRemakeProjectForUser(user.id, parsed.data);
        return NextResponse.json({ code: 0, data: { project }, msg: "复刻项目已创建" });
    } catch (error) {
        if (error instanceof RemakeProjectServiceError) return NextResponse.json({ code: error.status, data: null, msg: error.message }, { status: error.status });
        throw error;
    }
}
