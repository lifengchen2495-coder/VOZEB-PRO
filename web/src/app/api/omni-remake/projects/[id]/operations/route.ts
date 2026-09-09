import { after } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import { readJsonBodyResult } from "@/lib/auth/request";
import { getOmniProjectForUser, startOmniOperation } from "@/lib/server/omni-remake-project-service";
import { assertOmniPreparationReady, assertOmniStageModelReady, runOmniOperation } from "@/lib/server/omni-remake-runtime";
import { OMNI_WORKFLOW_STAGES, omniStagePrerequisite } from "@/lib/omni-remake-workflow";
import type { OmniWorkflowStage } from "@/lib/omni-remake-contract";
import { resolveInternalOrigin } from "@/lib/server/internal-origin";
import { requestRuntimeCredential } from "@/lib/server/maintenance-auth";
import { checkGenerationRateLimit } from "@/lib/server/security";
import { omniError, omniResponse } from "../../../api-response";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 2400;
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
    const user = await getCurrentUser(request);
    if (!user) return omniResponse(null, "请先登录", 401);
    const body = await readJsonBodyResult<{ revision?: number; kind?: string; promptMode?: string }>(request, 4096);
    if (!body.ok) return omniResponse(null, body.message, body.status);
    const requestedKind = body.data?.kind;
    if (requestedKind !== "prepare" && requestedKind !== "merge" && !OMNI_WORKFLOW_STAGES.includes(requestedKind as OmniWorkflowStage)) return omniResponse(null, "处理步骤不正确", 400);
    const kind = requestedKind as OmniWorkflowStage | "prepare" | "merge";
    const promptMode = body.data.promptMode || "template";
    if (promptMode !== "template" && promptMode !== "ai") return omniResponse(null, "提示词准备方式不正确", 400);
    if (!(await checkGenerationRateLimit(user.id, request, "text")).allowed) return omniResponse(null, "请求过于频繁，请稍后重试", 429);
    try {
        const id = (await context.params).id;
        const current = await getOmniProjectForUser(user.id, id);
        if (!current.sourceVideo) return omniResponse(null, "请先上传参考视频", 400);
        try {
            if (kind === "prepare") assertOmniPreparationReady(current);
            else if (kind !== "merge") {
                const prerequisite = omniStagePrerequisite(current, kind);
                if (prerequisite) return omniResponse(null, prerequisite, 409);
                await assertOmniStageModelReady(current, kind);
            }
        } catch (error) {
            return omniResponse(null, (error as Error).message, 400);
        }
        if (kind === "merge" && (!current.segments.length || current.segments.some((segment) => segment.video.status !== "completed" || !segment.video.result))) return omniResponse(null, "请先完成全部片段视频", 409);
        const project = await startOmniOperation(user.id, id, Number(body.data.revision), kind, promptMode);
        const origin = resolveInternalOrigin(new URL(request.url).origin);
        const credential = requestRuntimeCredential(request, user.id);
        after(() => runOmniOperation({ project, userId: user.id, origin, credential }));
        return omniResponse(project, "处理已开始", 202);
    } catch (error) {
        return omniError(error);
    }
}
