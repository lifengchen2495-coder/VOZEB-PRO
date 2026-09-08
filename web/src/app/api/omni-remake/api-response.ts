import { NextResponse } from "next/server";
import { OmniProjectError } from "@/lib/server/omni-remake-project-service";
import { RemakeProjectStoreError } from "@/lib/server/omni-remake-project-store";

export function omniResponse(data: unknown, msg = "OK", status = 200) {
    return NextResponse.json({ code: status < 400 ? 0 : status, data, msg }, { status });
}
export function omniError(error: unknown) {
    if (error instanceof OmniProjectError || error instanceof RemakeProjectStoreError) return omniResponse(null, error.message, error.status);
    console.error("Omni 全品类请求失败", error);
    return omniResponse(null, "处理失败，请稍后重试", 500);
}
