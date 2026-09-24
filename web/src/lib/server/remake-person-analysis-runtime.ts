import { isOriginalRemakePersonLayout, remakePersonFrameGroups, remakePersonCopyFrameGroups, remakePersonGridLayout } from "@/lib/remake-person-layout";
import { remakePersonSegmentCopyPrompt } from "@/lib/remake-person-segment-prompts";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp, { type OverlayOptions } from "sharp";

import { getAuthSettings, refundUserPoints } from "@/lib/auth/store";
import { runFfmpeg, runFfprobe } from "@/lib/server/ffmpeg";
import { toSafeGenerationErrorMessage } from "@/lib/server/generation-errors";
import { writeAssetBytes } from "@/lib/server/generation-log-repository";
import { REMAKE_FEISHU_ANALYSIS_PROMPT, REMAKE_FEISHU_COPY_PROMPT } from "@/lib/remake-person-feishu-prompts";
import { resolveLogicalModelCandidates, type ResolvedLogicalModel } from "@/lib/server/logical-model-router";
import { maintenanceWorkerContext, maintenanceWorkerContextHeaders } from "@/lib/server/maintenance-auth";
import { downloadMediaToFile } from "@/lib/server/media-download";
import { buildDoubaoFileUploadBody, fetchDoubaoFileApi, readDoubaoJsonResponse } from "@/lib/server/doubao-file-api";
import { requestDoubaoVideoResponse } from "@/lib/server/doubao-video-response";
import { writeReferenceMediaFile } from "@/lib/server/reference-asset-store";
import { completeRemakeAnalysisTask, failRemakeAnalysisTask, markRemakeAnalysisTaskRunning, updateRemakeAnalysisTaskProgress, type RemakeAnalysisTask } from "@/lib/server/remake-person-analysis-task-store";
import {
    isRemakeNoNarrationCopy,
    remakeSourceCopyForAnalysis,
    REMAKE_COPY_BLOCK_COUNT,
    REMAKE_FRAME_COUNT,
    REMAKE_NO_NARRATION_TEXT,
    type RemakeContactSheetInput,
    type RemakeCopyBlock,
    type RemakeCopyState,
    type RemakeFrame,
    type RemakeMediaAsset,
    type RemakeSourceVideo,
} from "@/lib/server/remake-person-project-contract";
import { completeRemakeProjectAnalysis, failRemakeProjectAnalysis, markRemakeProjectAnalysisRunning, RemakeAnalysisSupersededError } from "@/lib/server/remake-person-project-service";
import { hasSystemAiCharge, readSystemAiBilling, systemAiBillingHeaders, systemAiIdempotencyKey } from "@/lib/server/system-ai-billing";
import { rankTextPlanningCandidates } from "@/lib/server/text-planning-runtime";
import { requestRemakeVisionPrompt, RemakeProductionVisionError } from "./remake-vision-request";
import { parseRemakePersonAnalysisBody, parseRemakePersonCopyBody } from "@/lib/remake-person-original-output";
import { transcribeBangbangVideo } from "./bangbang-asr";
import { requestFrameRemakeTranscription, resolveFrameTranscriptionModel } from "./frame-remake-transcription";
import { deleteUserMediaAssetsCascade } from "@/lib/server/user-media-deletion-service";

type ProbeResult = { hasAudio: boolean; durationMs: number; width: number; height: number; ratio: string };
type VideoFrameAnalysis = Pick<RemakeFrame, "segmentIndex" | "subtitle" | "sellingPoint" | "shotType" | "description" | "subjectRatio" | "hasFace"> & {
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
const FRAME_EXTRACTION_CONCURRENCY = 4;
const FRAME_PERSISTENCE_CONCURRENCY = 4;
// Allow one analysis frame plus timestamp rounding; whole-second rounding is checked separately below.
const VIDEO_END_TOLERANCE_MS = 100;
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
    let analysisRaw: string | undefined;
    let transcriptionRaw: string | undefined;
    try {
        const project = await markRemakeProjectAnalysisRunning(task);
        if (isStrictAnalysisComplete(project)) {
            await completeRemakeAnalysisTask(task, project.analysis.warning);
            return { status: "completed" as const, warning: project.analysis.warning };
        }
        if (!project.sourceVideo?.url) throw new Error("复刻项目缺少原视频");

        workDirectory = await mkdtemp(join(tmpdir(), "vozeb-remake-person-analysis-"));
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
            onResponse: (raw) => { analysisRaw = raw; },
            onCharge: (headers: Headers) => trackAnalysisCharge(pendingRefunds, task, models.videoModel, "video-understanding", headers),
        });

        let sourceCopy = remakeSourceCopyForAnalysis(project, understanding.sourceCopy);
        if (!sourceCopy && probe.hasAudio && project.sourceCopy.trim() !== REMAKE_NO_NARRATION_TEXT && project.copy?.optionRaw !== REMAKE_NO_NARRATION_TEXT) {
            // 原文案是独立的输入字段；原版48镜头提示词不承担音轨转录。
            await updateRemakeAnalysisTaskProgress(task, { stage: "analyzing", progress: 38 });
            if (process.env.DASHSCOPE_API_KEY?.trim() || process.env.DASHSCOPE_KEY?.trim()) {
                const transcript = await transcribeBangbangVideo({ sourcePath, workDirectory, hasAudio: true });
                sourceCopy = transcript.status === "transcribed" ? transcript.text : "";
            } else {
                const candidate = resolveFrameTranscriptionModel(await getAuthSettings());
                const key = systemAiIdempotencyKey("remake-person-transcription", task.userId, task.id);
                try {
                    const transcript = await requestFrameRemakeTranscription({ origin: input.origin, credential, candidate,
                        video: { type: "video", file_name: "source.mp4", file_base64: inlineVideo.toString("base64"), content_type: "video/mp4" }, idempotencyKey: key,
                        onResponse: (raw) => { transcriptionRaw = raw; } });
                    sourceCopy = transcript.text;
                    trackAnalysisCharge(pendingRefunds, task, candidate.logicalModelId, "transcription", transcript.headers);
                } catch (error) {
                    if (error instanceof RemakeProductionVisionError && error.responseHeaders) await refundInvalidResponse(task.userId, candidate.logicalModelId, error.responseHeaders);
                    throw error;
                }
            }
        }
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
            onCharge: (headers: Headers) => trackAnalysisCharge(pendingRefunds, task, models.copyModel, "copy-planning", headers),
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
            analysisRaw: analysisRaw ?? renderFeishuVideoAnalysis(understanding.frames),
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
        if (!(error instanceof RemakeAnalysisSupersededError)) await Promise.resolve(failRemakeProjectAnalysis(task, message, analysisRaw, transcriptionRaw)).catch(() => null);
        // 页面在任务终止后立即重新读取项目，先保存原始返回，避免读到旧诊断。
        await Promise.resolve(failRemakeAnalysisTask(task, message)).catch(() => null);
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
        isOriginalRemakePersonLayout(project.frames) &&
        remakePersonFrameGroups(project.frames).length > 0 &&
        project.copyBlocks.length === remakePersonCopyFrameGroups(project.frames).length &&
        project.groups?.filter((group) => group.sourceContactSheet?.url).length === remakePersonFrameGroups(project.frames).length &&
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
    return { hasAudio: streams.some((stream) => stream.codec_type === "audio"), durationMs: Math.max(1, Math.round(durationSeconds * 1_000)), width, height, ratio: aspectRatio(width, height) };
}

async function resolveAnalysisModels() {
    const settings = await getAuthSettings();
    const doubaoLogicalIds = settings.logicalModels
        .filter((logical) => logical.enabled && logical.capability === "text" && logical.bindings.some((binding) => binding.enabled && normalizedModelId(binding.upstreamModel) === DOUBAO_VIDEO_UNDERSTANDING_MODEL))
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
        source: "remake-person-analysis-audio",
        originalName: "remake-person-source-voice.aac",
        runId: input.task.runId,
        taskId: input.task.id,
        projectId: input.task.projectId,
    });
    input.onAsset(stored.token);
    return {
        url: stored.url || `/api/reference-assets/${stored.token}`,
        storageKey: stored.token,
        mimeType: stored.mimeType,
        originalName: "remake-person-source-voice.aac",
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
    onResponse: (raw: string) => void;
    onCharge: (headers: Headers) => void;
}): Promise<VideoUnderstandingResult> {
    let latestError: unknown;
    for (const candidate of input.candidates) {
        const idempotencyKey = systemAiIdempotencyKey("remake-person-video-understanding", input.task.userId, input.task.id, candidate.channelId, candidate.upstreamModel);
        try {
            const call = await requestDoubaoVideoUnderstanding({ ...input, candidate, idempotencyKey });
            input.onResponse(call.arguments);
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
    throw new Error(`来源视频理解失败：${toSafeGenerationErrorMessage(latestError, "视频理解模型未返回完整的镜头分析")}`);
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
        return await requestDoubaoVideoResponse({
            candidate: input.candidate,
            model: input.model,
            origin: input.origin,
            credential: input.credential,
            idempotencyKey: input.idempotencyKey,
            body,
            allowNaturalLanguage: true,
            onInvalidResponse: (headers) => refundInvalidResponse(input.task.userId, input.model, headers),
        });
    } finally {
        await deleteDoubaoFile(input.candidate, fileId).catch(() => undefined);
    }
}

export function buildDoubaoVideoUnderstandingPrompt(durationMs: number, _segmented = false) {
    void _segmented;
    if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error("原视频时长无效");
    return REMAKE_FEISHU_ANALYSIS_PROMPT;
}

async function uploadDoubaoVideo(candidate: ResolvedLogicalModel, bytes: Buffer) {
    const upload = buildDoubaoFileUploadBody(bytes, "remake-person-analysis-video.mp4");
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

export function parseVideoUnderstanding(argumentsText: string, durationMs: number, _segmented = false): VideoUnderstandingResult {
    void _segmented;
    const response = argumentsText.trim();
    const fence = response.match(/^```(?:json|text|markdown|yaml)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i);
    const text = (fence?.[1] ?? response).trim();
    let payload: Record<string, unknown>;
    if (text.startsWith("{") || text.startsWith("[")) {
        let parsed: unknown;
        try {
            parsed = JSON.parse(text);
        } catch {
            throw new Error("模型返回的 JSON 格式不完整，请展开原始返回查看");
        }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("模型返回的 JSON 须为包含 frames 的对象");
        payload = parsed as Record<string, unknown>;
    } else {
        // 正文缺分镜或字段时保留具体原因，不能误报成 JSON 错误。
        payload = parseRemakePersonAnalysisBody(text);
    }
    if (payload.sourceCopy !== undefined && (typeof payload.sourceCopy !== "string" || payload.sourceCopy.length > 200_000)) throw new Error("视频理解模型返回的原文案字段无效");
    const sourceCopy = typeof payload.sourceCopy === "string" ? payload.sourceCopy.trim() : "";
    const items = records(payload.frames);
    if (items.length !== REMAKE_FRAME_COUNT) throw new Error(`视频理解模型返回了 ${items.length} 个分镜，必须返回完整的 ${REMAKE_FRAME_COUNT} 条镜头分析`);
    const durationSeconds = roundedSeconds(durationMs / 1_000);
    const byOrdinal = new Map<number, VideoFrameAnalysis>();
    for (const item of items) {
        const ordinal = strictOrdinal(item.ordinal, REMAKE_FRAME_COUNT);
        if (!ordinal || byOrdinal.has(ordinal)) throw new Error("视频理解模型返回了重复或无效的镜头编号");
        const rawStart = parseTimestamp(item.startTime);
        const rawEnd = parseTimestamp(item.endTime);
        if (rawStart === null || rawEnd === null || !Number.isFinite(rawStart) || !Number.isFinite(rawEnd) || rawStart < 0 || rawEnd <= rawStart) throw new Error(`镜头 ${ordinal} 的时间字段不合格`);
        const time = roundedSeconds(rawStart);
        let endTime = roundedSeconds(rawEnd);
        const endMs = Math.round(endTime * 1_000);
        // 模型可能将真实片尾 38.267 秒四舍五入为 38 秒。只校正最后一镜，
        // 且整秒值必须恰好等于真实时长四舍五入的结果，不放宽其他时间轴校验。
        const roundedToWholeSecond = endMs === Math.round(durationMs / 1_000) * 1_000;
        if (ordinal === items.length && (Math.abs(endMs - durationMs) <= VIDEO_END_TOLERANCE_MS || roundedToWholeSecond)) endTime = durationSeconds;
        if (endTime <= time || endTime > durationSeconds) {
            throw new Error(`镜头 ${ordinal} 的时间字段不合格（开始 ${time} 秒，结束 ${endTime} 秒，视频时长 ${durationSeconds} 秒）`);
        }
        const subtitle = strictText(item.subtitle, 2_000, true);
        const sellingPoint = strictText(item.sellingPoint, 2_000, true);
        const shotType = strictText(item.shotType, 200);
        const description = strictText(item.description, 4_000);
        const subjectRatio = strictText(item.subjectRatio, 200);
        if (subtitle === null || sellingPoint === null || !shotType || !description || !subjectRatio || typeof item.hasFace !== "boolean") {
            throw new Error(`镜头 ${ordinal} 的分析字段不完整`);
        }
        byOrdinal.set(ordinal, { ordinal, time, endTime, subtitle, sellingPoint, shotType, description, subjectRatio, hasFace: item.hasFace });
    }
    const frames = Array.from(byOrdinal.values()).sort((left, right) => left.ordinal - right.ordinal);
    if (frames.some((frame, index) => frame.ordinal !== index + 1)) throw new Error("视频理解模型没有覆盖连续的全部镜头编号");
    if (frames[0]?.time !== 0) throw new Error("视频理解模型的第一段必须从视频开头开始");
    for (const [index, frame] of frames.entries()) {
        const previous = frames[index - 1];
        if (previous && frame.time !== previous.endTime) throw new Error(`分镜${frame.ordinal}从${frame.time}秒开始，上一分镜在${previous.endTime}秒结束；分镜时间线必须连续且无重叠`);
    }
    if (frames.at(-1)?.endTime !== durationSeconds) throw new Error(`最后一个分镜结束于${frames.at(-1)?.endTime}秒，必须精确结束于视频实际结尾${durationSeconds}秒`);
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
            source: "remake-person-analysis",
            taskId: input.task.id,
            originalName: `remake-person-frame-${String(sample.ordinal).padStart(2, "0")}.jpg`,
            assetIndex: sample.ordinal - 1,
            assetCount: samples.length,
        });
        const frameUrl = asset.serverUrl || asset.url;
        const storageKey = storageKeyFromAssetUrl(frameUrl);
        if (storageKey) input.onAsset(storageKey);
        return {
            ordinal: sample.ordinal,
            ...(sample.segmentIndex ? { segmentIndex: sample.segmentIndex } : {}),
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
    const batches = remakePersonFrameGroups(input.frames).map((group) => input.frames.slice(group.startFrame - 1, group.endFrame));
    return mapConcurrent(batches, 2, async (batch, batchIndex) => {
        const groupOrdinal = batchIndex + 1;
        const bytes = await createContactSheet(batch);
        const originalName = `remake-person-contact-sheet-${String(groupOrdinal).padStart(2, "0")}.jpg`;
        const asset = await writeAssetBytes(bytes, "image/jpeg", "image", {
            ownerUserId: input.task.userId,
            source: "remake-person-analysis",
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
    const { columns, rows } = remakePersonGridLayout(batch.length);
    const composites: OverlayOptions[] = [];
    for (const [index, frame] of batch.entries()) {
        const column = index % columns;
        const row = Math.floor(index / columns);
        const left = Math.floor(column * CONTACT_SHEET_WIDTH / columns);
        const top = Math.floor(row * CONTACT_SHEET_HEIGHT / rows);
        const cellWidth = Math.floor((column + 1) * CONTACT_SHEET_WIDTH / columns) - left;
        const cellHeight = Math.floor((row + 1) * CONTACT_SHEET_HEIGHT / rows) - top;
        const image = await sharp(frame.bytes).resize(cellWidth, cellHeight, { fit: "contain", background: "#111111" }).toBuffer();
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
    if (!input.sourceCopy.trim()) return buildCopyPlan(emptyCopySegmentation(remakePersonCopyFrameGroups(input.frames).length), input.frames);
    let latestError: unknown;
    for (const candidate of input.candidates) {
        const baseKey = systemAiIdempotencyKey("remake-person-copy-planning", input.task.userId, input.task.id, candidate.channelId, candidate.upstreamModel);
        const workerHeaders = maintenanceWorkerContextHeaders(input.credential) || {};
        try {
            const call = await requestRemakeVisionPrompt({
                origin: input.origin,
                cookie: Object.keys(workerHeaders).length ? "" : input.credential,
                candidate,
                messages: [
                    { role: "system", content: input.frames[0]?.segmentIndex ? remakePersonSegmentCopyPrompt(input.frames) : REMAKE_FEISHU_COPY_PROMPT },
                    { role: "user", content: JSON.stringify({ "镜头解析": renderFeishuVideoAnalysis(input.frames), "原文案": input.sourceCopy, "用户选择": "选项A：保持原文" }) },
                ],
                boards: [],
                allowTextOnly: true,
                maxOutputTokens: 24_000,
                headers: planningHeaders(input.model, candidate, baseKey, workerHeaders),
            });
            let plan: CopyPlan;
            try {
                plan = parseOriginalCopyPlan(call.text, input.sourceCopy, input.frames);
            } catch (error) {
                await refundInvalidResponse(input.task.userId, input.model, call.headers);
                throw error;
            }
            input.onCharge(call.headers);
            return plan;
        } catch (error) {
            if (error instanceof RemakeProductionVisionError && error.responseHeaders) await refundInvalidResponse(input.task.userId, input.model, error.responseHeaders);
            latestError = error;
        }
    }
    throw new Error(`原文案切分失败：${toSafeGenerationErrorMessage(latestError, "文案模型未返回完整的语义切分")}`);
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

export function parseOriginalCopyPlan(raw: string, sourceCopy: string, frames: RemakeFrame[]): CopyPlan {
    const texts = parseRemakePersonCopyBody(raw, remakePersonCopyFrameGroups(frames));
    const lengths = texts.map((text) => Array.from(normalizeCoverageText(text)).length);
    if (texts.map(normalizeCoverageText).join("") !== normalizeCoverageText(sourceCopy)) throw new Error("选项A的字幕表没有按原顺序完整覆盖原文案");
    const nonempty = lengths.flatMap((length, index) => length ? [index] : []);
    const restored = restoreExactSourceSegments(sourceCopy, nonempty.map((index) => lengths[index]));
    if (!restored) throw new Error("文案预处理无法对应原文区间");
    const segments = texts.map(() => "");
    nonempty.forEach((index, ordinal) => { segments[index] = restored[ordinal]; });
    const paragraphs: CopySegmentation["paragraphs"] = [];
    const paragraphOrdinalsByBlock = segments.map((text) => {
        if (!text.trim()) return [];
        paragraphs.push({ ordinal: paragraphs.length + 1, text });
        return [paragraphs.length];
    });
    const plan = buildCopyPlan({ segments, texts, paragraphs, paragraphOrdinalsByBlock }, frames);
    plan.copy.rawReport = raw;
    return plan;
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

function buildCopyPlan(segmentation: CopySegmentation, frames: RemakeFrame[]): CopyPlan {
    const ranges = remakePersonCopyFrameGroups(frames);
    if (!ranges.length || segmentation.segments.length !== ranges.length || segmentation.texts.length !== ranges.length || segmentation.paragraphOrdinalsByBlock.length !== ranges.length) {
        throw new Error("无法生成完整的全部文案区间");
    }
    const blocks = segmentation.segments.map((sourceText, index): RemakeCopyBlock => {
        const ordinal = index + 1;
        const frameOrdinals = ranges[index];
        const firstFrame = frames[frameOrdinals[0] - 1];
        const lastFrame = frames[frameOrdinals.at(-1)! - 1];
        return {
            id: `copy-block-${ordinal}`,
            ordinal,
            frameOrdinals,
            startTime: firstFrame.time,
            endTime: lastFrame.endTime,
            sourceText,
            text: segmentation.texts[index],
        };
    });
    const hasNarration = blocks.some((block) => block.sourceText.trim());
    if (!hasNarration && blocks.some((block) => block.sourceText.trim() || block.text.trim())) throw new Error("无口播视频的文案区间必须保持为空");
    const mappings = blocks.map((block, index) => ({
        blockOrdinal: block.ordinal,
        paragraphOrdinals: segmentation.paragraphOrdinalsByBlock[index],
        sourceText: block.sourceText,
        text: block.text,
    }));
    const statuses = blocks.map((block, index) => classifyCopyBlock(block, frames.filter((frame) => ranges[index].includes(frame.ordinal))));
    const countStatus = (status: CopyBlockStatus) => statuses.filter((value) => value === status).length;
    const optionRaw = hasNarration ? "A: 保持原文案" : REMAKE_NO_NARRATION_TEXT;
    return {
        blocks,
        copy: {
            status: "completed",
            optionRaw,
            rawReport: renderFeishuCopyReport(blocks, segmentation.paragraphs, mappings, statuses, optionRaw, frames),
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

function emptyCopySegmentation(count = REMAKE_COPY_BLOCK_COUNT): CopySegmentation {
    return {
        segments: Array.from({ length: count }, () => ""),
        texts: Array.from({ length: count }, () => ""),
        paragraphs: [],
        paragraphOrdinalsByBlock: Array.from({ length: count }, () => []),
    };
}

function classifyCopyBlock(block: RemakeCopyBlock, frames: RemakeFrame[]): CopyBlockStatus {
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
    return remakePersonFrameGroups(frames).map((group, groupIndex) => {
        const start = group.startFrame;
        const end = group.endFrame;
        const batch = frames.slice(start - 1, end);
        const recordsText = batch
            .map(
                (frame) =>
                    `分镜${frame.ordinal}:\n时间: "${formatTimestamp(frame.time)}-${formatTimestamp(frame.endTime)}"\n字幕: "${quotedText(frame.subtitle)}"\n卖点: "${quotedText(frame.sellingPoint)}"\n镜头类型: "${quotedText(frame.shotType)}"\n画面描述: "${quotedText(frame.description)}"\n人物占比: "${quotedText(frame.subjectRatio)}"\n是否包含人脸: "${frame.hasFace ? "是" : "否"}"`,
            )
            .join("\n\n");
        return `### ${sectionNames[groupIndex] || `第${groupIndex + 1}部分`}：分镜${start}-${end}\n${recordsText}`;
    }).join("\n\n---\n\n");
}

function renderFeishuCopyReport(blocks: RemakeCopyBlock[], paragraphs: Array<{ ordinal: number; text: string }>, mappings: Array<{ blockOrdinal: number; paragraphOrdinals: number[] }>, statuses: CopyBlockStatus[], optionRaw: string, frames: RemakeFrame[]) {
    const mappingByBlock = new Map(mappings.map((mapping) => [mapping.blockOrdinal, mapping.paragraphOrdinals]));
    const allocationRows = blocks
        .map((block) => {
            const paragraphReferences = (mappingByBlock.get(block.ordinal) || []).map((ordinal) => `段落${ordinal}`).join("、") || "-";
            return `| 区间${block.ordinal} | 分镜${block.frameOrdinals[0]}-${block.frameOrdinals.at(-1)} | ${paragraphReferences} |`;
        })
        .join("\n");
    const statusRows = blocks.map((block, index) => `| 区间${block.ordinal} | 分镜${block.frameOrdinals[0]}-${block.frameOrdinals.at(-1)} | ${reportCell(Array.from(block.text).slice(0, 20).join(""))} | ${copyStatusLabel(statuses[index])} |`).join("\n");
    const countStatus = (status: CopyBlockStatus) => statuses.filter((value) => value === status).length;
    const numerals = ["一", "二", "三", "四"];
    const groups = remakePersonFrameGroups(frames).map((group, groupIndex) => {
        const rows = blocks
            .filter((block) => block.frameOrdinals[0] >= group.startFrame && block.frameOrdinals.at(-1)! <= group.endFrame)
            .map((block) => `| 分镜${block.frameOrdinals[0]}-${block.frameOrdinals.at(-1)} | ${reportCell(block.text)} |`)
            .join("\n");
        return `=== 第${numerals[groupIndex] || groupIndex + 1}部分：分镜${group.startFrame}-${group.endFrame}（第${numerals[groupIndex] || groupIndex + 1}张分镜拼图） ===\n\n| 分镜区间 | 字幕 |\n| --- | --- |\n${rows}`;
    }).join("\n\n---\n\n");
    return `=== 文案切分结果 ===\n\n- 文案段落数量：${paragraphs.length} 个\n- 分镜区间数量：${blocks.length} 个\n\n段落分配表：\n| 区间 | 分镜范围 | 文案段落 |\n| --- | --- | --- |\n${allocationRows}\n\n---\n\n=== 处理方式 ===\n\n选择：${optionRaw}\n\n---\n\n=== 顺序填充检查 ===\n\n| 区间 | 分镜范围 | 文案内容（前 20 字符） | 状态 |\n| --- | --- | --- | --- |\n${statusRows}\n\n检查结果：\n- 顺序正确：是\n- 无重复：是\n- 无跳跃：是\n\n---\n\n=== 字幕补全校对统计 ===\n\n- 保持不变：${countStatus("unchanged")} 个区间\n- 补全字幕：${countStatus("completed")} 个区间\n- 校对修正：${countStatus("corrected")} 个区间\n- 字幕为空：${countStatus("empty")} 个区间\n\n---\n\n${groups}`;
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

function trackAnalysisCharge(pendingRefunds: Map<string, PendingAnalysisRefund>, task: RemakeAnalysisTask, model: string, stage: "video-understanding" | "copy-planning" | "transcription", headers: Headers) {
    const billing = readSystemAiBilling(headers);
    if (!hasSystemAiCharge(billing) || pendingRefunds.has(billing.pointsRecordId)) return;
    pendingRefunds.set(billing.pointsRecordId, {
        userId: task.userId,
        model,
        pointsCost: billing.pointsCost,
        pointsRecordId: billing.pointsRecordId,
        idempotencyKey: systemAiIdempotencyKey("remake-person-analysis-refund", task.userId, task.id, task.runId, stage, billing.pointsRecordId),
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
    const text = value.trim().replace(/：/g, ":").replace(/\s*(?:秒|s)$/i, "");
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
