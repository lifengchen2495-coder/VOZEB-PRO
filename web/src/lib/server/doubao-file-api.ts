import { randomUUID } from "node:crypto";

import { readProviderError } from "@/lib/server/provider-task-config";
import { sanitizeProviderMessage } from "@/lib/server/admin-channel-config";
import { toSafeGenerationErrorMessage } from "@/lib/server/generation-errors";

export function buildDoubaoFileUploadBody(bytes: Buffer, filename: string) {
    const boundary = `----VozebDoubao${randomUUID().replaceAll("-", "")}`;
    const safeFilename = asciiFilename(filename);
    const encodedFilename = encodeURIComponent(filename);
    const prefix = Buffer.from(
        [
            `--${boundary}`,
            'Content-Disposition: form-data; name="purpose"',
            "",
            "user_data",
            `--${boundary}`,
            `Content-Disposition: form-data; name="file"; filename="${safeFilename}"; filename*=UTF-8''${encodedFilename}`,
            "Content-Type: video/mp4",
            "",
        ].join("\r\n") + "\r\n",
        "utf8",
    );
    const suffix = Buffer.from(`\r\n--${boundary}--\r\n`, "ascii");
    const body = new Blob([new Uint8Array(prefix), new Uint8Array(bytes), new Uint8Array(suffix)]);
    return {
        body,
        contentType: `multipart/form-data; boundary=${boundary}`,
        contentLength: body.size,
    };
}

export async function readDoubaoJsonResponse(response: Response, fallback: string, secrets: string[] = []) {
    const raw = await response.text().catch(() => "");
    const payload = parseJsonRecord(raw);
    if (response.ok && payload) return payload;

    const providerMessage = readProviderError(payload) || (!payload ? raw.trim() : "");
    const sanitized = toSafeGenerationErrorMessage(sanitizeProviderMessage(providerMessage, secrets), fallback);
    const context = [`HTTP ${response.status}`];
    const code = providerErrorCode(payload);
    const requestId = safeMetadata(response.headers.get("x-request-id"));
    if (code) context.push(`code=${code}`);
    if (requestId) context.push(`request_id=${requestId}`);
    throw new Error(`${fallback}（${context.join("；")}）${sanitized && sanitized !== fallback ? `：${sanitized}` : ""}`);
}

function parseJsonRecord(value: string) {
    if (!value.trim()) return null;
    try {
        const parsed = JSON.parse(value) as unknown;
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    } catch {
        return null;
    }
}

function providerErrorCode(payload: Record<string, unknown> | null) {
    if (!payload) return "";
    const error = payload.error && typeof payload.error === "object" && !Array.isArray(payload.error) ? (payload.error as Record<string, unknown>) : undefined;
    return safeMetadata(error?.code || error?.type || payload.code || payload.type);
}

function safeMetadata(value: unknown) {
    const text = typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
    return /^[a-zA-Z0-9._:/-]{1,160}$/.test(text) ? text : "";
}

function asciiFilename(value: string) {
    return Array.from(value.trim() || "attachment.mp4", (character) => (character.charCodeAt(0) <= 0x7f && !['"', "\\", "\r", "\n"].includes(character) ? character : "_")).join("") || "attachment.mp4";
}
