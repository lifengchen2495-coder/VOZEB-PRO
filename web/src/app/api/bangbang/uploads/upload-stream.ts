import { open, mkdtemp, rmdir, unlink, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fileTypeFromBuffer } from "file-type";

export const BANGBANG_VIDEO_UPLOAD_MAX_BYTES = 200 * 1024 * 1024;
export const BANGBANG_IMAGE_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;

const SNIFF_BYTES = 8 * 1024;
const VIDEO_MIME_TYPES = new Set(["video/mp4", "video/quicktime", "video/webm"]);
const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

export type TemporaryBangbangUpload = {
    bytes: number;
    directory: string;
    filePath: string;
    mimeType: string;
};

export class BangbangUploadInputError extends Error {
    constructor(
        message: string,
        readonly status = 400,
    ) {
        super(message);
        this.name = "BangbangUploadInputError";
    }
}

export async function streamBangbangUpload(request: Request): Promise<TemporaryBangbangUpload> {
    const declaredMimeType = normalizeContentType(request.headers.get("content-type"));
    if (!VIDEO_MIME_TYPES.has(declaredMimeType) && !IMAGE_MIME_TYPES.has(declaredMimeType)) throw new BangbangUploadInputError("仅支持 MP4、MOV、WebM 视频和 PNG、JPG、WebP 图片", 415);
    const limit = IMAGE_MIME_TYPES.has(declaredMimeType) ? BANGBANG_IMAGE_UPLOAD_MAX_BYTES : BANGBANG_VIDEO_UPLOAD_MAX_BYTES;
    assertContentLength(request.headers.get("content-length"), limit);
    if (!request.body) throw new BangbangUploadInputError("请选择要上传的文件");

    const directory = await mkdtemp(join(tmpdir(), "vozeb-pro-bangbang-upload-"));
    const filePath = join(directory, "media.upload");
    let handle: FileHandle | undefined;
    let succeeded = false;
    try {
        handle = await open(filePath, "wx", 0o600);
        const streamed = await writeLimitedRequestBody(request.body, handle, limit);
        if (!streamed.bytes) throw new BangbangUploadInputError("上传的文件不能为空");
        const detected = await fileTypeFromBuffer(streamed.prefix);
        const detectedMimeType = detected?.mime.toLowerCase() || "";
        if (!VIDEO_MIME_TYPES.has(detectedMimeType) && !IMAGE_MIME_TYPES.has(detectedMimeType)) throw new BangbangUploadInputError("文件内容格式不正确", 415);
        if (detectedMimeType !== declaredMimeType) throw new BangbangUploadInputError("文件类型与 Content-Type 不一致", 415);
        succeeded = true;
        return { bytes: streamed.bytes, directory, filePath, mimeType: detectedMimeType as TemporaryBangbangUpload["mimeType"] };
    } finally {
        await handle?.close().catch(() => undefined);
        if (!succeeded) await cleanupBangbangUpload({ directory, filePath });
    }
}

export async function cleanupBangbangUpload(upload: Pick<TemporaryBangbangUpload, "directory" | "filePath">) {
    await unlink(upload.filePath).catch(() => undefined);
    await rmdir(upload.directory).catch(() => undefined);
}

async function writeLimitedRequestBody(body: ReadableStream<Uint8Array>, handle: FileHandle, maxBytes: number) {
    const reader = body.getReader();
    const prefix = Buffer.alloc(Math.min(SNIFF_BYTES, maxBytes));
    let prefixBytes = 0;
    let total = 0;
    try {
        while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            if (!chunk.value.byteLength) continue;
            total += chunk.value.byteLength;
            if (total > maxBytes) {
                await reader.cancel("Upload exceeds size limit").catch(() => undefined);
                throw uploadLimitError(maxBytes);
            }
            if (prefixBytes < prefix.length) {
                const source = Buffer.from(chunk.value.buffer, chunk.value.byteOffset, chunk.value.byteLength);
                prefixBytes += source.copy(prefix, prefixBytes, 0, prefix.length - prefixBytes);
            }
            await writeAll(handle, chunk.value);
        }
    } catch (error) {
        await reader.cancel(error).catch(() => undefined);
        throw error;
    }
    return { bytes: total, prefix: prefix.subarray(0, prefixBytes) };
}

async function writeAll(handle: FileHandle, bytes: Uint8Array) {
    let offset = 0;
    while (offset < bytes.byteLength) {
        const result = await handle.write(bytes, offset, bytes.byteLength - offset, null);
        if (!result.bytesWritten) throw new Error("媒体临时文件写入失败");
        offset += result.bytesWritten;
    }
}

function assertContentLength(value: string | null, maxBytes: number) {
    if (value === null) return;
    if (!/^\d+$/.test(value.trim())) throw new BangbangUploadInputError("Content-Length 不正确");
    const bytes = Number(value);
    if (!Number.isSafeInteger(bytes)) throw new BangbangUploadInputError("Content-Length 不正确");
    if (bytes > maxBytes) throw uploadLimitError(maxBytes);
    if (bytes === 0) throw new BangbangUploadInputError("上传的文件不能为空");
}

function uploadLimitError(maxBytes: number) {
    return new BangbangUploadInputError(`单个文件不能超过 ${maxBytes / (1024 * 1024)} MB`, 413);
}

function normalizeContentType(value: string | null) {
    const normalized = value?.split(";", 1)[0]?.trim().toLowerCase() || "";
    return normalized === "image/jpg" ? "image/jpeg" : normalized;
}
