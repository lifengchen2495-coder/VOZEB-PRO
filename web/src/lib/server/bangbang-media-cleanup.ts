import { BANGBANG_STEPS, bangbangCreationMode, type BangbangProject } from "@/lib/bangbang-contract";
import { containsUserMediaReference } from "./user-media-reference-cleanup";

export function cleanBangbangMediaReferences(project: BangbangProject, keys: string[]): { value: BangbangProject; changed: boolean } {
    const removed = (value: unknown) => containsUserMediaReference(value, keys);
    if (!removed(project)) return { value: project, changed: false };
    const sourceRemoved = removed(project.sourceVideo);
    const framesRemoved = removed(project.sourceFrames);
    const creationMode = bangbangCreationMode(project);
    // 产品原创保留的旧对标素材不参与当前剧本，删除它们无需重置原创结果。
    if (creationMode === "product" && !removed(project.references) && !removed(project.groups)) return {
        changed: true,
        value: { ...project, creationMode, revision: project.revision + 1, updatedAt: new Date(Math.max(Date.now(), Date.parse(project.updatedAt) + 1)).toISOString(), sourceVideo: sourceRemoved ? undefined : project.sourceVideo, sourceFrames: project.sourceFrames.filter((frame) => !removed(frame)) },
    };
    const productRemoved = removed(project.references.product);
    const referencesRemoved = removed(project.references);
    const sourceAffectsStory = creationMode === "reference" && sourceRemoved;
    const framesAffectStory = creationMode === "reference" && framesRemoved;
    const earliest = sourceAffectsStory ? 0 : framesAffectStory ? BANGBANG_STEPS.indexOf("frames") : productRemoved ? BANGBANG_STEPS.indexOf("directions") : referencesRemoved ? BANGBANG_STEPS.indexOf("storyboard") : BANGBANG_STEPS.indexOf("video-prompts");
    const outputs = { ...project.outputs };
    for (const step of BANGBANG_STEPS.slice(earliest)) delete outputs[step];
    const references = {
        product: project.references.product.filter((reference) => !removed(reference)),
        character: project.references.character.filter((reference) => !removed(reference)),
        scene: project.references.scene.filter((reference) => !removed(reference)),
    };
    const firstRemovedGroup = project.groups.findIndex((group) => removed(group.image));
    const resetPlan = earliest <= BANGBANG_STEPS.indexOf("storyboard");
    return {
        changed: true,
        value: {
            ...project, creationMode, revision: project.revision + 1, updatedAt: new Date(Math.max(Date.now(), Date.parse(project.updatedAt) + 1)).toISOString(),
            sourceVideo: sourceRemoved ? undefined : project.sourceVideo,
            sourceFrames: sourceRemoved || framesRemoved ? [] : project.sourceFrames,
            references, outputs, operation: undefined, videoSegments: [],
            directions: sourceAffectsStory || framesAffectStory || productRemoved ? [] : project.directions,
            selectedDirectionId: sourceAffectsStory || framesAffectStory || productRemoved ? "" : project.selectedDirectionId,
            characters: sourceAffectsStory || framesAffectStory || productRemoved ? [] : project.characters.map((character) => ({ ...character, imageId: references.character.some((reference) => reference.id === character.imageId) ? character.imageId : undefined })),
            groups: resetPlan ? [] : project.groups.map((group, index) => firstRemovedGroup >= 0 && index >= firstRemovedGroup ? { ...group, image: { status: "idle", attemptNo: group.image.attemptNo + 1 } } : group),
            error: "项目素材已被删除，请重新准备对应环节",
        },
    };
}
