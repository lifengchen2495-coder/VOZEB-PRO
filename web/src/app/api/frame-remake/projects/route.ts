import { getCurrentUser } from "@/lib/auth/session";
import { readJsonBodyResult } from "@/lib/auth/request";
import { createFrameRemakeProjectForUser } from "@/lib/server/frame-remake-project-service";
import { listFrameRemakeProjects } from "@/lib/server/frame-remake-project-store";
import { frameRemakeError, frameRemakeResponse, frameRemakeWriteGuard } from "../api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
    const user = await getCurrentUser(request);
    if (!user) return frameRemakeResponse(null, "请先登录", 401);
    const query = new URL(request.url).searchParams;
    try {
        return frameRemakeResponse(await listFrameRemakeProjects(user.id, { page: Number(query.get("page")), pageSize: Number(query.get("pageSize")) }));
    } catch (error) {
        return frameRemakeError(error);
    }
}

export async function POST(request: Request) {
    const user = await getCurrentUser(request);
    if (!user) return frameRemakeResponse(null, "请先登录", 401);
    const blocked = frameRemakeWriteGuard(request);
    if (blocked) return blocked;
    const body = await readJsonBodyResult<{ title?: unknown }>(request, 4096);
    if (!body.ok) return frameRemakeResponse(null, body.message, body.status);
    if (!body.data || typeof body.data !== "object" || Array.isArray(body.data)) return frameRemakeResponse(null, "请求内容不正确", 400);
    if (body.data.title !== undefined && (typeof body.data.title !== "string" || body.data.title.length > 160)) return frameRemakeResponse(null, "项目名称最多 160 字", 400);
    try {
        return frameRemakeResponse(await createFrameRemakeProjectForUser(user.id, String(body.data.title || "")), "项目已创建", 201);
    } catch (error) {
        return frameRemakeError(error);
    }
}
