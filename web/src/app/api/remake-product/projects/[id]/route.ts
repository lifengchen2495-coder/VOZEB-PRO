import { NextResponse } from "next/server";

import { readJsonBodyResult } from "@/lib/auth/request";
import { getCurrentUser } from "@/lib/auth/session";
import { deleteRemakeProjectForUser, getRemakeProjectForUser, RemakeProjectServiceError, updateRemakeProjectForUser } from "@/lib/server/remake-product-project-service";

type Context = { params: Promise<{ id: string }> };

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: Context) {
    return handle(request, context, async (userId, id) => {
        const project = await getRemakeProjectForUser(userId, id);
        return NextResponse.json({ code: 0, data: { project }, msg: "OK" });
    });
}

export async function PATCH(request: Request, context: Context) {
    const parsed = await readJsonBodyResult<unknown>(request, 5 * 1024 * 1024);
    if (!parsed.ok) return NextResponse.json({ code: parsed.status, data: null, msg: parsed.message }, { status: parsed.status });
    return handle(request, context, async (userId, id) => {
        const project = await updateRemakeProjectForUser(userId, id, parsed.data);
        return NextResponse.json({ code: 0, data: { project }, msg: "复刻项目已保存" });
    });
}

export async function DELETE(request: Request, context: Context) {
    return handle(request, context, async (userId, id) => {
        await deleteRemakeProjectForUser(userId, id);
        return NextResponse.json({ code: 0, data: { deleted: true }, msg: "复刻项目已删除" });
    });
}

async function handle(request: Request, context: Context, action: (userId: string, id: string) => Promise<NextResponse>) {
    const user = await getCurrentUser(request);
    if (!user) return NextResponse.json({ code: 401, data: null, msg: "请先登录" }, { status: 401 });
    try {
        return await action(user.id, (await context.params).id);
    } catch (error) {
        if (error instanceof RemakeProjectServiceError) return NextResponse.json({ code: error.status, data: null, msg: error.message }, { status: error.status });
        throw error;
    }
}
