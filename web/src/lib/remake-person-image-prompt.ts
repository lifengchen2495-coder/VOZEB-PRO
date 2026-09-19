import { REMAKE_FEISHU_IMAGE_PROMPT } from "./remake-person-feishu-prompts";

export type RemakeImagePromptAsset = { url?: string };
export type RemakeImagePromptFrame = { ordinal: number; time: number; endTime: number; subtitle: string; sellingPoint: string; shotType: string; description: string; subjectRatio: string };
export type RemakeImagePromptReference<T extends RemakeImagePromptAsset> = { key: string; label: string; asset: T };

const GROUP_IDS = ["1-12", "13-24", "25-36", "37-48"] as const;

export function remakeStoryboardPrompt(groupId: string, _frames: RemakeImagePromptFrame[], reservedProductInfo = "") {
    if (!(GROUP_IDS as readonly string[]).includes(groupId)) throw new Error("换人分镜组无效");
    if (reservedProductInfo.trim()) throw new Error("换人不换品流程不能提供产品替换信息");
    return REMAKE_FEISHU_IMAGE_PROMPT;
}

export function remakeStoryboardPromptReferences<T extends RemakeImagePromptAsset>(input: { frames: T[]; character?: T; background?: T }): RemakeImagePromptReference<T>[] {
    if (input.frames.length !== 12 || input.frames.some((frame) => !frame.url)) throw new Error("换人生图需要完整的12张原始分镜图片");
    if (!input.background?.url) throw new Error("换人生图需要背景图");
    return [
        ...input.frames.map((asset, index) => ({ key: `frame-${index + 1}`, label: `分镜${index + 1}`, asset })),
        { key: "background", label: "背景图", asset: input.background },
        ...(input.character?.url ? [{ key: "character", label: "人物六宫格图", asset: input.character }] : []),
    ];
}
