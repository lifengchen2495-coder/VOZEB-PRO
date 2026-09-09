import { getCurrentUser } from "@/lib/auth/session";
import { getBangbangProjectForUser } from "@/lib/server/bangbang-project-service";
import { bangbangDefaultVideoPromptInstructions, bangbangVideoPromptInstructions } from "@/lib/server/bangbang-prompts";
import { bangbangError, bangbangResponse } from "../../../api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
    const user = await getCurrentUser(request);
    if (!user) return bangbangResponse(null, "请先登录", 401);
    try {
        const project = await getBangbangProjectForUser(user.id, (await context.params).id);
        return bangbangResponse({ defaultText: bangbangDefaultVideoPromptInstructions(project), text: bangbangVideoPromptInstructions(project), source: project.videoPromptInstructions?.trim() ? "custom" : "default" });
    } catch (error) {
        return bangbangError(error);
    }
}
