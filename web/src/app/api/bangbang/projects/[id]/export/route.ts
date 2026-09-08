import { mkdtemp, readFile, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { zipSync } from "fflate";
import { fileTypeFromBuffer } from "file-type";
import { getCurrentUser } from "@/lib/auth/session";
import { bangbangBusy, bangbangCreationMode, type BangbangMedia } from "@/lib/bangbang-contract";
import { getBangbangProjectForUser, ownedBangbangMedia, BangbangProjectError } from "@/lib/server/bangbang-project-service";
import { resolveInternalOrigin } from "@/lib/server/internal-origin";
import { maintenanceWorkerContextHeaders, requestRuntimeCredential } from "@/lib/server/maintenance-auth";
import { downloadMediaToFile } from "@/lib/server/media-download";
import { bangbangError, bangbangResponse } from "../../../api-response";
import { bangbangProductionExportBlockReason, bangbangTextExportFiles } from "./export-files";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;
const MAX_EXPORT_BYTES = 300 * 1024 * 1024;

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
    const user = await getCurrentUser(request);
    if (!user) return bangbangResponse(null, "请先登录", 401);
    try {
        const project = await getBangbangProjectForUser(user.id, (await context.params).id);
        if (bangbangBusy(project)) return bangbangResponse(null, "请等待当前步骤完成后导出", 409);
        const mode = new URL(request.url).searchParams.get("mode") || "production";
        if (mode !== "text" && mode !== "production") return bangbangResponse(null, "导出类型不正确", 400);
        if (mode === "production") {
            const reason = bangbangProductionExportBlockReason(project);
            if (reason) return bangbangResponse(null, reason, 409);
        }
        const files = bangbangTextExportFiles(project);
        if (mode === "production") {
            const download = { userId: user.id, origin: resolveInternalOrigin(new URL(request.url).origin), credential: requestRuntimeCredential(request, user.id) };
            const images: Array<{ base: string; asset: BangbangMedia }> = [
                ...project.groups.map((group, index) => ({ base: `九宫格/${String(index + 1).padStart(3, "0")}/九宫格`, asset: group.image.result! })),
                ...(bangbangCreationMode(project) === "reference" ? project.sourceFrames.map((asset, index) => ({ base: `对标拆帧/${String(index + 1).padStart(3, "0")}`, asset })) : []),
                ...(["product", "character", "scene"] as const).flatMap((role) => project.references[role].map((reference, index) => ({ base: `参考图/${role}/${String(index + 1).padStart(3, "0")}`, asset: reference.media }))),
            ];
            let total = Object.values(files).reduce((sum, file) => sum + file.byteLength, 0);
            for (const image of images) {
                const result = await readExportImage(image.asset, download);
                total += result.bytes.byteLength;
                if (total > MAX_EXPORT_BYTES) return bangbangResponse(null, "素材包超过 300 MB，请导出文字并单独下载图片", 413);
                files[`${image.base}.${result.extension}`] = result.bytes;
            }
        }
        return new Response(new Uint8Array(zipSync(files, { level: 0 })), { headers: { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="bangbang-${mode}.zip"`, "Cache-Control": "no-store" } });
    } catch (error) {
        return bangbangError(error);
    }
}

async function readExportImage(asset: BangbangMedia, input: { userId: string; origin: string; credential: string }) {
    const owned = await ownedBangbangMedia(input.userId, asset, "image");
    const directory = await mkdtemp(join(tmpdir(), "vozeb-bangbang-export-"));
    const path = join(directory, "image");
    try {
        const internalHeaders = maintenanceWorkerContextHeaders(input.credential);
        await downloadMediaToFile(owned.url, path, { origin: input.origin, cookie: internalHeaders ? undefined : input.credential, internalHeaders: internalHeaders || undefined, maxBytes: 20 * 1024 * 1024, timeoutMs: 60_000 });
        const bytes = await readFile(path);
        const type = await fileTypeFromBuffer(bytes);
        if (!type || !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(type.mime)) throw new BangbangProjectError("导出的图片内容不完整，请检查素材后重试", 409);
        return { bytes, extension: type.ext };
    } finally {
        await unlink(path).catch(() => undefined);
        await rmdir(directory).catch(() => undefined);
    }
}
