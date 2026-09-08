import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import { getCurrentUser } from "@/lib/auth/session";
import { getBangbangProjectForUser } from "@/lib/server/bangbang-project-service";
import { writePersistentMediaDataUrl, writeReferenceMediaFile } from "@/lib/server/reference-asset-store";
import { checkRateLimit } from "@/lib/server/security";
import { bangbangError, bangbangResponse, bangbangWriteGuard } from "../api-response";
import { BangbangUploadInputError, BANGBANG_VIDEO_UPLOAD_MAX_BYTES, cleanupBangbangUpload, streamBangbangUpload } from "./upload-stream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;

export async function POST(request: Request) {
    const user = await getCurrentUser(request);
    if (!user) return bangbangResponse(null, "请先登录", 401);
    const blocked = bangbangWriteGuard(request);
    if (blocked) return blocked;
    let temporary: Awaited<ReturnType<typeof streamBangbangUpload>> | undefined;
    try {
        const projectId = new URL(request.url).searchParams.get("projectId")?.trim() || "";
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$/.test(projectId)) return bangbangResponse(null, "请先创建带货短剧项目", 400);
        await getBangbangProjectForUser(user.id, projectId);
        if (!(await checkRateLimit(`bangbang-upload:${user.id}`, { maxRequests: 30, windowMs: 15 * 60 * 1000 })).allowed) return bangbangResponse(null, "上传过于频繁，请稍后重试", 429);
        const originalName = readOriginalName(request);
        temporary = await streamBangbangUpload(request);
        const context = { ownerUserId: user.id, projectId, source: "bangbang-upload", originalName };
        const asset = temporary.mimeType.startsWith("image/")
            ? await writePersistentMediaDataUrl(`data:${temporary.mimeType};base64,${(await readFile(temporary.filePath)).toString("base64")}`, "image", context)
            : await writeReferenceMediaFile(temporary.filePath, "video", temporary.mimeType, true, { ...context, maxBytes: BANGBANG_VIDEO_UPLOAD_MAX_BYTES });
        return bangbangResponse({ url: `/api/reference-assets/${asset.token.split("/").map(encodeURIComponent).join("/")}`, storageKey: asset.token, bytes: asset.bytes, mimeType: asset.mimeType, originalName }, "素材已上传", 201);
    } catch (error) {
        if (error instanceof BangbangUploadInputError) return bangbangResponse(null, error.message, error.status);
        return bangbangError(error);
    } finally {
        if (temporary) await cleanupBangbangUpload(temporary);
    }
}

function readOriginalName(request: Request) {
    let decoded: string;
    try {
        decoded = decodeURIComponent(request.headers.get("x-file-name")?.trim() || "");
    } catch {
        throw new BangbangUploadInputError("文件名不正确");
    }
    return basename(decoded.replace(/\\/g, "/")).normalize("NFKC").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 240) || "source-media";
}
