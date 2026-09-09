import { creativeAssetReferenceAliases } from "@/lib/creative-asset-references";
import type { CommerceImageReferenceRole, CreativeAsset } from "@/lib/creative-runtime-contract";

export type { CommerceImageReferenceRole } from "@/lib/creative-runtime-contract";

export type CommerceImageWorkflow = "showcase" | "reference-edit";

export type CommerceImageBrief = {
    workflow: CommerceImageWorkflow;
    productName: string;
    platform: string;
    imageType: string;
    sellingPoints: string;
    requirements: string;
    referenceRoles: Record<string, CommerceImageReferenceRole>;
};

export const COMMERCE_IMAGE_REFERENCE_ROLES = [
    { value: "product", label: "产品图", description: "以这张图中的商品外观、颜色和材质为准" },
    { value: "layout", label: "排版参考", description: "参考构图和排版，替换其中的旧商品和旧文案" },
    { value: "background", label: "背景参考", description: "仅参考环境、场景和氛围" },
    { value: "person", label: "人物参考", description: "仅参考人物身份和姿势" },
] as const satisfies readonly { value: CommerceImageReferenceRole; label: string; description: string }[];

type CommerceImageRequestInput = {
    brief: CommerceImageBrief;
    assets: readonly CreativeAsset[];
    selectedAssetIds: readonly string[];
    prompt: string;
};

// 与创作运行时的需求长度限制一致，避免素材规则被截断。
const MAX_COMMERCE_IMAGE_PROMPT_LENGTH = 4000;

export function createCommerceImageBrief(): CommerceImageBrief {
    return {
        workflow: "showcase",
        productName: "",
        platform: "通用电商",
        imageType: "白底主图",
        sellingPoints: "",
        requirements: "",
        referenceRoles: {},
    };
}

export function validateCommerceImageBrief(input: CommerceImageRequestInput): string | undefined {
    const { brief, assets, selectedAssetIds, prompt } = input;
    if (!brief.productName.trim()) return "请填写产品名称。";
    if (selectedAssetIds.length === 0) return "请先选择至少一张产品图，并标注素材用途。";

    const assetsById = new Map(assets.map((asset) => [asset.id, asset]));
    const aliases = creativeAssetReferenceAliases(assets, selectedAssetIds);
    const roles = new Set<CommerceImageReferenceRole>();
    for (const assetId of new Set(selectedAssetIds)) {
        const asset = assetsById.get(assetId);
        if (!asset) return "所选素材已不存在，请移除后重新选择。";
        if (asset.type !== "image") return "电商图片模式只支持图片素材，请移除视频、音频或文本素材。";
        if (asset.status !== "ready" || !(asset.serverUrl?.trim() || asset.remoteUrl?.trim())) return `@${aliases.get(assetId)} 暂不可用，请重新上传或选择可用图片。`;
        const role = brief.referenceRoles[assetId];
        if (!COMMERCE_IMAGE_REFERENCE_ROLES.some((item) => item.value === role)) return `请为 @${aliases.get(assetId)} 选择素材用途。`;
        roles.add(role);
    }

    if (!roles.has("product")) return "请至少将一张已选图片标注为“产品图”，作为商品外观依据。";
    if (brief.workflow === "reference-edit") {
        if (!roles.has("layout")) return "参考图改图需要另一张“排版参考”图片，请选择参考图并标注用途。";
        if (!brief.requirements.trim() && !prompt.trim()) return "请描述如何修改参考图，例如要替换的商品、文案或背景。";
    }
    if (buildCommerceImageRequest(input).prompt.length > MAX_COMMERCE_IMAGE_PROMPT_LENGTH) return "当前需求与素材说明过长，请精简产品信息或补充要求后再生成。";
    return undefined;
}

export function buildCommerceImageRequest({ brief, assets, selectedAssetIds, prompt }: CommerceImageRequestInput): { prompt: string; publicPrompt: string } {
    const aliases = creativeAssetReferenceAliases(assets, selectedAssetIds);
    const assetsById = new Map(assets.map((asset) => [asset.id, asset]));
    const references = Array.from(new Set(selectedAssetIds)).flatMap((assetId) => {
        const asset = assetsById.get(assetId);
        const role = COMMERCE_IMAGE_REFERENCE_ROLES.find((item) => item.value === brief.referenceRoles[assetId]);
        const alias = aliases.get(assetId);
        return asset && role && alias ? [`@${alias}：${role.label}（${asset.title || alias}）`] : [];
    });
    const requestLines = [
        `电商图片 · ${brief.workflow === "reference-edit" ? "参考图改图" : "商品展示图"}`,
        `图片用途：${brief.imageType.trim() || "商品展示图"}`,
        `目标平台：${brief.platform.trim() || "通用电商"}`,
        `产品：${brief.productName.trim()}`,
        ...(brief.sellingPoints.trim() ? [`产品卖点：${brief.sellingPoints.trim()}`] : []),
        ...(brief.requirements.trim() ? [`用户要求：${brief.requirements.trim()}`] : []),
        ...(prompt.trim() ? [`补充需求：${prompt.trim()}`] : []),
        ...(references.length ? ["素材角色：", ...references] : []),
    ];
    const publicPrompt = requestLines.join("\n");
    const rules = [
        "按以上用途和用户要求生成图片，使用已选择 Skill 中适用的电商作图规则。",
        "素材仅按标注的角色使用：产品图是商品外观、颜色、材质、包装和品牌的依据，保持商品一致；排版参考只参考构图和排版，不得带入其中的旧商品和旧文案；背景参考仅参考场景；人物参考仅参考人物身份和姿势。",
        "画面文案以用户提供的具体内容为准；用户未提供文案时，不得自行虚构价格、促销或功效。",
        brief.workflow === "reference-edit"
            ? "生成新的编辑结果：以产品图中的商品覆盖排版参考中的旧产品，并按用户要求调整画面和文案。"
            : "根据产品图生成符合用途的商品展示图，确保主体商品清晰、外观一致。",
    ];

    return { prompt: [...requestLines, "", "生成要求：", ...rules].join("\n"), publicPrompt };
}
