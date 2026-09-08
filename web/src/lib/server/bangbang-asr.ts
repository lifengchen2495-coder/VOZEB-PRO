import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runFfmpeg, runFfprobe } from "./ffmpeg";
import { fetchSafeOutbound } from "./safe-outbound-fetch";

const DASHSCOPE_BASE = "https://dashscope.aliyuncs.com";
const ASR_TIMEOUT_MS = 12 * 60_000;
export const BANGBANG_MAX_VIDEO_SECONDS = 600;
export type BangbangTranscript = { status: "transcribed" | "no-audio" | "no-speech"; text: string; srt: string; sentences: Array<{ start: number; end: number; text: string }> };

export async function probeBangbangVideo(sourcePath: string) {
    const result = await runFfprobe(["-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height", "-of", "json", sourcePath], { timeoutMs: 30_000 });
    const data = record(JSON.parse(result.stdout));
    const streams = rows(data.streams);
    const video = streams.find((stream) => stream.codec_type === "video");
    const duration = Number(record(data.format).duration);
    if (!video || !Number.isFinite(duration) || duration <= 0 || duration > BANGBANG_MAX_VIDEO_SECONDS) throw new Error(`对标视频必须包含有效画面，时长须在 0 至 ${BANGBANG_MAX_VIDEO_SECONDS} 秒之间`);
    return { duration, width: Number(video.width) || undefined, height: Number(video.height) || undefined, hasAudio: streams.some((stream) => stream.codec_type === "audio") };
}

export async function transcribeBangbangVideo(input: { sourcePath: string; workDirectory: string; hasAudio: boolean; signal?: AbortSignal }): Promise<BangbangTranscript> {
    if (!input.hasAudio) return { status: "no-audio", text: "视频无音轨，无对白。", srt: "", sentences: [] };
    const apiKey = process.env.DASHSCOPE_API_KEY?.trim() || process.env.DASHSCOPE_KEY?.trim() || "";
    if (!apiKey) throw new Error("服务器未配置百炼语音转写凭据（DASHSCOPE_API_KEY 或 DASHSCOPE_KEY），请由管理员配置，或导入已有字幕后继续");
    const signal = input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(ASR_TIMEOUT_MS)]) : AbortSignal.timeout(ASR_TIMEOUT_MS);
    const path = join(input.workDirectory, "full-audio.wav");
    // 不设置截取区间，保留完整音轨；统一为 Paraformer 支持的单声道 PCM。
    await runFfmpeg(["-hide_banner", "-loglevel", "error", "-i", input.sourcePath, "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-y", path], { timeoutMs: 3 * 60_000, signal });
    const bytes = await readFile(path);
    if (!bytes.length || bytes.length > 25 * 1024 * 1024) throw new Error("完整音轨为空或超过 25 MB 转写上限");
    const auth = { Authorization: `Bearer ${apiKey}` };
    const policy = record((await requestJson(`${DASHSCOPE_BASE}/api/v1/uploads?action=getPolicy&model=paraformer-v2`, { headers: auth, signal }, "读取语音上传凭证失败")).data);
    for (const key of ["upload_host", "upload_dir", "oss_access_key_id", "policy", "signature"]) if (!nonempty(policy[key])) throw new Error("语音上传凭证不完整");
    const objectKey = `${policy.upload_dir}/bangbang-audio-${randomUUID()}.wav`;
    const body = new FormData();
    Object.entries({ key: objectKey, OSSAccessKeyId: policy.oss_access_key_id, policy: policy.policy, signature: policy.signature, "x-oss-object-acl": policy.x_oss_object_acl || "private", "x-oss-forbid-overwrite": policy.x_oss_forbid_overwrite || "true", success_action_status: "200" }).forEach(([key, value]) => body.set(key, String(value)));
    body.set("file", new Blob([new Uint8Array(bytes)], { type: "audio/wav" }), "bangbang-audio.wav");
    const upload = await fetchSafeOutbound(String(policy.upload_host), { method: "POST", body, signal });
    if (!upload.ok) throw new Error(`完整音轨上传失败（HTTP ${upload.status}）`);
    await upload.body?.cancel();
    const submitted = await requestJson(`${DASHSCOPE_BASE}/api/v1/services/audio/asr/transcription`, {
        method: "POST", headers: { ...auth, "Content-Type": "application/json", "X-DashScope-Async": "enable", "X-DashScope-OssResourceResolve": "enable" },
        body: JSON.stringify({ model: "paraformer-v2", input: { file_urls: [`oss://${objectKey}`] }, parameters: { language_hints: ["zh", "en"] } }), signal,
    }, "语音转写提交失败");
    const taskId = record(submitted.output).task_id;
    if (!nonempty(taskId)) throw new Error("语音转写响应缺少任务标识");
    let completed: Record<string, unknown> | undefined;
    while (!signal.aborted) {
        const current = record((await requestJson(`${DASHSCOPE_BASE}/api/v1/tasks/${encodeURIComponent(String(taskId))}`, { headers: auth, signal }, "语音转写状态查询失败")).output);
        if (current.task_status === "SUCCEEDED") { completed = current; break; }
        if (["FAILED", "CANCELED", "UNKNOWN"].includes(String(current.task_status))) throw new Error(`语音转写任务失败（${current.task_status}），可导入字幕后继续`);
        await delay(2_000, undefined, { signal });
    }
    if (!completed) throw new Error("语音转写超过 12 分钟，请稍后重试或导入已有字幕");
    const results = rows(completed.results);
    if (!results.length || results.some((item) => item.subtask_status === "FAILED" || !nonempty(item.transcription_url))) throw new Error("语音转写未返回完整的音轨结果");
    const sentences: BangbangTranscript["sentences"] = [];
    for (const item of results) {
        const payload = await requestJson(String(item.transcription_url), { signal }, "读取语音转写结果失败");
        sentences.push(...parseBangbangAsrSentences(payload));
    }
    sentences.sort((left, right) => left.start - right.start);
    const srt = sentences.map((sentence, index) => `${index + 1}\n${srtTime(sentence.start)} --> ${srtTime(sentence.end)}\n${sentence.text}`).join("\n\n");
    return { status: sentences.length ? "transcribed" : "no-speech", text: sentences.length ? sentences.map((sentence) => sentence.text).join("\n") : "完整音轨转写完成，未识别到对白。", srt, sentences };
}

export function parseBangbangAsrSentences(value: unknown): BangbangTranscript["sentences"] {
    const payload = record(value);
    if (!Array.isArray(payload.transcripts)) throw new Error("语音转写结果缺少 transcripts，未保存不完整字幕");
    return rows(payload.transcripts).flatMap((transcript) => {
        if (!Array.isArray(transcript.sentences)) throw new Error("语音转写结果缺少逐句时间码");
        return rows(transcript.sentences).filter((item) => nonempty(item.text)).map((item) => {
            const start = Number(item.begin_time) / 1000;
            const end = Number(item.end_time) / 1000;
            if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) throw new Error("语音转写结果包含无效时间码");
            return { start, end, text: String(item.text).trim() };
        });
    });
}
function srtTime(seconds: number) {
    const ms = Math.round(seconds * 1000);
    return `${String(Math.floor(ms / 3600000)).padStart(2, "0")}:${String(Math.floor(ms / 60000) % 60).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
}
async function requestJson(url: string, init: RequestInit, fallback: string) {
    const signal = init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(90_000)]) : AbortSignal.timeout(90_000);
    const response = await fetchSafeOutbound(url, { ...init, signal });
    if (!response.ok) throw new Error(`${fallback}（HTTP ${response.status}）`);
    const payload = await response.json().catch(() => null);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error(`${fallback}：服务返回了无效 JSON`);
    return payload as Record<string, unknown>;
}
function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function rows(value: unknown): Record<string, unknown>[] { return Array.isArray(value) ? value.map(record) : []; }
function nonempty(value: unknown) { return typeof value === "string" && value.trim().length > 0; }
