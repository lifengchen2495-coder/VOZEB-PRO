import { NextResponse } from "next/server";

import { BangbangProjectError } from "@/lib/server/bangbang-project-service";
import { BangbangProjectStoreError } from "@/lib/server/bangbang-project-store";
import { resolvePublicRequestOrigin } from "@/lib/server/public-request-origin";

export function bangbangResponse(data: unknown, message = "OK", status = 200) {
    return NextResponse.json(status < 400 ? { data, message } : { data: null, error: message }, { status, headers: { "Cache-Control": "no-store" } });
}

export function bangbangError(error: unknown) {
    if (error instanceof BangbangProjectError || error instanceof BangbangProjectStoreError) return bangbangResponse(null, error.message, error.status);
    console.error("带货短剧请求失败", error);
    return bangbangResponse(null, "处理失败，请稍后重试", 500);
}

export function bangbangWriteGuard(request: Request) {
    if (request.headers.get("sec-fetch-site") === "cross-site") return bangbangResponse(null, "跨站请求已被拦截", 403);
    const expected = resolvePublicRequestOrigin(request);
    for (const header of ["origin", "referer"]) {
        const value = request.headers.get(header);
        if (!value) continue;
        try {
            if (new URL(value).origin !== expected) return bangbangResponse(null, "跨站请求已被拦截", 403);
        } catch {
            return bangbangResponse(null, "请求来源无效", 403);
        }
    }
    return null;
}

export function isBangbangRevision(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
