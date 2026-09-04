import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp, { type OverlayOptions } from "sharp";

import { getAuthSettings, refundUserPoints } from "@/lib/auth/store";
import { runFfmpeg, runFfprobe } from "@/lib/server/ffmpeg";
import { toSafeGenerationErrorMessage } from "@/lib/server/generation-errors";
import { writeAssetBytes } from "@/lib/server/generation-log-repository";
import { fetchInternalApi } from "@/lib/server/internal-origin";
import { REMAKE_FEISHU_ANALYSIS_PROMPT, REMAKE_FEISHU_COPY_PROMPT } from "@/lib/remake-feishu-prompts";
import { resolveLogicalModelCandidates, type ResolvedLogicalModel } from "@/lib/server/logical-model-router";
import { maintenanceWorkerContext, maintenanceWorkerContextHeaders } from "@/lib/server/maintenance-auth";
import { downloadMediaToFile } from "@/lib/server/media-download";
import { buildDoubaoFileUploadBody, readDoubaoJsonResponse } from "@/lib/server/doubao-file-api";
import { resolveModelRequestTimeoutMs } from "@/lib/server/model-request-policy";
import { writeReferenceMediaFile } from "@/lib/server/reference-asset-store";
import { completeRemakeAnalysisTask, failRemakeAnalysisTask, markRemakeAnalysisTaskRunning, updateRemakeAnalysisTaskProgress, type RemakeAnalysisTask } from "@/lib/server/remake-analysis-task-store";
import {
    isRemakeNoNarrationCopy,
    REMAKE_COPY_BLOCK_COUNT,
    REMAKE_FRAME_COUNT,
    REMAKE_FRAMES_PER_COPY_BLOCK,
    REMAKE_NO_NARRATION_TEXT,
    type RemakeContactSheetInput,
    type RemakeCopyBlock,
    type RemakeCopyState,
    type RemakeFrame,
    type RemakeMediaAsset,
    type RemakeSourceVideo,
} from "@/lib/server/remake-project-contract";
import { completeRemakeProjectAnalysis, failRemakeProjectAnalysis, markRemakeProjectAnalysisRunning, RemakeAnalysisSupersededError } from "@/lib/server/remake-project-service";
import { hasSystemAiCharge, readSystemAiBilling, systemAiBillingHeaders, systemAiIdempotencyKey } from "@/lib/server/system-ai-billing";
import { rankTextPlanningCandidates, requestStructuredText } from "@/lib/server/text-planning-runtime";
import { strictJsonObjectText } from "@/lib/server/structured-model-output";
import { deleteUserMediaAssetsCascade } from "@/lib/server/user-media-deletion-service";

type ProbeResult = { durationMs: number; width: number; height: number; ratio: string };
type VideoFrameAnalysis = Pick<RemakeFrame, "subtitle" | "sellingPoint" | "shotType" | "description" | "subjectRatio" | "hasFace"> & {
    ordinal: number;
    time: number;
    endTime: number;
};
type VideoUnderstandingResult = { frames: VideoFrameAnalysis[]; sourceCopy: string };
type ExtractedFrame = RemakeFrame & { bytes: Buffer };
type CopyPlan = { blocks: RemakeCopyBlock[]; copy: RemakeCopyState };
type CopySegmentation = {
    segments: string[];
    texts: string[];
    paragraphs: Array<{ ordinal: number; text: string }>;
    paragraphOrdinalsByBlock: number[][];
};
type CopyBlockStatus = "unchanged" | "completed" | "corrected" | "empty";
type PendingAnalysisRefund = {
    userId: string;
    model: string;
    pointsCost: number;
    pointsRecordId: string;
    idempotencyKey: string;
};

const MAX_SOURCE_VIDEO_BYTES = 200 * 1024 * 1024;
const INLINE_VIDEO_TARGET_BYTES = 22 * 1024 * 1024;
const MAX_INLINE_VIDEO_BYTES = 24 * 1024 * 1024;
const FRAME_BATCH_SIZE = 12;
const FRAME_EXTRACTION_CONCURRENCY = 4;
const FRAME_PERSISTENCE_CONCURRENCY = 4;
const CONTACT_SHEET_COLUMNS = 3;
const CONTACT_SHEET_ROWS = 4;
const CONTACT_SHEET_WIDTH = 1_080;
const CONTACT_SHEET_HEIGHT = 1_920;
const DOUBAO_VIDEO_UNDERSTANDING_MODEL = "doubao-seed-2-0-pro-260215";
const DOUBAO_FILE_POLL_INTERVAL_MS = 1_500;
const DOUBAO_FILE_WAIT_TIMEOUT_MS = 5 * 60_000;

export async function runRemakeAnalysisTask(input: { task: RemakeAnalysisTask; origin: string; cookie: string }) {
    const task = (await markRemakeAnalysisTaskRunning(input.task)) || input.task;
    let workDirectory = "";
    const writtenStorageKeys = new Set<string>();
    const pendingRefunds = new Map<string, PendingAnalysisRefund>();
    let committed = false;
    try {
        const project = await markRemakeProjectAnalysisRunning(task);
        if (isStrictAnalysisComplete(project)) {
            await completeRemakeAnalysisTask(task, project.analysis.warning);
            return { status: "completed" as const, warning: project.analysis.warning };
        }
        if (!project.sourceVideo?.url) throw new Error("复刻项目缺少原视频");

        workDirectory = await mkdtemp(join(tmpdir(), "vozeb-remake-analysis-"));
        const sourcePath = join(workDirectory, "source-video");
        const credential = input.cookie || maintenanceWorkerContext(task.userId);
        const workerHeaders = maintenanceWorkerContextHeaders(credential) || undefined;

        await updateRemakeAnalysisTaskProgress(task, { stage: "preparing", progress: 5 });
        const downloaded = await downloadMediaToFile(project.sourceVideo.url, sourcePath, {
            origin: input.origin,
            cookie: workerHeaders ? undefined : credential,
            internalHeaders: workerHeaders,
            maxBytes: MAX_SOURCE_VIDEO_BYTES,
            timeoutMs: 10 * 60_000,
        });
        const probe = await probeSourceVideo(sourcePath);
        const models = await resolveAnalysisModels();

        await updateRemakeAnalysisTaskProgress(task, { stage: "transcoding", progress: 12 });
        const inlineVideo = await transcodeAnalysisVideo({ sourcePath, workDirectory, probe });
        let audio: RemakeMediaAsset | undefined;
        let audioExtractionFailed = false;
        try {
            audio = await extractReferenceAudio({ sourcePath, workDirectory, task, onAsset: (storageKey) => writtenStorageKeys.add(storageKey) });
        } catch {
            audioExtractionFailed = true;
        }

        await updateRemakeAnalysisTaskProgress(task, { stage: "video-understanding", progress: 25 });
        const understanding = await understandVideo({
            bytes: inlineVideo,
            durationMs: probe.durationMs,
            candidates: models.videoCandidates,
            model: models.videoModel,
            origin: input.origin,
            credential,
            task,
            onCharge: (headers) => trackAnalysisCharge(pendingRefunds, task, models.videoModel, "video-understanding", headers),
        });

        const existingSourceCopy = typeof project.sourceCopy === "string" ? project.sourceCopy : "";
        const selectedSourceCopy = existingSourceCopy.trim() === REMAKE_NO_NARRATION_TEXT ? "" : existingSourceCopy.trim() ? existingSourceCopy : understanding.sourceCopy;
        const sourceCopy = isRemakeNoNarrationCopy(selectedSourceCopy) ? "" : selectedSourceCopy;
        if (audioExtractionFailed && !isRemakeNoNarrationCopy(sourceCopy)) throw new Error("无法从原视频提取音色参考音频，请确认视频包含有效音轨");
        const warning = isRemakeNoNarrationCopy(sourceCopy) ? (audioExtractionFailed ? "未检测到人物口播，且未生成音色参考音频" : `未检测到人物口播，${REMAKE_NO_NARRATION_TEXT}`) : undefined;

        await updateRemakeAnalysisTaskProgress(task, { stage: "extracting", progress: 45 });
        const frames = await extractAnalyzedFrames({
            sourcePath,
            workDirectory,
            analysis: understanding.frames,
            task,
            onAsset: (storageKey) => writtenStorageKeys.add(storageKey),
        });

        await updateRemakeAnalysisTaskProgress(task, { stage: "contact-sheets", progress: 76 });
        const contactSheets = await createAndPersistContactSheets({ frames, task, onAsset: (storageKey) => writtenStorageKeys.add(storageKey) });

        await updateRemakeAnalysisTaskProgress(task, { stage: "copy-planning", progress: 88 });
        const copyPlan = await planSemanticCopy({
            sourceCopy,
            frames,
            candidates: models.copyCandidates,
            model: models.copyModel,
            origin: input.origin,
            credential,
            task,
            onCharge: (headers) => trackAnalysisCharge(pendingRefunds, task, models.copyModel, "copy-planning", headers),
        });

        await updateRemakeAnalysisTaskProgress(task, { stage: "saving", progress: 97 });
        const sourceVideo: RemakeSourceVideo = {
            ...project.sourceVideo,
            mimeType: downloaded.mimeType.startsWith("video/") ? downloaded.mimeType : project.sourceVideo.mimeType,
            bytes: downloaded.bytes,
            durationMs: probe.durationMs,
            width: probe.width,
            height: probe.height,
            ratio: probe.ratio,
        };
        await completeRemakeProjectAnalysis({
            task,
            frames: frames.map(({ bytes, ...frame }) => {
                void bytes;
                return frame;
            }),
            sourceVideo,
            sourceCopy,
            mode: "video",
            warning,
            analysisRaw: renderFeishuVideoAnalysis(understanding.frames),
            timestamps: understanding.frames.map((frame) => frame.time),
            contactSheets,
            copyBlocks: copyPlan.blocks,
            copy: copyPlan.copy,
            audio,
        });
        committed = true;
        await completeRemakeAnalysisTask(task, warning);
        return warning ? { status: "completed" as const, warning } : { status: "completed" as const };
    } catch (error) {
        const message = toSafeGenerationErrorMessage(error, "视频分析失败，请稍后重试").slice(0, 500);
        await Promise.resolve(failRemakeAnalysisTask(task, message)).catch(() => null);
        if (!(error instanceof RemakeAnalysisSupersededError)) await Promise.resolve(failRemakeProjectAnalysis(task, message)).catch(() => null);
        return { status: error instanceof RemakeAnalysisSupersededError ? ("superseded" as const) : ("failed" as const), error: message };
    } finally {
        if (!committed && pendingRefunds.size) await refundPendingAnalysisCharges(pendingRefunds);
        if (!committed && writtenStorageKeys.size) await Promise.resolve(deleteUserMediaAssetsCascade(task.userId, Array.from(writtenStorageKeys))).catch(() => undefined);
        if (workDirectory) await Promise.resolve(rm(workDirectory, { recursive: true, force: true })).catch(() => undefined);
    }
}

function isStrictAnalysisComplete(project: Awaited<ReturnType<typeof markRemakeProjectAnalysisRunning>>) {
    return (
        project.analysis.status === "completed" &&
        project.analysis.mode === "video" &&
        project.frames.length === REMAKE_FRAME_COUNT &&
        project.copyBlocks.length === REMAKE_COPY_BLOCK_COUNT &&
        project.groups?.filter((group) => group.sourceContactSheet?.url).length === REMAKE_FRAME_COUNT / FRAME_BATCH_SIZE &&
        project.copy?.status === "completed" &&
        (isRemakeNoNarrationCopy(project.sourceCopy) || Boolean(project.references?.audio?.url))
    );
}

async function probeSourceVideo(sourcePath: string): Promise<ProbeResult> {
    const result = await runFfprobe(["-v", "error", "-print_format", "json", "-show_streams", "-show_format", sourcePath], { timeoutMs: 60_000 });
    let payload: Record<string, unknown>;
    try {
        payload = JSON.parse(result.stdout) as Record<string, unknown>;
    } catch {
        throw new Error("无法读取原视频信息");
    }
    const streams = records(payload.streams);
    const video = streams.find((stream) => stream.codec_type === "video");
    if (!video) throw new Error("原文件不包含可解码的视频轨道");
    const format = object(payload.format);
    const durationSeconds = positiveNumber(video.duration) || positiveNumber(format.duration);
    if (!durationSeconds) throw new Error("无法读取原视频时长");
    let width = positiveInteger(video.width);
    let height = positiveInteger(video.height);
    if (!width || !height) throw new Error("无法读取原视频画幅");
    if (videoRotation(video) % 180 !== 0) [width, height] = [height, width];
    return { durationMs: Math.max(1, Math.round(durationSeconds * 1_000)), width, height, ratio: aspectRatio(width, height) };
}

async function resolveAnalysisModels() {
    const settings = await getAuthSettings();
    const doubaoLogicalIds = settings.logicalModels
        .filter(
            (logical) =>
                logical.enabled &&
                logical.capability === "text" &&
                logical.bindings.some((binding) => binding.enabled && normalizedModelId(binding.upstreamModel) === DOUBAO_VIDEO_UNDERSTANDING_MODEL),
        )
        .map((logical) => logical.id);
    const requestedVideoModels = Array.from(new Set([settings.defaultModels.textModel, ...doubaoLogicalIds, DOUBAO_VIDEO_UNDERSTANDING_MODEL].filter(Boolean)));
    const videoCandidates = rankTextPlanningCandidates(
        uniqueCandidates(requestedVideoModels.flatMap((model) => resolveLogicalModelCandidates(settings, "text", model))).filter(
            (candidate) => normalizedModelId(candidate.upstreamModel) === DOUBAO_VIDEO_UNDERSTANDING_MODEL && Boolean(candidate.channel.apiKey.trim()) && Boolean(doubaoFilesBaseUrl(candidate)),
        ),
    );
    if (!videoCandidates.length) throw new Error(`后台尚未配置可用的 ${DOUBAO_VIDEO_UNDERSTANDING_MODEL} 文本模型渠道`);

    const copyModel = settings.defaultModels.textModel || videoCandidates[0].logicalModelId;
    const copyCandidates = rankTextPlanningCandidates(resolveLogicalModelCandidates(settings, "text", copyModel));
    if (!copyCandidates.length) throw new Error("后台尚未配置可用的 Prompt 文本模型");
    return { copyModel, copyCandidates, videoModel: videoCandidates[0].logicalModelId, videoCandidates };
}

async function transcodeAnalysisVideo(input: { sourcePath: string; workDirectory: string; probe: ProbeResult }) {
    const outputPath = join(input.workDirectory, "analysis-video.mp4");
    const durationSeconds = input.probe.durationMs / 1_000;
    const totalBitrate = Math.max(96_000, Math.floor((INLINE_VIDEO_TARGET_BYTES * 8 * 0.94) / durationSeconds));
    const audioBitrate = 48_000;
    let videoBitrate = Math.max(64_000, Math.min(1_600_000, totalBitrate - audioBitrate));
    await runAnalysisTranscode(input.sourcePath, outputPath, videoBitrate, audioBitrate);
    let bytes = await readFile(outputPath);
    if (!bytes.length) throw new Error("原视频转码结果为空");
    if (bytes.length > MAX_INLINE_VIDEO_BYTES) {
        videoBitrate = Math.max(48_000, Math.floor(videoBitrate * ((MAX_INLINE_VIDEO_BYTES * 0.9) / bytes.length)));
        await runAnalysisTranscode(input.sourcePath, outputPath, videoBitrate, 32_000);
        bytes = await readFile(outputPath);
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

async function extractReferenceAudio(input: { sourcePath: string; workDirectory: string; task: RemakeAnalysisTask; onAsset: (storageKey: string) => void }): Promise<RemakeMediaAsset> {
    const outputPath = join(input.workDirectory, "source-voice.aac");
    try {
        await runFfmpeg(
            [
                "-hide_banner",
                "-loglevel",
                "error",
                "-i",
                input.sourcePath,
                "-map",
                "0:a:0",
                "-vn",
                "-af",
                "highpass=f=80,lowpass=f=12000,loudnorm=I=-16:TP=-1.5:LRA=11",
                "-c:a",
                "aac",
                "-b:a",
                "96k",
                "-ac",
                "1",
                "-ar",
                "44100",
                "-f",
                "adts",
                "-y",
                outputPath,
            ],
            { timeoutMs: 5 * 60_000 },
        );
    } catch {
        throw new Error("无法从原视频提取音色参考音频，请确认视频包含有效音轨");
    }
    const stored = await writeReferenceMediaFile(outputPath, "audio", "audio/aac", true, {
        ownerUserId: input.task.userId,
        source: "remake-analysis-audio",
        originalName: "remake-source-voice.aac",
        runId: input.task.runId,
        taskId: input.task.id,
        projectId: input.task.projectId,
    });
    input.onAsset(stored.token);
    return {
        url: stored.url || `/api/reference-assets/${stored.token}`,
        storageKey: stored.token,
        mimeType: stored.mimeType,
        originalName: "remake-source-voice.aac",
        bytes: stored.bytes,
    };
}

async function understandVideo(input: {
    bytes: Buffer;
    durationMs: number;
    candidates: ResolvedLogicalModel[];
    model: string;
    origin: string;
    credential: string;
    task: RemakeAnalysisTask;
    onCharge: (headers: Headers) => void;
}): Promise<VideoUnderstandingResult> {
    let latestError: unknown;
    for (const candidate of input.candidates) {
        const idempotencyKey = systemAiIdempotencyKey("remake-video-understanding", input.task.userId, input.task.id, candidate.channelId, candidate.upstreamModel);
        try {
            const call = await requestDoubaoVideoUnderstanding({ ...input, candidate, idempotencyKey });
            try {
                const understanding = parseVideoUnderstanding(call.arguments, input.durationMs);
                input.onCharge(call.headers);
                return understanding;
            } catch (error) {
                await refundInvalidResponse(input.task.userId, input.model, call.headers);
                latestError = error;
            }
        } catch (error) {
            latestError = error;
        }
    }
    throw new Error(toSafeGenerationErrorMessage(latestError, "视频理解模型未返回完整的 48 条镜头分析"));
}

async function requestDoubaoVideoUnderstanding(input: { bytes: Buffer; durationMs: number; candidate: ResolvedLogicalModel; model: string; origin: string; credential: string; task: RemakeAnalysisTask; idempotencyKey: string }) {
    if (normalizedModelId(input.candidate.upstreamModel) !== DOUBAO_VIDEO_UNDERSTANDING_MODEL) throw new Error("当前候选模型不是 Doubao Seed 2.0 Pro");
    const fileId = await uploadDoubaoVideo(input.candidate, input.bytes);
    try {
        await waitForDoubaoFile(input.candidate, fileId);
        const prompt = buildDoubaoVideoUnderstandingPrompt(input.durationMs);
        const body = {
            model: input.candidate.upstreamModel,
            input: [
                {
                    role: "user",
                    content: [
                        { type: "input_video", file_id: fileId },
                        { type: "input_text", text: prompt },
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
        if (!response.ok) throw new Error(toSafeGenerationErrorMessage(await response.text().catch(() => ""), `Doubao 视频理解调用失败（HTTP ${response.status}）`));
        const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
        if (!payload) {
            await refundInvalidResponse(input.task.userId, input.model, response.headers);
            throw new Error("Doubao 视频理解返回了无效 JSON");
        }
        const argumentsText = strictJsonObjectText(readDoubaoOutputText(payload));
        if (!argumentsText) {
            await refundInvalidResponse(input.task.userId, input.model, response.headers);
            throw new Error("Doubao 视频理解没有返回完整的结构化分析");
        }
        return { arguments: argumentsText, headers: response.headers };
    } finally {
        await deleteDoubaoFile(input.candidate, fileId).catch(() => undefined);
    }
}

function buildDoubaoVideoUnderstandingPrompt(durationMs: number) {
    const runtimeContract = [
        "## 【当前记录执行合同】",
        "完整观看已上传的视频，并按时间顺序严格拆解为恰好 48 个编号分镜，四部分各 12 个。",
        "48 个分镜必须完整、连续覆盖视频：第一段从 0:00 开始，后一段的开始时间必须等于前一段的结束时间，禁止时间跳跃、重叠、重复或乱序；最后一段结束时间必须等于视频实际结尾。",
        "每个分镜必须给出真实语义起止时间、画面可见字幕、卖点、镜头类型、画面描述、人物占比和是否包含清晰人脸。无字幕且无卖点的纯过渡画面应与相邻镜头合并，不得为了凑数虚构画面。",
        "画面描述必须包含景别或构图、人物性别、动作、节奏、展示目的和环境背景。",
        "除视频原语言字幕和 sourceCopy 外，所有分析字段使用简体中文。sourceCopy 必须按视频中的原语言逐字返回，不得翻译、概括、改写、遗漏或重复；无口播时返回空字符串。",
        `视频实际时长为 ${formatTimestamp(durationMs / 1_000)}。`,
        "只输出一个 JSON 对象，不要输出 Markdown 代码围栏、解释或前后缀。JSON 必须严格符合以下 Schema：",
        JSON.stringify(remakeVideoTool.parameters),
    ].join("\n\n");
    return `${REMAKE_FEISHU_ANALYSIS_PROMPT}\n\n---\n\n${runtimeContract}`;
}

async function uploadDoubaoVideo(candidate: ResolvedLogicalModel, bytes: Buffer) {
    const upload = buildDoubaoFileUploadBody(bytes, "remake-analysis-video.mp4");
    const response = await fetch(doubaoEndpoint(candidate, "files"), {
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
        const response = await fetch(doubaoEndpoint(candidate, `files/${encodeURIComponent(fileId)}`), {
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
    const response = await fetch(doubaoEndpoint(candidate, `files/${encodeURIComponent(fileId)}`), {
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
    return value.trim().replace(/^models\//i, "").toLowerCase();
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

function parseVideoUnderstanding(argumentsText: string, durationMs: number): VideoUnderstandingResult {
    let payload: Record<string, unknown>;
    try {
        payload = JSON.parse(argumentsText) as Record<string, unknown>;
    } catch {
        throw new Error("视频理解模型返回的分析不是有效 JSON");
    }
    if (typeof payload.sourceCopy !== "string" || payload.sourceCopy.length > 200_000) throw new Error("视频理解模型缺少完整 sourceCopy");
    const sourceCopy = payload.sourceCopy.trim();
    const items = records(payload.frames);
    if (items.length !== REMAKE_FRAME_COUNT) throw new Error(`视频理解模型必须返回完整的 ${REMAKE_FRAME_COUNT} 条镜头分析`);
    const durationSeconds = roundedSeconds(durationMs / 1_000);
    const byOrdinal = new Map<number, VideoFrameAnalysis>();
    for (const item of items) {
        const ordinal = strictOrdinal(item.ordinal, REMAKE_FRAME_COUNT);
        if (!ordinal || byOrdinal.has(ordinal)) throw new Error("视频理解模型返回了重复或无效的镜头编号");
        const rawStart = parseTimestamp(item.startTime);
        const rawEnd = parseTimestamp(item.endTime);
        if (rawStart === null || rawEnd === null || rawStart < 0 || rawEnd <= rawStart || rawEnd > durationSeconds) throw new Error(`镜头 ${ordinal} 的时间字段不合格`);
        const subtitle = strictText(item.subtitle, 2_000, true);
        const sellingPoint = strictText(item.sellingPoint, 2_000, true);
        const shotType = strictText(item.shotType, 200);
        const description = strictText(item.description, 4_000);
        const subjectRatio = strictText(item.subjectRatio, 200);
        if (subtitle === null || sellingPoint === null || !shotType || !description || !subjectRatio || typeof item.hasFace !== "boolean") {
            throw new Error(`镜头 ${ordinal} 的分析字段不完整`);
        }
        const time = roundedSeconds(rawStart);
        const endTime = roundedSeconds(rawEnd);
        byOrdinal.set(ordinal, { ordinal, time, endTime, subtitle, sellingPoint, shotType, description, subjectRatio, hasFace: item.hasFace });
    }
    const frames = Array.from(byOrdinal.values()).sort((left, right) => left.ordinal - right.ordinal);
    if (frames.some((frame, index) => frame.ordinal !== index + 1)) throw new Error("视频理解模型没有覆盖完整的 1-48 镜头编号");
    if (frames[0]?.time !== 0) throw new Error("视频理解模型的第一段必须从视频开头开始");
    for (const [index, frame] of frames.entries()) {
        const previous = frames[index - 1];
        if (previous && frame.time !== previous.endTime) throw new Error("视频理解模型的 48 段时间线必须连续且无重叠");
    }
    if (frames.at(-1)?.endTime !== durationSeconds) throw new Error("视频理解模型的最后一段必须精确结束于视频结尾");
    return { frames, sourceCopy };
}

async function extractAnalyzedFrames(input: { sourcePath: string; workDirectory: string; analysis: VideoFrameAnalysis[]; task: RemakeAnalysisTask; onAsset: (storageKey: string) => void }): Promise<ExtractedFrame[]> {
    const samples = input.analysis.map((frame) => ({ ...frame, outputPath: join(input.workDirectory, `frame-${String(frame.ordinal).padStart(3, "0")}.jpg`) }));
    await mapConcurrent(samples, FRAME_EXTRACTION_CONCURRENCY, async (sample) => {
        await runFfmpeg(["-hide_banner", "-loglevel", "error", "-ss", sample.time.toFixed(3), "-i", input.sourcePath, "-map", "0:v:0", "-frames:v", "1", "-an", "-sn", "-q:v", "3", "-y", sample.outputPath], { timeoutMs: 2 * 60_000 });
    });
    const persisted = await mapConcurrent(samples, FRAME_PERSISTENCE_CONCURRENCY, async (sample) => {
        const bytes = await sharp(await readFile(sample.outputPath), { failOn: "error", limitInputPixels: 80_000_000 })
            .rotate()
            .resize({ width: 1_280, height: 1_280, fit: "inside", withoutEnlargement: true })
            .jpeg({ quality: 86, chromaSubsampling: "4:2:0" })
            .toBuffer();
        const asset = await writeAssetBytes(bytes, "image/jpeg", "image", {
            ownerUserId: input.task.userId,
            source: "remake-analysis",
            taskId: input.task.id,
            originalName: `remake-frame-${String(sample.ordinal).padStart(2, "0")}.jpg`,
            assetIndex: sample.ordinal - 1,
            assetCount: REMAKE_FRAME_COUNT,
        });
        const frameUrl = asset.serverUrl || asset.url;
        const storageKey = storageKeyFromAssetUrl(frameUrl);
        if (storageKey) input.onAsset(storageKey);
        return {
            ordinal: sample.ordinal,
            time: sample.time,
            endTime: sample.endTime,
            frameUrl,
            storageKey,
            analysisStatus: "available" as const,
            subtitle: sample.subtitle,
            sellingPoint: sample.sellingPoint,
            shotType: sample.shotType,
            description: sample.description,
            subjectRatio: sample.subjectRatio,
            hasFace: sample.hasFace,
            bytes,
        };
    });
    return persisted.sort((left, right) => left.ordinal - right.ordinal);
}

async function createAndPersistContactSheets(input: { frames: ExtractedFrame[]; task: RemakeAnalysisTask; onAsset: (storageKey: string) => void }): Promise<RemakeContactSheetInput[]> {
    const batches = Array.from({ length: REMAKE_FRAME_COUNT / FRAME_BATCH_SIZE }, (_, index) => input.frames.slice(index * FRAME_BATCH_SIZE, (index + 1) * FRAME_BATCH_SIZE));
    return mapConcurrent(batches, 2, async (batch, batchIndex) => {
        const groupOrdinal = batchIndex + 1;
        const bytes = await createContactSheet(batch);
        const originalName = `remake-contact-sheet-${String(groupOrdinal).padStart(2, "0")}.jpg`;
        const asset = await writeAssetBytes(bytes, "image/jpeg", "image", {
            ownerUserId: input.task.userId,
            source: "remake-analysis",
            taskId: input.task.id,
            originalName,
            assetIndex: groupOrdinal - 1,
            assetCount: batches.length,
        });
        const url = asset.serverUrl || asset.url;
        const storageKey = storageKeyFromAssetUrl(url);
        if (storageKey) input.onAsset(storageKey);
        return {
            groupOrdinal,
            asset: {
                url,
                storageKey,
                mimeType: "image/jpeg",
                originalName,
                bytes: bytes.length,
                width: CONTACT_SHEET_WIDTH,
                height: CONTACT_SHEET_HEIGHT,
            },
        };
    });
}

async function createContactSheet(batch: ExtractedFrame[]) {
    if (batch.length !== FRAME_BATCH_SIZE) throw new Error("十二宫格必须包含完整的 12 个帧单元");
    const cellWidth = CONTACT_SHEET_WIDTH / CONTACT_SHEET_COLUMNS;
    const cellHeight = CONTACT_SHEET_HEIGHT / CONTACT_SHEET_ROWS;
    const composites: OverlayOptions[] = [];
    for (const [index, frame] of batch.entries()) {
        const image = await sharp(frame.bytes).resize(cellWidth, cellHeight, { fit: "cover", position: "centre" }).toBuffer();
        const left = (index % CONTACT_SHEET_COLUMNS) * cellWidth;
        const top = Math.floor(index / CONTACT_SHEET_COLUMNS) * cellHeight;
        composites.push({ input: image, left, top });
    }
    return sharp({ create: { width: CONTACT_SHEET_WIDTH, height: CONTACT_SHEET_HEIGHT, channels: 3, background: "#111111" } })
        .composite(composites)
        .jpeg({ quality: 84, chromaSubsampling: "4:2:0" })
        .toBuffer();
}

async function planSemanticCopy(input: {
    sourceCopy: string;
    frames: ExtractedFrame[];
    candidates: ResolvedLogicalModel[];
    model: string;
    origin: string;
    credential: string;
    task: RemakeAnalysisTask;
    onCharge: (headers: Headers) => void;
}): Promise<CopyPlan> {
    if (!input.sourceCopy.trim()) return buildCopyPlan(emptyCopySegmentation(), input.frames);
    let latestError: unknown;
    for (const candidate of input.candidates) {
        const baseKey = systemAiIdempotencyKey("remake-copy-planning", input.task.userId, input.task.id, candidate.channelId, candidate.upstreamModel);
        const workerHeaders = maintenanceWorkerContextHeaders(input.credential) || {};
        try {
            const call = await requestStructuredText({
                origin: input.origin,
                cookie: Object.keys(workerHeaders).length ? "" : input.credential,
                candidate,
                messages: [
                    {
                        role: "system",
                        content: REMAKE_FEISHU_COPY_PROMPT,
                    },
                    {
                        role: "system",
                        content:
                            "当前系统执行合同：先把 sourceCopy 连续切成不少于 16 个非空语义段落，再根据每 3 帧的时间、字幕、卖点、镜头类型以及场景动作，把连续段落依次映射到恰好 16 个非空区间，分别对应分镜 1-3、4-6，依此类推直到 46-48。paragraphs.sourceText 和 blocks.sourceText 必须按原语言、原顺序完整连续覆盖 sourceCopy，禁止翻译、重排、遗漏或重复任何原文字符。每个 block 还必须返回最终 text：仅可依据视频口播和可见字幕补全缺失内容、纠正明显 ASR 错字或标点，不得改变语言、品牌、商品、卖点、价格、数量、规格、事实或表达意图，不得润色和营销改写。每个段落只能归入一个区间。必须调用 build_remake_copy_plan。",
                    },
                    { role: "user", content: JSON.stringify(copyPlanningInput(input.sourceCopy, input.frames)) },
                ],
                tool: remakeCopyTool,
                headers: planningHeaders(input.model, candidate, `${baseKey}:tool`, workerHeaders),
                fallbackHeaders: planningHeaders(input.model, candidate, `${baseKey}:json`, workerHeaders),
                preferNativeTools: true,
                validateArguments: (argumentsText) => parseCopySegments(argumentsText, input.sourceCopy) !== null,
                onInvalidResponse: (headers) => refundInvalidResponse(input.task.userId, input.model, headers),
            });
            const segments = parseCopySegments(call.arguments, input.sourceCopy);
            if (!segments) {
                await refundInvalidResponse(input.task.userId, input.model, call.headers);
                throw new Error("文案模型没有完整、连续地覆盖原文");
            }
            const plan = buildCopyPlan(segments, input.frames);
            input.onCharge(call.headers);
            return plan;
        } catch (error) {
            latestError = error;
        }
    }
    throw new Error(toSafeGenerationErrorMessage(latestError, "文案模型未返回完整的 16 段语义切分"));
}

function copyPlanningInput(sourceCopy: string, frames: ExtractedFrame[]) {
    return {
        sourceCopy,
        frameGroups: Array.from({ length: REMAKE_COPY_BLOCK_COUNT }, (_, index) => {
            const groupFrames = frames.slice(index * 3, index * 3 + 3);
            return {
                blockOrdinal: index + 1,
                frameOrdinals: groupFrames.map((frame) => frame.ordinal),
                startTime: groupFrames[0]?.time,
                endTime: groupFrames.at(-1)?.endTime,
                frames: groupFrames.map((frame) => ({
                    ordinal: frame.ordinal,
                    startTime: frame.time,
                    endTime: frame.endTime,
                    subtitle: frame.subtitle,
                    sellingPoint: frame.sellingPoint,
                    shotType: frame.shotType,
                    sceneAndAction: frame.description,
                    subjectRatio: frame.subjectRatio,
                    hasFace: frame.hasFace,
                })),
            };
        }),
    };
}

function planningHeaders(model: string, candidate: ResolvedLogicalModel, idempotencyKey: string, workerHeaders: Record<string, string>) {
    return {
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
        "X-Client-Request-Id": idempotencyKey,
        ...workerHeaders,
        ...systemAiBillingHeaders(model, idempotencyKey, candidate.upstreamModel),
    };
}

function parseCopySegments(argumentsText: string, sourceCopy: string): CopySegmentation | null {
    let payload: Record<string, unknown>;
    try {
        payload = JSON.parse(argumentsText) as Record<string, unknown>;
    } catch {
        return null;
    }
    const items = records(payload.blocks);
    if (items.length !== REMAKE_COPY_BLOCK_COUNT) return null;
    const planned = new Map<number, { sourceText: string; text: string; paragraphOrdinals?: number[] }>();
    for (const item of items) {
        const ordinal = strictOrdinal(item.ordinal, REMAKE_COPY_BLOCK_COUNT);
        if (!ordinal || planned.has(ordinal) || typeof item.sourceText !== "string" || item.sourceText.length > 20_000 || !normalizeCoverageText(item.sourceText) || typeof item.text !== "string" || item.text.length > 20_000 || !item.text.trim())
            return null;
        const hasParagraphOrdinals = Object.prototype.hasOwnProperty.call(item, "paragraphOrdinals");
        const parsedParagraphOrdinals = hasParagraphOrdinals ? strictOrdinalList(item.paragraphOrdinals, 500) : undefined;
        const paragraphOrdinals = parsedParagraphOrdinals || undefined;
        if (hasParagraphOrdinals && !paragraphOrdinals?.length) return null;
        planned.set(ordinal, { sourceText: item.sourceText, text: item.text, paragraphOrdinals });
    }
    const ordered = Array.from({ length: REMAKE_COPY_BLOCK_COUNT }, (_, index) => planned.get(index + 1));
    if (ordered.some((value) => value === undefined)) return null;
    const complete = ordered as Array<{ sourceText: string; text: string; paragraphOrdinals?: number[] }>;
    const normalized = complete.map((value) => normalizeCoverageText(value.sourceText));
    if (normalized.some((value) => !value)) return null;
    if (normalized.join("") !== normalizeCoverageText(sourceCopy)) return null;
    const restored = restoreExactSourceSegments(
        sourceCopy,
        normalized.map((value) => Array.from(value).length),
    );
    if (!restored || restored.some((value, index) => value.length > 20_000 || !value.trim() || normalizeCoverageText(value) !== normalized[index])) return null;

    const hasParagraphs = Object.prototype.hasOwnProperty.call(payload, "paragraphs");
    if (!hasParagraphs) {
        if (complete.some((value) => value.paragraphOrdinals !== undefined)) return null;
        return {
            segments: restored,
            texts: complete.map((value) => value.text),
            paragraphs: restored.map((text, index) => ({ ordinal: index + 1, text })),
            paragraphOrdinalsByBlock: restored.map((_, index) => [index + 1]),
        };
    }

    const paragraphItems = records(payload.paragraphs);
    if (paragraphItems.length < REMAKE_COPY_BLOCK_COUNT || paragraphItems.length > 500) return null;
    const plannedParagraphs = new Map<number, string>();
    for (const item of paragraphItems) {
        const ordinal = strictOrdinal(item.ordinal, paragraphItems.length);
        if (!ordinal || plannedParagraphs.has(ordinal) || typeof item.sourceText !== "string" || item.sourceText.length > 20_000 || !normalizeCoverageText(item.sourceText)) return null;
        plannedParagraphs.set(ordinal, item.sourceText);
    }
    const orderedParagraphs = Array.from({ length: paragraphItems.length }, (_, index) => plannedParagraphs.get(index + 1));
    if (orderedParagraphs.some((value) => value === undefined)) return null;
    const normalizedParagraphs = (orderedParagraphs as string[]).map(normalizeCoverageText);
    if (normalizedParagraphs.join("") !== normalizeCoverageText(sourceCopy)) return null;
    const restoredParagraphs = restoreExactSourceSegments(
        sourceCopy,
        normalizedParagraphs.map((value) => Array.from(value).length),
    );
    if (!restoredParagraphs || restoredParagraphs.some((value, index) => value.length > 20_000 || !value.trim() || normalizeCoverageText(value) !== normalizedParagraphs[index])) return null;

    const paragraphOrdinalsByBlock = complete.map((value) => value.paragraphOrdinals || []);
    const flattenedOrdinals = paragraphOrdinalsByBlock.flat();
    if (flattenedOrdinals.length !== restoredParagraphs.length || flattenedOrdinals.some((ordinal, index) => ordinal !== index + 1)) return null;
    if (
        paragraphOrdinalsByBlock.some((ordinals, blockIndex) => {
            const text = ordinals.map((ordinal) => restoredParagraphs[ordinal - 1]).join("");
            return normalizeCoverageText(text) !== normalized[blockIndex];
        })
    )
        return null;
    return {
        segments: restored,
        texts: complete.map((value) => value.text),
        paragraphs: restoredParagraphs.map((text, index) => ({ ordinal: index + 1, text })),
        paragraphOrdinalsByBlock,
    };
}

function strictOrdinalList(value: unknown, maximum: number) {
    if (!Array.isArray(value) || !value.length || value.length > maximum) return null;
    const ordinals = value.map((item) => strictOrdinal(item, maximum));
    return ordinals.every(Boolean) && new Set(ordinals).size === ordinals.length ? ordinals : null;
}

function restoreExactSourceSegments(source: string, normalizedLengths: number[]) {
    const characters = Array.from(source);
    const segments: string[] = [];
    let cursor = 0;
    for (const [index, length] of normalizedLengths.entries()) {
        if (index === normalizedLengths.length - 1) {
            segments.push(characters.slice(cursor).join(""));
            cursor = characters.length;
            continue;
        }
        const start = cursor;
        let consumed = 0;
        while (cursor < characters.length && consumed < length) {
            if (!/\s/u.test(characters[cursor])) consumed += 1;
            cursor += 1;
        }
        if (consumed !== length) return null;
        segments.push(characters.slice(start, cursor).join(""));
    }
    return cursor === characters.length ? segments : null;
}

function buildCopyPlan(segmentation: CopySegmentation, frames: ExtractedFrame[]): CopyPlan {
    if (segmentation.segments.length !== REMAKE_COPY_BLOCK_COUNT || segmentation.texts.length !== REMAKE_COPY_BLOCK_COUNT || segmentation.paragraphOrdinalsByBlock.length !== REMAKE_COPY_BLOCK_COUNT || frames.length !== REMAKE_FRAME_COUNT) {
        throw new Error("无法生成完整的 16 个文案区间");
    }
    const blocks = segmentation.segments.map((sourceText, index): RemakeCopyBlock => {
        const ordinal = index + 1;
        const firstFrameOrdinal = index * 3 + 1;
        const firstFrame = frames[firstFrameOrdinal - 1];
        const lastFrame = frames[firstFrameOrdinal + 1];
        return {
            id: `copy-block-${ordinal}`,
            ordinal,
            frameOrdinals: [firstFrameOrdinal, firstFrameOrdinal + 1, firstFrameOrdinal + 2],
            startTime: firstFrame.time,
            endTime: lastFrame.endTime,
            sourceText,
            text: segmentation.texts[index],
        };
    });
    const hasNarration = blocks.some((block) => block.sourceText.trim());
    if (hasNarration && blocks.some((block) => !block.sourceText.trim() || !block.text.trim())) throw new Error("文案模型必须返回完整的 16 个非空文案区间");
    if (!hasNarration && blocks.some((block) => block.sourceText.trim() || block.text.trim())) throw new Error("无口播视频的文案区间必须保持为空");
    const mappings = blocks.map((block, index) => ({
        blockOrdinal: block.ordinal,
        paragraphOrdinals: segmentation.paragraphOrdinalsByBlock[index],
        sourceText: block.sourceText,
        text: block.text,
    }));
    const statuses = blocks.map((block, index) => classifyCopyBlock(block, frames.slice(index * REMAKE_FRAMES_PER_COPY_BLOCK, index * REMAKE_FRAMES_PER_COPY_BLOCK + REMAKE_FRAMES_PER_COPY_BLOCK)));
    const countStatus = (status: CopyBlockStatus) => statuses.filter((value) => value === status).length;
    const optionRaw = hasNarration ? "A: 保持原文案" : REMAKE_NO_NARRATION_TEXT;
    return {
        blocks,
        copy: {
            status: "completed",
            optionRaw,
            rawReport: renderFeishuCopyReport(blocks, segmentation.paragraphs, mappings, statuses, optionRaw),
            paragraphs: segmentation.paragraphs,
            mappings,
            checks: { sequential: true, noDuplicates: true, noSkips: true },
            stats: {
                paragraphCount: segmentation.paragraphs.length,
                unchangedBlocks: countStatus("unchanged"),
                completedBlocks: countStatus("completed"),
                correctedBlocks: countStatus("corrected"),
                emptyBlocks: countStatus("empty"),
            },
        },
    };
}

function emptyCopySegmentation(): CopySegmentation {
    return {
        segments: Array.from({ length: REMAKE_COPY_BLOCK_COUNT }, () => ""),
        texts: Array.from({ length: REMAKE_COPY_BLOCK_COUNT }, () => ""),
        paragraphs: [],
        paragraphOrdinalsByBlock: Array.from({ length: REMAKE_COPY_BLOCK_COUNT }, () => []),
    };
}

function classifyCopyBlock(block: RemakeCopyBlock, frames: ExtractedFrame[]): CopyBlockStatus {
    if (!block.text.trim()) return "empty";
    const sourceText = normalizeCopyComparisonText(block.sourceText);
    const finalText = normalizeCopyComparisonText(block.text);
    if (sourceText !== finalText) return isCharacterSubsequence(sourceText, finalText) ? "completed" : "corrected";
    const visibleSubtitles = normalizeCopyComparisonText(frames.map((frame) => frame.subtitle).join(""));
    return visibleSubtitles === finalText ? "unchanged" : "completed";
}

function normalizeCopyComparisonText(value: string) {
    return Array.from(value.normalize("NFKC").toLocaleLowerCase())
        .filter((character) => !/[\s\p{P}\p{S}]/u.test(character))
        .join("");
}

function isCharacterSubsequence(source: string, target: string) {
    if (!source) return true;
    const sourceCharacters = Array.from(source);
    let cursor = 0;
    for (const character of Array.from(target)) {
        if (character === sourceCharacters[cursor]) cursor += 1;
        if (cursor === sourceCharacters.length) return true;
    }
    return false;
}

function renderFeishuVideoAnalysis(frames: VideoFrameAnalysis[]) {
    const sectionNames = ["第一部分", "第二部分", "第三部分", "第四部分"];
    return Array.from({ length: REMAKE_FRAME_COUNT / FRAME_BATCH_SIZE }, (_, groupIndex) => {
        const batch = frames.slice(groupIndex * FRAME_BATCH_SIZE, (groupIndex + 1) * FRAME_BATCH_SIZE);
        const start = groupIndex * FRAME_BATCH_SIZE + 1;
        const end = start + FRAME_BATCH_SIZE - 1;
        const recordsText = batch
            .map(
                (frame) =>
                    `分镜${frame.ordinal}:\n时间: "${formatTimestamp(frame.time)}-${formatTimestamp(frame.endTime)}"\n字幕: "${quotedText(frame.subtitle)}"\n卖点: "${quotedText(frame.sellingPoint)}"\n镜头类型: "${quotedText(frame.shotType)}"\n画面描述: "${quotedText(frame.description)}"\n人物占比: "${quotedText(frame.subjectRatio)}"\n是否包含人脸: "${frame.hasFace ? "是" : "否"}"`,
            )
            .join("\n\n");
        return `### ${sectionNames[groupIndex]}：分镜${start}-${end}\n${recordsText}`;
    }).join("\n\n---\n\n");
}

function renderFeishuCopyReport(blocks: RemakeCopyBlock[], paragraphs: Array<{ ordinal: number; text: string }>, mappings: Array<{ blockOrdinal: number; paragraphOrdinals: number[] }>, statuses: CopyBlockStatus[], optionRaw: string) {
    const mappingByBlock = new Map(mappings.map((mapping) => [mapping.blockOrdinal, mapping.paragraphOrdinals]));
    const allocationRows = blocks
        .map((block) => {
            const paragraphReferences = (mappingByBlock.get(block.ordinal) || []).map((ordinal) => `段落${ordinal}`).join("、") || "-";
            return `| 区间${block.ordinal} | 分镜${block.frameOrdinals[0]}-${block.frameOrdinals[2]} | ${paragraphReferences} |`;
        })
        .join("\n");
    const statusRows = blocks.map((block, index) => `| 区间${block.ordinal} | 分镜${block.frameOrdinals[0]}-${block.frameOrdinals[2]} | ${reportCell(Array.from(block.text).slice(0, 20).join(""))} | ${copyStatusLabel(statuses[index])} |`).join("\n");
    const countStatus = (status: CopyBlockStatus) => statuses.filter((value) => value === status).length;
    const numerals = ["一", "二", "三", "四"];
    const groups = Array.from({ length: 4 }, (_, groupIndex) => {
        const rows = blocks
            .slice(groupIndex * 4, groupIndex * 4 + 4)
            .map((block) => `| 分镜${block.frameOrdinals[0]}-${block.frameOrdinals[2]} | ${reportCell(block.text)} |`)
            .join("\n");
        return `=== 第${numerals[groupIndex]}部分：分镜${groupIndex * 12 + 1}-${groupIndex * 12 + 12}（第${numerals[groupIndex]}张十二宫格） ===\n\n| 分镜区间 | 字幕 |\n| --- | --- |\n${rows}`;
    }).join("\n\n---\n\n");
    return `=== 文案切分结果 ===\n\n- 文案段落数量：${paragraphs.length} 个\n- 分镜区间数量：${REMAKE_COPY_BLOCK_COUNT} 个\n\n段落分配表：\n| 区间 | 分镜范围 | 文案段落 |\n| --- | --- | --- |\n${allocationRows}\n\n---\n\n=== 处理方式 ===\n\n选择：${optionRaw}\n\n---\n\n=== 顺序填充检查 ===\n\n| 区间 | 分镜范围 | 文案内容（前 20 字符） | 状态 |\n| --- | --- | --- | --- |\n${statusRows}\n\n检查结果：\n- 顺序正确：是\n- 无重复：是\n- 无跳跃：是\n\n---\n\n=== 字幕补全校对统计 ===\n\n- 保持不变：${countStatus("unchanged")} 个区间\n- 补全字幕：${countStatus("completed")} 个区间\n- 校对修正：${countStatus("corrected")} 个区间\n- 字幕为空：${countStatus("empty")} 个区间\n\n---\n\n${groups}`;
}

function copyStatusLabel(status: CopyBlockStatus) {
    if (status === "unchanged") return "保持不变";
    if (status === "completed") return "补全字幕";
    if (status === "corrected") return "校对修正";
    return "字幕为空";
}

async function refundInvalidResponse(userId: string, model: string, headers: Headers) {
    if (!userId) return;
    const billing = readSystemAiBilling(headers);
    if (hasSystemAiCharge(billing)) await refundUserPoints(userId, model, billing.pointsCost, "text", 1, undefined, billing.pointsRecordId);
}

function trackAnalysisCharge(pendingRefunds: Map<string, PendingAnalysisRefund>, task: RemakeAnalysisTask, model: string, stage: "video-understanding" | "copy-planning", headers: Headers) {
    const billing = readSystemAiBilling(headers);
    if (!hasSystemAiCharge(billing) || pendingRefunds.has(billing.pointsRecordId)) return;
    pendingRefunds.set(billing.pointsRecordId, {
        userId: task.userId,
        model,
        pointsCost: billing.pointsCost,
        pointsRecordId: billing.pointsRecordId,
        idempotencyKey: systemAiIdempotencyKey("remake-analysis-refund", task.userId, task.id, task.runId, stage, billing.pointsRecordId),
    });
}

async function refundPendingAnalysisCharges(pendingRefunds: Map<string, PendingAnalysisRefund>) {
    await Promise.all(Array.from(pendingRefunds.values(), (refund) => Promise.resolve(refundUserPoints(refund.userId, refund.model, refund.pointsCost, "text", 1, refund.idempotencyKey, refund.pointsRecordId)).catch(() => undefined)));
}

function videoRotation(video: Record<string, unknown>) {
    const tagRotation = Number(object(video.tags).rotate);
    if (Number.isFinite(tagRotation)) return Math.abs(Math.round(tagRotation));
    const sideData = records(video.side_data_list).find((item) => Number.isFinite(Number(item.rotation)));
    return Math.abs(Math.round(Number(sideData?.rotation) || 0));
}

function aspectRatio(width: number, height: number) {
    const common = [
        { ratio: "16:9", value: 16 / 9 },
        { ratio: "9:16", value: 9 / 16 },
        { ratio: "4:3", value: 4 / 3 },
        { ratio: "3:4", value: 3 / 4 },
        { ratio: "1:1", value: 1 },
    ].find((item) => Math.abs(width / height - item.value) < 0.03);
    if (common) return common.ratio;
    const divisor = greatestCommonDivisor(width, height);
    return `${Math.round(width / divisor)}:${Math.round(height / divisor)}`;
}

function greatestCommonDivisor(left: number, right: number) {
    let a = Math.abs(Math.round(left));
    let b = Math.abs(Math.round(right));
    while (b) [a, b] = [b, a % b];
    return Math.max(1, a);
}

function storageKeyFromAssetUrl(value: string) {
    const prefix = "/api/generation-log-assets/";
    if (!value.startsWith(prefix)) return undefined;
    try {
        return value
            .slice(prefix.length)
            .split("/")
            .map((segment) => decodeURIComponent(segment))
            .join("/");
    } catch {
        return undefined;
    }
}

async function mapConcurrent<T, R>(items: T[], limit: number, run: (item: T, index: number) => Promise<R>) {
    const results = new Array<R>(items.length);
    let cursor = 0;
    let firstError: unknown;
    await Promise.all(
        Array.from({ length: Math.min(limit, items.length) }, async () => {
            while (cursor < items.length && !firstError) {
                const index = cursor++;
                try {
                    results[index] = await run(items[index], index);
                } catch (error) {
                    firstError ||= error;
                }
            }
        }),
    );
    if (firstError) throw firstError;
    return results;
}

function parseTimestamp(value: unknown) {
    if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : null;
    if (typeof value !== "string" || !value.trim()) return null;
    const text = value.trim();
    if (!text.includes(":")) {
        const number = Number(text);
        return Number.isFinite(number) && number >= 0 ? number : null;
    }
    const parts = text.split(":");
    if (parts.length < 2 || parts.length > 3 || parts.some((part) => !/^\d+(?:\.\d+)?$/u.test(part))) return null;
    const numbers = parts.map(Number);
    const seconds = numbers.at(-1) || 0;
    const minutes = numbers.at(-2) || 0;
    const hours = numbers.length === 3 ? numbers[0] : 0;
    return hours * 3_600 + minutes * 60 + seconds;
}

function strictOrdinal(value: unknown, maximum: number) {
    const number = Number(value);
    return Number.isInteger(number) && number >= 1 && number <= maximum ? number : 0;
}

function strictText(value: unknown, maximum: number, allowEmpty = false) {
    if (typeof value !== "string" || value.length > maximum) return null;
    const text = value.trim();
    return text || allowEmpty ? text : null;
}

function roundedSeconds(value: number) {
    return Number(value.toFixed(3));
}

function formatTimestamp(value: number) {
    const rounded = roundedSeconds(Math.max(0, value));
    const minutes = Math.floor(rounded / 60);
    const seconds = rounded - minutes * 60;
    const rawSeconds = seconds
        .toFixed(3)
        .replace(/\.0+$/u, "")
        .replace(/(\.\d*?)0+$/u, "$1");
    return `${minutes}:${seconds < 10 ? `0${rawSeconds}` : rawSeconds}`;
}

function quotedText(value: string) {
    return value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"').replace(/\r?\n/gu, "\\n");
}

function reportCell(value: string) {
    return value.replace(/\|/gu, "\\|").replace(/\s+/gu, " ").trim() || "-";
}

function normalizeCoverageText(value: string) {
    return Array.from(value)
        .filter((character) => !/\s/u.test(character))
        .join("");
}

function positiveNumber(value: unknown) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : 0;
}

function positiveInteger(value: unknown) {
    return Math.floor(positiveNumber(value));
}

function records(value: unknown): Record<string, unknown>[] {
    return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
}

function object(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function jsonText(value: unknown) {
    if (typeof value === "string") return value.trim();
    try {
        return value && typeof value === "object" ? JSON.stringify(value) : "";
    } catch {
        return "";
    }
}

const remakeVideoTool = {
    name: "analyze_remake_video",
    description: "完整分析电商视频，按视频原语言逐字返回口播原文及固定 48 个镜头单元",
    parameters: {
        type: "object",
        properties: {
            sourceCopy: { type: "string", description: "按视频原语言逐字转写的完整口播，不得翻译；无口播时返回空字符串" },
            frames: {
                type: "array",
                minItems: REMAKE_FRAME_COUNT,
                maxItems: REMAKE_FRAME_COUNT,
                items: {
                    type: "object",
                    properties: {
                        ordinal: { type: "integer", minimum: 1, maximum: REMAKE_FRAME_COUNT },
                        startTime: { type: "string", description: "镜头起始时间，格式 m:ss.xx" },
                        endTime: { type: "string", description: "镜头结束时间，格式 m:ss.xx" },
                        subtitle: { type: "string" },
                        sellingPoint: { type: "string" },
                        shotType: { type: "string" },
                        description: { type: "string" },
                        subjectRatio: { type: "string" },
                        hasFace: { type: "boolean" },
                    },
                    required: ["ordinal", "startTime", "endTime", "subtitle", "sellingPoint", "shotType", "description", "subjectRatio", "hasFace"],
                    additionalProperties: false,
                },
            },
        },
        required: ["sourceCopy", "frames"],
        additionalProperties: false,
    },
};

const remakeCopyTool = {
    name: "plan_remake_copy",
    description: "保留原文切片，并依据 48 帧上下文输出仅补全字幕或校对明显 ASR 错误后的 16 个最终文案区间",
    parameters: {
        type: "object",
        properties: {
            paragraphs: {
                type: "array",
                minItems: REMAKE_COPY_BLOCK_COUNT,
                maxItems: 500,
                items: {
                    type: "object",
                    properties: {
                        ordinal: { type: "integer", minimum: 1, maximum: 500 },
                        sourceText: { type: "string" },
                    },
                    required: ["ordinal", "sourceText"],
                    additionalProperties: false,
                },
            },
            blocks: {
                type: "array",
                minItems: REMAKE_COPY_BLOCK_COUNT,
                maxItems: REMAKE_COPY_BLOCK_COUNT,
                items: {
                    type: "object",
                    properties: {
                        ordinal: { type: "integer", minimum: 1, maximum: REMAKE_COPY_BLOCK_COUNT },
                        paragraphOrdinals: {
                            type: "array",
                            minItems: 1,
                            maxItems: 500,
                            items: { type: "integer", minimum: 1, maximum: 500 },
                        },
                        sourceText: { type: "string", description: "sourceCopy 的原语言连续切片，禁止改写、翻译、遗漏或重排" },
                        text: { type: "string", description: "最终文案；只允许依据视频补全缺失字幕或纠正明显 ASR/标点错误，不得更改品牌、商品、卖点、价格、数量、规格、事实、语言或表达意图" },
                    },
                    required: ["ordinal", "paragraphOrdinals", "sourceText", "text"],
                    additionalProperties: false,
                },
            },
        },
        required: ["paragraphs", "blocks"],
        additionalProperties: false,
    },
};
