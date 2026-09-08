import { getCurrentUser } from "@/lib/auth/session";
import { readJsonBodyResult } from "@/lib/auth/request";
import { createBangbangProjectForUser } from "@/lib/server/bangbang-project-service";
import { listBangbangProjects } from "@/lib/server/bangbang-project-store";
import { bangbangError, bangbangResponse, bangbangWriteGuard } from "../api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
    const user = await getCurrentUser(request);
    if (!user) return bangbangResponse(null, "请先登录", 401);
    const query = new URL(request.url).searchParams;
    try {
        return bangbangResponse(await listBangbangProjects(user.id, { page: Number(query.get("page")), pageSize: Number(query.get("pageSize")) }));
    } catch (error) {
        return bangbangError(error);
    }
}

export async function POST(request: Request) {
    const user = await getCurrentUser(request);
    if (!user) return bangbangResponse(null, "请先登录", 401);
    const blocked = bangbangWriteGuard(request);
    if (blocked) return blocked;
    const body = await readJsonBodyResult<{ title?: unknown }>(request, 4096);
    if (!body.ok) return bangbangResponse(null, body.message, body.status);
    if (!body.data || typeof body.data !== "object" || Array.isArray(body.data)) return bangbangResponse(null, "请求内容不正确", 400);
    if (body.data.title !== undefined && (typeof body.data.title !== "string" || body.data.title.length > 160)) return bangbangResponse(null, "项目名称最多 160 字", 400);
    try {
        return bangbangResponse(await createBangbangProjectForUser(user.id, String(body.data.title || "")), "项目已创建", 201);
    } catch (error) {
        return bangbangError(error);
    }
}
