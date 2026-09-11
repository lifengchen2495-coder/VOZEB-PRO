import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runFfmpeg } from "./ffmpeg";
import { buildDoubaoFileUploadBody, fetchDoubaoFileApi, readDoubaoJsonResponse } from "./doubao-file-api";
import { fetchInternalApi } from "./internal-origin";
import type { ResolvedLogicalModel } from "./logical-model-router";
import { readResponsesBody } from "./responses-stream";

export const BANGBANG_VIDEO_MODEL = "doubao-seed-2-0-pro-260215";

export function supportsBangbangFullVideo(candidate: ResolvedLogicalModel) {
    return candidate.upstreamModel.trim().replace(/^models\//i, "").toLowerCase() === BANGBANG_VIDEO_MODEL && Boolean(candidate.channel.apiKey.trim());
}

export function buildBangbangVideoRequest(candidate: ResolvedLogicalModel, fileId: string, messages: Array<{ role: string; content: string }>) {
    if (!supportsBangbangFullVideo(candidate) || !fileId) throw new Error("完整视频理解需要已配置的 Doubao Seed 2.0 Pro 与有效视频文件");
    return {
        model: candidate.upstreamModel, store: false, max_output_tokens: 24_000, stream: true,
        input: [
            ...messages.filter((message) => message.role === "system"),
            { role: "user", content: [{ type: "input_video", file_id: fileId }, { type: "input_text", text: messages.filter((message) => message.role !== "system").map((message) => message.content).join("\n\n") }] },
        ],
    };
}

export async function requestBangbangFullVideo(input: {
    sourcePath: string; workDirectory: string; duration: number; candidate: ResolvedLogicalModel; origin: string;
    messages: Array<{ role: string; content: string }>; headers: Headers; signal: AbortSignal; onResponse: (headers: Headers) => void;
}) {
    const output = join(input.workDirectory, "whole-video.mp4");
    const bitrate = Math.max(96_000, Math.min(1_200_000, Math.floor(21 * 1024 * 1024 * 8 * 0.9 / input.duration) - 48_000));
    // 全程转码，不使用 -ss/-t；视觉理解必须读取完整视频及原音。
    await runFfmpeg(["-hide_banner", "-loglevel", "error", "-i", input.sourcePath, "-map", "0:v:0", "-map", "0:a:0?", "-vf", "scale=min(720\\,iw):-2,fps=12", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-b:v", String(bitrate), "-maxrate", String(bitrate), "-bufsize", String(bitrate * 2), "-c:a", "aac", "-b:a", "48000", "-ac", "1", "-ar", "24000", "-movflags", "+faststart", "-y", output], { timeoutMs: 5 * 60_000, signal: input.signal });
    const bytes = await readFile(output);
    if (!bytes.length || bytes.length > 24 * 1024 * 1024) throw new Error("完整视频转码后超过 24 MB 理解上限，请缩短视频或降低源视频复杂度后重试");
    const upload = buildDoubaoFileUploadBody(bytes, "bangbang-whole-video.mp4");
    const authorization = { Authorization: `Bearer ${input.candidate.channel.apiKey}` };
    const response = await fetchDoubaoFileApi(endpoint(input.candidate, "files"), { method: "POST", headers: { ...authorization, "Content-Type": upload.contentType, "Content-Length": String(upload.contentLength) }, body: upload.body, signal: input.signal });
    const uploaded = await readDoubaoJsonResponse(response, "完整视频文件上传失败", [input.candidate.channel.apiKey]);
    const fileId = typeof uploaded.id === "string" ? uploaded.id.trim() : "";
    if (!fileId) throw new Error("完整视频上传响应缺少文件标识");
    try {
        const expires = Date.now() + 5 * 60_000;
        while (true) {
            input.signal.throwIfAborted();
            const ready = await fetchDoubaoFileApi(endpoint(input.candidate, `files/${encodeURIComponent(fileId)}`), { headers: authorization, signal: input.signal });
            const status = await readDoubaoJsonResponse(ready, "完整视频处理状态查询失败", [input.candidate.channel.apiKey]);
            if (status.status === "active") break;
            if (status.status === "failed") throw new Error("完整视频文件处理失败，请检查视频格式");
            if (Date.now() > expires) throw new Error("完整视频文件处理超过 5 分钟，请稍后重试");
            await delay(1_500, undefined, { signal: input.signal });
        }
        const call = await fetchInternalApi(`${input.origin}/api/ai/system/${encodeURIComponent(input.candidate.channelId)}/responses`, {
            method: "POST", headers: input.headers, body: JSON.stringify(buildBangbangVideoRequest(input.candidate, fileId, input.messages)), cache: "no-store", signal: AbortSignal.any([input.signal, AbortSignal.timeout(10 * 60_000)]),
        });
        return await readResponsesBody(call, input.onResponse);
    } finally {
        try {
            const deleted = await fetchDoubaoFileApi(endpoint(input.candidate, `files/${encodeURIComponent(fileId)}`), { method: "DELETE", headers: authorization, signal: AbortSignal.timeout(30_000) });
            if (!deleted.ok) console.warn("棒棒临时视频文件清理失败", { status: deleted.status });
        } catch { console.warn("棒棒临时视频文件清理暂时失败"); }
    }
}
function endpoint(candidate: ResolvedLogicalModel, path: string) {
    let url: URL;
    try { url = new URL(candidate.channel.baseUrl); } catch { throw new Error("完整视频渠道地址无效"); }
    if (url.protocol !== "https:" || url.username || url.password) throw new Error("完整视频渠道必须使用 HTTPS 地址");
    return `${url.toString().replace(/\/+$/, "")}/${path}`;
}
