import { apiError, apiSuccess } from "@/app/api/_shared/api-response";
import { readJsonBody } from "@/lib/auth/request";
import { getCurrentUser } from "@/lib/auth/session";
import { isAuthInputError } from "@/lib/auth/store";
import { CommerceVideoWorkflowError, normalizeCommerceVideoWorkflowInput } from "@/lib/commerce-video-workflow";
import { generateCommerceVideoWorkflow } from "@/lib/server/commerce-video-workflow-service";
import { resolveInternalOrigin } from "@/lib/server/internal-origin";
import { checkGenerationRateLimit, rateLimitHeaders } from "@/lib/server/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 2400;

export async function POST(request: Request) {
    const user = await getCurrentUser(request);
    if (!user) return apiError(401, "请先登录");
    const rate = await checkGenerationRateLimit(user.id, request, "text");
    if (!rate.allowed) return apiError(429, "流程设计请求过于频繁，请稍后重试", { headers: rateLimitHeaders(rate) });
    try {
        const input = normalizeCommerceVideoWorkflowInput(await readJsonBody(request, 32 * 1024));
        const result = await generateCommerceVideoWorkflow({ origin: resolveInternalOrigin(new URL(request.url).origin), cookie: request.headers.get("cookie") || "", userId: user.id, input });
        return apiSuccess(result);
    } catch (error) {
        if (error instanceof CommerceVideoWorkflowError || isAuthInputError(error)) return apiError(error.status, error.message);
        return apiError(502, "视频流程设计失败，请稍后重试");
    }
}
