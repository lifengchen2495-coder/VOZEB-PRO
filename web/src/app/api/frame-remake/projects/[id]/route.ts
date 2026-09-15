import { getCurrentUser } from "@/lib/auth/session";
import { readJsonBodyResult } from "@/lib/auth/request";
import { deleteFrameRemakeProjectForUser, getFrameRemakeProjectForUser, saveFrameRemakeProjectForUser } from "@/lib/server/frame-remake-project-service";
import { frameRemakeError, frameRemakeResponse, frameRemakeWriteGuard, isFrameRemakeRevision } from "../../api-response";

type Context = { params: Promise<{ id: string }> };
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: Context) {
    const user = await getCurrentUser(request);
    if (!user) return frameRemakeResponse(null, "请先登录", 401);
    try {
        return frameRemakeResponse(await getFrameRemakeProjectForUser(user.id, (await context.params).id));
    } catch (error) {
        return frameRemakeError(error);
    }
}

export async function PATCH(request: Request, context: Context) {
    const user = await getCurrentUser(request);
    if (!user) return frameRemakeResponse(null, "请先登录", 401);
    const blocked = frameRemakeWriteGuard(request);
    if (blocked) return blocked;
    const body = await readJsonBodyResult<Record<string, unknown>>(request, 512 * 1024);
    if (!body.ok) return frameRemakeResponse(null, body.message, body.status);
    if (!body.data || !isFrameRemakeRevision(body.data.revision)) return frameRemakeResponse(null, "项目版本不正确，请刷新后重试", 400);
    try {
        return frameRemakeResponse(await saveFrameRemakeProjectForUser(user.id, (await context.params).id, body.data.revision, body.data), "已保存");
    } catch (error) {
        return frameRemakeError(error);
    }
}

export async function DELETE(request: Request, context: Context) {
    const user = await getCurrentUser(request);
    if (!user) return frameRemakeResponse(null, "请先登录", 401);
    const blocked = frameRemakeWriteGuard(request);
    if (blocked) return blocked;
    try {
        await deleteFrameRemakeProjectForUser(user.id, (await context.params).id);
        return frameRemakeResponse(null, "项目已删除");
    } catch (error) {
        return frameRemakeError(error);
    }
}
