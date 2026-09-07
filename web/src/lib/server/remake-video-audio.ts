import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { VideoGenerationReference } from "@/lib/video-reference-contract";
import { runFfmpeg, runFfprobe } from "@/lib/server/ffmpeg";
import { createSignedReferenceAssetUrl } from "@/lib/server/reference-asset-access";
import { writeReferenceMediaFile } from "@/lib/server/reference-asset-store";
import { fetchRemakeProductionImage } from "@/lib/server/remake-production-image-fetch";

const MAX_AUDIO_BYTES = 30 * 1024 * 1024;
const CACHE_TTL_MS = 5 * 60_000;
const CACHE_MAX_ENTRIES = 64;
const conversionCache = new Map<string, { expiresAt: number; token: Promise<string> }>();

type AudioInput = {
    references: VideoGenerationReference[];
    userId: string;
    internalOrigin: string;
    publicOrigin: string;
    projectId: string;
};

export async function normalizeRemakeVideoAudioReferences(input: AudioInput): Promise<VideoGenerationReference[]> {
    return Promise.all(input.references.map(async (reference) => {
        if (reference.type !== "audio") return reference;
        const source = new URL(reference.url, input.publicOrigin);
        if (source.origin !== new URL(input.publicOrigin).origin || source.username || source.password || !/^\/api\/(?:reference-assets|generation-log-assets)\/(?:temporary|permanent)\/\d{4}\/\d{2}\/\d{2}\/audio\/[^/]+$/.test(source.pathname)) {
            throw new Error("复刻参考音频必须是当前站点的受管素材");
        }
        const now = Date.now();
        for (const [key, entry] of conversionCache) if (entry.expiresAt <= now) conversionCache.delete(key);
        const key = JSON.stringify([input.userId, source.origin, source.pathname, "mp3-14.8s-v1"]);
        let entry = conversionCache.get(key);
        if (!entry) {
            if (conversionCache.size >= CACHE_MAX_ENTRIES) conversionCache.delete(conversionCache.keys().next().value!);
            const token = convertReferenceAudio(source, input);
            entry = { expiresAt: now + CACHE_TTL_MS, token };
            conversionCache.set(key, entry);
            const pending = entry;
            void token.catch(() => {
                if (conversionCache.get(key) === pending) conversionCache.delete(key);
            });
        }
        const token = await entry.token;
        const url = createSignedReferenceAssetUrl(token, input.publicOrigin, input.userId);
        if (!url) throw new Error("复刻参考音频签名不可用，请检查站点地址和加密密钥");
        return { ...reference, url };
    }));
}

async function convertReferenceAudio(source: URL, input: AudioInput) {
    const workdir = await mkdtemp(join(tmpdir(), "vozeb-remake-audio-"));
    try {
        const sourcePath = join(workdir, "source-audio");
        const outputPath = join(workdir, "reference.mp3");
        const target = `${input.internalOrigin.replace(/\/+$/, "")}${source.pathname}${source.search}`;
        const response = await fetchRemakeProductionImage(target, { internal: true, cookie: "" });
        await writeFile(sourcePath, await readAudioBytes(response));
        const sourceProbe = await probeAudio(sourcePath);
        if (sourceProbe.duration < 2) throw new Error("复刻参考音频至少需要 2 秒有效音频");
        try {
            // MP3 编码会附加少量延迟，预留余量避免超过渠道的 15 秒上限。
            await runFfmpeg(["-hide_banner", "-loglevel", "error", "-protocol_whitelist", "file,pipe", "-i", sourcePath, "-map", "0:a:0", "-vn", "-t", "14.8", "-c:a", "libmp3lame", "-b:a", "96k", "-ac", "1", "-ar", "44100", "-f", "mp3", "-y", outputPath], { timeoutMs: 60_000 });
        } catch {
            throw new Error("复刻参考音频无法转换为 MP3，请检查原音频是否有效");
        }
        const outputProbe = await probeAudio(outputPath);
        if (outputProbe.codec !== "mp3" || outputProbe.duration < 2 || outputProbe.duration > 15 || outputProbe.channels !== 1 || outputProbe.sampleRate !== 44100) {
            throw new Error("复刻参考音频转换结果不符合 MP3、2 至 15 秒的要求");
        }
        const asset = await writeReferenceMediaFile(outputPath, "audio", "audio/mpeg", false, {
            ownerUserId: input.userId,
            source: "remake-video-audio",
            originalName: "remake-voice-reference.mp3",
            projectId: input.projectId,
        });
        return asset.token;
    } finally {
        await rm(workdir, { recursive: true, force: true }).catch(() => undefined);
    }
}

async function probeAudio(path: string) {
    try {
        const { stdout } = await runFfprobe(["-v", "error", "-protocol_whitelist", "file,pipe", "-select_streams", "a:0", "-show_entries", "stream=codec_name,sample_rate,channels,duration:format=duration", "-of", "json", path], { timeoutMs: 15_000 });
        const data = JSON.parse(stdout) as { streams?: Array<{ codec_name?: string; sample_rate?: string; channels?: number; duration?: string }>; format?: { duration?: string } };
        const stream = data.streams?.[0];
        const duration = Number(data.format?.duration || stream?.duration);
        if (!stream?.codec_name || !Number.isFinite(duration) || duration <= 0) throw new Error("Invalid audio");
        return { duration, codec: stream.codec_name, sampleRate: Number(stream.sample_rate), channels: stream.channels };
    } catch {
        throw new Error("复刻参考音频无法解码，请检查原音频是否有效");
    }
}

async function readAudioBytes(response: Response) {
    if (!response.ok || !response.body) throw new Error(`复刻参考音频读取失败（${response.status}）`);
    if (Number(response.headers.get("content-length")) > MAX_AUDIO_BYTES) {
        await response.body.cancel().catch(() => undefined);
        throw new Error("复刻参考音频不能超过 30MB");
    }
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let size = 0;
    try {
        for (;;) {
            const next = await reader.read();
            if (next.done) break;
            size += next.value.byteLength;
            if (size > MAX_AUDIO_BYTES) throw new Error("复刻参考音频不能超过 30MB");
            chunks.push(Buffer.from(next.value));
        }
        if (!size) throw new Error("复刻参考音频为空");
        return Buffer.concat(chunks, size);
    } catch (error) {
        await reader.cancel(error).catch(() => undefined);
        throw error;
    } finally {
        reader.releaseLock();
    }
}
