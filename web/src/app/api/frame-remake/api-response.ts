import { NextResponse } from "next/server";

import { FrameRemakeError } from "@/lib/server/frame-remake-project-service";
import { FrameRemakeProjectStoreError } from "@/lib/server/frame-remake-project-store";
import { resolvePublicRequestOrigin } from "@/lib/server/public-request-origin";

export function frameRemakeResponse(data: unknown, message = "OK", status = 200) {
    return NextResponse.json(status < 400 ? { data, message } : { data: null, error: message }, { status, headers: { "Cache-Control": "no-store" } });
}

export function frameRemakeError(error: unknown) {
    if (error instanceof FrameRemakeError || error instanceof FrameRemakeProjectStoreError) return frameRemakeResponse(null, error.message, error.status);
    console.error("拆帧复刻请求失败", error);
    return frameRemakeResponse(null, "处理失败，请稍后重试", 500);
}

export function frameRemakeWriteGuard(request: Request) {
    if (request.headers.get("sec-fetch-site") === "cross-site") return frameRemakeResponse(null, "跨站请求已被拦截", 403);
    // 同源校验使用当前访问地址，不能由生成公开链接的站点配置覆盖。
    const expected = resolvePublicRequestOrigin(request, "");
    for (const header of ["origin", "referer"]) {
        const value = request.headers.get(header);
        if (!value) continue;
        try {
            if (new URL(value).origin !== expected) return frameRemakeResponse(null, "跨站请求已被拦截", 403);
        } catch {
            return frameRemakeResponse(null, "请求来源无效", 403);
        }
    }
    return null;
}

export function isFrameRemakeRevision(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
