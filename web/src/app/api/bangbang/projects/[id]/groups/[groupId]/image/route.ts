import { getCurrentUser } from "@/lib/auth/session";
import { readJsonBodyResult } from "@/lib/auth/request";
import { abandonBangbangImage, submitBangbangImage } from "@/lib/server/bangbang-project-service";
import { resolveInternalOrigin } from "@/lib/server/internal-origin";
import { requestRuntimeCredential } from "@/lib/server/maintenance-auth";
import { bangbangError, bangbangResponse, bangbangWriteGuard, isBangbangRevision } from "../../../../../api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 2400;

export async function POST(request: Request, context: { params: Promise<{ id: string; groupId: string }> }) {
    const user = await getCurrentUser(request);
    if (!user) return bangbangResponse(null, "请先登录", 401);
    const blocked = bangbangWriteGuard(request);
    if (blocked) return blocked;
    const body = await readJsonBodyResult<{ revision?: unknown }>(request, 4096);
    if (!body.ok) return bangbangResponse(null, body.message, body.status);
    if (!isBangbangRevision(body.data?.revision)) return bangbangResponse(null, "项目版本不正确，请刷新后重试", 400);
    try {
        const { id, groupId } = await context.params;
        return bangbangResponse(await submitBangbangImage({ userId: user.id, projectId: id, revision: body.data.revision, groupId, origin: resolveInternalOrigin(new URL(request.url).origin), credential: requestRuntimeCredential(request, user.id) }), "九宫格生成已提交", 202);
    } catch (error) {
        return bangbangError(error);
    }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string; groupId: string }> }) {
    const user = await getCurrentUser(request);
    if (!user) return bangbangResponse(null, "请先登录", 401);
    const blocked = bangbangWriteGuard(request);
    if (blocked) return blocked;
    try {
        const { id, groupId } = await context.params;
        return bangbangResponse(await abandonBangbangImage(user.id, id, groupId), "生图提交已检查");
    } catch (error) {
        return bangbangError(error);
    }
}
