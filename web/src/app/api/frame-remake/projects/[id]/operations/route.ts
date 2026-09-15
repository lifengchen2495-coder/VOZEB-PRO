import { after } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import { readJsonBodyResult } from "@/lib/auth/request";
import { getFrameRemakeProjectForUser, startFrameRemakeOperation } from "@/lib/server/frame-remake-project-service";
import { runFrameRemakeOperation } from "@/lib/server/frame-remake-runtime";
import { resolveInternalOrigin } from "@/lib/server/internal-origin";
import { requestRuntimeCredential } from "@/lib/server/maintenance-auth";
import { checkGenerationRateLimit } from "@/lib/server/security";
import { frameRemakeError, frameRemakeResponse, frameRemakeWriteGuard, isFrameRemakeRevision } from "../../../api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 2400;
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
    const user = await getCurrentUser(request);
    if (!user) return frameRemakeResponse(null, "请先登录", 401);
    const blocked = frameRemakeWriteGuard(request);
    if (blocked) return blocked;
    const body = await readJsonBodyResult<{ revision?: number; kind?: string; groupId?: string }>(request, 4096);
    if (!body.ok) return frameRemakeResponse(null, body.message, body.status);
    const kind = body.data?.kind;
    if (!isFrameRemakeRevision(body.data?.revision) || (kind !== "extract" && kind !== "analyze" && kind !== "merge") || (body.data.groupId !== undefined && typeof body.data.groupId !== "string"))
        return frameRemakeResponse(null, "处理步骤或项目版本不正确", 400);
    if (!(await checkGenerationRateLimit(user.id, request, "text")).allowed) return frameRemakeResponse(null, "请求过于频繁，请稍后重试", 429);
    try {
        const id = (await context.params).id;
        await getFrameRemakeProjectForUser(user.id, id);
        const project = await startFrameRemakeOperation(user.id, id, body.data.revision, kind, body.data.groupId);
        const origin = resolveInternalOrigin(new URL(request.url).origin);
        const credential = requestRuntimeCredential(request, user.id);
        after(() => runFrameRemakeOperation({ project, userId: user.id, origin, credential }));
        return frameRemakeResponse(project, "处理已开始", 202);
    } catch (error) {
        return frameRemakeError(error);
    }
}
