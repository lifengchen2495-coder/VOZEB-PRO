export function mergeCreateAssetSelection(selectedIds: readonly string[], draftIds: readonly string[], addedIds: readonly string[] = []) {
    return Array.from(new Set([...selectedIds, ...draftIds, ...addedIds]));
}

export function toggleCreateAssetSelection(selectedIds: readonly string[], draftIds: readonly string[], assetId: string) {
    const current = mergeCreateAssetSelection(selectedIds, draftIds);
    return current.includes(assetId) ? current.filter((id) => id !== assetId) : [...current, assetId];
}

export function replaceCreateAssetSelection(selectedIds: readonly string[], draftIds: readonly string[], replacements: ReadonlyMap<string, string>) {
    // 替换原位置，避免上传后把产品图或排版参考移到队尾。
    return Array.from(new Set(mergeCreateAssetSelection(selectedIds, draftIds).map((id) => replacements.get(id) || id)));
}

export function retainCreateAssetSelection(selectedIds: readonly string[], draftIds: readonly string[], readyIds: ReadonlySet<string>) {
    const availableIds = new Set([...readyIds, ...draftIds]);
    return mergeCreateAssetSelection(selectedIds, draftIds).filter((id) => availableIds.has(id));
}
