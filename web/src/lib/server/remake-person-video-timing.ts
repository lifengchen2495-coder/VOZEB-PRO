import { REMAKE_PERSON_OUTPUT_FPS, remakePersonOutputSeconds, type RemakePersonTiming } from "@/lib/remake-person-timing";
import { runFfmpeg, runFfprobe } from "./ffmpeg";

export async function probeRemakeVideo(path: string) {
    const probe = JSON.parse((await runFfprobe(["-v", "error", "-show_streams", "-show_format", "-of", "json", path])).stdout) as {
        streams?: Array<{ codec_type?: string; duration?: string }>;
        format?: { duration?: string };
    };
    const video = probe.streams?.find((stream) => stream.codec_type === "video");
    const duration = Number(video?.duration || probe.format?.duration);
    if (!video || !Number.isFinite(duration) || duration <= 0) throw new Error("生成文件没有有效的视频轨道或时长");
    return { duration, hasAudio: Boolean(probe.streams?.some((stream) => stream.codec_type === "audio")) };
}

export function assertRemakeVideoLength(duration: number, timing: RemakePersonTiming, exact = false) {
    const target = remakePersonOutputSeconds(timing);
    // 仅容忍一帧舍入误差，不能把缺失内容用长时间定格补齐。
    if (duration < target - 1 / REMAKE_PERSON_OUTPUT_FPS - 0.002 || (exact && Math.abs(duration - target) > 1 / REMAKE_PERSON_OUTPUT_FPS + 0.002)) {
        throw new Error(`分镜 ${timing.groupId} 实际视频为 ${duration.toFixed(3)} 秒，与本组 ${timing.durationMs / 1000} 秒不符，请重新生成`);
    }
}

export function remakeVideoTimingFilter() {
    return `setpts=PTS-STARTPTS,fps=${REMAKE_PERSON_OUTPUT_FPS},tpad=stop_mode=clone:stop_duration=${1 / REMAKE_PERSON_OUTPUT_FPS}`;
}

export async function trimRemakePersonVideo(source: string, output: string, timing: RemakePersonTiming) {
    const probe = await probeRemakeVideo(source);
    assertRemakeVideoLength(probe.duration, timing);
    await runFfmpeg([
        "-y", "-i", source, "-map", "0:v:0", "-map", "0:a:0?",
        "-vf", remakeVideoTimingFilter(),
        ...(probe.hasAudio ? ["-af", "asetpts=PTS-STARTPTS,apad"] : []),
        "-t", String(remakePersonOutputSeconds(timing)),
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-movflags", "+faststart", output,
    ], { timeoutMs: 10 * 60_000 });
    const delivered = await probeRemakeVideo(output);
    assertRemakeVideoLength(delivered.duration, timing, true);
    return Math.round(delivered.duration * 1000);
}
