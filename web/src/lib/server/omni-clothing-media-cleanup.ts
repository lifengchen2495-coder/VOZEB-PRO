import type { OmniClothingProject } from "@/lib/omni-clothing-contract";

import { collectLocalMediaStorageKeys } from "@/lib/server/local-media-references";
import { deleteUserLocalMediaAssets } from "@/lib/server/local-media-storage";
import { mutateOmniClothingProject } from "@/lib/server/omni-clothing-project-store";

export async function mutateOmniClothingProjectWithMediaCleanup(userId: string, id: string, mutate: (project: OmniClothingProject) => OmniClothingProject | null) {
    let previous: OmniClothingProject | undefined;
    const next = await mutateOmniClothingProject(userId, id, (project) => {
        previous = project;
        return mutate(project);
    });
    if (previous && next) {
        const retained = new Set(collectLocalMediaStorageKeys(next));
        const generated = collectLocalMediaStorageKeys({ clips: previous.segments.map((segment) => segment.sourceVideo), mergedVideo: previous.mergedVideo });
        await cleanupOmniClothingMediaAssets(
            userId,
            generated.filter((key) => !retained.has(key)),
        );
    }
    return next;
}

export async function cleanupOmniClothingMediaAssets(userId: string, assets: unknown) {
    const keys = collectLocalMediaStorageKeys(assets);
    if (!keys.length) return;
    try {
        // 共用删除服务会核对归属和 countLocalMediaReferences，保留仍被其他项目引用的文件。
        await deleteUserLocalMediaAssets(userId, keys);
    } catch (error) {
        console.warn("服装复刻旧切片清理失败，素材管理仍可重试清理", { userId, count: keys.length, error });
    }
}
