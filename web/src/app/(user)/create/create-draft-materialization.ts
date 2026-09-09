import type { CreativeAsset, CreativeGenerationPreferences } from "@/lib/creative-runtime-contract";

export async function materializeCreateDraftAssets(
    drafts: readonly { id: string; file: File }[],
    upload: (file: File) => Promise<CreativeAsset>,
    onMaterialized: (replacements: ReadonlyMap<string, CreativeAsset>) => void,
) {
    const replacements = new Map<string, CreativeAsset>();
    try {
        for (const { id, file } of drafts) replacements.set(id, await upload(file));
        return replacements;
    } finally {
        // 部分上传成功也立即同步，重试时复用真实素材，保留未完成的草稿。
        if (replacements.size) onMaterialized(replacements);
    }
}

export function remapDraftAssetIds(preferences: CreativeGenerationPreferences | undefined, replacements: ReadonlyMap<string, CreativeAsset>): CreativeGenerationPreferences | undefined {
    if (!preferences || !replacements.size) return preferences;
    const remap = (id: string) => replacements.get(id)?.id || id;
    return {
        ...preferences,
        ...(preferences.image ? { image: { ...preferences.image, ...(preferences.image.references ? { references: preferences.image.references.map((reference) => ({ ...reference, assetId: remap(reference.assetId) })) } : {}) } } : {}),
        ...(preferences.video ? {
            video: {
                ...preferences.video,
                ...(preferences.video.firstFrameAssetId ? { firstFrameAssetId: remap(preferences.video.firstFrameAssetId) } : {}),
                ...(preferences.video.lastFrameAssetId ? { lastFrameAssetId: remap(preferences.video.lastFrameAssetId) } : {}),
            },
        } : {}),
    };
}
