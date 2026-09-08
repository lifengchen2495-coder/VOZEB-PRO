import { getCurrentUser } from "@/lib/auth/session";
import { readJsonBodyResult } from "@/lib/auth/request";
import { getOmniProjectForUser, reserveOmniVideo, failOmniVideoSubmission, abandonOmniSubmission } from "@/lib/server/omni-remake-project-service";
import { omniVideoReferences, omniVideoSize } from "@/lib/omni-remake-contract";
import { fetchInternalApi, resolveInternalOrigin } from "@/lib/server/internal-origin";
import { omniError, omniResponse } from "../../../../../api-response";
export const runtime = "nodejs";
export const maxDuration = 600;
export async function DELETE(request: Request, context: { params: Promise<{ id: string; segmentId: string }> }) {
    const user = await getCurrentUser(request);
    if (!user) return omniResponse(null, "请先登录", 401);
    try {
        const { id, segmentId } = await context.params;
        return omniResponse(await abandonOmniSubmission(user.id, id, segmentId));
    } catch (error) {
        return omniError(error);
    }
}
export async function POST(request: Request, context: { params: Promise<{ id: string; segmentId: string }> }) {
    const user = await getCurrentUser(request);
    if (!user) return omniResponse(null, "请先登录", 401);
    const body = await readJsonBodyResult<{ revision?: number }>(request, 4096);
    if (!body.ok) return omniResponse(null, body.message, body.status);
    try {
        const { id, segmentId } = await context.params;
        const project = await reserveOmniVideo(user.id, id, Number(body.data?.revision), segmentId);
        const segment = project.segments.find((item) => item.id === segmentId)!;
        try {
            const response = await fetchInternalApi(`${resolveInternalOrigin(new URL(request.url).origin)}/api/video-generation-tasks`, {
                method: "POST",
                headers: { "Content-Type": "application/json", cookie: request.headers.get("cookie") || "" },
                body: JSON.stringify({
                    prompt: segment.prompt,
                    references: omniVideoReferences(project, segment),
                    config: { model: project.modelSelection.video, size: omniVideoSize(project, segment), videoSeconds: segment.video.generationDurationSeconds || Math.ceil(segment.duration) },
                    source: "omni-remake",
                    context: { projectId: id, generationSlotId: `omni-remake-video:${segmentId}`, clientRequestId: segment.video.clientRequestId, attemptNo: segment.video.attemptNo },
                }),
            });
            const result = (await response.json().catch(() => ({}))) as { error?: string };
            if (!response.ok) {
                // 明确拒绝才结束本次尝试；网络或服务端结果不确定时保留同一请求号。
                if (response.status >= 400 && response.status < 500) await failOmniVideoSubmission(user.id, id, segmentId, segment.video.attemptNo, result.error || "视频提交被拒绝");
                return omniResponse(null, result.error || "提交结果尚未确认，请点击检查或继续提交", response.status);
            }
        } catch (error) {
            console.warn("Omni 视频提交结果待确认", error);
            return omniResponse(null, "网络中断，提交结果尚未确认。请点击检查或继续提交，将复用本次请求号", 502);
        }
        return omniResponse(await getOmniProjectForUser(user.id, id), "视频任务已提交", 202);
    } catch (error) {
        return omniError(error);
    }
}
