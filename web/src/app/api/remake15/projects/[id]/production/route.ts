import { NextResponse } from "next/server";

import { readJsonBodyResult } from "@/lib/auth/request";
import { getCurrentUser } from "@/lib/auth/session";
import { resolveInternalOrigin } from "@/lib/server/internal-origin";
import { REMAKE_PRODUCTION_GROUP_IDS } from "@/lib/server/remake15-production-prompt";
import { buildRemakeProductionForUser, RemakeProductionError } from "@/lib/server/remake15-production-service";
import { RemakeProjectServiceError } from "@/lib/server/remake15-project-service";
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
    const parsed = await readJsonBodyResult<{ revision?: unknown; groupId?: unknown; inputVersion?: unknown }>(request, 16 * 1024);
    if (!parsed.ok) return NextResponse.json({ code: parsed.status, data: null, msg: parsed.message }, { status: parsed.status });
    const revision = optionalRevision(parsed.data.revision);
    if (revision === null) return NextResponse.json({ code: 400, data: null, msg: "项目版本号无效" }, { status: 400 });
    const groupId = parsed.data.groupId;
    if (groupId !== undefined && (typeof groupId !== "string" || !REMAKE_PRODUCTION_GROUP_IDS.some((id) => id === groupId))) {
        return NextResponse.json({ code: 400, data: null, msg: "视频提示词分组无效" }, { status: 400 });
    }
    const inputVersion = parsed.data.inputVersion;
    if (inputVersion !== undefined && (typeof inputVersion !== "string" || !/^[a-f0-9]{64}$/i.test(inputVersion))) {
        return NextResponse.json({ code: 400, data: null, msg: "生成素材版本无效" }, { status: 400 });
    }
    try {
        const project = await buildRemakeProductionForUser({
            userId: user.id,
            projectId: (await context.params).id,
            origin: resolveInternalOrigin(new URL(request.url).origin),
            cookie: request.headers.get("cookie") || "",
            expectedRevision: revision,
            groupId,
            inputVersion: inputVersion?.toLowerCase(),
        });
        return NextResponse.json({ code: 0, data: { project }, msg: groupId ? `分镜 ${groupId} Prompt 已生成` : "一组 Seedance 生产包已生成" });
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
