import { getCurrentUser } from "@/lib/auth/session";
import { readJsonBodyResult } from "@/lib/auth/request";
import { deleteBangbangProjectForUser, getBangbangProjectForUser, saveBangbangProjectForUser } from "@/lib/server/bangbang-project-service";
import { bangbangError, bangbangResponse, bangbangWriteGuard, isBangbangRevision } from "../../api-response";

type Context = { params: Promise<{ id: string }> };
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: Context) {
    const user = await getCurrentUser(request);
    if (!user) return bangbangResponse(null, "请先登录", 401);
    try {
        return bangbangResponse(await getBangbangProjectForUser(user.id, (await context.params).id));
    } catch (error) {
        return bangbangError(error);
    }
}

export async function PATCH(request: Request, context: Context) {
    const user = await getCurrentUser(request);
    if (!user) return bangbangResponse(null, "请先登录", 401);
    const blocked = bangbangWriteGuard(request);
    if (blocked) return blocked;
    const body = await readJsonBodyResult<Record<string, unknown>>(request, 512 * 1024);
    if (!body.ok) return bangbangResponse(null, body.message, body.status);
    if (!body.data || !isBangbangRevision(body.data.revision)) return bangbangResponse(null, "项目版本不正确，请刷新后重试", 400);
    try {
        return bangbangResponse(await saveBangbangProjectForUser(user.id, (await context.params).id, body.data.revision, body.data), "已保存");
    } catch (error) {
        return bangbangError(error);
    }
}

export async function DELETE(request: Request, context: Context) {
    const user = await getCurrentUser(request);
    if (!user) return bangbangResponse(null, "请先登录", 401);
    const blocked = bangbangWriteGuard(request);
    if (blocked) return blocked;
    try {
        await deleteBangbangProjectForUser(user.id, (await context.params).id);
        return bangbangResponse(null, "项目已删除");
    } catch (error) {
        return bangbangError(error);
    }
}
