import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAuthSettings, refundUserPoints } from "@/lib/auth/store";
import { runFfmpeg } from "./ffmpeg";
import { fetchInternalApi } from "./internal-origin";
import { resolveLogicalModelCandidates, type ResolvedLogicalModel } from "./logical-model-router";
import { rankTextPlanningCandidates } from "./text-planning-runtime";
import { buildDoubaoFileUploadBody, fetchDoubaoFileApi, readDoubaoJsonResponse } from "./doubao-file-api";
import { resolveModelRequestTimeoutMs } from "./model-request-policy";
import { hasSystemAiCharge, readSystemAiBilling, systemAiBillingHeaders, systemAiIdempotencyKey } from "./system-ai-billing";
import { maintenanceWorkerContextHeaders } from "./maintenance-auth";
import { strictJsonObjectText } from "./structured-model-output";
import { toSafeGenerationErrorMessage } from "./generation-errors";

type ProbeResult = { durationMs: number };
type RemakeAnalysisTask = { id: string; userId: string };
const INLINE_VIDEO_TARGET_BYTES = 22 * 1024 * 1024;
const MAX_INLINE_VIDEO_BYTES = 24 * 1024 * 1024;
const DOUBAO_VIDEO_UNDERSTANDING_MODEL = "doubao-seed-2-0-pro-260215";
const DOUBAO_FILE_WAIT_TIMEOUT_MS = 5 * 60_000;
const DOUBAO_FILE_POLL_INTERVAL_MS = 1500;

export async function understandOmniVideo(input: { sourcePath: string; workDirectory: string; duration: number; userId: string; operationId: string; origin: string; credential: string; model: string; messages: { system: string; user: string } }) {
    const models = await resolveOmniAnalysisModels(input.model);
    const bytes = await transcodeAnalysisVideo({ sourcePath: input.sourcePath, workDirectory: input.workDirectory, probe: { durationMs: input.duration * 1000 } });
    let lastError: unknown;
    for (const candidate of models.videoCandidates) {
        const idempotencyKey = systemAiIdempotencyKey("omni-remake-analysis", input.userId, input.operationId, candidate.channelId, candidate.upstreamModel);
        try {
            const call = await requestDoubaoVideoUnderstanding({
                bytes,
                durationMs: input.duration * 1000,
                candidate,
                model: candidate.logicalModelId,
                origin: input.origin,
                credential: input.credential,
                task: { id: input.operationId, userId: input.userId },
                idempotencyKey,
                messages: input.messages,
            });
            return { raw: call.arguments, headers: call.headers, model: candidate.logicalModelId };
        } catch (error) {
            lastError = error;
        }
    }
    throw new Error(toSafeGenerationErrorMessage(lastError, "Omni 视频理解失败"));
}

async function refundInvalidResponse(userId: string, model: string, headers: Headers) {
    const billing = readSystemAiBilling(headers);
    if (hasSystemAiCharge(billing)) await refundUserPoints(userId, model, billing.pointsCost, "text", 1, undefined, billing.pointsRecordId);
}
function records(value: unknown): Record<string, unknown>[] {
    return Array.isArray(value) ? value.filter((row) => row && typeof row === "object" && !Array.isArray(row)) : [];
}

export async function resolveOmniAnalysisModels(requestedModel = "") {
    const settings = await getAuthSettings();
    const doubaoLogicalIds = settings.logicalModels
        .filter((logical) => logical.enabled && logical.capability === "text" && logical.bindings.some((binding) => binding.enabled && normalizedModelId(binding.upstreamModel) === DOUBAO_VIDEO_UNDERSTANDING_MODEL))
        .map((logical) => logical.id);
    const selected = requestedModel.trim();
    const requestedVideoModels = selected ? [selected] : Array.from(new Set([settings.defaultModels.textModel, ...doubaoLogicalIds, DOUBAO_VIDEO_UNDERSTANDING_MODEL].filter(Boolean)));
    const videoCandidates = rankTextPlanningCandidates(
        uniqueCandidates(requestedVideoModels.flatMap((model) => resolveLogicalModelCandidates(settings, "text", model))).filter(
            (candidate) => normalizedModelId(candidate.upstreamModel) === DOUBAO_VIDEO_UNDERSTANDING_MODEL && Boolean(candidate.channel.apiKey.trim()) && Boolean(doubaoFilesBaseUrl(candidate)),
        ),
    );
    if (!videoCandidates.length) {
        if (selected) throw new Error(`所选分析模型未配置可用的整段视频理解渠道；当前支持 ${DOUBAO_VIDEO_UNDERSTANDING_MODEL} 的 HTTPS Files / Responses 接口，请修改分析模型或对应渠道配置`);
        throw new Error(`后台尚未配置可用的 ${DOUBAO_VIDEO_UNDERSTANDING_MODEL} 视频理解渠道`);
    }
    return { videoModel: videoCandidates[0].logicalModelId, videoCandidates };
}

async function transcodeAnalysisVideo(input: { sourcePath: string; workDirectory: string; probe: ProbeResult }): Promise<Buffer> {
    const outputPath = join(input.workDirectory, "analysis-video.mp4");
    const durationSeconds = input.probe.durationMs / 1_000;
    const totalBitrate = Math.max(96_000, Math.floor((INLINE_VIDEO_TARGET_BYTES * 8 * 0.94) / durationSeconds));
    const audioBitrate = 48_000;
    let videoBitrate = Math.max(64_000, Math.min(1_600_000, totalBitrate - audioBitrate));
    await runAnalysisTranscode(input.sourcePath, outputPath, videoBitrate, audioBitrate);
    let bytes: Buffer = (await readFile(outputPath)) as Buffer;
    if (!bytes.length) throw new Error("原视频转码结果为空");
    if (bytes.length > MAX_INLINE_VIDEO_BYTES) {
        videoBitrate = Math.max(48_000, Math.floor(videoBitrate * ((MAX_INLINE_VIDEO_BYTES * 0.9) / bytes.length)));
        await runAnalysisTranscode(input.sourcePath, outputPath, videoBitrate, 32_000);
        bytes = (await readFile(outputPath)) as Buffer;
    }
    if (!bytes.length) throw new Error("原视频转码结果为空");
    if (bytes.length > MAX_INLINE_VIDEO_BYTES) throw new Error("原视频转码后仍超过视频理解内联上限，请缩短视频后重试");
    return bytes;
}

async function runAnalysisTranscode(sourcePath: string, outputPath: string, videoBitrate: number, audioBitrate: number) {
    await runFfmpeg(
        [
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            sourcePath,
            "-map",
            "0:v:0",
            "-map",
            "0:a:0?",
            "-vf",
            "scale=min(720\\,iw):-2,fps=12",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-pix_fmt",
            "yuv420p",
            "-b:v",
            String(videoBitrate),
            "-maxrate",
            String(videoBitrate),
            "-bufsize",
            String(videoBitrate * 2),
            "-c:a",
            "aac",
            "-b:a",
            String(audioBitrate),
            "-ac",
            "1",
            "-ar",
            "24000",
            "-movflags",
            "+faststart",
            "-y",
            outputPath,
        ],
        { timeoutMs: 10 * 60_000 },
    );
}

async function requestDoubaoVideoUnderstanding(input: { bytes: Buffer; durationMs: number; candidate: ResolvedLogicalModel; model: string; origin: string; credential: string; task: RemakeAnalysisTask; idempotencyKey: string; messages: { system: string; user: string } }) {
    if (normalizedModelId(input.candidate.upstreamModel) !== DOUBAO_VIDEO_UNDERSTANDING_MODEL) throw new Error("当前候选模型不是 Doubao Seed 2.0 Pro");
    const fileId = await uploadDoubaoVideo(input.candidate, input.bytes);
    try {
        await waitForDoubaoFile(input.candidate, fileId);
        const body = {
            model: input.candidate.upstreamModel,
            input: [
                { role: "system", content: input.messages.system },
                {
                    role: "user",
                    content: [
                        { type: "input_video", file_id: fileId },
                        { type: "input_text", text: `${input.messages.user}\n\n实际视频时长：${input.durationMs / 1000} 秒。所有片段必须覆盖完整视频，时间范围不得超过实际时长。` },
                    ],
                },
            ],
            store: false,
            max_output_tokens: 24_000,
        };
        const headers = new Headers({
            "Content-Type": "application/json",
            "Idempotency-Key": input.idempotencyKey,
            "X-Client-Request-Id": input.idempotencyKey,
            ...systemAiBillingHeaders(input.model, input.idempotencyKey, input.candidate.upstreamModel),
        });
        const workerHeaders = maintenanceWorkerContextHeaders(input.credential);
        if (workerHeaders) Object.entries(workerHeaders).forEach(([key, value]) => headers.set(key, value));
        else if (input.credential) headers.set("cookie", input.credential);
        const response = await fetchInternalApi(`${input.origin}/api/ai/system/${encodeURIComponent(input.candidate.channelId)}/responses`, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            cache: "no-store",
            signal: AbortSignal.timeout(Math.max(10 * 60_000, resolveModelRequestTimeoutMs(input.candidate, "text"))),
        });
        if (!response.ok) {
            await refundInvalidResponse(input.task.userId, input.model, response.headers);
            throw new Error(toSafeGenerationErrorMessage(await response.text().catch(() => ""), `Doubao 视频理解调用失败（HTTP ${response.status}）`));
        }
        const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
        if (!payload || payload.status === "incomplete" || payload.status === "failed") {
            await refundInvalidResponse(input.task.userId, input.model, response.headers);
            throw new Error("Doubao 视频理解返回了无效或未完成的 JSON，请重试");
        }
        const argumentsText = strictJsonObjectText(readDoubaoOutputText(payload));
        if (!argumentsText) {
            await refundInvalidResponse(input.task.userId, input.model, response.headers);
            throw new Error("Doubao 视频理解没有返回完整的结构化分析");
        }
        return { arguments: argumentsText, headers: response.headers };
    } finally {
        await deleteDoubaoFile(input.candidate, fileId).catch((error) => console.error("Omni 视频理解临时文件清理失败", toSafeGenerationErrorMessage(error, "文件删除失败")));
    }
}

async function uploadDoubaoVideo(candidate: ResolvedLogicalModel, bytes: Buffer) {
    const upload = buildDoubaoFileUploadBody(bytes, "omni-remake-analysis-video.mp4");
    const response = await fetchDoubaoFileApi(doubaoEndpoint(candidate, "files"), {
        method: "POST",
        headers: {
            Accept: "application/json",
            Authorization: `Bearer ${candidate.channel.apiKey}`,
            "Content-Type": upload.contentType,
            "Content-Length": String(upload.contentLength),
        },
        body: upload.body,
        signal: AbortSignal.timeout(10 * 60_000),
    });
    const payload = await readDoubaoJsonResponse(response, "Doubao 视频文件上传失败", [candidate.channel.apiKey]);
    const fileId = typeof payload.id === "string" ? payload.id.trim() : "";
    if (!fileId) throw new Error("Doubao 视频文件上传响应缺少 file id");
    return fileId;
}

async function waitForDoubaoFile(candidate: ResolvedLogicalModel, fileId: string) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < DOUBAO_FILE_WAIT_TIMEOUT_MS) {
        const response = await fetchDoubaoFileApi(doubaoEndpoint(candidate, `files/${encodeURIComponent(fileId)}`), {
            headers: { Authorization: `Bearer ${candidate.channel.apiKey}` },
            cache: "no-store",
            signal: AbortSignal.timeout(60_000),
        });
        const payload = await readDoubaoJsonResponse(response, "Doubao 视频文件状态查询失败", [candidate.channel.apiKey]);
        if (payload.status === "active") return;
        if (payload.status === "failed") throw new Error(toSafeGenerationErrorMessage(payload.error, "Doubao 视频文件处理失败"));
        await new Promise((resolve) => setTimeout(resolve, DOUBAO_FILE_POLL_INTERVAL_MS));
    }
    throw new Error("Doubao 视频文件处理超时，请稍后重试");
}

async function deleteDoubaoFile(candidate: ResolvedLogicalModel, fileId: string) {
    const response = await fetchDoubaoFileApi(doubaoEndpoint(candidate, `files/${encodeURIComponent(fileId)}`), {
        method: "DELETE",
        headers: { Authorization: `Bearer ${candidate.channel.apiKey}` },
        signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`Doubao 临时视频清理失败（HTTP ${response.status}）`);
}

function readDoubaoOutputText(payload: Record<string, unknown>) {
    const direct = typeof payload.output_text === "string" ? payload.output_text.trim() : "";
    if (direct) return direct;
    return records(payload.output)
        .flatMap((item) => records(item.content))
        .filter((item) => item.type === "output_text" || item.type === "text")
        .map((item) => (typeof item.text === "string" ? item.text : ""))
        .filter(Boolean)
        .join("\n");
}

function doubaoFilesBaseUrl(candidate: ResolvedLogicalModel) {
    try {
        const url = new URL(candidate.channel.baseUrl);
        if (url.protocol !== "https:" || url.username || url.password) return "";
        return url.toString().replace(/\/+$/, "");
    } catch {
        return "";
    }
}

function doubaoEndpoint(candidate: ResolvedLogicalModel, path: string) {
    const baseUrl = doubaoFilesBaseUrl(candidate);
    if (!baseUrl) throw new Error("Doubao 渠道必须配置有效的 HTTPS Base URL");
    return `${baseUrl}/${path.replace(/^\/+/, "")}`;
}

function normalizedModelId(value: string) {
    return value
        .trim()
        .replace(/^models\//i, "")
        .toLowerCase();
}

function uniqueCandidates(candidates: ResolvedLogicalModel[]) {
    const seen = new Set<string>();
    return candidates.filter((candidate) => {
        const key = `${candidate.channelId}\0${normalizedModelId(candidate.upstreamModel)}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}
