import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { isAuthInputError } from "@/lib/auth/store";
import { OmniClothingError } from "@/lib/server/omni-clothing-project-service";
import { OmniClothingProjectStoreError } from "@/lib/server/omni-clothing-project-store";

export function clothingResponse(data: unknown, status = 200, message = "OK") {
    return NextResponse.json({ code: status < 400 ? 0 : status, data, msg: message }, { status });
}
export async function withClothingUser(request: Request, action: (userId: string) => Promise<Response>) {
    const user = await getCurrentUser(request);
    if (!user) return clothingResponse(null, 401, "请先登录");
    try {
        return await action(user.id);
    } catch (error) {
        if (error instanceof OmniClothingError || error instanceof OmniClothingProjectStoreError || isAuthInputError(error)) return clothingResponse(null, error.status, error.message);
        console.error("Omni clothing request failed", error);
        return clothingResponse(null, 500, "服装视频处理失败，请稍后重试");
    }
}
