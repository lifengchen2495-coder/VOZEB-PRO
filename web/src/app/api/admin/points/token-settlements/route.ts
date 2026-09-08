import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import { isAuthInputError } from "@/lib/auth/store";
import { readJsonBody } from "@/lib/auth/request";
import { hasAllAdminPermissions } from "@/lib/admin-permissions";
import { auditActorFromRequest, safeRecordAuditLog } from "@/lib/server/audit-log-store";
import { listPendingTokenSettlements, parseTokenReconciliation, reconcileTokenSettlement } from "@/lib/server/token-billing-reconciliation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });
    if (!hasAllAdminPermissions(user, ["billing.manage"])) return NextResponse.json({ error: "需要财务管理权限" }, { status: 403 });
    return NextResponse.json({ records: await listPendingTokenSettlements() });
}

export async function POST(request: Request) {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });
    if (!hasAllAdminPermissions(user, ["billing.manage"])) return NextResponse.json({ error: "需要财务管理权限" }, { status: 403 });
    try {
        const input = parseTokenReconciliation(await readJsonBody(request, 8192));
        const result = await reconcileTokenSettlement(input);
        await safeRecordAuditLog({
            action: "admin.points.token-settle",
            actor: auditActorFromRequest(request, user),
            target: { type: "point-record", id: input.recordId },
            metadata: { reason: input.reason, usage: input.usage, applied: result.applied, actualPoints: result.record.tokenBilling?.actualPoints },
        });
        return NextResponse.json(result);
    } catch (error) {
        if (isAuthInputError(error)) return NextResponse.json({ error: error.message }, { status: error.status });
        console.error("Token reconciliation failed", error);
        return NextResponse.json({ error: "Token 用量核对失败，请稍后重试" }, { status: 500 });
    }
}
