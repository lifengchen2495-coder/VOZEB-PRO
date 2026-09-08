import { getCurrentUser } from "@/lib/auth/session";
import { bangbangResponse } from "../api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
    const user = await getCurrentUser(request);
    if (!user) return bangbangResponse(null, "请先登录", 401);
    return bangbangResponse({ asrConfigured: Boolean(process.env.DASHSCOPE_API_KEY?.trim() || process.env.DASHSCOPE_KEY?.trim()) });
}
