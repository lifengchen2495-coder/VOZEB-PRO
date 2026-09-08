import { getCurrentUser } from "@/lib/auth/session";
import { readJsonBodyResult } from "@/lib/auth/request";
import { updateOmniPrompt } from "@/lib/server/omni-remake-project-service";
import { omniError, omniResponse } from "../../../../api-response";
export const runtime = "nodejs";
export async function PATCH(request: Request, context: { params: Promise<{ id: string; segmentId: string }> }) {
    const user = await getCurrentUser(request);
    if (!user) return omniResponse(null, "请先登录", 401);
    const body = await readJsonBodyResult<{ revision?: number; prompt?: string; promptZh?: string }>(request, 128 * 1024);
    if (!body.ok) return omniResponse(null, body.message, body.status);
    if (typeof body.data?.prompt !== "string" || typeof body.data?.promptZh !== "string") return omniResponse(null, "请填写中英文提示词", 400);
    try {
        const { id, segmentId } = await context.params;
        return omniResponse(await updateOmniPrompt(user.id, id, Number(body.data.revision), segmentId, body.data.prompt, body.data.promptZh));
    } catch (error) {
        return omniError(error);
    }
}
