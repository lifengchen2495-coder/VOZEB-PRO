import { streamLongOperation } from "@/lib/server/long-operation-response";
import { NextResponse } from "next/server";

import { readJsonBodyResult } from "@/lib/auth/request";
import { getCurrentUser } from "@/lib/auth/session";
import { resolveInternalOrigin } from "@/lib/server/internal-origin";
import { buildRemakeProductScriptsForUser } from "@/lib/server/remake15-product-script-service";
import { RemakeProjectServiceError } from "@/lib/server/remake15-project-service";
import { checkGenerationRateLimit, rateLimitHeaders } from "@/lib/server/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 2_400;

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
    const user = await getCurrentUser(request);
    if (!user) return NextResponse.json({ code: 401, data: null, msg: "请先登录" }, { status: 401 });
    const rate = await checkGenerationRateLimit(user.id, request, "text");
    if (!rate.allowed) return NextResponse.json({ code: 429, data: null, msg: "脚本生成请求过于频繁，请稍后重试" }, { status: 429, headers: rateLimitHeaders(rate) });
    const parsed = await readJsonBodyResult<{ revision?: unknown }>(request, 16 * 1024);
    if (!parsed.ok) return NextResponse.json({ code: parsed.status, data: null, msg: parsed.message }, { status: parsed.status });
    const revision = parsed.data.revision === undefined ? undefined : Number(parsed.data.revision);
    if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1)) return NextResponse.json({ code: 400, data: null, msg: "项目版本号无效" }, { status: 400 });
    return streamLongOperation(request, async () => {
        try {
            const project = await buildRemakeProductScriptsForUser({ userId: user.id, projectId: (await context.params).id, origin: resolveInternalOrigin(new URL(request.url).origin), cookie: request.headers.get("cookie") || "", expectedRevision: revision });
            return NextResponse.json({ code: 0, data: { project }, msg: "新产品脚本和 1-12 分镜提示词已生成" });
        } catch (error) {
            if (error instanceof RemakeProjectServiceError) return NextResponse.json({ code: error.status, data: null, msg: error.message }, { status: error.status });
            throw error;
        }
    });
}
