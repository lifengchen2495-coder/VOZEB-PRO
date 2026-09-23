import { remakePersonGroupTiming, remakePersonTimings, remakePersonTaskTimingMatches, remakePersonOutputSeconds, remakePersonSeconds, type RemakePersonTiming } from "@/lib/remake-person-timing";
import { probeRemakeVideo, assertRemakeVideoLength, remakeVideoTimingFilter } from "./remake-person-video-timing";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { remakeVideoOutputDimensions, type RemakeVideoDimensions, type RemakeVideoSettings } from "@/lib/remake-person-video-settings";

import { runFfmpeg } from "@/lib/server/ffmpeg";
import { writeAssetBytes } from "@/lib/server/generation-log-repository";
import { localMediaStorageKeyFromValue } from "@/lib/server/local-media-references";
import { deleteUserLocalMediaAssets } from "@/lib/server/local-media-storage";
import { downloadMediaToFile } from "@/lib/server/media-download";
import { getVideoTask } from "@/lib/server/video-task-store";
import { normalizeRemakeProjectWorkflow, type HydratedRemakeProject, type RemakeMediaAsset } from "./remake-person-project-contract";
import { getRemakeProjectForUser, RemakeProjectServiceError } from "./remake-person-project-service";
import { mutateRemakeProject } from "./remake-person-project-store";
import { remakeMergeInputVersion } from "./remake-person-merge-contract";

const pending = new Map<string, Promise<HydratedRemakeProject>>();
type MergeRequest = { userId: string; projectId: string; origin: string; cookie: string; expectedRevision?: number };

export async function mergeRemakeVideosForUser(input: MergeRequest) {
    const project = await getRemakeProjectForUser(input.userId, input.projectId);
    if (input.expectedRevision !== undefined && project.revision !== input.expectedRevision) throw new RemakeProjectServiceError("项目版本已变化，请刷新后重试", 409);
    assertMergeReady(project);
    const version = remakeMergeInputVersion(project);
    if (project.mergedVideo?.url && project.mergedVideoInputVersion === version) return project;
    const key = `${input.userId}:${project.id}:${version}`;
    const existing = pending.get(key);
    if (existing) return existing;
    const operation = mergeAndPersist(input, project, version).finally(() => pending.delete(key));
    pending.set(key, operation);
    return operation;
}

async function mergeAndPersist(input: MergeRequest, project: HydratedRemakeProject, version: string) {
    let workDirectory = "";
    let created: RemakeMediaAsset | undefined;
    let committed = false;
    try {
        workDirectory = await mkdtemp(join(tmpdir(), "vozeb-remake-person-merge-"));
        const normalizedFiles: string[] = [];
        let outputDimensions: RemakeVideoDimensions | undefined;
        for (const group of project.groups) {
            const timing = remakePersonGroupTiming(project, group.id)!;
            const task = await getVideoTask(group.videoGeneration.taskId!);
            if (!task || task.userId !== input.userId || task.projectId !== project.id || task.generationSlotId !== `remake-person-video:${group.id}` || task.status !== "success" || !remakePersonTaskTimingMatches(timing, task) || task.result?.url !== group.videoGeneration.result?.url) throw new RemakeProjectServiceError(`分镜 ${group.id} 的视频任务与当前成片不一致`, 409);
            const source = join(workDirectory, `source-${group.ordinal}.mp4`);
            await downloadMediaToFile(group.videoGeneration.result!.url, source, { origin: input.origin, cookie: input.cookie, maxBytes: 200 * 1024 * 1024, timeoutMs: 120_000 });
            const probe = await probeRemakeVideo(source);
            assertRemakeVideoLength(probe.duration, timing, true);
            outputDimensions ||= remakeVideoOutputDimensions(project.videoSettings, probe);
            const hasAudio = probe.hasAudio;
            const name = `part-${group.ordinal}.mp4`;
            await runFfmpeg(remakeMergeNormalizationArgs(source, join(workDirectory, name), hasAudio, project.videoSettings, timing, outputDimensions), { timeoutMs: 10 * 60_000 });
            normalizedFiles.push(`file '${name}'\nduration ${remakePersonOutputSeconds(timing)}`);
        }
        await writeFile(join(workDirectory, "segments.txt"), normalizedFiles.join("\n"), "utf8");
        const output = join(workDirectory, "merged.mp4");
        const timings = remakePersonTimings(project);
        const totalSeconds = timings.reduce((sum, timing) => sum + timing.outputFrames, 0) / 30;
        await runFfmpeg(["-y", "-f", "concat", "-safe", "1", "-i", "segments.txt", "-vf", remakeVideoTimingFilter(), "-af", "asetpts=PTS-STARTPTS,apad", "-t", String(totalSeconds), "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "aac", "-movflags", "+faststart", output], { cwd: workDirectory, timeoutMs: 10 * 60_000 });
        const delivered = await probeRemakeVideo(output);
        if (Math.abs(delivered.duration - totalSeconds) > 0.002) throw new RemakeProjectServiceError("合并视频时长与原视频不一致，请重试", 422);
        const originalName = `${project.title}-${remakePersonSeconds(timings[0].sourceDurationMs)}秒.mp4`;
        if ((await stat(output)).size > 200 * 1024 * 1024) throw new RemakeProjectServiceError("合并视频超过文件大小上限", 413);
        const asset = await writeAssetBytes(await readFile(output), "video/mp4", "video", { ownerUserId: input.userId, source: "remake-person-merge", taskId: `${project.id}:merged`, originalName });
        created = { url: asset.serverUrl || asset.url, storageKey: localMediaStorageKeyFromValue(asset.serverUrl || asset.url), mimeType: "video/mp4", originalName, bytes: asset.bytes, durationMs: Math.round(delivered.duration * 1000), width: delivered.width, height: delivered.height };
        const saved = await mutateRemakeProject(input.userId, project.id, (current) => {
            if (remakeMergeInputVersion(current) !== version) throw new RemakeProjectServiceError("合并期间视频已变化，请按最新四段重新合并", 409);
            return { ...current, mergedVideo: created, mergedVideoInputVersion: version, revision: current.revision + 1, updatedAt: new Date().toISOString() };
        });
        if (!saved) throw new RemakeProjectServiceError("复刻项目不存在", 404);
        committed = true;
        if (project.mergedVideo?.storageKey && project.mergedVideo.storageKey !== created.storageKey) await deleteUserLocalMediaAssets(input.userId, [project.mergedVideo.storageKey]);
        return normalizeRemakeProjectWorkflow(saved);
    } finally {
        if (!committed && created?.storageKey) await deleteUserLocalMediaAssets(input.userId, [created.storageKey]);
        if (workDirectory) await rm(workDirectory, { recursive: true, force: true });
    }
}

export function assertMergeReady(project: HydratedRemakeProject) {
    if (!remakePersonTimings(project).length) throw new RemakeProjectServiceError("原视频时间轴不完整，请重新分析", 409);
    if (!project.groups.length || project.groups.length !== remakePersonTimings(project).length || project.groups.some((group, index) => group.ordinal !== index + 1 || group.videoGeneration.status !== "completed" || !group.videoGeneration.taskId || !group.videoGeneration.result?.url)) throw new RemakeProjectServiceError("请先按原视频时长完成全部分组视频", 409);
}

export function remakeMergeNormalizationArgs(source: string, output: string, hasAudio: boolean, settings: RemakeVideoSettings | undefined, timing: RemakePersonTiming, sourceDimensions?: RemakeVideoDimensions) {
    const { width, height } = remakeVideoOutputDimensions(settings, sourceDimensions);
    return ["-y", "-i", source, ...(!hasAudio ? ["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000"] : []), "-map", "0:v:0", "-map", hasAudio ? "0:a:0" : "1:a:0", "-vf", `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,${remakeVideoTimingFilter()}`, "-af", "asetpts=PTS-STARTPTS,apad", "-t", String(remakePersonOutputSeconds(timing)), "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "48000", "-ac", "2", "-movflags", "+faststart", output];
}
