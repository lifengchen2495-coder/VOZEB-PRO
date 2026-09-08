import { open, mkdtemp, rmdir, unlink, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fileTypeFromBuffer } from "file-type";

export const OMNI_CLOTHING_VIDEO_UPLOAD_MAX_BYTES = 200 * 1024 * 1024;

const SNIFF_BYTES = 8 * 1024;
const VIDEO_MIME_TYPES = new Set(["video/mp4", "video/quicktime", "video/webm"]);

export type TemporaryVideoUpload = {
    bytes: number;
    directory: string;
    filePath: string;
    mimeType: "video/mp4" | "video/quicktime" | "video/webm";
};

export class OmniClothingUploadInputError extends Error {
    constructor(
        message: string,
        readonly status = 400,
    ) {
        super(message);
        this.name = "OmniClothingUploadInputError";
    }
}

export async function streamRequestToTemporaryVideo(request: Request, maxBytes = OMNI_CLOTHING_VIDEO_UPLOAD_MAX_BYTES): Promise<TemporaryVideoUpload> {
    const limit = Math.max(1, Math.floor(maxBytes));
    const declaredMimeType = normalizeContentType(request.headers.get("content-type"));
    if (!VIDEO_MIME_TYPES.has(declaredMimeType)) throw new OmniClothingUploadInputError("仅支持 MP4、MOV 或 WebM 视频", 415);
    assertContentLength(request.headers.get("content-length"), limit);
    if (!request.body) throw new OmniClothingUploadInputError("请选择要上传的视频");

    const directory = await mkdtemp(join(tmpdir(), "vozeb-pro-clothing-upload-"));
    const filePath = join(directory, "source-video.upload");
    let handle: FileHandle | undefined;
    let succeeded = false;
    try {
        handle = await open(filePath, "wx", 0o600);
        const streamed = await writeLimitedRequestBody(request.body, handle, limit);
        if (!streamed.bytes) throw new OmniClothingUploadInputError("上传的视频不能为空");
        const detected = await fileTypeFromBuffer(streamed.prefix);
        const detectedMimeType = detected?.mime.toLowerCase() || "";
        if (!VIDEO_MIME_TYPES.has(detectedMimeType)) throw new OmniClothingUploadInputError("视频文件内容格式不正确", 415);
        if (detectedMimeType !== declaredMimeType) throw new OmniClothingUploadInputError("视频文件类型与 Content-Type 不一致", 415);
        succeeded = true;
        return { bytes: streamed.bytes, directory, filePath, mimeType: detectedMimeType as TemporaryVideoUpload["mimeType"] };
    } finally {
        await handle?.close().catch(() => undefined);
        if (!succeeded) await cleanupTemporaryVideoUpload({ directory, filePath });
    }
}

export async function cleanupTemporaryVideoUpload(upload: Pick<TemporaryVideoUpload, "directory" | "filePath">) {
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
                await reader.cancel("Video upload exceeds size limit").catch(() => undefined);
                throw new OmniClothingUploadInputError("单个视频不能超过 200MB", 413);
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
        if (!result.bytesWritten) throw new Error("视频临时文件写入失败");
        offset += result.bytesWritten;
    }
}

function assertContentLength(value: string | null, maxBytes: number) {
    if (value === null) return;
    if (!/^\d+$/.test(value.trim())) throw new OmniClothingUploadInputError("Content-Length 不正确");
    const bytes = Number(value);
    if (!Number.isSafeInteger(bytes)) throw new OmniClothingUploadInputError("Content-Length 不正确");
    if (bytes > maxBytes) throw new OmniClothingUploadInputError("单个视频不能超过 200MB", 413);
    if (bytes === 0) throw new OmniClothingUploadInputError("上传的视频不能为空");
}

function normalizeContentType(value: string | null) {
    return value?.split(";", 1)[0]?.trim().toLowerCase() || "";
}
