import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { RemakeDramaHandoffError, handoffRemakeProjectToDrama } from "@/lib/server/remake60-drama-handoff";
import { RemakeProjectServiceError } from "@/lib/server/remake60-project-service";

type Context = { params: Promise<{ id: string }> };

export async function POST(_: Request, context: Context) {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ code: 401, data: null, msg: "请先登录" }, { status: 401 });
    try {
        const result = await handoffRemakeProjectToDrama(user.id, (await context.params).id);
        return NextResponse.json({ code: 0, data: result, msg: "已交接到短剧工作区" });
    } catch (error) {
        if (error instanceof RemakeDramaHandoffError || error instanceof RemakeProjectServiceError) {
            return NextResponse.json({ code: error.status, data: null, msg: error.message }, { status: error.status });
        }
        throw error;
    }
}
