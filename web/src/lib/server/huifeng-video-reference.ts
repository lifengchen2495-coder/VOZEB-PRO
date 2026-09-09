import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFfprobe } from "./ffmpeg";
import { downloadMediaToFile } from "./media-download";
import { maintenanceWorkerContextHeaders } from "./maintenance-auth";

export async function inspectHuifengVideoReference(input: { url: string; origin: string; publicOrigin: string; credential: string }) {
    const source = new URL(input.url, input.publicOrigin);
    const internal = source.origin === new URL(input.publicOrigin).origin;
    if (internal && !/^\/api\/(?:reference-assets|generation-log-assets)\//.test(source.pathname)) throw new Error("汇风参考视频需要已上传的素材或公网视频直链");
    const directory = await mkdtemp(join(tmpdir(), "vozeb-huifeng-reference-"));
    try {
        const path = join(directory, "source-video");
        const workerHeaders = maintenanceWorkerContextHeaders(input.credential);
        const downloaded = await downloadMediaToFile(internal ? `${source.pathname}${source.search}` : source.toString(), path, {
            origin: input.origin,
            cookie: workerHeaders ? undefined : input.credential,
            internalHeaders: workerHeaders || undefined,
            maxBytes: 100 * 1024 * 1024,
            timeoutMs: 3 * 60_000,
        });
        const probe = await runFfprobe(["-v", "error", "-show_entries", "format=format_name,duration:stream=codec_type,width,height,duration", "-of", "json", path], { timeoutMs: 30_000 });
        const payload = JSON.parse(probe.stdout) as { format?: { format_name?: string; duration?: string }; streams?: Array<{ codec_type?: string; width?: number; height?: number; duration?: string }> };
        const video = payload.streams?.find((stream) => stream.codec_type === "video");
        const streamDuration = Number(video?.duration);
        const duration = Number.isFinite(streamDuration) && streamDuration > 0 ? streamDuration : Number(payload.format?.duration);
        if (!payload.format?.format_name?.split(",").some((format) => format === "mov" || format === "mp4") || !video?.width || !video.height) throw new Error("汇风 Omni 视频编辑仅支持包含有效视频画面的 MP4／MOV");
        if (video.width < 700) throw new Error("汇风 Omni 参考视频宽度至少需要 700px，请重新准备片段");
        if (!Number.isFinite(duration) || duration < 3 || duration > 10) throw new Error("汇风 Omni 参考视频必须为 3–10 秒，请调整切点后重新准备片段");
        return { duration: Math.round(duration * 1000) / 1000, width: video.width, height: video.height, bytes: downloaded.bytes };
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}
