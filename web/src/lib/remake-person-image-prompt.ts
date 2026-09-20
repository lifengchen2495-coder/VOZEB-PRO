import { REMAKE_FEISHU_IMAGE_PROMPT } from "./remake-person-feishu-prompts";

export type RemakeImagePromptAsset = { url?: string };
export type RemakeImagePromptFrame = { ordinal: number; time: number; endTime: number; subtitle: string; sellingPoint: string; shotType: string; description: string; subjectRatio: string };
export type RemakeImagePromptReference<T extends RemakeImagePromptAsset> = { key: string; label: string; asset: T };
export type RemakeImagePromptInputs<T extends RemakeImagePromptAsset = RemakeImagePromptAsset> = { frames: T[]; character?: T; background?: T; product?: T };

const GROUP_IDS = ["1-12", "13-24", "25-36", "37-48"] as const;

export function remakeStoryboardPrompt(groupId: string, _frames: RemakeImagePromptFrame[], reservedProductInfo = "", input?: RemakeImagePromptInputs) {
    if (!(GROUP_IDS as readonly string[]).includes(groupId)) throw new Error("换人分镜组无效");
    if (reservedProductInfo.trim()) throw new Error("换人不换品流程不能提供产品替换信息");
    if (!input) return REMAKE_FEISHU_IMAGE_PROMPT;
    const references = remakeStoryboardPromptReferences(input);
    const firstOrdinal = Number(groupId.split("-")[0]);
    const bindings = references.map((reference, index) => {
        const tag = `@图片${index + 1}（实际输入的第${index + 1}张图片）`;
        if (reference.key.startsWith("frame-")) {
            return `${tag}：原始分镜，对应本次十二宫格第${index + 1}格、全片分镜${firstOrdinal + index}。该格的构图、景别、人物动作、姿势、眼神、人物与产品互动，以及产品是否出现、数量、位置、角度和状态均以此图为准。`;
        }
        if (reference.key === "background") return `${tag}：背景图，只提供目标背景场景；人物与产品的位置关系、动作和原分镜的风格光线保持不变，不照搬背景图中的人物或产品。`;
        if (reference.key === "character") return `${tag}：人物六宫格图，只参考人物外貌和服装款式，不参考其中的姿势、动作、眼神、背景或产品。是否出现人物、可见身体范围仍以对应原始分镜为准，人脸继续按正文要求模糊处理。`;
        return `${tag}：原产品参考图，用于校准原产品的包装、品牌标识、包装文字、配色、形状和材质细节。产品是否出现、对应款式、数量、位置、角度、画面占比、状态和手部互动仍以对应原始分镜为准。参考图有多款产品时逐款匹配，不把所有款式添加到每格；未覆盖的款式保留原分镜外观。不照搬产品参考图的背景、人物、摆放构图。清理画面字幕和水印时保留产品包装本身的标识与文字。`;
    });
    return `${REMAKE_FEISHU_IMAGE_PROMPT}\n\n## 【本次输入图片编号与用途】\n\n以下编号严格对应本次请求中实际附带图片的顺序，@图片N 指第N张输入图片。逐张按指定用途使用，不得交换角色。\n\n${bindings.join("\n\n")}\n\n仅前12张原始分镜分别对应输出的12格，按从左到右、从上到下排列。其余图片只作指定用途的参考，不得作为额外分镜拼入输出；不要把图片编号、用途说明或标签绘制到画面中。`;
}

export function remakeStoryboardPromptReferences<T extends RemakeImagePromptAsset>(input: RemakeImagePromptInputs<T>): RemakeImagePromptReference<T>[] {
    if (input.frames.length !== 12 || input.frames.some((frame) => !frame.url)) throw new Error("换人生图需要完整的12张原始分镜图片");
    if (!input.background?.url) throw new Error("换人生图需要背景图");
    return [
        ...input.frames.map((asset, index) => ({ key: `frame-${index + 1}`, label: `分镜${index + 1}`, asset })),
        { key: "background", label: "背景图", asset: input.background },
        ...(input.character?.url ? [{ key: "character", label: "人物六宫格图", asset: input.character }] : []),
        ...(input.product?.url ? [{ key: "product", label: "原产品参考图", asset: input.product }] : []),
    ];
}
