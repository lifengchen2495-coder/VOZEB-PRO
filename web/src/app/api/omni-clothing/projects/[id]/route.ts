import { readJsonBody } from "@/lib/auth/request";
import { resolveInternalOrigin } from "@/lib/server/internal-origin";
import { requestRuntimeCredential } from "@/lib/server/maintenance-auth";
import { importOmniClothingVideoResult, mergeOmniClothingVideos, splitOmniClothingVideo } from "@/lib/server/omni-clothing-media-service";
import {
    abandonOmniClothingSubmission,
    beginOmniClothingVideoAttempt,
    bindOmniClothingVideoTask,
    buildOmniClothingPromptsForUser,
    deleteOmniClothingProjectForUser,
    failOmniClothingSubmission,
    getOmniClothingProjectForUser,
    OmniClothingError,
    saveOmniClothingPromptForUser,
    updateOmniClothingProjectForUser,
} from "@/lib/server/omni-clothing-project-service";
import { checkRateLimit, rateLimitHeaders } from "@/lib/server/security";

import { clothingResponse, withClothingUser } from "../../route-utils";

type Context = { params: Promise<{ id: string }> };
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;

export async function GET(request: Request, context: Context) {
    return withClothingUser(request, async (userId) => clothingResponse({ project: await getOmniClothingProjectForUser(userId, (await context.params).id) }));
}

export async function PATCH(request: Request, context: Context) {
    return withClothingUser(request, async (userId) => clothingResponse({ project: await updateOmniClothingProjectForUser(userId, (await context.params).id, await readJsonBody<Record<string, unknown>>(request, 128 * 1024)) }));
}

export async function DELETE(request: Request, context: Context) {
    return withClothingUser(request, async (userId) => {
        await deleteOmniClothingProjectForUser(userId, (await context.params).id);
        return clothingResponse({ deleted: true });
    });
}

export async function POST(request: Request, context: Context) {
    return withClothingUser(request, async (userId) => {
        const input = await readJsonBody<Record<string, unknown>>(request, 128 * 1024);
        if (!input || typeof input !== "object" || Array.isArray(input)) throw new OmniClothingError("操作参数必须是 JSON 对象");
        const id = (await context.params).id;
        const access = { origin: resolveInternalOrigin(new URL(request.url).origin), cookie: requestRuntimeCredential(request, userId) };
        if (input.action === "import-result") {
            const limit = await checkRateLimit(`omni-clothing-import:${userId}`, { maxRequests: 240, windowMs: 15 * 60_000 });
            if (!limit.allowed) return Response.json({ code: 429, data: null, msg: "结果采用过于频繁，请稍后重试；已上传视频仍保留" }, { status: 429, headers: rateLimitHeaders(limit) });
        }
        if (input.action === "split" || input.action === "merge") {
            const limit = await checkRateLimit(`omni-clothing-process:${userId}`, { maxRequests: 12, windowMs: 15 * 60_000 });
            if (!limit.allowed) return Response.json({ code: 429, data: null, msg: "视频处理过于频繁，请稍后重试" }, { status: 429, headers: rateLimitHeaders(limit) });
        }
        const project =
            input.action === "split"
                ? await splitOmniClothingVideo(userId, id, { revision: input.revision, boundaries: input.boundaries }, access)
                : input.action === "prompts"
                  ? await buildOmniClothingPromptsForUser(userId, id, input.revision)
                  : input.action === "prompt"
                    ? await saveOmniClothingPromptForUser(userId, id, input)
                    : input.action === "import-result"
                      ? await importOmniClothingVideoResult(userId, id, input, access)
                      : input.action === "attempt"
                        ? await beginOmniClothingVideoAttempt(userId, id, input)
                        : input.action === "bind"
                          ? await bindOmniClothingVideoTask(userId, id, String(input.segmentId || ""), String(input.taskId || ""))
                          : input.action === "abandon-submission"
                            ? await abandonOmniClothingSubmission(userId, id, String(input.segmentId || ""))
                            : input.action === "submission-failed"
                              ? await failOmniClothingSubmission(userId, id, input)
                              : input.action === "merge"
                                ? await mergeOmniClothingVideos(userId, id, input.revision, access)
                                : undefined;
        if (!project) throw new OmniClothingError("不支持的服装复刻操作");
        return clothingResponse({ project });
    });
}
