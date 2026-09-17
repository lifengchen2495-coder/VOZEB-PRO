import { frameRemakeActiveReferences, frameRemakeIsBasicWorkflow, frameRemakeSourceCopyReady, resetFrameRemakeAnalysisFrom } from "@/lib/frame-remake-contract";
import { parseFrameRemakeOriginalAnalysis, parseFrameRemakeCopy } from "@/lib/frame-remake-source";
import { frameRemakeTemplates } from "@/lib/frame-remake-prompt-templates";
import { transcribeBangbangVideo } from "./bangbang-asr";
import { requestFrameRemakeTranscription, FRAME_REMAKE_TRANSCRIPTION_PROMPT } from "./frame-remake-transcription";
import { resolveFrameOriginalModel, requestFrameOriginalText, type FrameOriginalFile } from "./frame-remake-original-gateway";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp, { type OverlayOptions } from "sharp";
import { getAuthSettings, refundUserPoints } from "@/lib/auth/store";
import { assertFrameRemakeTimeline, frameRemakeSeconds, planFrameRemakeTimeline, nextFrameRemakeAnalysisStage, FRAME_REMAKE_ANALYSIS_LABELS, type FrameRemakeGroup, type FrameRemakeMedia, type FrameRemakeProject } from "@/lib/frame-remake-contract";
import { parseFrameRemakeAnalysis } from "@/lib/frame-remake-prompts";
import { assertFrameRemakeAnalysisPromptReady, changedFrameRemake, mutateFrameRemake, ownedFrameRemakeMedia } from "./frame-remake-project-service";
import { getFrameRemakeProject } from "./frame-remake-project-store";
import { runFfmpeg, runFfprobe } from "./ffmpeg";
import { probeOmniVideo } from "./omni-remake-runtime";
import { downloadMediaToFile } from "./media-download";
import { writePersistentMediaDataUrl, writeReferenceMediaFile } from "./reference-asset-store";
import { deleteUserLocalMediaAssets } from "./local-media-storage";
import { maintenanceWorkerContextHeaders } from "./maintenance-auth";
import { hasSystemAiCharge, readSystemAiBilling, systemAiIdempotencyKey } from "./system-ai-billing";
import { getVideoTask } from "./video-task-store";
import { getStoredGenerationTaskRecord } from "./generation-task-store";
import { toSafeGenerationErrorMessage } from "./generation-errors";
import { RemakeProductionVisionError } from "./remake-vision-request";

export const FRAME_REMAKE_MAX_VIDEO_BYTES = 200 * 1024 * 1024;
export type FrameRemakeRuntimeInput = { userId: string; project: FrameRemakeProject; origin: string; credential: string };
export async function inspectFrameRemakeVideo(path: string) {
    const measured = await probeOmniVideo(path);
    const result = await runFfprobe(["-v", "error", "-select_streams", "v:0", "-show_entries", "stream_side_data=rotation", "-of", "json", path], { timeoutMs: 30000 });
    const rotation = Number(JSON.parse(result.stdout).streams?.[0]?.side_data_list?.find((item: { rotation?: number }) => item.rotation !== undefined)?.rotation || 0);
    // FFmpeg 解码时自动转正，画幅也使用转正后的尺寸（常见于手机 MOV）。
    return Math.abs(rotation) % 180 === 90 ? { ...measured, width: measured.height, height: measured.width } : measured;
}

export async function runFrameRemakeOperation(input: FrameRemakeRuntimeInput) {
    const operation = input.project.operation;
    if (!operation) return;
    const directory = await mkdtemp(join(tmpdir(), "vozeb-frame-remake-"));
    const uncommitted = new Set<string>();
    const deadline = Date.now() + 24 * 60_000;
    const canContinue = async () => {
        if (Date.now() >= deadline) return false;
        const latest = await getFrameRemakeProject(input.project.id, input.userId);
        return Boolean(latest && frameRemakeOperationCanContinue(input.project, latest));
    };
    const apply = async (fn: (current: FrameRemakeProject) => FrameRemakeProject, committedKeys: string[] = []) => {
        const result = await mutateFrameRemake(input.userId, input.project.id, (current) => {
            if (current.operation?.id !== operation.id) throw new Error("处理已被新的操作替代");
            const next = fn(current);
            return changedFrameRemake({ ...next, operation: next.operation ? { ...next.operation, updatedAt: new Date().toISOString() } : undefined });
        });
        for (const key of committedKeys) uncommitted.delete(key);
        return result;
    };
    try {
        if (operation.kind === "inspect" || (operation.kind === "extract" && !input.project.groups.length)) assertFrameRemakeAnalysisPromptReady(input.project, undefined, "analysis");
        if (operation.kind === "analyze") assertFrameRemakeAnalysisPromptReady(input.project, operation.groupId, operation.analysisStage);
        if (!(await canContinue())) {
            await apply((current) => ({ ...current, operation: undefined }));
            return;
        }
        if (operation.kind === "inspect" || (operation.kind === "extract" && !input.project.groups.length)) {
            const source = join(directory, "source-video");
            await downloadOwned(input.project.sourceVideo!, source, input);
            const measured = await inspectFrameRemakeVideo(source);
            const durationMs = Math.round(measured.duration * 1000);
            await apply((current) => ({
                ...current,
                sourceVideo: { ...current.sourceVideo!, ...measured },
                durationMs,
                workflowVersion: "feishu-original-15s",
                groups: current.workflowVersion === "feishu-original-15s" && current.durationMs === durationMs && current.groups.length ? current.groups : planFrameRemakeTimeline(durationMs, current.maxSegmentSeconds),
                mergedVideo: undefined,
            }));
        } else if (operation.kind === "extract") {
            assertFrameRemakeTimeline(input.project);
            const group = operation.groupId ? input.project.groups.find((item) => item.id === operation.groupId) : input.project.groups.find((item) => !item.contactSheet || item.frames.some((frame) => !frame.media));
            if (!group) throw new Error("没有待拆帧的分组");
            const source = join(directory, "source-video");
            await downloadOwned(input.project.sourceVideo!, source, input);
            await apply((current) => ({ ...current, operation: { ...current.operation!, groupId: group.id, progress: `正在拆帧：第 ${group.number} / ${input.project.groups.length} 组` } }));
            const extracted = await extractFrameRemakeGroup(source, directory, group);
            const keys: string[] = [];
            const frames: FrameRemakeGroup["frames"] = [];
            for (const [index, bytes] of extracted.frames.entries()) {
                const media = await persistImage(bytes, `frame-${group.frames[index].number}.jpg`, input, uncommitted);
                keys.push(media.storageKey!);
                frames.push({ ...group.frames[index], media });
            }
            const contactSheet = await persistImage(extracted.contactSheet, `${group.id}-source-grid.jpg`, input, uncommitted);
            keys.push(contactSheet.storageKey!);
            const sourceAudio = await extractFrameRemakeAudio(source, directory, group, input, uncommitted);
            if (sourceAudio?.storageKey) keys.push(sourceAudio.storageKey);
            await apply((current) => ({ ...current, groups: current.groups.map((item) => (item.id === group.id ? { ...item, frames, contactSheet, sourceAudio } : item)) }), keys);
        } else if (operation.kind === "transcribe") {
            const group = operation.groupId ? input.project.groups.find((item) => item.id === operation.groupId) : input.project.groups.find((item) => !frameRemakeSourceCopyReady(input.project, item));
            if (!group) throw new Error("没有待转录的分组");
            const source = join(directory, "source-video");
            await downloadOwned(input.project.sourceVideo!, source, input);
            const probe = await inspectFrameRemakeVideo(source);
            const controller = new AbortController();
            const timer = setInterval(() => { void canContinue().then((active) => { if (!active) controller.abort(); }).catch(() => controller.abort()); }, 3000);
            let chargedHeaders: Headers | undefined;
            let saved = false;
            let model = "";
            try {
                let result: { text: string; status: "transcribed" | "no-audio" | "no-speech" } = { text: "", status: "no-audio" };
                let step: FrameRemakeGroup["sourceCopyStep"];
                const started = Date.now();
                if (probe.hasAudio) {
                    const useAsr = Boolean(process.env.DASHSCOPE_API_KEY?.trim() || process.env.DASHSCOPE_KEY?.trim());
                    const candidate = useAsr ? undefined : resolveFrameOriginalModel(await getAuthSettings(), "text", input.project.modelSelection.analysis, { fullVideo: true });
                    model = candidate?.logicalModelId || "paraformer-v2";
                    step = { source: useAsr ? "dashscope-asr" : "system-video-transcription", model, prompt: useAsr ? "" : FRAME_REMAKE_TRANSCRIPTION_PROMPT, startedAt: new Date().toISOString() };
                    await apply((current) => ({ ...current, groups: current.groups.map((g) => g.id === group.id ? { ...g, sourceCopyStep: step } : g) }));
                    const clip = join(directory, useAsr ? "transcription-audio.wav" : "transcription-video.mp4");
                    const encoding = useAsr
                        ? ["-map", "0:a:0", "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le"]
                        : ["-map", "0:v:0", "-map", "0:a:0", "-vf", "scale=min(720\\,iw):-2", "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-c:a", "aac", "-b:a", "64k", "-movflags", "+faststart"];
                    await runFfmpeg(["-y", "-hide_banner", "-loglevel", "error", "-ss", String(group.startMs / 1000), "-i", source, "-t", String(frameRemakeSeconds(group)), ...encoding, clip], { timeoutMs: 180000, signal: controller.signal });
                    if (!(await canContinue())) throw new Error("转录已暂停");
                    if (candidate) {
                        const call = await requestFrameRemakeTranscription({ origin: input.origin, credential: input.credential, candidate, video: { type: "video", file_name: "source.mp4", file_base64: (await readFile(clip)).toString("base64"), content_type: "video/mp4" }, idempotencyKey: systemAiIdempotencyKey("frame-remake-transcribe", input.userId, input.project.id, operation.id, group.id), signal: controller.signal });
                        chargedHeaders = call.headers;
                        result = call;
                    } else result = await transcribeBangbangVideo({ sourcePath: clip, workDirectory: directory, hasAudio: true, signal: controller.signal });
                    step = { ...step, completedAt: new Date().toISOString(), elapsedMs: Date.now() - started };
                }
                if (!(await canContinue())) throw new Error("转录已暂停");
                await apply((current) => ({ ...current, mergedVideo: undefined, groups: current.groups.map((g) => g.id === group.id ? { ...resetFrameRemakeAnalysisFrom(g, "copy"), sourceCopy: result.status === "transcribed" ? result.text : "", sourceCopyStatus: result.status, sourceCopyStep: step } : g) }));
                saved = true;
            } catch (error) {
                if (error instanceof RemakeProductionVisionError && error.responseHeaders) chargedHeaders = error.responseHeaders;
                throw error;
            } finally {
                clearInterval(timer);
                if (!saved && chargedHeaders) {
                    const billing = readSystemAiBilling(chargedHeaders);
                    if (hasSystemAiCharge(billing)) await refundUserPoints(input.userId, model, billing.pointsCost, "text", 1, undefined, billing.pointsRecordId);
                }
            }
        } else if (operation.kind === "analyze") {
            const group = operation.groupId ? input.project.groups.find((item) => item.id === operation.groupId) : input.project.groups.find((item) => nextFrameRemakeAnalysisStage(item, input.project));
            if (!group) throw new Error("没有待分析的分组");
            const { stage, prompt } = assertFrameRemakeAnalysisPromptReady(input.project, group.id, operation.analysisStage);
            const refs = frameRemakeActiveReferences(input.project);
            const images = frameRemakeIsBasicWorkflow(input.project) ? (stage === "copy" || stage === "videoPrompt" ? [group.image.result!] : []) : stage === "productScript" ? [...refs.product, ...refs.character, ...refs.background] : stage === "imagePrompt" ? [group.contactSheet!] : stage === "videoPrompt" ? [group.image.result!, ...refs.product, ...refs.character] : [];
            const settings = await getAuthSettings();
            const candidate = resolveFrameOriginalModel(settings, "text", input.project.modelSelection.analysis, { fullVideo: stage === "analysis", imageCount: images.length });
            const model = candidate.logicalModelId;
            const started = Date.now();
            const step = { prompt, model, startedAt: new Date().toISOString(), ...(stage === "videoPrompt" && frameRemakeIsBasicWorkflow(input.project) ? { promptSource: frameRemakeTemplates(input.project, group).videoSource } : {}) };
            await apply((current) => ({
                ...current,
                operation: { ...current.operation!, groupId: group.id, analysisStage: stage, progress: `第 ${group.number} 组：${FRAME_REMAKE_ANALYSIS_LABELS[stage]}` },
                groups: current.groups.map((g) => (g.id === group.id ? { ...g, analysisSteps: { ...g.analysisSteps, [stage]: step } } : g)),
            }));
            const files: FrameOriginalFile[] = [];
            if (stage === "analysis") {
                const source = join(directory, "source-video"),
                    clip = join(directory, "analysis-video.mp4");
                await downloadOwned(input.project.sourceVideo!, source, input);
                await runFfmpeg(
                    [
                        "-y",
                        "-hide_banner",
                        "-loglevel",
                        "error",
                        "-ss",
                        String(group.startMs / 1000),
                        "-i",
                        source,
                        "-t",
                        String(frameRemakeSeconds(group)),
                        "-map",
                        "0:v:0",
                        "-map",
                        "0:a:0?",
                        "-vf",
                        "scale=min(720\\,iw):-2",
                        "-c:v",
                        "libx264",
                        "-preset",
                        "veryfast",
                        "-crf",
                        "28",
                        "-c:a",
                        "aac",
                        "-b:a",
                        "64k",
                        "-movflags",
                        "+faststart",
                        clip,
                    ],
                    { timeoutMs: 180000 },
                );
                files.push({ type: "video", file_name: "source.mp4", file_base64: (await readFile(clip)).toString("base64"), content_type: "video/mp4", fps: 0.5 });
            } else {
                for (const [index, media] of images.entries()) {
                    const path = join(directory, `reference-${index}`);
                    await downloadOwned(media, path, input);
                    files.push({ type: "image", file_name: media.originalName || `reference-${index + 1}.jpg`, file_base64: (await readFile(path)).toString("base64"), content_type: media.mimeType });
                }
            }
            if (!(await canContinue())) {
                await apply((current) => ({ ...current, operation: undefined }));
                return;
            }
            let saved = false;
            let chargedHeaders: Headers | undefined;
            try {
                const call = await requestFrameOriginalText({
                    origin: input.origin,
                    credential: input.credential,
                    candidate,
                    prompt,
                    files,
                    idempotencyKey: systemAiIdempotencyKey("frame-remake-original", input.userId, input.project.id, operation.id, group.id, stage),
                });
                chargedHeaders = call.headers;
                const result = stage === "analysis" ? parseFrameRemakeOriginalAnalysis(call.text, group) : stage === "copy" ? parseFrameRemakeCopy(call.text, group) : { [stage]: parseFrameRemakeAnalysis(call.text, stage) };
                await apply((current) => ({
                    ...current,
                    modelSelection: { ...current.modelSelection, analysis: model },
                    mergedVideo: undefined,
                    groups: current.groups.map((g) =>
                        g.id === group.id
                            ? {
                                  ...g,
                                  ...result,
                                  ...(stage === "analysis" ? { contactSheet: undefined, sourceAnalysisMode: "video" as const, sourceCopy: g.sourceCopy, sourceCopyStatus: g.sourceCopyStatus } : {}),
                                  analysisSteps: { ...g.analysisSteps, [stage]: { ...step, completedAt: new Date().toISOString(), elapsedMs: Date.now() - started } },
                              }
                            : g,
                    ),
                }));
                saved = true;
            } catch (error) {
                if (error instanceof RemakeProductionVisionError && error.responseHeaders) chargedHeaders = error.responseHeaders;
                throw error;
            } finally {
                if (!saved && chargedHeaders) {
                    const billing = readSystemAiBilling(chargedHeaders);
                    if (hasSystemAiCharge(billing)) await refundUserPoints(input.userId, model, billing.pointsCost, "text", 1, undefined, billing.pointsRecordId);
                }
            }
        } else {
            assertFrameRemakeTimeline(input.project);
            await apply((current) => ({ ...current, operation: { ...current.operation!, progress: "正在按原片时间线合并" } }));
            const media = await mergeFrameRemakeVideos(input, directory);
            uncommitted.add(media.storageKey!);
            await apply((current) => ({ ...current, mergedVideo: media }), [media.storageKey!]);
        }
        await apply((current) => ({ ...current, operation: undefined, error: undefined }));
    } catch (error) {
        const message = toSafeGenerationErrorMessage(error, "拆帧复刻处理失败");
        await apply((current) => ({
            ...current,
            groups: current.groups.map((group) => {
                if (current.operation?.kind === "transcribe" && current.operation.groupId === group.id && group.sourceCopyStep) return { ...group, sourceCopyStep: { ...group.sourceCopyStep, error: message } };
                const stage = current.operation?.analysisStage;
                if (current.operation?.kind !== "analyze" || current.operation.groupId !== group.id || !stage) return group;
                const step = group.analysisSteps?.[stage];
                return { ...group, analysisSteps: { ...group.analysisSteps, [stage]: { prompt: "", model: "", startedAt: operation.startedAt, ...step, error: message } } };
            }),
            operation: undefined,
            error: message,
        })).catch(() => undefined);
    } finally {
        if (uncommitted.size) await deleteUserLocalMediaAssets(input.userId, [...uncommitted]).catch(() => undefined);
        await rm(directory, { recursive: true, force: true });
    }
}

export function frameRemakeOperationCanContinue(started: FrameRemakeProject, current: FrameRemakeProject) {
    if (!started.operation || current.operation?.id !== started.operation.id) return false;
    return started.automation?.status !== "running" || (current.automation?.status === "running" && current.automation.id === started.automation.id);
}

export async function extractFrameRemakeGroup(source: string, directory: string, group: FrameRemakeGroup) {
    const frames: Buffer[] = [];
    for (const frame of group.frames) {
        const output = join(directory, `frame-${frame.number}.jpg`);
        await runFfmpeg(["-y", "-hide_banner", "-loglevel", "error", "-ss", String(frame.sampleMs / 1000), "-i", source, "-map", "0:v:0", "-frames:v", "1", "-q:v", "2", output], { timeoutMs: 60000 });
        const bytes = await readFile(output);
        if (!bytes.length) throw new Error(`第 ${frame.number} 帧提取失败`);
        frames.push(bytes);
    }
    return { frames, contactSheet: await createFrameRemakeContactSheet(group, frames) };
}
export async function createFrameRemakeContactSheet(group: FrameRemakeGroup, frames: Buffer[]) {
    if (frames.length !== group.frames.length) throw new Error("抽帧数量与时间线不一致");
    if (frames.length !== 12) throw new Error("原版拼图需要12帧");
    const tileWidth = 480,
        tileHeight = 640,
        columns = 3,
        rows = 4;
    const overlays: OverlayOptions[] = [];
    const border = Buffer.from(`<svg width="${tileWidth}" height="${tileHeight}"><rect x="2" y="2" width="${tileWidth - 4}" height="${tileHeight - 4}" fill="none" stroke="white" stroke-width="4"/></svg>`);
    for (const [index, bytes] of frames.entries()) {
        const image = await sharp(bytes)
            .resize(tileWidth, tileHeight, { fit: "cover", position: "centre", kernel: "lanczos3" })
            .composite([{ input: border }])
            .png()
            .toBuffer();
        overlays.push({ input: image, left: (index % columns) * tileWidth, top: Math.floor(index / columns) * tileHeight });
    }
    return sharp({ create: { width: columns * tileWidth, height: rows * tileHeight, channels: 3, background: "white" } })
        .composite(overlays)
        .jpeg({ quality: 94 })
        .toBuffer();
}

export function frameRemakeNormalizationArgs(source: string, output: string, seconds: number, hasAudio: boolean, width: number, height: number, generatedSeconds = seconds, timingMode: "trim" | "fit" = "trim") {
    // 完整缩放生成片段至原片时长，保留尾段最后的镜头；历史 trim 任务仍沿用原处理。
    const tempo: number[] = [];
    if (timingMode === "fit") {
        let remaining = generatedSeconds / seconds;
        while (remaining > 2) {
            tempo.push(2);
            remaining /= 2;
        }
        while (remaining < 0.5) {
            tempo.push(0.5);
            remaining /= 0.5;
        }
        tempo.push(remaining);
    }
    return [
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        source,
        ...(!hasAudio ? ["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000"] : []),
        "-map",
        "0:v:0",
        "-map",
        hasAudio ? "0:a:0" : "1:a:0",
        "-vf",
        `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,setpts=${timingMode === "fit" ? `(PTS-STARTPTS)*${seconds / generatedSeconds}` : "PTS-STARTPTS"},fps=30,tpad=stop_mode=clone:stop_duration=0.05`,
        "-af",
        ["asetpts=PTS-STARTPTS", ...tempo.map((factor) => `atempo=${factor}`), "apad"].join(","),
        "-t",
        String(seconds),
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "20",
        "-pix_fmt",
        "yuv420p",
        "-video_track_timescale",
        "90000",
        "-c:a",
        "aac",
        "-ar",
        "48000",
        "-ac",
        "2",
        "-movflags",
        "+faststart",
        output,
    ];
}
export async function mergeFrameRemakeFiles(input: {
    files: Array<{ path: string; seconds: number; generatedSeconds?: number; timingMode?: "trim" | "fit" }>;
    directory: string;
    durationMs: number;
    width: number;
    height: number;
    audioMode: FrameRemakeProject["audioMode"];
    sourcePath?: string;
}) {
    const normalized: string[] = [];
    for (const [index, file] of input.files.entries()) {
        const probe = await inspectFrameRemakeVideo(file.path);
        if (probe.duration + 0.04 < (file.generatedSeconds ?? file.seconds)) throw new Error(`第 ${index + 1} 组视频只有 ${probe.duration} 秒，短于所需 ${file.seconds} 秒`);
        const name = `part-${index + 1}.mp4`;
        await runFfmpeg(frameRemakeNormalizationArgs(file.path, join(input.directory, name), file.seconds, probe.hasAudio, input.width, input.height, file.generatedSeconds ?? file.seconds, file.timingMode), { timeoutMs: 10 * 60_000 });
        normalized.push(name);
    }
    if (Math.abs(input.files.reduce((sum, file) => sum + file.seconds * 1000, 0) - input.durationMs) > 1) throw new Error("分组总时长与原片不一致");
    await writeFile(join(input.directory, "segments.txt"), normalized.map((name, index) => `file '${name}'\nduration ${input.files[index].seconds}`).join("\n"));
    const joined = join(input.directory, "joined.mp4");
    await runFfmpeg(["-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "1", "-i", "segments.txt", "-c", "copy", "-movflags", "+faststart", joined], { cwd: input.directory, timeoutMs: 10 * 60_000 });
    const output = join(input.directory, "complete.mp4");
    const originalAudio = input.audioMode === "source" && input.sourcePath && (await inspectFrameRemakeVideo(input.sourcePath)).hasAudio;
    await runFfmpeg(
        [
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            joined,
            ...(originalAudio ? ["-i", input.sourcePath!] : []),
            "-map",
            "0:v:0",
            ...(originalAudio ? ["-map", "1:a:0", "-af", "asetpts=PTS-STARTPTS,apad", "-c:a", "aac"] : input.audioMode === "generated" ? ["-map", "0:a:0", "-c:a", "copy"] : ["-an"]),
            "-c:v",
            "copy",
            "-t",
            String(input.durationMs / 1000),
            "-movflags",
            "+faststart",
            output,
        ],
        { timeoutMs: 10 * 60_000 },
    );
    const measured = await inspectFrameRemakeVideo(output);
    if (Math.abs(measured.duration * 1000 - input.durationMs) > 50) throw new Error("成片画面时长与原片不一致，未保存结果");
    return { path: output, ...measured };
}
async function mergeFrameRemakeVideos(input: FrameRemakeRuntimeInput, directory: string): Promise<FrameRemakeMedia> {
    const files = [];
    for (const group of input.project.groups) {
        const task = group.video.taskId ? await getVideoTask(group.video.taskId) : null;
        const record = task ? await getStoredGenerationTaskRecord("video", task.id) : null;
        if (
            !task ||
            !record ||
            record.userId !== input.userId ||
            record.clientRequestId !== group.video.clientRequestId ||
            record.attemptNo !== group.video.attemptNo ||
            task.status !== "success" ||
            task.userId !== input.userId ||
            task.projectId !== input.project.id ||
            task.generationSlotId !== `frame-remake-video:${group.id}` ||
            task.clientRequestId !== group.video.clientRequestId ||
            task.requestedDurationSeconds !== group.video.seconds ||
            task.prompt !== group.video.prompt ||
            task.result?.url !== group.video.result?.url
        )
            throw new Error(`第 ${group.number} 组视频尚未完成或与当前分组不一致`);
        const path = join(directory, `generated-${group.number}.mp4`);
        await downloadOwned(group.video.result!, path, input);
        files.push({ path, seconds: frameRemakeSeconds(group), generatedSeconds: group.video.seconds, timingMode: group.video.timingMode ?? "fit" });
    }
    const sourcePath = join(directory, "original-video");
    if (input.project.audioMode === "source") await downloadOwned(input.project.sourceVideo!, sourcePath, input);
    const sourceWidth = input.project.sourceVideo!.width!,
        sourceHeight = input.project.sourceVideo!.height!;
    const scale = Math.min(1, 1280 / Math.max(sourceWidth, sourceHeight));
    const width = Math.max(2, Math.round((sourceWidth * scale) / 2) * 2),
        height = Math.max(2, Math.round((sourceHeight * scale) / 2) * 2);
    const result = await mergeFrameRemakeFiles({ files, directory, durationMs: input.project.durationMs, width, height, sourcePath, audioMode: input.project.audioMode });
    if ((await stat(result.path)).size > FRAME_REMAKE_MAX_VIDEO_BYTES) throw new Error("成片超过 200 MB 存储上限，请降低输出分辨率");
    const latest = await getFrameRemakeProject(input.project.id, input.userId);
    if (latest?.operation?.id !== input.project.operation?.id) throw new Error("合并任务已被替代");
    const originalName = `${input.project.title}-${input.project.durationMs / 1000}s.mp4`;
    const stored = await writeReferenceMediaFile(result.path, "video", "video/mp4", true, { ownerUserId: input.userId, projectId: input.project.id, source: "frame-remake-merge", originalName });
    return { url: `/api/reference-assets/${stored.token}`, storageKey: stored.token, mimeType: "video/mp4", bytes: stored.bytes, duration: result.duration, width: result.width, height: result.height, originalName };
}
export async function extractFrameRemakeAudio(source: string, directory: string, group: FrameRemakeGroup, input: FrameRemakeRuntimeInput, uncommitted: Set<string>) {
    const probe = await runFfprobe(["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=index", "-of", "json", source], { timeoutMs: 30000 });
    if (!JSON.parse(probe.stdout).streams?.length) return undefined;
    const path = join(directory, `${group.id}-audio.m4a`);
    await runFfmpeg(["-y", "-hide_banner", "-loglevel", "error", "-ss", String(group.startMs / 1000), "-i", source, "-t", String(frameRemakeSeconds(group)), "-vn", "-c:a", "aac", "-b:a", "128k", path], { timeoutMs: 60000 });
    const originalName = `${group.id}-原视频音频.m4a`;
    const stored = await writeReferenceMediaFile(path, "audio", "audio/mp4", true, { ownerUserId: input.userId, projectId: input.project.id, source: "frame-remake-audio", originalName });
    uncommitted.add(stored.token);
    return { url: `/api/reference-assets/${stored.token}`, storageKey: stored.token, mimeType: "audio/mp4", bytes: stored.bytes, originalName, duration: frameRemakeSeconds(group) };
}
async function persistImage(bytes: Buffer, originalName: string, input: FrameRemakeRuntimeInput, uncommitted: Set<string>): Promise<FrameRemakeMedia> {
    const stored = await writePersistentMediaDataUrl(`data:image/jpeg;base64,${bytes.toString("base64")}`, "image", { ownerUserId: input.userId, projectId: input.project.id, source: "frame-remake-extract", originalName });
    uncommitted.add(stored.token);
    const metadata = await sharp(bytes).metadata();
    return { url: `/api/reference-assets/${stored.token}`, storageKey: stored.token, mimeType: "image/jpeg", bytes: stored.bytes, width: metadata.width, height: metadata.height, originalName };
}
async function downloadOwned(media: FrameRemakeMedia, path: string, input: FrameRemakeRuntimeInput) {
    const type = media.mimeType.startsWith("image/") ? "image" : "video";
    const owned = await ownedFrameRemakeMedia(input.userId, media, type);
    const headers = maintenanceWorkerContextHeaders(input.credential);
    return downloadMediaToFile(owned.url, path, {
        origin: input.origin,
        cookie: headers ? undefined : input.credential,
        internalHeaders: headers || undefined,
        maxBytes: type === "image" ? 20 * 1024 * 1024 : FRAME_REMAKE_MAX_VIDEO_BYTES,
        timeoutMs: 5 * 60_000,
    });
}
