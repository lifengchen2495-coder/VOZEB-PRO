import { zipSync, strToU8 } from "fflate";
import { getCurrentUser } from "@/lib/auth/session";
import { getOmniProjectForUser } from "@/lib/server/omni-remake-project-service";
import { readOmniExportMedia } from "@/lib/server/omni-remake-runtime";
import { resolveInternalOrigin } from "@/lib/server/internal-origin";
import { requestRuntimeCredential } from "@/lib/server/maintenance-auth";
import { omniError, omniResponse } from "../../../api-response";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
    const user = await getCurrentUser(request);
    if (!user) return omniResponse(null, "请先登录", 401);
    try {
        const project = await getOmniProjectForUser(user.id, (await context.params).id);
        if (project.operation) return omniResponse(null, "请等待当前步骤完成", 409);
        const download = { origin: resolveInternalOrigin(new URL(request.url).origin), credential: requestRuntimeCredential(request, user.id) };
        if (new URL(request.url).searchParams.get("format") === "video") {
            if (!project.mergedVideo) return omniResponse(null, "请先合并成片", 409);
            return new Response(new Uint8Array(await readOmniExportMedia(project.mergedVideo, download)), { headers: { "Content-Type": "video/mp4", "Content-Disposition": 'attachment; filename="omni-remake.mp4"', "Cache-Control": "no-store" } });
        }
        if (!project.segments.length || project.segments.some((segment) => !segment.prompt || !segment.sourceClip)) return omniResponse(null, "请先准备全部片段和提示词", 409);
        const files: Record<string, Uint8Array> = { "project.json": strToU8(JSON.stringify(project, null, 2)), "plan.txt": strToU8(`${project.materialAnalysis}\n\n${project.plan}`) };
        let bytes = 0;
        for (const segment of project.segments) {
            files[`${segment.id}/prompt.txt`] = strToU8(`${segment.prompt}\n\n${segment.promptZh}`);
            for (const [name, asset] of [
                ["source.mp4", segment.sourceClip],
                ["result.mp4", segment.video.result],
            ] as const) {
                if (!asset) continue;
                const media = await readOmniExportMedia(asset, download);
                bytes += media.length;
                if (bytes > 400 * 1024 * 1024) return omniResponse(null, "素材包超过 400 MB，请逐段下载视频", 413);
                files[`${segment.id}/${name}`] = media;
            }
        }
        const zip = zipSync(files, { level: 0 });
        return new Response(new Uint8Array(zip), { headers: { "Content-Type": "application/zip", "Content-Disposition": 'attachment; filename="omni-remake.zip"', "Cache-Control": "no-store" } });
    } catch (error) {
        return omniError(error);
    }
}
