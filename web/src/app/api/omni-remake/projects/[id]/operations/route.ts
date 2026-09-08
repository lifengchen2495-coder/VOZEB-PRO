import { after } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import { readJsonBodyResult } from "@/lib/auth/request";
import { getOmniProjectForUser, startOmniOperation } from "@/lib/server/omni-remake-project-service";
import { assertOmniPreparationReady, runOmniOperation } from "@/lib/server/omni-remake-runtime";
import { resolveInternalOrigin } from "@/lib/server/internal-origin";
import { requestRuntimeCredential } from "@/lib/server/maintenance-auth";
import { checkGenerationRateLimit } from "@/lib/server/security";
import { omniError, omniResponse } from "../../../api-response";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 2400;
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
    const user = await getCurrentUser(request);
    if (!user) return omniResponse(null, "请先登录", 401);
    const body = await readJsonBodyResult<{ revision?: number; kind?: string }>(request, 4096);
    if (!body.ok) return omniResponse(null, body.message, body.status);
    const kind = body.data?.kind;
    if (kind !== "analysis" && kind !== "prepare" && kind !== "merge") return omniResponse(null, "处理步骤不正确", 400);
    if (!(await checkGenerationRateLimit(user.id, request, "text")).allowed) return omniResponse(null, "请求过于频繁，请稍后重试", 429);
    try {
        const id = (await context.params).id;
        const current = await getOmniProjectForUser(user.id, id);
        if (!current.sourceVideo) return omniResponse(null, "请先上传参考视频", 400);
        if (kind === "prepare") {
            try {
                assertOmniPreparationReady(current);
            } catch (error) {
                return omniResponse(null, (error as Error).message, 400);
            }
        }
        if (kind === "merge" && (!current.segments.length || current.segments.some((segment) => segment.video.status !== "completed" || !segment.video.result))) return omniResponse(null, "请先完成全部片段视频", 409);
        const project = await startOmniOperation(user.id, id, Number(body.data.revision), kind);
        const origin = resolveInternalOrigin(new URL(request.url).origin);
        const credential = requestRuntimeCredential(request, user.id);
        after(() => runOmniOperation({ project, userId: user.id, origin, credential }));
        return omniResponse(project, "处理已开始", 202);
    } catch (error) {
        return omniError(error);
    }
}
