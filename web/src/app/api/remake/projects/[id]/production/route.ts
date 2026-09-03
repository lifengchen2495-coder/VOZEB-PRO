import { NextResponse } from "next/server";

import { readJsonBodyResult } from "@/lib/auth/request";
import { getCurrentUser } from "@/lib/auth/session";
import { resolveInternalOrigin } from "@/lib/server/internal-origin";
import { buildRemakeProductionForUser, RemakeProductionError } from "@/lib/server/remake-production-service";
import { RemakeProjectServiceError } from "@/lib/server/remake-project-service";
import { checkGenerationRateLimit, rateLimitHeaders } from "@/lib/server/security";

type Context = { params: Promise<{ id: string }> };

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 2_400;

export async function POST(request: Request, context: Context) {
    const user = await getCurrentUser(request);
    if (!user) return NextResponse.json({ code: 401, data: null, msg: "请先登录" }, { status: 401 });
    const rate = await checkGenerationRateLimit(user.id, request, "text");
    if (!rate.allowed) return NextResponse.json({ code: 429, data: null, msg: "生产包生成请求过于频繁，请稍后重试" }, { status: 429, headers: rateLimitHeaders(rate) });
    const parsed = await readJsonBodyResult<{ revision?: unknown }>(request, 16 * 1024);
    if (!parsed.ok) return NextResponse.json({ code: parsed.status, data: null, msg: parsed.message }, { status: parsed.status });
    const revision = optionalRevision(parsed.data.revision);
    if (revision === null) return NextResponse.json({ code: 400, data: null, msg: "项目版本号无效" }, { status: 400 });
    try {
        const project = await buildRemakeProductionForUser({
            userId: user.id,
            projectId: (await context.params).id,
            origin: resolveInternalOrigin(new URL(request.url).origin),
            cookie: request.headers.get("cookie") || "",
            expectedRevision: revision,
        });
        return NextResponse.json({ code: 0, data: { project }, msg: "四组 Seedance 生产包已生成" });
    } catch (error) {
        if (error instanceof RemakeProjectServiceError || error instanceof RemakeProductionError) return NextResponse.json({ code: error.status, data: null, msg: error.message }, { status: error.status });
        throw error;
    }
}

function optionalRevision(value: unknown) {
    if (value === undefined || value === null || value === "") return undefined;
    const revision = Number(value);
    return Number.isSafeInteger(revision) && revision >= 1 ? revision : null;
}
