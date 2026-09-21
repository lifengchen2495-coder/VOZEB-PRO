import type { RemakePersonTiming } from "@/lib/remake-person-timing";
import { trimRemakePersonVideo } from "./remake-person-video-timing";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeReferenceMediaFile } from "@/lib/server/reference-asset-store";
import { downloadMediaToFile } from "@/lib/server/media-download";

const MAX_VIDEO_BYTES = 300 * 1024 * 1024;

export type NormalizedVideoResult = {
    url: string;
    mimeType: string;
    durationMs?: number;
};

export async function normalizeVideoResult(input: {
    url: string;
    origin: string;
    cookie?: string;
    internalHeaders?: HeadersInit;
    requestedDurationSeconds?: number;
    remakePersonTiming?: RemakePersonTiming;
    mimeType?: string;
    ownerUserId: string;
    source?: string;
    conversationId?: string;
    runId?: string;
    taskId?: string;
    projectId?: string;
}) {
    const workdir = await mkdtemp(join(tmpdir(), "vozeb-pro-video-"));
    const sourcePath = join(workdir, "source-video");
    try {
        const downloaded = await downloadMediaToFile(input.url, sourcePath, { origin: input.origin, cookie: input.cookie, internalHeaders: input.internalHeaders, maxBytes: MAX_VIDEO_BYTES });
        const requestedDuration = normalizeRequestedDuration(input.requestedDurationSeconds);
        const mimeType = input.remakePersonTiming ? "video/mp4" : downloaded.mimeType.startsWith("video/") ? downloaded.mimeType : input.mimeType || "video/mp4";

        const outputPath = input.remakePersonTiming ? join(workdir, "timed-video.mp4") : sourcePath;
        const durationMs = input.remakePersonTiming ? await trimRemakePersonVideo(sourcePath, outputPath, input.remakePersonTiming) : requestedDuration ? requestedDuration * 1000 : undefined;
        const asset = await writeReferenceMediaFile(outputPath, "video", mimeType, true, {
            ownerUserId: input.ownerUserId,
            source: input.source || "video-task",
            conversationId: input.conversationId,
            runId: input.runId,
            taskId: input.taskId,
            projectId: input.projectId,
        });
        return {
            url: asset.url || `/api/reference-assets/${asset.token}`,
            mimeType,
            ...(durationMs ? { durationMs } : {}),
        } satisfies NormalizedVideoResult;
    } finally {
        await rm(workdir, { recursive: true, force: true }).catch(() => undefined);
    }
}

function normalizeRequestedDuration(value: unknown) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}
