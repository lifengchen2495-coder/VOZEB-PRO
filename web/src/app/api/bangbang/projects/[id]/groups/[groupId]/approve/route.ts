import { getCurrentUser } from "@/lib/auth/session";
import { readJsonBodyResult } from "@/lib/auth/request";
import { approveBangbangImage } from "@/lib/server/bangbang-project-service";
import { bangbangError, bangbangResponse, bangbangWriteGuard, isBangbangRevision } from "../../../../../api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
        return bangbangResponse(await approveBangbangImage(user.id, id, body.data.revision, groupId), "九宫格已确认");
    } catch (error) {
        return bangbangError(error);
    }
}
