import { CreativeRuntimeInputError, type CommerceImageReferenceRole, type CreativeAsset, type CreativeImageReference } from "@/lib/creative-runtime-contract";
import type { AgentRunReference } from "./agent-run-store";

const ROLE_INSTRUCTIONS: Record<CommerceImageReferenceRole, string> = {
    product: "产品图：商品外观、颜色、材质、包装和品牌以此图为准，保持商品一致",
    layout: "排版参考：只参考构图和排版，替换其中的旧商品和旧文案，不得将旧商品作为当前产品",
    background: "背景参考：仅参考环境、场景和氛围，不得替换产品主体",
    person: "人物参考：仅参考人物身份和姿势，不得将人物图中的商品作为当前产品",
};

export function assertImageReferenceAssets(references: readonly CreativeImageReference[], assets: readonly CreativeAsset[], userId?: string) {
    const byId = new Map(assets.map((asset) => [asset.id, asset]));
    for (const { assetId } of references) {
        const asset = byId.get(assetId);
        if (!asset || (userId !== undefined && asset.userId !== userId) || asset.status !== "ready") throw new CreativeRuntimeInputError("已标注用途的图片不存在或已失效");
        if (asset.type !== "image") throw new CreativeRuntimeInputError("图片素材用途只能绑定图片素材");
        if (![asset.remoteUrl, asset.serverUrl].some((url) => typeof url === "string" && url.trim() && !url.trim().startsWith("data:"))) throw new CreativeRuntimeInputError("已标注用途的图片暂不可用，请重新上传");
    }
}

export function finalImageReferenceAliases(references: readonly AgentRunReference[]) {
    return new Map(references.filter((reference) => reference.type === "image").flatMap((reference, index) => reference.assetId ? [[reference.assetId, `图片${index + 1}`] as const] : []));
}

export function applyImageReferenceRoles(prompt: string, bindings: readonly CreativeImageReference[], references: readonly AgentRunReference[], originalAliases: ReadonlyMap<string, string>) {
    if (!bindings.length) return prompt;
    const finalAliases = finalImageReferenceAliases(references);
    const replacements = new Map(Array.from(originalAliases, ([id, alias]) => [alias, finalAliases.get(id) || `未提供的图片（资产 ID：${id}）`]));
    // 先整体替换原编号，避免逐项替换时把交换后的编号再次替换。
    const content = prompt.replace(/\n\n【图片素材用途绑定】[\s\S]*?【图片素材用途绑定结束】/g, "").replace(/@?图片([1-9]\d*)(?!\d)/g, (match, ordinal: string) => {
        const replacement = replacements.get(`图片${ordinal}`);
        return replacement ? `${match.startsWith("@") ? "@" : ""}${replacement}` : match;
    });
    const roles = new Map(bindings.map((binding) => [binding.assetId, binding.role]));
    const lines = references.filter((reference) => reference.type === "image").map((reference, index) => {
        const role = reference.assetId ? roles.get(reference.assetId) : undefined;
        return `@图片${index + 1}（实际参考图第 ${index + 1} 张${reference.assetId ? `，资产 ID：${reference.assetId}` : ""}）：${role ? ROLE_INSTRUCTIONS[role] : "辅助参考：不得覆盖已标注产品图的商品身份和外观"}。`;
    });
    return `${content}\n\n【图片素材用途绑定】\n以下编号与实际提交给图片模型的图片顺序一致，必须按这些用途使用素材，不得交换角色；其他描述与素材用途冲突时，以本节的用途绑定为准：\n${lines.join("\n")}\n【图片素材用途绑定结束】`;
}
