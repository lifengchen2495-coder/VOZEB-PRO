import { NextResponse } from "next/server";
import { runFrameRemakeAutomationBatch } from "@/lib/server/frame-remake-automation";
import { isAuthorizedWorkerRequest, isWorkerTokenConfigured } from "@/lib/server/maintenance-auth";
import { resolveInternalOrigin } from "@/lib/server/internal-origin";
import { getInstallStatus } from "@/lib/server/install-status";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 2400;
export async function POST(request: Request) {
    if (!isWorkerTokenConfigured() || !isAuthorizedWorkerRequest(request)) return NextResponse.json({ error: "Worker 认证失败" }, { status: 401 });
    try {
        if (!(await getInstallStatus()).database.schemaReady) return NextResponse.json({ data: { claimed: 0 } });
        return NextResponse.json({ data: await runFrameRemakeAutomationBatch(resolveInternalOrigin(new URL(request.url).origin)) });
    } catch (error) {
        console.error("Frame remake worker failed", error);
        return NextResponse.json({ error: "复刻流程调度失败" }, { status: 500 });
    }
}
