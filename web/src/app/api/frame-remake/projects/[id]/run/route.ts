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
    const body = await readJsonBodyResult<{ revision?: number; action?: string }>(request, 4096);
    if (!body.ok) return frameRemakeResponse(null, body.message, body.status);
    if (!isFrameRemakeRevision(body.data?.revision) || (body.data?.action !== "start" && body.data?.action !== "pause")) return frameRemakeResponse(null, "操作或项目版本不正确", 400);
    try {
        const project = await controlFrameRemakeAutomation(user.id, (await context.params).id, body.data.revision, body.data.action);
        if (body.data.action === "start") after(() => runFrameRemakeAutomationBatch(resolveInternalOrigin(new URL(request.url).origin)).then(() => undefined));
        return frameRemakeResponse(project, body.data.action === "start" ? "已开始自动复刻" : "已暂停后续步骤");
    } catch (error) {
        return frameRemakeError(error);
    }
}
