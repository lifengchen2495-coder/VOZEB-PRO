import { getCurrentUser } from "@/lib/auth/session";
import { readJsonBodyResult } from "@/lib/auth/request";
import { createOmniProjectForUser } from "@/lib/server/omni-remake-project-service";
import { listRemakeProjectSummaries } from "@/lib/server/omni-remake-project-store";
import { omniError, omniResponse } from "../api-response";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
    const user = await getCurrentUser(request);
    if (!user) return omniResponse(null, "请先登录", 401);
    const query = new URL(request.url).searchParams;
    try {
        return omniResponse(await listRemakeProjectSummaries(user.id, { page: Number(query.get("page")), pageSize: 20 }));
    } catch (error) {
        return omniError(error);
    }
}
export async function POST(request: Request) {
    const user = await getCurrentUser(request);
    if (!user) return omniResponse(null, "请先登录", 401);
    const body = await readJsonBodyResult<{ title?: unknown }>(request, 4096);
    if (!body.ok) return omniResponse(null, body.message, body.status);
    if (body.data?.title !== undefined && (typeof body.data.title !== "string" || body.data.title.length > 120)) return omniResponse(null, "项目名称最多 120 字", 400);
    try {
        return omniResponse(await createOmniProjectForUser(user.id, String(body.data?.title || "")), "项目已创建", 201);
    } catch (error) {
        return omniError(error);
    }
}
