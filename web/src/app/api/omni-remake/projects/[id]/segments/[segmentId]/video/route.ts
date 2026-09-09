import { getCurrentUser } from "@/lib/auth/session";
import { readJsonBodyResult } from "@/lib/auth/request";
import { getOmniProjectForUser, importOmniSegmentVideo, abandonOmniSubmission } from "@/lib/server/omni-remake-project-service";
import { resolveInternalOrigin } from "@/lib/server/internal-origin";
import { requestRuntimeCredential } from "@/lib/server/maintenance-auth";
import { omniError, omniResponse } from "../../../../../api-response";

export const runtime = "nodejs";
export const maxDuration = 600;
type Context = { params: Promise<{ id: string; segmentId: string }> };

export async function DELETE(request: Request, context: Context) {
    const user = await getCurrentUser(request);
    if (!user) return omniResponse(null, "请先登录", 401);
    try {
        const { id, segmentId } = await context.params;
        return omniResponse(await abandonOmniSubmission(user.id, id, segmentId));
    } catch (error) {
        return omniError(error);
    }
}

export async function POST(request: Request, context: Context) {
    const user = await getCurrentUser(request);
    if (!user) return omniResponse(null, "请先登录", 401);
    try {
        const { id, segmentId } = await context.params;
        const project = await getOmniProjectForUser(user.id, id);
        if (!project.segments.some((segment) => segment.id === segmentId)) return omniResponse(null, "片段不存在", 404);
        return omniResponse(null, "自动视频生成已停用，请导出素材到 Google 手动生成，再上传对应片段视频", 410);
    } catch (error) {
        return omniError(error);
    }
}

export async function PUT(request: Request, context: Context) {
    const user = await getCurrentUser(request);
    if (!user) return omniResponse(null, "请先登录", 401);
    const body = await readJsonBodyResult<{ revision?: number; url?: string }>(request, 8192);
    if (!body.ok) return omniResponse(null, body.message, body.status);
    if (typeof body.data.url !== "string") return omniResponse(null, "请先上传在 Google 生成的片段视频", 400);
    try {
        const { id, segmentId } = await context.params;
        return omniResponse(await importOmniSegmentVideo(user.id, id, Number(body.data.revision), segmentId, body.data.url, { origin: resolveInternalOrigin(new URL(request.url).origin), credential: requestRuntimeCredential(request, user.id) }), "片段视频已采用");
    } catch (error) {
        return omniError(error);
    }
}
