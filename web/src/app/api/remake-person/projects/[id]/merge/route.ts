import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import { readJsonBodyResult } from "@/lib/auth/request";
import { fetchInternalApi, resolveInternalOrigin } from "@/lib/server/internal-origin";
import { getRemakeProjectForUser, RemakeProjectServiceError } from "@/lib/server/remake-person-project-service";
import { mergeRemakeVideosForUser } from "@/lib/server/remake-person-merge-service";
import { remakeMergeInputVersion } from "@/lib/server/remake-person-merge-contract";
import { checkGenerationRateLimit, rateLimitHeaders } from "@/lib/server/security";
import { toSafeGenerationErrorMessage } from "@/lib/server/generation-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 2_400;
type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context) {
    const user = await getCurrentUser(request);
    if (!user) return NextResponse.json({ code: 401, msg: "请先登录", data: null }, { status: 401 });
    const rate = await checkGenerationRateLimit(user.id, request, "video");
    if (!rate.allowed) return NextResponse.json({ code: 429, msg: "合并请求过于频繁，请稍后重试", data: null }, { status: 429, headers: rateLimitHeaders(rate) });
    const parsed = await readJsonBodyResult<{ revision?: unknown }>(request, 16 * 1024);
    if (!parsed.ok) return NextResponse.json({ code: parsed.status, msg: parsed.message, data: null }, { status: parsed.status });
    const revision = parsed.data.revision === undefined ? undefined : Number(parsed.data.revision);
    if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1)) return NextResponse.json({ code: 400, msg: "项目版本号无效", data: null }, { status: 400 });
    try {
        const project = await mergeRemakeVideosForUser({ userId: user.id, projectId: (await context.params).id, expectedRevision: revision, origin: resolveInternalOrigin(new URL(request.url).origin), cookie: request.headers.get("cookie") || "" });
        return NextResponse.json({ code: 0, msg: "1 分钟视频已合并", data: { project } });
    } catch (error) {
        const status = error instanceof RemakeProjectServiceError ? error.status : 502;
        return NextResponse.json({ code: status, msg: toSafeGenerationErrorMessage(error, "视频合并失败，请稍后重试"), data: null }, { status });
    }
}

export async function GET(request: Request, context: Context) {
    const user = await getCurrentUser(request);
    if (!user) return NextResponse.json({ code: 401, msg: "请先登录", data: null }, { status: 401 });
    try {
        const project = await getRemakeProjectForUser(user.id, (await context.params).id);
        if (!project.mergedVideo?.url || project.mergedVideoInputVersion !== remakeMergeInputVersion(project)) throw new RemakeProjectServiceError("请先合并当前四段视频", 409);
        if (!project.mergedVideo.url.startsWith("/api/generation-log-assets/")) throw new RemakeProjectServiceError("合并视频地址无效", 409);
        const response = await fetchInternalApi(new URL(project.mergedVideo.url, resolveInternalOrigin(new URL(request.url).origin)), { headers: { cookie: request.headers.get("cookie") || "" }, signal: AbortSignal.timeout(120_000) });
        if (!response.ok || !response.body) throw new RemakeProjectServiceError("合并视频暂时不可读取，请重新合并", 404);
        return new Response(response.body, { headers: { "content-type": "video/mp4", "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`${project.title}-1分钟.mp4`)}`, "cache-control": "private, no-store" } });
    } catch (error) {
        if (error instanceof RemakeProjectServiceError) return NextResponse.json({ code: error.status, msg: error.message, data: null }, { status: error.status });
        throw error;
    }
}
