import type { FrameRemakeWorkflowStage } from "@/lib/frame-remake-contract";
import { after } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import { readJsonBodyResult } from "@/lib/auth/request";
import { controlFrameRemakeAutomation, runFrameRemakeAutomationBatch } from "@/lib/server/frame-remake-automation";
import { resolveInternalOrigin } from "@/lib/server/internal-origin";
import { frameRemakeError, frameRemakeResponse, frameRemakeWriteGuard, isFrameRemakeRevision } from "../../../api-response";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 2400;
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
    const user = await getCurrentUser(request);
    if (!user) return frameRemakeResponse(null, "请先登录", 401);
    const blocked = frameRemakeWriteGuard(request);
    if (blocked) return blocked;
    const body = await readJsonBodyResult<{ revision?: number; action?: string; stageScope?: FrameRemakeWorkflowStage; stopAfterPrompts?: boolean }>(request, 4096);
    if (!body.ok) return frameRemakeResponse(null, body.message, body.status);
    if (!isFrameRemakeRevision(body.data?.revision) || (body.data?.action !== "step" && body.data?.action !== "start" && body.data?.action !== "pause")) return frameRemakeResponse(null, "操作或项目版本不正确", 400);
    if (body.data.stageScope !== undefined && !["analysis", "images", "production"].includes(body.data.stageScope)) return frameRemakeResponse(null, "复刻阶段不正确", 400);
    if (body.data.stopAfterPrompts !== undefined && typeof body.data.stopAfterPrompts !== "boolean") return frameRemakeResponse(null, "脚本审阅选项不正确", 400);
    try {
        const project = await controlFrameRemakeAutomation(user.id, (await context.params).id, body.data.revision, body.data.action, body.data.stageScope, body.data.stopAfterPrompts);
        if (body.data.action !== "pause") after(() => runFrameRemakeAutomationBatch(resolveInternalOrigin(new URL(request.url).origin)).then(() => undefined));
        return frameRemakeResponse(project, body.data.action === "pause" ? "已暂停后续步骤" : body.data.action === "step" ? "已开始执行下一步" : "已开始自动逐步复刻");
    } catch (error) {
        return frameRemakeError(error);
    }
}
