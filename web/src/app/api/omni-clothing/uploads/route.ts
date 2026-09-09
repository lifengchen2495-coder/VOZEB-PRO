import { basename } from "node:path";

import { fileTypeFromBuffer } from "file-type";
import sharp from "sharp";

import { writePersistentMediaDataUrl, writeReferenceMediaFile } from "@/lib/server/reference-asset-store";
import { assertClothingResultTarget, assertRevision, getOmniClothingProjectForUser, OmniClothingError } from "@/lib/server/omni-clothing-project-service";
import { assertClothingResultDuration, clothingResultUploadContext, probeClothingVideo } from "@/lib/server/omni-clothing-media-service";
import { checkRateLimit, rateLimitHeaders } from "@/lib/server/security";

import { clothingResponse, withClothingUser } from "../route-utils";
import { cleanupTemporaryVideoUpload, OmniClothingUploadInputError, streamRequestToTemporaryVideo } from "./upload-stream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: Request) {
    return withClothingUser(request, async (userId) => {
        const query = new URL(request.url).searchParams;
        const project = await getOmniClothingProjectForUser(userId, query.get("projectId") || "");
        const isResult = query.get("purpose") === "result";
        if (isResult) assertRevision(project, Number(query.get("revision")));
        const segment = isResult ? assertClothingResultTarget(project, query.get("segmentId"), Number(query.get("inputVersion"))) : undefined;
        if (isResult && query.get("type") !== "video") throw new OmniClothingError("回传结果需要视频文件", 415);
        const limit = await checkRateLimit(`omni-clothing-${isResult ? "result-upload" : "upload"}:${userId}`, { maxRequests: isResult ? 240 : 40, windowMs: 15 * 60_000 });
        if (!limit.allowed) return Response.json({ code: 429, data: null, msg: "上传过于频繁，请稍后重试" }, { status: 429, headers: rateLimitHeaders(limit) });
        let name: string;
        try {
            name = basename(decodeURIComponent(request.headers.get("x-file-name") || "素材").replace(/\\/g, "/"))
                .replace(/[\u0000-\u001f\u007f]/g, "")
                .slice(0, 200);
        } catch {
            throw new OmniClothingError("素材名称不正确");
        }
        const context = { ...(segment ? clothingResultUploadContext(userId, project, segment) : { ownerUserId: userId, projectId: project.id, source: "omni-clothing-source-upload" }), originalName: name };
        let stored;
        let videoMetadata;
        if (query.get("type") === "image") {
            const bytes = await boundedImageBody(request);
            const detected = await fileTypeFromBuffer(bytes);
            if (!detected || !["image/jpeg", "image/png", "image/webp"].includes(detected.mime)) throw new OmniClothingError("服装参考图支持 JPG、PNG 和 WebP", 415);
            const metadata = await sharp(bytes, { limitInputPixels: 40_000_000 }).metadata();
            if (!metadata.width || !metadata.height) throw new OmniClothingError("参考图内容无效");
            stored = await writePersistentMediaDataUrl(`data:${detected.mime};base64,${bytes.toString("base64")}`, "image", context);
        } else {
            let temporary: Awaited<ReturnType<typeof streamRequestToTemporaryVideo>> | undefined;
            try {
                temporary = await streamRequestToTemporaryVideo(request);
                if (segment) {
                    videoMetadata = await probeClothingVideo(temporary.filePath, undefined, true);
                    assertClothingResultDuration(segment, videoMetadata.durationSeconds);
                }
                stored = await writeReferenceMediaFile(temporary.filePath, "video", temporary.mimeType, true, context);
            } catch (error) {
                if (error instanceof OmniClothingUploadInputError) throw new OmniClothingError(error.message, error.status);
                throw error;
            } finally {
                if (temporary) await cleanupTemporaryVideoUpload(temporary);
            }
        }
        return clothingResponse({ asset: { url: `/api/reference-assets/${stored.token.split("/").map(encodeURIComponent).join("/")}`, storageKey: stored.token, mimeType: stored.mimeType, bytes: stored.bytes, name, ...videoMetadata } });
    });
}

async function boundedImageBody(request: Request) {
    const maximum = 20 * 1024 * 1024;
    if (Number(request.headers.get("content-length")) > maximum) throw new OmniClothingError("单张参考图不能超过 20 MB", 413);
    if (!request.body) throw new OmniClothingError("请选择服装参考图");
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > maximum) {
                await reader.cancel();
                throw new OmniClothingError("单张参考图不能超过 20 MB", 413);
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }
    if (!size) throw new OmniClothingError("参考图不能为空");
    return Buffer.concat(chunks, size);
}
