import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAuthSettings, refundUserPoints } from "@/lib/auth/store";
import { omniManualSegmentPrompts, omniPlanningPrompt, parseOmniAnalysis, parseOmniPlan, type OmniMedia, type OmniProject, type OmniSegment } from "@/lib/omni-remake-contract";
import { runFfmpeg, runFfprobe } from "./ffmpeg";
import { downloadMediaToFile } from "./media-download";
import { writeReferenceMediaFile } from "./reference-asset-store";
import { finishOmniOperation, ownedOmniMedia } from "./omni-remake-project-service";
import { resolveLogicalModelCandidates } from "./logical-model-router";
import { buildRemakeScriptVisualBoards, requestRemakeProductionVisionPrompt, resolveRemakeProductionVisionProtocol, RemakeProductionVisionError } from "./remake15-production-vision-runtime";
import { hasSystemAiCharge, readSystemAiBilling, systemAiBillingHeaders, systemAiIdempotencyKey } from "./system-ai-billing";
import { strictJsonObjectText } from "./structured-model-output";
import { toSafeGenerationErrorMessage } from "./generation-errors";
import { maintenanceWorkerContextHeaders } from "./maintenance-auth";
import { deleteUserLocalMediaAssets } from "./local-media-storage";

const MAX_VIDEO_BYTES = 200 * 1024 * 1024;
type OperationInput = { project: OmniProject; userId: string; origin: string; credential: string };
type Charge = { model: string; headers: Headers };

export async function runOmniOperation(input: OperationInput) {
    const operation = input.project.operation;
    if (!operation) throw new Error("没有待执行的 Omni 操作");
    const directory = await mkdtemp(join(tmpdir(), "vozeb-omni-remake-"));
    const created: string[] = [];
    const charges: Charge[] = [];
    let committed = false;
    try {
        let patch: Partial<OmniProject>;
        if (operation.kind === "analysis") throw new Error("自动视频分析已停用，请导入在外部完成的分析 JSON");
        if (operation.kind === "merge") patch = { mergedVideo: await mergeOmniClips(input, directory, created) };
        else {
            if (!input.project.sourceVideo) throw new Error("请先上传参考视频");
            await ownedOmniMedia(input.userId, input.project.sourceVideo, "video");
            const sourcePath = join(directory, "source.mp4");
            await download(input.project.sourceVideo.url, sourcePath, input);
            const probe = await probeOmniVideo(sourcePath);
            {
                assertOmniPreparationReady(input.project);
                parseOmniAnalysis(input.project.analysisRaw, probe.duration, input.project.audioMode);
                for (const media of [...input.project.references.product, ...(input.project.replaceCharacter ? input.project.references.character : []), ...(input.project.replaceBackground ? input.project.references.background : [])]) await ownedOmniMedia(input.userId, media, "image");
                const prepared = operation.promptMode === "ai" ? await planOmniSegments(input, charges) : {
                    materialAnalysis: input.project.materialAnalysis || "参考素材按产品、人物与背景角色整理；请在外部生成前核对。",
                    plan: input.project.plan || "按片段顺序使用来源视频与对应参考图，在 Google 手动生成后回传各段结果。",
                    segments: input.project.segments.map((segment) => segment.prompt.trim() && segment.promptZh.trim() ? segment : { ...segment, ...omniManualSegmentPrompts(input.project, segment) }),
                };
                const segments = [];
                for (const segment of prepared.segments) {
                    const clipPath = join(directory, `${segment.id}.mp4`);
                    await runFfmpeg(
                        [
                            "-y",
                            "-hide_banner",
                            "-loglevel",
                            "error",
                            "-ss",
                            String(segment.start),
                            "-i",
                            sourcePath,
                            "-t",
                            String(segment.duration),
                            "-map",
                            "0:v:0",
                            ...(segment.audioStrategy === "remove_audio" ? ["-an"] : ["-map", "0:a:0?", "-c:a", "aac", "-b:a", "128k"]),
                            "-vf",
                            "scale=min(1280\\,iw):-2,setsar=1",
                            "-r",
                            "30",
                            "-c:v",
                            "libx264",
                            "-preset",
                            "veryfast",
                            "-crf",
                            "20",
                            "-pix_fmt",
                            "yuv420p",
                            "-movflags",
                            "+faststart",
                            clipPath,
                        ],
                        { timeoutMs: 3 * 60_000 },
                    );
                    const measured = await probeOmniVideo(clipPath);
                    if (Math.abs(measured.duration - segment.duration) > 0.2) throw new Error(`片段 ${segment.id} 切分时长不正确，未保存结果`);
                    const sourceClip = await persistVideo(clipPath, `${segment.id}-source.mp4`, input, created);
                    segments.push({ ...segment, sourceClip: { ...sourceClip, ...measured }, video: { status: "idle" as const, attemptNo: segment.video.attemptNo } });
                }
                patch = { sourceVideo: { ...input.project.sourceVideo, ...probe }, materialAnalysis: prepared.materialAnalysis, plan: prepared.plan, segments, mergedVideo: undefined };
            }
        }
        await finishOmniOperation(input.userId, input.project.id, operation.id, { ...patch, error: undefined });
        committed = true;
    } catch (error) {
        const message = toSafeGenerationErrorMessage(error, "Omni 处理失败");
        try {
            await finishOmniOperation(input.userId, input.project.id, operation.id, { error: message });
        } catch (saveError) {
            console.error("Omni 失败状态保存失败", saveError);
        }
    } finally {
        if (!committed) {
            for (const charge of charges) {
                const billing = readSystemAiBilling(charge.headers);
                if (hasSystemAiCharge(billing))
                    try {
                        await refundUserPoints(input.userId, charge.model, billing.pointsCost, "text", 1, undefined, billing.pointsRecordId);
                    } catch (error) {
                        console.error("Omni 无效结果退款失败", error);
                    }
            }
            if (created.length) await deleteUserLocalMediaAssets(input.userId, created).catch((error) => console.error("Omni 未保存媒体清理失败", error));
        }
        await rm(directory, { recursive: true, force: true });
    }
}

export function assertOmniPreparationReady(project: OmniProject) {
    if (!project.segments.length || !project.analysisRaw) throw new Error("请先完成视频分析");
    if (project.productStrategy === "replace" && (!project.references.product.length || !project.productName.trim())) throw new Error("换品时请提供产品名称和新产品参考图");
    if (project.replaceCharacter && !project.references.character.length) throw new Error("换人物时请提供人物参考图");
    if (project.replaceBackground && !project.references.background.length) throw new Error("换背景时请提供背景参考图");
    if (!project.references.product.length && !project.replaceCharacter && !project.replaceBackground) throw new Error("请至少提供一类目标参考素材");
}

async function planOmniSegments(input: OperationInput, charges: Charge[]) {
    const project = input.project;
    const model = project.modelSelection.prompt.trim();
    if (!model) throw new Error("使用 AI 润色前，请明确选择提示词模型；也可以使用本地模板直接准备");
    const settings = await getAuthSettings();
    const referenceInputs = [
        ...project.references.product.map((asset, index) => ({ role: "product" as const, label: `产品参考图 ${index + 1}`, asset })),
        ...(project.replaceCharacter ? project.references.character.map((asset, index) => ({ role: "character" as const, label: `人物参考图 ${index + 1}`, asset })) : []),
        ...(project.replaceBackground ? project.references.background.map((asset, index) => ({ role: "product" as const, label: `背景参考图 ${index + 1}（仅用于背景）`, asset })) : []),
    ];
    for (const reference of referenceInputs) await ownedOmniMedia(input.userId, reference.asset, "image");
    const candidates = resolveLogicalModelCandidates(settings, "text", model).filter((candidate) => resolveRemakeProductionVisionProtocol(candidate) && (candidate.capabilityProfile?.maxReferenceImages ?? 8) >= referenceInputs.length);
    if (!candidates.length) throw new Error("请配置支持当前参考图数量的视觉文本模型");
    const boards = await buildRemakeScriptVisualBoards({ origin: input.origin, cookie: input.credential, references: referenceInputs });
    let lastError: unknown;
    for (const candidate of candidates) {
        const billingKey = systemAiIdempotencyKey("omni-remake-plan", input.userId, project.operation!.id, candidate.channelId, candidate.upstreamModel);
        try {
            const call = await requestRemakeProductionVisionPrompt({
                origin: input.origin,
                cookie: input.credential,
                candidate,
                boards,
                headers: systemAiBillingHeaders(model, billingKey, candidate.upstreamModel),
                messages: [
                    { role: "system", content: omniPlanningPrompt(project) },
                    {
                        role: "user",
                        content: JSON.stringify({
                            productName: project.productName,
                            requirements: project.instructions,
                            references: referenceInputs.map((reference, index) => ({ index: index + 1, label: reference.label })),
                            segments: project.segments.map(({ id, start, end, description, hasFace, speaking, personCount, needsSecondCheck, audioStrategy }) => ({
                                id,
                                start,
                                end,
                                description,
                                hasFace,
                                speaking,
                                personCount,
                                needsSecondCheck,
                                audioStrategy,
                            })),
                        }),
                    },
                ],
            });
            charges.push({ model, headers: call.headers });
            const raw = strictJsonObjectText(call.text);
            if (!raw) throw new Error("模型没有返回完整的 Omni 片段计划 JSON");
            return parseOmniPlan(raw, project.segments);
        } catch (error) {
            if (error instanceof RemakeProductionVisionError && error.responseHeaders) charges.push({ model, headers: error.responseHeaders });
            // 候选失败当场退款，后续候选成功也不能保留失败费用。
            while (charges.length) {
                const charge = charges.pop()!;
                const billing = readSystemAiBilling(charge.headers);
                if (hasSystemAiCharge(billing)) await refundUserPoints(input.userId, charge.model, billing.pointsCost, "text", 1, undefined, billing.pointsRecordId);
            }
            lastError = error;
        }
    }
    throw new Error(toSafeGenerationErrorMessage(lastError, "Omni 片段计划生成失败"));
}

export async function probeOmniVideo(path: string) {
    const result = await runFfprobe(["-v", "error", "-show_entries", "stream=codec_type,width,height,duration,start_time:stream_tags=DURATION", "-of", "json", path], { timeoutMs: 30000 });
    const payload = JSON.parse(result.stdout) as { streams?: Array<{ codec_type?: string; width?: number; height?: number; duration?: string; start_time?: string; tags?: { DURATION?: string } }> };
    const video = payload.streams?.find((stream) => stream.codec_type === "video");
    const tagged = video?.tags?.DURATION?.match(/^(\d+):(\d+):(\d+(?:\.\d+)?)$/);
    let duration = Number(video?.duration) || (tagged ? Number(tagged[1]) * 3600 + Number(tagged[2]) * 60 + Number(tagged[3]) : 0);
    if (!Number.isFinite(duration) || duration <= 0) {
        // 容器总时长可能来自更长的音轨，按视频包时间验证实际画面长度。
        const packets = await runFfprobe(["-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time,duration_time", "-of", "csv=p=0", path], { timeoutMs: 30000 });
        const first = Number(video?.start_time) || 0;
        let last = -Infinity;
        // FFmpeg 工具保留输出尾部；仅需要最后的视频包时间，不解析可能被截断的 JSON。
        const packetLines = packets.stdout.trim().split(/\r?\n/);
        if (packets.stdout.length >= 20_000) packetLines.shift();
        for (const row of packetLines) {
            const fields = row.split(",");
            const start = Number(fields[0]);
            const span = Number(fields[1]);
            if (!Number.isFinite(start)) continue;
            last = Math.max(last, start + (Number.isFinite(span) && span > 0 ? span : 0));
        }
        duration = last - first;
    }
    if (!video?.width || !video.height || !Number.isFinite(duration) || duration <= 0) throw new Error("视频缺少可解码画面或有效时长");
    return { duration: Math.round(duration * 1000) / 1000, width: video.width, height: video.height, hasAudio: Boolean(payload.streams?.some((stream) => stream.codec_type === "audio")) };
}

export async function inspectOmniVideoAsset(input: { userId: string; media: OmniMedia; origin: string; credential: string }): Promise<OmniMedia & { duration: number }> {
    const media = await ownedOmniMedia(input.userId, input.media, "video");
    const directory = await mkdtemp(join(tmpdir(), "vozeb-omni-inspect-"));
    try {
        const path = join(directory, "video");
        await download(media.url, path, input);
        return { ...media, ...await probeOmniVideo(path) };
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

export async function prepareOmniManualResult(input: { userId: string; projectId: string; media: OmniMedia; segment: OmniSegment; version: string; origin: string; credential: string }): Promise<OmniMedia> {
    const directory = await mkdtemp(join(tmpdir(), "vozeb-omni-manual-result-"));
    try {
        const path = join(directory, "video");
        await download(input.media.url, path, input);
        const measured = await probeOmniVideo(path);
        if (measured.duration + 0.15 < input.segment.duration) throw new Error(`回传视频实际画面只有 ${measured.duration} 秒，短于片段 ${input.segment.id} 所需的 ${input.segment.duration} 秒`);
        const asset = await writeReferenceMediaFile(path, "video", input.media.mimeType, true, { ownerUserId: input.userId, projectId: input.projectId, source: "omni-remake-manual-result", originalName: input.media.originalName || `${input.segment.id}-result.mp4`, taskId: input.version, runId: input.media.storageKey, maxBytes: MAX_VIDEO_BYTES });
        return { url: `/api/reference-assets/${asset.token.split("/").map(encodeURIComponent).join("/")}`, storageKey: asset.token, mimeType: asset.mimeType, bytes: asset.bytes, originalName: input.media.originalName, ...measured };
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

async function mergeOmniClips(input: OperationInput, directory: string, created: string[]) {
    const segments = input.project.segments;
    if (!segments.length || segments.some((segment) => segment.video.status !== "completed" || !segment.video.result?.url)) throw new Error("请先完成所有片段视频");
    const targetWidth = input.project.sourceVideo?.width || 720;
    const targetHeight = input.project.sourceVideo?.height || 1280;
    const width = Math.max(2, Math.round(Math.min(1280, targetWidth) / 2) * 2);
    const height = Math.max(2, Math.round((width * targetHeight) / targetWidth / 2) * 2);
    for (const [index, segment] of segments.entries()) {
        const sourcePath = join(directory, `result-${index}.mp4`);
        await download(segment.video.result!.url, sourcePath, input);
        const source = await probeOmniVideo(sourcePath);
        if (source.duration + 0.15 < segment.duration) throw new Error(`片段 ${segment.id} 的生成视频短于来源，不能拼接残缺成片`);
        const args = ["-y", "-hide_banner", "-loglevel", "error", "-i", sourcePath];
        // 保留源声时从已切分的原片恢复真实音轨，避免供应商生成的口播改变原文。
        if (segment.audioStrategy === "preserve_audio" && segment.sourceClip) {
            const clipPath = join(directory, `audio-${index}.mp4`);
            await download(segment.sourceClip.url, clipPath, input);
            if ((await probeOmniVideo(clipPath)).hasAudio) args.push("-i", clipPath, "-map", "0:v:0", "-map", "1:a:0");
            else args.push("-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-map", "0:v:0", "-map", "1:a:0");
        } else args.push("-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-map", "0:v:0", "-map", "1:a:0");
        args.push(
            "-t",
            String(segment.duration),
            "-vf",
            `${source.duration < segment.duration ? `tpad=stop_mode=clone:stop_duration=${(segment.duration - source.duration).toFixed(3)},` : ""}scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1`,
            "-r",
            "30",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "20",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-ar",
            "48000",
            "-ac",
            "2",
            "-movflags",
            "+faststart",
            join(directory, `clip-${index}.mp4`),
        );
        await runFfmpeg(args, { timeoutMs: 3 * 60_000 });
    }
    await writeFile(join(directory, "concat.txt"), segments.map((_, index) => `file 'clip-${index}.mp4'`).join("\n"));
    const output = join(directory, "merged.mp4");
    await runFfmpeg(["-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", "concat.txt", "-c", "copy", "-movflags", "+faststart", output], { cwd: directory, timeoutMs: 3 * 60_000 });
    const probe = await probeOmniVideo(output);
    if (Math.abs(probe.duration - segments.reduce((sum, segment) => sum + segment.duration, 0)) > 0.1 * segments.length + 0.25) throw new Error("合并成片时长与完整片段不一致");
    return { ...(await persistVideo(output, "omni-全品类-成片.mp4", input, created)), ...probe };
}

async function persistVideo(path: string, originalName: string, input: OperationInput, created: string[]): Promise<OmniMedia> {
    const stored = await writeReferenceMediaFile(path, "video", "video/mp4", true, { ownerUserId: input.userId, projectId: input.project.id, source: "omni-remake", originalName, maxBytes: MAX_VIDEO_BYTES });
    created.push(stored.token);
    return { url: `/api/reference-assets/${stored.token.split("/").map(encodeURIComponent).join("/")}`, storageKey: stored.token, mimeType: stored.mimeType, bytes: stored.bytes, originalName };
}
async function download(url: string, path: string, input: Pick<OperationInput, "origin" | "credential">) {
    const headers = maintenanceWorkerContextHeaders(input.credential);
    return downloadMediaToFile(url, path, { origin: input.origin, cookie: headers ? undefined : input.credential, internalHeaders: headers || undefined, maxBytes: MAX_VIDEO_BYTES, timeoutMs: 5 * 60_000 });
}
export function omniSegmentGuard(project: OmniProject, strategy: string) {
    return {
        en: `Final constraints: ${project.productStrategy === "preserve" ? "Keep the source product unchanged; product references only verify details." : "Replace the target product using the supplied product references; never add a product where absent."} ${project.replaceCharacter ? "Only replace originally visible people or body parts using the character references. Do not add faces to hands-only shots." : "Keep the original person, outfit and hands unchanged."} ${project.replaceBackground ? "Use the supplied background reference without changing foreground geometry." : "Keep the original background and lighting unchanged."} Preserve all action timing, camera movements and contact geometry. ${strategy === "remove_audio" ? "Output without speech, music or sound." : "Keep original audio and exact lip-sync timing; never invent speech."}`,
        zh: `最终约束：${project.productStrategy === "preserve" ? "原产品不变，产品图只补充核对细节。" : "按产品参考图换品，无产品的镜头不新增产品。"}${project.replaceCharacter ? "仅替换原片可见人物或身体局部，只有手的镜头不补脸。" : "原人物、服装和手部不变。"}${project.replaceBackground ? "按背景图替换背景，保留前景空间关系。" : "原背景和光线不变。"}保持全部动作、镜头时序和接触关系。${strategy === "remove_audio" ? "不生成语音、音乐或音效。" : "保留原声和口型同步，不编造口播。"}`,
    };
}

export async function readOmniExportMedia(asset: OmniMedia, input: Pick<OperationInput, "origin" | "credential">) {
    const directory = await mkdtemp(join(tmpdir(), "vozeb-omni-export-"));
    try {
        const path = join(directory, "media");
        await download(asset.url, path, input);
        return await readFile(path);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}
