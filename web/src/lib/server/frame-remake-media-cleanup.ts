import { idleFrameRemakeTask, type FrameRemakeProject } from "@/lib/frame-remake-contract";
import { containsUserMediaReference } from "./user-media-reference-cleanup";

export function cleanFrameRemakeMediaReferences(project: FrameRemakeProject, keys: string[]): { value: FrameRemakeProject; changed: boolean } {
    const removed = (value: unknown) => containsUserMediaReference(value, keys);
    if (!removed(project)) return { value: project, changed: false };
    const sourceRemoved = removed(project.sourceVideo);
    const targetsRemoved = removed(project.references);
    return {
        changed: true,
        value: {
            ...project,
            revision: project.revision + 1,
            updatedAt: new Date(Math.max(Date.now(), Date.parse(project.updatedAt) + 1)).toISOString(),
            sourceVideo: sourceRemoved ? undefined : project.sourceVideo,
            durationMs: sourceRemoved ? 0 : project.durationMs,
            references: { product: project.references.product.filter((item) => !removed(item)), character: project.references.character.filter((item) => !removed(item)), background: project.references.background.filter((item) => !removed(item)) },
            operation: undefined,
            automation: project.automation ? { ...project.automation, status: "error", leaseId: undefined, leaseUntil: undefined } : undefined,
            mergedVideo: undefined,
            error: "素材已被删除，请重新准备对应分组",
            groups: sourceRemoved
                ? []
                : project.groups.map((group) => {
                      const framesRemoved = removed(group.frames) || removed(group.contactSheet);
                      const resetTemplate = targetsRemoved || framesRemoved || removed(group.template);
                      const resetImage = resetTemplate || removed(group.image);
                      const resetVideo = resetImage || removed(group.video);
                      return {
                          ...group,
                          frames: framesRemoved ? group.frames.map(({ media: _media, ...frame }) => frame) : group.frames,
                          contactSheet: framesRemoved ? undefined : group.contactSheet,
                          productScript: targetsRemoved || framesRemoved ? "" : group.productScript,
                          analysisSteps: framesRemoved ? undefined : targetsRemoved ? { analysis: group.analysisSteps?.analysis } : resetImage ? { ...group.analysisSteps, videoPrompt: undefined } : group.analysisSteps,
                          analysis: framesRemoved ? "" : group.analysis,
                          imagePrompt: targetsRemoved || framesRemoved ? "" : group.imagePrompt,
                          videoPrompt: resetImage ? "" : group.videoPrompt,
                          template: resetTemplate ? idleFrameRemakeTask(group.template.attemptNo + 1) : group.template,
                          image: resetImage ? idleFrameRemakeTask(group.image.attemptNo + 1) : group.image,
                          video: resetVideo ? idleFrameRemakeTask(group.video.attemptNo + 1) : group.video,
                      };
                  }),
        },
    };
}
