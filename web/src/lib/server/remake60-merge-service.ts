import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runFfmpeg, runFfprobe } from "@/lib/server/ffmpeg";
import { writeAssetBytes } from "@/lib/server/generation-log-repository";
import { localMediaStorageKeyFromValue } from "@/lib/server/local-media-references";
import { deleteUserLocalMediaAssets } from "@/lib/server/local-media-storage";
import { downloadMediaToFile } from "@/lib/server/media-download";
import { getVideoTask } from "@/lib/server/video-task-store";
import { normalizeRemakeProjectWorkflow, type HydratedRemakeProject, type RemakeMediaAsset } from "./remake60-project-contract";
import { getRemakeProjectForUser, RemakeProjectServiceError } from "./remake60-project-service";
import { mutateRemakeProject } from "./remake60-project-store";
import { remakeMergeInputVersion } from "./remake60-merge-contract";

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
        workDirectory = await mkdtemp(join(tmpdir(), "vozeb-remake60-merge-"));
        const normalizedFiles: string[] = [];
        for (const group of project.groups) {
            const task = await getVideoTask(group.videoGeneration.taskId!);
            if (!task || task.userId !== input.userId || task.projectId !== project.id || task.generationSlotId !== `remake60-video:${group.id}` || task.status !== "success" || task.requestedDurationSeconds !== 15 || task.result?.url !== group.videoGeneration.result?.url) throw new RemakeProjectServiceError(`分镜 ${group.id} 的视频任务与当前成片不一致`, 409);
            const source = join(workDirectory, `source-${group.ordinal}.mp4`);
            await downloadMediaToFile(group.videoGeneration.result!.url, source, { origin: input.origin, cookie: input.cookie, maxBytes: 200 * 1024 * 1024, timeoutMs: 120_000 });
            const probe = JSON.parse((await runFfprobe(["-v", "error", "-show_streams", "-show_format", "-of", "json", source])).stdout) as { streams?: Array<{ codec_type?: string }>; format?: { duration?: string } };
            if (!probe.streams?.some((stream) => stream.codec_type === "video")) throw new RemakeProjectServiceError(`分镜 ${group.id} 的文件没有有效视频轨道`, 422);
            const duration = Number(probe.format?.duration);
            if (!Number.isFinite(duration) || duration < 14 || duration > 16) throw new RemakeProjectServiceError(`分镜 ${group.id} 的实际时长不是 15 秒，请重新生成`, 422);
            const hasAudio = probe.streams.some((stream) => stream.codec_type === "audio");
            const name = `part-${group.ordinal}.mp4`;
            await runFfmpeg(remakeMergeNormalizationArgs(source, join(workDirectory, name), hasAudio), { timeoutMs: 10 * 60_000 });
            normalizedFiles.push(name);
        }
        await writeFile(join(workDirectory, "segments.txt"), normalizedFiles.map((name) => `file '${name}'`).join("\n"), "utf8");
        const output = join(workDirectory, "merged.mp4");
        await runFfmpeg(["-y", "-f", "concat", "-safe", "1", "-i", "segments.txt", "-c", "copy", "-movflags", "+faststart", output], { cwd: workDirectory, timeoutMs: 10 * 60_000 });
        if ((await stat(output)).size > 200 * 1024 * 1024) throw new RemakeProjectServiceError("合并视频超过文件大小上限", 413);
        const asset = await writeAssetBytes(await readFile(output), "video/mp4", "video", { ownerUserId: input.userId, source: "remake60-merge", taskId: `${project.id}:merged`, originalName: `${project.title}-1分钟.mp4` });
        created = { url: asset.serverUrl || asset.url, storageKey: localMediaStorageKeyFromValue(asset.serverUrl || asset.url), mimeType: "video/mp4", originalName: `${project.title}-1分钟.mp4`, bytes: asset.bytes, width: 720, height: 1280 };
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
    if (project.groups.length !== 4 || project.groups.some((group, index) => group.ordinal !== index + 1 || group.videoGeneration.status !== "completed" || !group.videoGeneration.taskId || !group.videoGeneration.result?.url)) throw new RemakeProjectServiceError("请先完成四条各 15 秒的视频", 409);
}

export function remakeMergeNormalizationArgs(source: string, output: string, hasAudio: boolean) {
    return ["-y", "-i", source, ...(!hasAudio ? ["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000"] : []), "-map", "0:v:0", "-map", hasAudio ? "0:a:0" : "1:a:0", "-vf", "scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=15", "-af", "asetpts=PTS-STARTPTS,apad", "-t", "15", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "48000", "-ac", "2", "-movflags", "+faststart", output];
}
