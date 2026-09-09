import { zipSync, strToU8 } from "fflate";
import { getCurrentUser } from "@/lib/auth/session";
import { getOmniProjectForUser, OmniProjectError } from "@/lib/server/omni-remake-project-service";
import { omniDefaultPlanningPrompt, type OmniMedia } from "@/lib/omni-remake-contract";
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
        if (!project.segments.length || project.segments.some((segment) => !segment.prompt.trim() || !segment.promptZh.trim() || !segment.sourceClip)) return omniResponse(null, "请先准备全部片段和中英文提示词", 409);
        const files: Record<string, Uint8Array> = { "project.json": strToU8(JSON.stringify(project, null, 2)), "plan.txt": strToU8(`${project.materialAnalysis}\n\n${project.plan}`) };
        files["视频提示词生成指令.txt"] = strToU8(project.videoPromptInstructions?.trim() || omniDefaultPlanningPrompt(project));
        let bytes = 0;
        const addMedia = async (path: string, asset: OmniMedia) => {
            const media = await readOmniExportMedia(asset, download);
            bytes += media.length;
            if (bytes > 400 * 1024 * 1024) throw new OmniProjectError("素材包超过 400 MB，请逐段下载素材", 413);
            files[path] = media;
        };
        const references: Array<{ role: string; path: string; originalName?: string }> = [];
        for (const role of ["product", "character", "background"] as const) {
            if ((role === "character" && !project.replaceCharacter) || (role === "background" && !project.replaceBackground)) continue;
            for (const [index, asset] of project.references[role].entries()) {
                const extension = ({ "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" } as Record<string, string>)[asset.mimeType] || "png";
                const path = `references/${role}/${String(index + 1).padStart(2, "0")}.${extension}`;
                await addMedia(path, asset);
                references.push({ role, path, originalName: asset.originalName });
            }
        }
        const manifest = {
            formatVersion: 1,
            workflow: "google-manual",
            projectId: project.id,
            title: project.title,
            productName: project.productName,
            productStrategy: project.productStrategy,
            replaceCharacter: project.replaceCharacter,
            replaceBackground: project.replaceBackground,
            audioMode: project.audioMode,
            references,
            segments: project.segments.map((segment, index) => ({ id: segment.id, order: index + 1, start: segment.start, end: segment.end, duration: segment.duration, audioStrategy: segment.audioStrategy, sourceVideo: `${segment.id}/source.mp4`, promptEnglish: `${segment.id}/prompt.en.txt`, promptChinese: `${segment.id}/prompt.zh.txt`, requiredImages: references.map((reference) => reference.path), suggestedResultFilename: `${segment.id}-result.mp4`, ...(segment.video.result ? { resultVideo: `${segment.id}/result.${videoExtension(segment.video.result)}` } : {}) })),
        };
        files["manifest.json"] = strToU8(JSON.stringify(manifest, null, 2));
        files["操作说明.txt"] = strToU8(`Google 手动视频生成素材包\n\n1. 打开 manifest.json，按 order 顺序处理片段。各段的 source.mp4 已按音频策略保留原声或移除音轨。\n2. 在 Google 手动生成页面上传该段来源视频及 requiredImages 列出的参考图，使用 prompt.en.txt；prompt.zh.txt 是中文对照。\n3. 生成结果须覆盖该段完整时长，建议按 suggestedResultFilename 命名。这里不会自动提交视频生成任务。\n4. 回到项目，在对应片段上传并采用结果。多出的时长会在合并时裁剪；短于来源的视频会被拒绝。\n5. 全部片段回传后点击合并。preserve_audio 段恢复原片音轨，remove_audio 段保持静音。\n\n参考图角色：product=产品，character=人物，background=背景。素材或提示词变化后，请按最新素材重新生成对应结果。\n`);
        for (const segment of project.segments) {
            files[`${segment.id}/prompt.txt`] = strToU8(`${segment.prompt}\n\n${segment.promptZh}`);
            files[`${segment.id}/prompt.en.txt`] = strToU8(segment.prompt);
            files[`${segment.id}/prompt.zh.txt`] = strToU8(segment.promptZh);
            for (const [name, asset] of [
                ["source.mp4", segment.sourceClip],
                [`result.${segment.video.result ? videoExtension(segment.video.result) : "mp4"}`, segment.video.result],
            ] as const) {
                if (!asset) continue;
                await addMedia(`${segment.id}/${name}`, asset);
            }
        }
        const zip = zipSync(files, { level: 0 });
        return new Response(new Uint8Array(zip), { headers: { "Content-Type": "application/zip", "Content-Disposition": 'attachment; filename="omni-remake.zip"', "Cache-Control": "no-store" } });
    } catch (error) {
        return omniError(error);
    }
}

function videoExtension(media: OmniMedia) {
    return media.mimeType === "video/quicktime" ? "mov" : media.mimeType === "video/webm" ? "webm" : "mp4";
}
