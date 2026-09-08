import { after } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import { readJsonBodyResult } from "@/lib/auth/request";
import { isBangbangStep } from "@/lib/bangbang-contract";
import { startBangbangOperation, runBangbangOperation } from "@/lib/server/bangbang-project-service";
import { resolveInternalOrigin } from "@/lib/server/internal-origin";
import { requestRuntimeCredential } from "@/lib/server/maintenance-auth";
import { checkGenerationRateLimit } from "@/lib/server/security";
import { bangbangError, bangbangResponse, bangbangWriteGuard, isBangbangRevision } from "../../../api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 2400;

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
    const user = await getCurrentUser(request);
    if (!user) return bangbangResponse(null, "请先登录", 401);
    const blocked = bangbangWriteGuard(request);
    if (blocked) return blocked;
    const body = await readJsonBodyResult<{ revision?: unknown; step?: unknown }>(request, 4096);
    if (!body.ok) return bangbangResponse(null, body.message, body.status);
    if (!isBangbangStep(body.data?.step)) return bangbangResponse(null, "处理步骤不正确", 400);
    if (!isBangbangRevision(body.data?.revision)) return bangbangResponse(null, "项目版本不正确，请刷新后重试", 400);
    try {
        if (!(await checkGenerationRateLimit(user.id, request, "text")).allowed) return bangbangResponse(null, "请求过于频繁，请稍后重试", 429);
        const origin = resolveInternalOrigin(new URL(request.url).origin);
        const credential = requestRuntimeCredential(request, user.id);
        const project = await startBangbangOperation(user.id, (await context.params).id, body.data.revision, body.data.step);
        after(() => runBangbangOperation({ project, userId: user.id, origin, credential }));
        return bangbangResponse(project, "处理已开始", 202);
    } catch (error) {
        return bangbangError(error);
    }
}
