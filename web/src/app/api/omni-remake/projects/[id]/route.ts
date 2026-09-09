import { getCurrentUser } from "@/lib/auth/session";
import { readJsonBodyResult } from "@/lib/auth/request";
import { deleteOmniProjectForUser, getOmniProjectForUser, saveOmniProjectForUser } from "@/lib/server/omni-remake-project-service";
import { omniError, omniResponse } from "../../api-response";
import { resolveInternalOrigin } from "@/lib/server/internal-origin";
import { requestRuntimeCredential } from "@/lib/server/maintenance-auth";
type Context = { params: Promise<{ id: string }> };
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: Context) {
    const user = await getCurrentUser(request);
    if (!user) return omniResponse(null, "请先登录", 401);
    try {
        return omniResponse(await getOmniProjectForUser(user.id, (await context.params).id));
    } catch (error) {
        return omniError(error);
    }
}
export async function PATCH(request: Request, context: Context) {
    const user = await getCurrentUser(request);
    if (!user) return omniResponse(null, "请先登录", 401);
    const body = await readJsonBodyResult<Record<string, unknown>>(request, 512 * 1024);
    if (!body.ok) return omniResponse(null, body.message, body.status);
    try {
        return omniResponse(await saveOmniProjectForUser(user.id, (await context.params).id, Number(body.data?.revision), body.data, { origin: resolveInternalOrigin(new URL(request.url).origin), credential: requestRuntimeCredential(request, user.id) }));
    } catch (error) {
        return omniError(error);
    }
}
export async function DELETE(request: Request, context: Context) {
    const user = await getCurrentUser(request);
    if (!user) return omniResponse(null, "请先登录", 401);
    try {
        await deleteOmniProjectForUser(user.id, (await context.params).id);
        return omniResponse(null, "项目已删除");
    } catch (error) {
        return omniError(error);
    }
}
