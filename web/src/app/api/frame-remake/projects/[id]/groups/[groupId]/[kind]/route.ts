import { getCurrentUser } from "@/lib/auth/session";
import { readJsonBodyResult } from "@/lib/auth/request";
import { abandonFrameRemakeGeneration, submitFrameRemakeGeneration } from "@/lib/server/frame-remake-project-service";
import { resolveInternalOrigin } from "@/lib/server/internal-origin";
import { requestRuntimeCredential } from "@/lib/server/maintenance-auth";
import { runGenerationTaskRecoveryBatch } from "@/lib/server/generation-task-recovery-service";
import { frameRemakeError, frameRemakeResponse, frameRemakeWriteGuard, isFrameRemakeRevision } from "../../../../../api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;
type Context = { params: Promise<{ id: string; groupId: string; kind: string }> };
export async function POST(request: Request, context: Context) {
    const user = await getCurrentUser(request);
    if (!user) return frameRemakeResponse(null, "请先登录", 401);
    const blocked = frameRemakeWriteGuard(request);
    if (blocked) return blocked;
    const { id, groupId, kind } = await context.params;
    if (kind !== "template" && kind !== "image" && kind !== "video") return frameRemakeResponse(null, "生成类型不正确", 400);
    const body = await readJsonBodyResult<{ revision?: number }>(request, 4096);
    if (!body.ok) return frameRemakeResponse(null, body.message, body.status);
    if (!isFrameRemakeRevision(body.data?.revision)) return frameRemakeResponse(null, "项目版本不正确", 400);
    try {
        return frameRemakeResponse(
            await submitFrameRemakeGeneration({ userId: user.id, projectId: id, revision: body.data.revision, groupId, kind, origin: resolveInternalOrigin(new URL(request.url).origin), credential: requestRuntimeCredential(request, user.id) }),
            "生成已提交",
            202,
        );
    } catch (error) {
        return frameRemakeError(error);
    }
}
export async function DELETE(request: Request, context: Context) {
    const user = await getCurrentUser(request);
    if (!user) return frameRemakeResponse(null, "请先登录", 401);
    const blocked = frameRemakeWriteGuard(request);
    if (blocked) return blocked;
    const { id, groupId, kind } = await context.params;
    if (kind !== "template" && kind !== "image" && kind !== "video") return frameRemakeResponse(null, "生成类型不正确", 400);
    try {
        const project = await abandonFrameRemakeGeneration(user.id, id, groupId, kind);
        const taskId = project.groups.find((group) => group.id === groupId)?.[kind].taskId;
        if (taskId) after(() => runGenerationTaskRecoveryBatch({ origin: resolveInternalOrigin(new URL(request.url).origin), limit: 1, taskIds: [taskId] }));
        return frameRemakeResponse(project);
    } catch (error) {
        return frameRemakeError(error);
    }
}
import { after } from "next/server";
