import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

import { zipSync, strToU8 } from "fflate";

import type { OmniClothingAsset, OmniClothingProject, OmniClothingSegment } from "@/lib/omni-clothing-contract";
import { OMNI_CLOTHING_SOURCE } from "@/lib/omni-clothing-contract";
import { runFfmpeg, runFfprobe } from "@/lib/server/ffmpeg";
import { downloadMediaToFile } from "@/lib/server/media-download";
import { getLocalMediaRegistration } from "@/lib/server/local-media-registry";
import { cleanupOmniClothingMediaAssets, mutateOmniClothingProjectWithMediaCleanup as mutateOmniClothingProject } from "@/lib/server/omni-clothing-media-cleanup";
import {
    assertClothingResultTarget,
    assertInputs,
    assertNotBusy,
    assertPreparedClothingSegments,
    assertRevision,
    clearSegmentResult,
    getOmniClothingProjectForUser,
    OmniClothingError,
    requireMutation,
    touch,
} from "@/lib/server/omni-clothing-project-service";
import { writeReferenceMediaFile } from "@/lib/server/reference-asset-store";

const MAX_MEDIA_BYTES = 200 * 1024 * 1024;
const OPERATION_TIMEOUT_MS = 8 * 60_000;
type MediaAccess = { origin: string; cookie?: string; internalHeaders?: HeadersInit };
type Cut = { startSeconds: number; endSeconds: number; boundary: OmniClothingSegment["boundary"] };

export async function splitOmniClothingVideo(userId: string, id: string, input: { revision: unknown; boundaries?: unknown }, access: MediaAccess) {
    const current = await getOmniClothingProjectForUser(userId, id);
    assertInputs(current);
    const maximum = current.maxSegmentSeconds;
    const minimum = 0.5;
    const project = await startOperation(userId, id, "split", input.revision);
    const root = await mkdtemp(join(tmpdir(), "vozeb-omni-clothing-"));
    const signal = AbortSignal.timeout(OPERATION_TIMEOUT_MS);
    const createdAssets: OmniClothingAsset[] = [];
    try {
        const sourcePath = join(root, "source-video.mp4");
        await downloadMediaToFile(project.sourceVideo!.url, sourcePath, { ...access, maxBytes: MAX_MEDIA_BYTES });
        const metadata = await probeClothingVideo(sourcePath, signal, true);
        if (metadata.durationSeconds > 1800) throw new OmniClothingError("单次支持最长 30 分钟的源视频，请先缩短视频");
        let scenes: number[] = [];
        if (input.boundaries === undefined) {
            await runFfmpeg(["-hide_banner", "-v", "error", "-i", sourcePath, "-an", "-vf", "fps=12,scale=320:-2,select=gt(scene\\,0.28),metadata=print:file=scenes.txt", "-f", "null", "-"], { cwd: root, timeoutMs: 180_000, signal });
            const sceneText = await readFile(join(root, "scenes.txt"), "utf8").catch((error: NodeJS.ErrnoException) => {
                if (error.code === "ENOENT") return "";
                throw error;
            });
            scenes = [...sceneText.matchAll(/pts_time:([0-9.]+)/g)].map((match) => Number(match[1]));
        }
        const cuts = input.boundaries === undefined ? planClothingCuts(metadata.durationSeconds, maximum, minimum, scenes) : validateClothingCuts(metadata.durationSeconds, maximum, minimum, input.boundaries);
        if (cuts.length > 180) throw new OmniClothingError("切片数量超过 180 段，请缩短源视频或调大单片上限");
        const segments: OmniClothingSegment[] = [];
        for (const [index, cut] of cuts.entries()) {
            const durationSeconds = roundTime(cut.endSeconds - cut.startSeconds);
            const clipPath = join(root, `clip-${index + 1}.mp4`);
            await runFfmpeg(
                [
                    "-hide_banner",
                    "-v",
                    "error",
                    "-y",
                    "-ss",
                    String(cut.startSeconds),
                    "-i",
                    sourcePath,
                    "-t",
                    String(durationSeconds),
                    "-map",
                    "0:v:0",
                    ...(project.audioStrategy === "mute" ? ["-an"] : ["-map", "0:a:0?", "-c:a", "aac", "-ar", "48000"]),
                    "-vf",
                    "scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1",
                    "-r",
                    "30",
                    "-c:v",
                    "libx264",
                    "-preset",
                    "fast",
                    "-crf",
                    "18",
                    "-pix_fmt",
                    "yuv420p",
                    "-movflags",
                    "+faststart",
                    clipPath,
                ],
                { timeoutMs: 120_000, signal },
            );
            const clipMetadata = await probeClothingVideo(clipPath, signal, true);
            const asset = await persistVideo(userId, id, clipPath, `源片段-${index + 1}.mp4`, "omni-clothing-source-segment", clipMetadata);
            createdAssets.push(asset);
            const segment: OmniClothingSegment = {
                id: `segment-${randomUUID()}`,
                index: index + 1,
                ...cut,
                durationSeconds,
                generationDurationSeconds: durationSeconds,
                sourceVideo: asset,
                preparedAudioStrategy: project.audioStrategy,
                prompt: "",
                inputVersion: project.inputVersion,
                attemptNo: 0,
                videoStatus: "idle",
            };
            segments.push(segment);
        }
        return await finishOperation(userId, id, project, (latest) => ({ ...latest, sourceVideo: { ...latest.sourceVideo!, ...metadata }, maxSegmentSeconds: maximum, segments, mergedVideo: undefined, status: "draft", error: undefined }));
    } catch (error) {
        await failOperation(userId, id, project, error);
        await cleanupOmniClothingMediaAssets(userId, createdAssets);
        throw error;
    } finally {
        await cleanup(root);
    }
}

export function planClothingCuts(duration: number, maxSeconds: number, minSeconds: number, sceneTimes: readonly number[]): Cut[] {
    if (!Number.isFinite(duration) || duration < minSeconds || !Number.isFinite(maxSeconds) || maxSeconds < minSeconds) throw new OmniClothingError(`源视频至少需要 ${minSeconds} 秒`);
    const scenes = [...new Set(sceneTimes.map(roundTime))].filter((time) => Number.isFinite(time) && time > 0 && time < duration).sort((a, b) => a - b);
    const cuts: Cut[] = [];
    let start = 0;
    while (duration - start > maxSeconds + 0.001) {
        const remaining = duration - start;
        const remainingCount = Math.ceil((remaining - 0.001) / maxSeconds);
        if (remainingCount * minSeconds > remaining + 0.001) throw new OmniClothingError(`无法将源视频连续切成每段 ${minSeconds}–${maxSeconds} 秒，请调整单片上限`);
        const lower = Math.max(start + minSeconds, duration - (remainingCount - 1) * maxSeconds);
        const upper = Math.min(start + maxSeconds, duration - minSeconds);
        const target = start + remaining / remainingCount;
        const scene = scenes.filter((time) => time >= lower && time <= upper).sort((a, b) => Math.abs(a - target) - Math.abs(b - target))[0];
        const end = roundTime(scene ?? Math.min(upper, Math.max(lower, target)));
        if (end - start < minSeconds - 0.001 || end - start > maxSeconds + 0.001) throw new OmniClothingError("无法在所选时长内连续切片，请调整单片上限");
        cuts.push({ startSeconds: roundTime(start), endSeconds: end, boundary: scene !== undefined ? "scene" : "duration" });
        start = end;
    }
    cuts.push({ startSeconds: roundTime(start), endSeconds: roundTime(duration), boundary: "end" });
    return cuts;
}

export function validateClothingCuts(duration: number, maximum: number, minimum: number, input: unknown): Cut[] {
    if (!Array.isArray(input) || input.length > 180 || input.some((point) => typeof point !== "number" || !Number.isFinite(point))) throw new OmniClothingError("请填写有效的切点秒数");
    const points = [0, ...input, roundTime(duration)];
    return points.slice(1).map((end, index) => {
        const start = points[index];
        const length = end - start;
        if (start < 0 || end > duration + 0.001 || length < minimum - 0.001 || length > maximum + 0.001) throw new OmniClothingError(`每个片段需要在 ${minimum}–${maximum} 秒之间，切点必须递增且覆盖完整视频`);
        return { startSeconds: roundTime(start), endSeconds: roundTime(end), boundary: index === points.length - 2 ? "end" : "manual" };
    });
}

export async function mergeOmniClothingVideos(userId: string, id: string, revision: unknown, access: MediaAccess) {
    const current = await getOmniClothingProjectForUser(userId, id);
    if (!current.segments.length || current.segments.some((segment) => segment.videoStatus !== "success" || !segment.videoUrl || segment.inputVersion !== current.inputVersion)) throw new OmniClothingError("请先完成全部片段的视频生成", 409);
    const project = await startOperation(userId, id, "merge", revision);
    const root = await mkdtemp(join(tmpdir(), "vozeb-omni-clothing-"));
    const signal = AbortSignal.timeout(OPERATION_TIMEOUT_MS);
    const createdAssets: OmniClothingAsset[] = [];
    try {
        const width = evenDimension(project.sourceVideo?.width || 720);
        const height = evenDimension(project.sourceVideo?.height || 1280);
        const normalized: string[] = [];
        let totalBytes = 0;
        for (const [index, segment] of project.segments.entries()) {
            const path = join(root, `result-${index}.mp4`);
            const downloaded = await downloadMediaToFile(segment.videoUrl!, path, { ...access, maxBytes: MAX_MEDIA_BYTES });
            totalBytes += downloaded.bytes;
            if (totalBytes > 600 * 1024 * 1024) throw new OmniClothingError("合并素材超过 600 MB，请缩短源视频", 413);
            const meta = await probeClothingVideo(path, signal, true);
            if (meta.durationSeconds + 0.15 < segment.durationSeconds) throw new OmniClothingError(`片段 ${index + 1} 的生成视频过短，无法完整保留源动作，请重新生成`, 409);
            const output = `normalized-${index}.mp4`;
            await runFfmpeg(
                [
                    "-hide_banner",
                    "-v",
                    "error",
                    "-y",
                    "-i",
                    path,
                    "-t",
                    String(segment.durationSeconds),
                    "-an",
                    "-vf",
                    `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,tpad=stop_mode=clone:stop_duration=0.15`,
                    "-c:v",
                    "libx264",
                    "-preset",
                    "fast",
                    "-crf",
                    "18",
                    "-pix_fmt",
                    "yuv420p",
                    join(root, output),
                ],
                { signal, timeoutMs: 120_000 },
            );
            normalized.push(`file '${output}'`);
        }
        await writeFile(join(root, "concat.txt"), normalized.join("\n"), "utf8");
        const silent = join(root, "silent.mp4");
        await runFfmpeg(["-hide_banner", "-v", "error", "-y", "-f", "concat", "-safe", "1", "-i", "concat.txt", "-c", "copy", "-an", "-movflags", "+faststart", silent], { cwd: root, timeoutMs: 120_000, signal });
        let finalPath = silent;
        if (project.audioStrategy === "preserve") {
            const original = join(root, "original.mp4");
            await downloadMediaToFile(project.sourceVideo!.url, original, { ...access, maxBytes: MAX_MEDIA_BYTES });
            finalPath = join(root, "final.mp4");
            await runFfmpeg(["-hide_banner", "-v", "error", "-y", "-i", silent, "-i", original, "-map", "0:v:0", "-map", "1:a:0?", "-c:v", "copy", "-c:a", "aac", "-t", String(project.segments.at(-1)!.endSeconds), "-movflags", "+faststart", finalPath], {
                signal,
                timeoutMs: 120_000,
            });
        }
        const metadata = await probeClothingVideo(finalPath, signal);
        const asset = await persistVideo(userId, id, finalPath, `${safeName(project.title)}-服装复刻.mp4`, "omni-clothing-merged-video", metadata);
        createdAssets.push(asset);
        return await finishOperation(userId, id, project, (latest) => ({ ...latest, mergedVideo: asset, status: "completed", error: undefined }));
    } catch (error) {
        await failOperation(userId, id, project, error);
        await cleanupOmniClothingMediaAssets(userId, createdAssets);
        throw error;
    } finally {
        await cleanup(root);
    }
}

export async function exportOmniClothingBundle(userId: string, id: string, access: MediaAccess) {
    const project = await getOmniClothingProjectForUser(userId, id);
    assertInputs(project);
    if (project.operation) throw new OmniClothingError("视频正在处理，请稍后导出", 409);
    if (!project.segments.length || project.segments.some((segment) => !segment.prompt)) throw new OmniClothingError("请先切片并准备逐段提示词，即可下载手动生成包", 409);
    assertPreparedClothingSegments(project);
    const root = await mkdtemp(join(tmpdir(), "vozeb-omni-clothing-"));
    try {
        const entries: Record<string, Uint8Array> = {
            "manifest.json": strToU8(
                JSON.stringify(
                    {
                        projectId: project.id,
                        title: project.title,
                        revision: project.revision,
                        inputVersion: project.inputVersion,
                        audioStrategy: project.audioStrategy,
                        source: OMNI_CLOTHING_SOURCE,
                        referenceImages: project.referenceImages.map((asset, index) => ({ name: asset.name, file: `references/clothing-${index + 1}${assetExtension(asset)}` })),
                        segments: project.segments.map((segment) => ({
                            id: segment.id,
                            index: segment.index,
                            startSeconds: segment.startSeconds,
                            endSeconds: segment.endSeconds,
                            durationSeconds: segment.durationSeconds,
                            sourceVideo: `segments/source-${segment.index}.mp4`,
                            prompt: `prompts/segment-${segment.index}.en.txt`,
                            instructions: `prompts/segment-${segment.index}.zh.txt`,
                            resultFile: `generated-${segment.index}.mp4`,
                        })),
                    },
                    null,
                    2,
                ),
            ),
            "prompts.txt": strToU8(project.segments.map((segment) => `片段 ${segment.index}｜${segment.startSeconds}–${segment.endSeconds} 秒\n${segment.prompt}`).join("\n\n========\n\n")),
            "操作说明.txt": strToU8(
                [
                    "服装复刻 · 手动生成包",
                    "1. 解压后，逐段使用 segments/source-N.mp4 和 references 中的真实服装参考图。",
                    "2. 打开你使用的谷歌视频工具，按其支持的参考视频/参考图输入方式上传素材，将 prompts/segment-N.en.txt 复制为提示词。具体模型与参数在谷歌工具中手动选择。",
                    "3. 输出需覆盖该段完整动作和时长。若工具时长限制更短，请回本站调整单片上限并重新切片；不要擅自加速、漏掉或重排动作。",
                    "4. 下载生成结果，建议命名 generated-N.mp4；回到同一个项目、对应片段点击“回传结果”。支持 MP4、MOV、WebM，最大 200 MB，时长至少覆盖本段且不超过 60 秒。",
                    "5. 所有片段回传后合并，超过源片段的尾部会裁剪。",
                    project.audioStrategy === "mute" ? "音频：分段源视频已去除音轨；生成时不要添加配音、音乐或音效，合并成片也保持静音。" : "音频：分段源视频保留原音轨（源视频存在音轨时）；合并时使用原视频音频，不采用生成视频的新声音。",
                    "请保留本包的 manifest.json，用于核对项目、输入版本和片段编号。素材或提示词变更后需重新下载；旧结果不会自动套用到新版本。",
                    "本包不含任何账号、API Key，也不会自动调用谷歌或视频模型。已回传结果和已有成片会一并附带（如有）。",
                ].join("\n\n"),
            ),
        };
        for (const segment of project.segments) {
            entries[`prompts/segment-${segment.index}.en.txt`] = strToU8(segment.prompt);
            entries[`prompts/segment-${segment.index}.zh.txt`] = strToU8(
                `片段 ${segment.index}\n源时间：${segment.startSeconds}–${segment.endSeconds} 秒；动作时长：${segment.durationSeconds} 秒。\n使用 segments/source-${segment.index}.mp4，以及 references 目录的全部服装图。只替换服装，保留原人物身份、动作、背景和镜头节奏。\n服装补充说明：${project.garmentDescription || "以参考图为准"}\n${project.audioStrategy === "mute" ? "源片段已静音；生成结果也应无音频。" : "保留嘴型和动作时序；成片将恢复原视频声音。"}\n生成后回传到片段 ${segment.index}（${segment.id}）。`,
            );
        }
        const media = [
            ...project.referenceImages.map((asset, index) => ({ url: asset.url, path: `references/clothing-${index + 1}${assetExtension(asset)}` })),
            ...project.segments.flatMap((segment) => [
                { url: segment.sourceVideo.url, path: `segments/source-${segment.index}.mp4` },
                ...(segment.videoStatus === "success" && segment.videoUrl ? [{ url: segment.videoUrl, path: `results/generated-${segment.index}${segment.importedVideo ? assetExtension(segment.importedVideo) : ".mp4"}` }] : []),
            ]),
            ...(project.mergedVideo ? [{ url: project.mergedVideo.url, path: "final.mp4" }] : []),
        ];
        let totalBytes = 0;
        for (const [index, item] of media.entries()) {
            const file = join(root, `asset-${index}`);
            const downloaded = await downloadMediaToFile(item.url, file, { ...access, maxBytes: MAX_MEDIA_BYTES });
            totalBytes += downloaded.bytes;
            if (totalBytes > 500 * 1024 * 1024) throw new OmniClothingError("完整包超过 500 MB，请分别下载源素材和视频", 413);
            entries[item.path] = await readFile(file);
        }
        const latest = await getOmniClothingProjectForUser(userId, id);
        if (latest.inputVersion !== project.inputVersion || JSON.stringify(latest.segments.map((segment) => [segment.id, segment.prompt])) !== JSON.stringify(project.segments.map((segment) => [segment.id, segment.prompt])))
            throw new OmniClothingError("导出期间素材或提示词已更新，请重新下载生成包", 409);
        return { bytes: zipSync(entries, { level: 0 }), fileName: `${safeName(project.title)}-服装手动生成包.zip` };
    } finally {
        await cleanup(root);
    }
}

export function clothingResultUploadContext(userId: string, project: OmniClothingProject, segment: OmniClothingSegment) {
    return { ownerUserId: userId, projectId: project.id, runId: segment.id, source: `omni-clothing-result-upload:${project.inputVersion}`, taskId: `prompt:${createHash("sha256").update(segment.prompt).digest("hex")}` };
}

export function assertClothingResultDuration(segment: OmniClothingSegment, duration: number) {
    if (!Number.isFinite(duration) || duration + 0.15 < segment.durationSeconds || duration > 60.15) throw new OmniClothingError(`回传片段需覆盖 ${segment.durationSeconds} 秒源动作，且不超过 60 秒；多余尾部将在合并时裁剪`, 409);
}

export async function importOmniClothingVideoResult(userId: string, id: string, input: Record<string, unknown>, access: MediaAccess) {
    const current = await getOmniClothingProjectForUser(userId, id);
    assertRevision(current, input.revision);
    const segment = assertClothingResultTarget(current, input.segmentId, input.inputVersion);
    const key = input.asset && typeof input.asset === "object" && !Array.isArray(input.asset) ? String((input.asset as Record<string, unknown>).storageKey || "") : "";
    const registration = await getLocalMediaRegistration(key);
    const expected = clothingResultUploadContext(userId, current, segment);
    if (
        !registration ||
        registration.ownerUserId !== userId ||
        registration.scope !== "reference" ||
        registration.type !== "video" ||
        registration.storageClass !== "permanent" ||
        registration.projectId !== id ||
        registration.runId !== segment.id ||
        registration.source !== expected.source ||
        registration.taskId !== expected.taskId
    )
        throw new OmniClothingError("结果素材不属于当前用户、项目片段或提示词版本", 403);
    if (!["video/mp4", "video/quicktime", "video/webm"].includes(registration.mimeType)) throw new OmniClothingError("回传结果需要 MP4、MOV 或 WebM 视频", 415);
    const asset: OmniClothingAsset = {
        storageKey: registration.storageKey,
        url: `/api/reference-assets/${registration.storageKey.split("/").map(encodeURIComponent).join("/")}`,
        name: registration.originalName || `generated-${segment.index}.mp4`,
        mimeType: registration.mimeType,
        bytes: registration.bytes,
    };
    const root = await mkdtemp(join(tmpdir(), "vozeb-omni-clothing-"));
    try {
        const path = join(root, "import-video");
        await downloadMediaToFile(asset.url, path, { ...access, maxBytes: MAX_MEDIA_BYTES });
        const metadata = await probeClothingVideo(path, undefined, true);
        assertClothingResultDuration(segment, metadata.durationSeconds);
        return requireMutation(
            await mutateOmniClothingProject(userId, id, (latest) => {
                assertRevision(latest, input.revision);
                const target = assertClothingResultTarget(latest, input.segmentId, input.inputVersion);
                if (target.prompt !== segment.prompt) throw new OmniClothingError("提示词已更新，请使用当前片段结果", 409);
                if (target.videoStatus === "success" && target.videoUrl === asset.url && target.importedVideo?.storageKey === asset.storageKey) return null;
                const importedVideo = { ...asset, ...metadata };
                return touch({
                    ...latest,
                    status: "ready",
                    error: undefined,
                    mergedVideo: undefined,
                    segments: latest.segments.map((item) => (item.id === target.id ? { ...clearSegmentResult(item), importedVideo, videoUrl: importedVideo.url, videoStatus: "success" as const } : item)),
                });
            }),
        );
    } finally {
        // 已上传结果属于用户的永久素材，绑定失败也不删除；只清理探测用临时文件。
        await cleanup(root);
    }
}

export async function probeClothingVideo(path: string, signal?: AbortSignal, preferVideoDuration = false) {
    const { stdout } = await runFfprobe(["-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height,duration", "-of", "json", path], { timeoutMs: 30_000, signal });
    const metadata = JSON.parse(stdout) as { format?: { duration?: string }; streams?: { codec_type?: string; width?: number; height?: number; duration?: string }[] };
    const video = metadata.streams?.find((stream) => stream.codec_type === "video");
    const videoDuration = Number(video?.duration);
    let durationSeconds = preferVideoDuration && Number.isFinite(videoDuration) && videoDuration > 0 ? videoDuration : Number(metadata.format?.duration);
    if (preferVideoDuration && video && !(Number.isFinite(videoDuration) && videoDuration > 0)) {
        // WebM 等格式可能不写流时长；无损提取纯视频，避免较长音轨让短画面通过校验。
        const root = await mkdtemp(join(tmpdir(), "vozeb-omni-clothing-"));
        try {
            const videoOnly = join(root, "video-only.mkv");
            await runFfmpeg(["-hide_banner", "-v", "error", "-y", "-i", path, "-map", "0:v:0", "-an", "-c:v", "copy", videoOnly], { timeoutMs: 30_000, signal });
            durationSeconds = (await probeClothingVideo(videoOnly, signal)).durationSeconds;
        } finally {
            await cleanup(root);
        }
    }
    if (!video?.width || !video.height || !Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new OmniClothingError("源文件不包含有效的视频画面或时长");
    return { durationSeconds: roundTime(durationSeconds), width: video.width, height: video.height };
}

async function startOperation(userId: string, id: string, kind: "split" | "merge", revision: unknown) {
    return requireMutation(
        await mutateOmniClothingProject(userId, id, (project) => {
            assertRevision(project, revision);
            assertNotBusy(project);
            return touch({ ...project, error: undefined, operation: { id: randomUUID(), kind, startedAt: new Date().toISOString(), inputVersion: project.inputVersion } });
        }),
    );
}

async function finishOperation(userId: string, id: string, operationProject: OmniClothingProject, update: (project: OmniClothingProject) => OmniClothingProject) {
    return requireMutation(
        await mutateOmniClothingProject(userId, id, (project) => {
            if (project.operation?.id !== operationProject.operation?.id || project.inputVersion !== operationProject.inputVersion) throw new OmniClothingError("处理结果已过期，请重新操作", 409);
            return touch({ ...update(project), operation: undefined });
        }),
    );
}

async function failOperation(userId: string, id: string, operationProject: OmniClothingProject, error: unknown) {
    await mutateOmniClothingProject(userId, id, (project) =>
        project.operation?.id === operationProject.operation?.id
            ? touch({ ...project, operation: undefined, status: "error", error: error instanceof OmniClothingError ? error.message : "视频处理失败，请重新操作；若持续失败，请检查 FFmpeg 和媒体服务" })
            : null,
    );
}

async function persistVideo(userId: string, projectId: string, path: string, name: string, source: string, metadata: Partial<OmniClothingAsset>): Promise<OmniClothingAsset> {
    const asset = await writeReferenceMediaFile(path, "video", "video/mp4", true, { ownerUserId: userId, source, projectId, originalName: name });
    return { url: `/api/reference-assets/${asset.token.split("/").map(encodeURIComponent).join("/")}`, storageKey: asset.token, name, mimeType: asset.mimeType, bytes: asset.bytes, ...metadata };
}

function roundTime(value: number) {
    return Math.round(value * 1000) / 1000;
}
function evenDimension(value: number) {
    return Math.max(2, Math.floor(value / 2) * 2);
}
function safeName(value: string) {
    return value.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(0, 100) || "服装复刻";
}
function assetExtension(asset: OmniClothingAsset) {
    return ({ "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif", "video/webm": ".webm", "video/quicktime": ".mov" } as Record<string, string>)[asset.mimeType] || ".mp4";
}
async function cleanup(root: string) {
    const absolute = resolve(root);
    if (!absolute.startsWith(`${resolve(tmpdir())}${sep}vozeb-omni-clothing-`)) throw new Error("临时目录不在服装视频工作区内");
    await rm(absolute, { recursive: true, force: true });
}

export type { ClothingModelPolicy } from "@/lib/server/omni-clothing-project-service";
