import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthSettings } from "@/lib/auth/store";
import { assertFrameRemakePromptResolved } from "@/lib/frame-remake-feishu-workflow";
import { resolveLogicalModelCandidates, type ResolvedLogicalModel } from "./logical-model-router";
import { maintenanceWorkerContextHeaders } from "./maintenance-auth";
import { systemAiBillingHeaders } from "./system-ai-billing";
import { resolveModelRequestTimeoutMs } from "./model-request-policy";
import { RemakeProductionVisionError, requestRemakeVisionPrompt, resolveRemakeVisionProtocol } from "./remake-vision-request";
import { requestBangbangFullVideo, supportsBangbangFullVideo, supportsBangbangVideoInput } from "./bangbang-runtime-video";
import { runFfprobe } from "./ffmpeg";
import { toSafeGenerationErrorMessage } from "./generation-errors";

export type FrameOriginalFile = { type: "video" | "image"; file_name: string; file_base64: string; content_type: string; fps?: number };
type FrameModelRequirements = { fullVideo?: boolean; imageCount?: number };

// 保留调用名称以兼容已保存项目；模型来自站内渠道，不绑定原表插件的服务商。
export function resolveFrameOriginalModel(settings: AuthSettings, capability: "text" | "image", requested = "", requirements: FrameModelRequirements = {}) {
    const fallback = capability === "text" ? settings.defaultModels.textModel : settings.defaultModels.imageModel;
    const ids = requested.trim() ? [requested.trim()] : Array.from(new Set([
        fallback,
        ...settings.logicalModels.filter((model) => model.enabled && model.capability === capability).map((model) => model.id),
        ...(settings.logicalModels.length ? [] : settings.systemChannels.filter((channel) => channel.enabled).flatMap((channel) => channel.models)),
    ].filter(Boolean)));
    for (const id of ids) {
        const candidate = resolveLogicalModelCandidates(settings, capability, id).find((item) => {
            if (!item.channel.apiKey.trim()) return false;
            if (capability === "image") return true;
            return requirements.fullVideo ? supportsBangbangFullVideo(item) : Boolean(resolveRemakeVisionProtocol(item, requirements.imageCount ?? 0));
        });
        if (candidate) return candidate;
    }
    throw new Error(requirements.fullVideo
        ? "所选模型没有已配置的完整视频理解渠道，请选择支持视频理解的 Doubao Seed 2.0 Pro"
        : `请选择已配置的${capability === "image" ? "生图" : requirements.imageCount ? "图片理解" : "文本"}模型`);
}

export async function requestFrameOriginalText(input: { origin: string; credential: string; candidate: ResolvedLogicalModel; prompt: string; files: FrameOriginalFile[]; idempotencyKey: string; signal?: AbortSignal }) {
    // 在读写媒体、上传文件或调用计费代理之前拒绝缺少原文的模块引用。
    assertFrameRemakePromptResolved(input.prompt);
    input.signal?.throwIfAborted();
    const videos = input.files.filter((file) => file.type === "video");
    const headers = new Headers({
        "content-type": "application/json",
        ...systemAiBillingHeaders(input.candidate.logicalModelId, input.idempotencyKey, input.candidate.upstreamModel),
        ...(maintenanceWorkerContextHeaders(input.credential) || { cookie: input.credential }),
    });
    const messages = [{ role: "user", content: input.prompt }];
    if (!videos.length) {
        return requestRemakeVisionPrompt({
            origin: input.origin,
            cookie: input.credential,
            candidate: input.candidate,
            messages,
            boards: input.files.map((file) => ({ mimeType: file.content_type, bytes: Buffer.from(file.file_base64, "base64") })),
            headers,
            maxOutputTokens: 24_000,
            defaultTimeoutMs: 600_000,
            signal: input.signal,
        });
    }
    if (videos.length !== 1 || input.files.length !== 1 || !supportsBangbangVideoInput(input.candidate)) throw new Error("当前视频分析需单个来源视频与已配置的 Doubao 完整视频理解渠道");
    const started = Date.now();
    const directory = await mkdtemp(join(tmpdir(), "vozeb-frame-video-"));
    let responseHeaders: Headers | undefined;
    try {
        const sourcePath = join(directory, "source.mp4");
        await writeFile(sourcePath, Buffer.from(videos[0].file_base64, "base64"), { signal: input.signal });
        const probe = await runFfprobe(["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=duration:format=duration", "-of", "json", sourcePath], { timeoutMs: 30_000, signal: input.signal });
        const metadata = JSON.parse(probe.stdout) as { streams?: Array<{ duration?: string }>; format?: { duration?: string } };
        const duration = [metadata.streams?.[0]?.duration, metadata.format?.duration].map(Number).find((value) => Number.isFinite(value) && value > 0);
        if (!duration) throw new Error("来源视频时长无效");
        const text = await requestBangbangFullVideo({
            sourcePath,
            workDirectory: directory,
            duration,
            candidate: input.candidate,
            origin: input.origin,
            messages,
            headers,
            signal: input.signal
                ? AbortSignal.any([input.signal, AbortSignal.timeout(resolveModelRequestTimeoutMs(input.candidate, "text", 600_000))])
                : AbortSignal.timeout(resolveModelRequestTimeoutMs(input.candidate, "text", 600_000)),
            onResponse: (value) => { responseHeaders = value; },
        });
        return { text, headers: responseHeaders!, elapsedMs: Date.now() - started };
    } catch (error) {
        throw new RemakeProductionVisionError(toSafeGenerationErrorMessage(error, "视频理解调用失败"), input.signal?.aborted ? 499 : 502, responseHeaders);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}
