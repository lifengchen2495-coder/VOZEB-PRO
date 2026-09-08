import { basename } from "node:path";

import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { getOmniProjectForUser, OmniProjectError } from "@/lib/server/omni-remake-project-service";
import { createSignedReferenceAssetUrl } from "@/lib/server/reference-asset-access";
import { writeReferenceMediaFile } from "@/lib/server/reference-asset-store";
import { resolvePublicRequestOrigin } from "@/lib/server/public-request-origin";
import { checkRateLimit, rateLimitHeaders } from "@/lib/server/security";

import { cleanupTemporaryVideoUpload, RemakeUploadInputError, REMAKE_VIDEO_UPLOAD_MAX_BYTES, streamRequestToTemporaryVideo } from "@/app/api/remake15/uploads/upload-stream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UPLOAD_RATE_LIMIT = { maxRequests: 12, windowMs: 15 * 60 * 1000 };

export async function POST(request: Request) {
    const user = await getCurrentUser(request);
    if (!user) return response(401, null, "请先登录");

    const limit = await checkRateLimit(`omni-remake-upload:${user.id}`, UPLOAD_RATE_LIMIT);
    if (!limit.allowed) return NextResponse.json({ code: 429, data: null, msg: "上传过于频繁，请稍后重试" }, { status: 429, headers: rateLimitHeaders(limit) });

    let temporary: Awaited<ReturnType<typeof streamRequestToTemporaryVideo>> | undefined;
    try {
        const projectId = readProjectId(request);
        if (!projectId) return response(400, null, "请先创建全品类复刻项目");
        await getOmniProjectForUser(user.id, projectId);
        const originalName = readOriginalName(request);
        const origin = resolvePublicRequestOrigin(request);
        temporary = await streamRequestToTemporaryVideo(request);
        const asset = await writeReferenceMediaFile(temporary.filePath, "video", temporary.mimeType, true, {
            ownerUserId: user.id,
            source: "omni-remake-source-upload",
            originalName,
            projectId,
            maxBytes: REMAKE_VIDEO_UPLOAD_MAX_BYTES,
        });
        const url = referenceAssetUrl(asset.token);
        return response(
            200,
            {
                url,
                upstreamUrl: asset.url || createSignedReferenceAssetUrl(asset.token, origin, user.id) || undefined,
                storageKey: asset.token,
                token: asset.token,
                key: asset.token,
                bytes: asset.bytes,
                size: asset.bytes,
                mimeType: asset.mimeType,
                storage: asset.storage,
                originalName,
            },
            "视频已上传",
        );
    } catch (error) {
        if (error instanceof RemakeUploadInputError || error instanceof OmniProjectError) return response(error.status, null, error.message);
        console.error("Remake source video upload failed", error);
        return response(500, null, "视频上传失败");
    } finally {
        if (temporary) await cleanupTemporaryVideoUpload(temporary);
    }
}

function readProjectId(request: Request) {
    const value = new URL(request.url).searchParams.get("projectId")?.trim() || "";
    if (!value) return undefined;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$/.test(value)) throw new RemakeUploadInputError("复刻项目 ID 不正确");
    return value;
}

function readOriginalName(request: Request) {
    const value = request.headers.get("x-file-name")?.trim() || "";
    let decoded = value;
    try {
        decoded = decodeURIComponent(value);
    } catch {
        throw new RemakeUploadInputError("视频文件名不正确");
    }
    const normalized = basename(decoded.replace(/\\/g, "/"))
        .normalize("NFKC")
        .replace(/[\u0000-\u001f\u007f]/g, "")
        .trim();
    return normalized.slice(0, 240) || "source-video";
}

function referenceAssetUrl(storageKey: string) {
    return `/api/reference-assets/${storageKey
        .split("/")
        .map((part) => encodeURIComponent(part))
        .join("/")}`;
}

function response(status: number, data: unknown, msg: string) {
    return NextResponse.json({ code: status === 200 ? 0 : status, data, msg }, { status });
}
