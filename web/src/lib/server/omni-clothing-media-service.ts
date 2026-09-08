import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

import { zipSync, strToU8 } from "fflate";

import type { OmniClothingAsset, OmniClothingProject, OmniClothingSegment } from "@/lib/omni-clothing-contract";
import { OMNI_CLOTHING_SOURCE } from "@/lib/omni-clothing-contract";
import { runFfmpeg, runFfprobe } from "@/lib/server/ffmpeg";
import { downloadMediaToFile } from "@/lib/server/media-download";
import { cleanupOmniClothingMediaAssets, mutateOmniClothingProjectWithMediaCleanup as mutateOmniClothingProject } from "@/lib/server/omni-clothing-media-cleanup";
import { assertInputs, assertNotBusy, assertRevision, clothingGenerationDuration, clothingModelPolicy, getOmniClothingProjectForUser, OmniClothingError, requireMutation, touch, type ClothingModelPolicy } from "@/lib/server/omni-clothing-project-service";
import { writeReferenceMediaFile } from "@/lib/server/reference-asset-store";

const MAX_MEDIA_BYTES = 200 * 1024 * 1024;
const OPERATION_TIMEOUT_MS = 8 * 60_000;
type MediaAccess = { origin: string; cookie?: string; internalHeaders?: HeadersInit };
type Cut = { startSeconds: number; endSeconds: number; boundary: OmniClothingSegment["boundary"] };

export async function splitOmniClothingVideo(userId: string, id: string, input: { revision: unknown; boundaries?: unknown }, access: MediaAccess) {
    const current = await getOmniClothingProjectForUser(userId, id);
    assertInputs(current);
    const policy = await clothingModelPolicy(current.model, current.referenceImages.length);
    const maximum = Math.min(current.maxSegmentSeconds, policy.maxReferenceSeconds);
    if (maximum < policy.minReferenceSeconds) throw new OmniClothingError("单片上限低于模型的参考视频最短时长");
    const project = await startOperation(userId, id, "split", input.revision);
    const root = await mkdtemp(join(tmpdir(), "vozeb-omni-clothing-"));
    const signal = AbortSignal.timeout(OPERATION_TIMEOUT_MS);
    const createdAssets: OmniClothingAsset[] = [];
    try {
        const sourcePath = join(root, "source-video.mp4");
        await downloadMediaToFile(project.sourceVideo!.url, sourcePath, { ...access, maxBytes: MAX_MEDIA_BYTES });
        const metadata = await probeClothingVideo(sourcePath, signal);
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
        const cuts = input.boundaries === undefined ? planClothingCuts(metadata.durationSeconds, maximum, policy.minReferenceSeconds, scenes) : validateClothingCuts(metadata.durationSeconds, maximum, policy.minReferenceSeconds, input.boundaries);
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
                    "-map",
                    "0:a?",
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
                    "-c:a",
                    "aac",
                    "-ar",
                    "48000",
                    "-movflags",
                    "+faststart",
                    clipPath,
                ],
                { timeoutMs: 120_000, signal },
            );
            const asset = await persistVideo(userId, id, clipPath, `源片段-${index + 1}.mp4`, "omni-clothing-source-segment", { durationSeconds, width: metadata.width, height: metadata.height });
            createdAssets.push(asset);
            segments.push({
                id: `segment-${randomUUID()}`,
                index: index + 1,
                ...cut,
                durationSeconds,
                generationDurationSeconds: clothingGenerationDuration(durationSeconds, policy),
                sourceVideo: asset,
                prompt: "",
                inputVersion: project.inputVersion,
                attemptNo: 0,
                videoStatus: "idle",
            });
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
        const lower = Math.max(start + minSeconds, duration - (remainingCount - 1) * maxSeconds);
        const upper = Math.min(start + maxSeconds, duration - minSeconds);
        const target = start + remaining / remainingCount;
        const scene = scenes.filter((time) => time >= lower && time <= upper).sort((a, b) => Math.abs(a - target) - Math.abs(b - target))[0];
        const end = roundTime(scene ?? Math.min(upper, Math.max(lower, target)));
        if (end <= start || end - start > maxSeconds + 0.001) throw new OmniClothingError("无法在所选模型时长内连续切片，请调整单片上限");
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
            const meta = await probeClothingVideo(path, signal);
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
                    `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30`,
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
    if (!project.mergedVideo || project.segments.some((segment) => segment.videoStatus !== "success" || !segment.videoUrl)) throw new OmniClothingError("请先生成并合并全部视频，再导出完整包", 409);
    const root = await mkdtemp(join(tmpdir(), "vozeb-omni-clothing-"));
    try {
        const entries: Record<string, Uint8Array> = {
            "project.json": strToU8(JSON.stringify({ ...project, source: OMNI_CLOTHING_SOURCE }, null, 2)),
            "prompts.txt": strToU8(project.segments.map((segment) => `片段 ${segment.index}｜${segment.startSeconds}–${segment.endSeconds} 秒\n${segment.prompt}`).join("\n\n========\n\n")),
            "说明.txt": strToU8("服装视频复刻完整包\n包含源视频、服装参考图、源切片、生成片段、成片、提示词与时间线。\n成片按源时间线裁剪，保留原声时音频来自源视频。\n"),
        };
        const media = [
            { url: project.sourceVideo!.url, path: `source/original${assetExtension(project.sourceVideo!)}` },
            ...project.referenceImages.map((asset, index) => ({ url: asset.url, path: `references/clothing-${index + 1}${assetExtension(asset)}` })),
            ...project.segments.flatMap((segment) => [
                { url: segment.sourceVideo.url, path: `segments/source-${segment.index}.mp4` },
                { url: segment.videoUrl!, path: `segments/generated-${segment.index}.mp4` },
            ]),
            { url: project.mergedVideo.url, path: "final.mp4" },
        ];
        let totalBytes = 0;
        for (const [index, item] of media.entries()) {
            const file = join(root, `asset-${index}`);
            const downloaded = await downloadMediaToFile(item.url, file, { ...access, maxBytes: MAX_MEDIA_BYTES });
            totalBytes += downloaded.bytes;
            if (totalBytes > 500 * 1024 * 1024) throw new OmniClothingError("完整包超过 500 MB，请分别下载源素材和视频", 413);
            entries[item.path] = await readFile(file);
        }
        return { bytes: zipSync(entries, { level: 0 }), fileName: `${safeName(project.title)}-服装复刻完整包.zip` };
    } finally {
        await cleanup(root);
    }
}

export async function probeClothingVideo(path: string, signal?: AbortSignal) {
    const { stdout } = await runFfprobe(["-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height", "-of", "json", path], { timeoutMs: 30_000, signal });
    const metadata = JSON.parse(stdout) as { format?: { duration?: string }; streams?: { codec_type?: string; width?: number; height?: number }[] };
    const video = metadata.streams?.find((stream) => stream.codec_type === "video");
    const durationSeconds = Number(metadata.format?.duration);
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

export type { ClothingModelPolicy };
