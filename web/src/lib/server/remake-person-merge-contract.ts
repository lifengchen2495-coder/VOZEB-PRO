import { remakePersonTimings } from "@/lib/remake-person-timing";
import { createHash } from "node:crypto";
import { remakeVideoSettingsKey } from "@/lib/remake-person-video-settings";
import type { RemakeProject } from "./remake-person-project-contract";

export function remakeMergeInputVersion(project: Pick<RemakeProject, "id" | "groups" | "videoSettings" | "frames" | "sourceVideo">) {
    const settings = remakeVideoSettingsKey(project.videoSettings);
    return createHash("sha256").update(JSON.stringify({ id: project.id, timings: remakePersonTimings(project), ...(settings ? { videoSettings: settings } : {}), groups: project.groups?.map((group) => ({ id: group.id, videoPrompt: group.videoPrompt, status: group.videoGeneration.status, taskId: group.videoGeneration.taskId || "", attemptNo: group.videoGeneration.attemptNo ?? 0, model: group.videoGeneration.model || "", url: group.videoGeneration.result?.url || "" })) })).digest("hex");
}

export function invalidateRemakeMergedVideo(previous: RemakeProject, next: RemakeProject): RemakeProject {
    if (remakeMergeInputVersion(previous) === remakeMergeInputVersion(next)) return next;
    return { ...next, mergedVideo: undefined, mergedVideoInputVersion: undefined };
}
