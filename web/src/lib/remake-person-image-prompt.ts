import { remakePersonFrameGroups, remakePersonGridLayout } from "./remake-person-layout";
import { REMAKE_FEISHU_IMAGE_PROMPT } from "./remake-person-feishu-prompts";

export type RemakeImagePromptAsset = { url?: string };
export type RemakeImagePromptFrame = { ordinal: number; segmentIndex?: number; time: number; endTime: number; subtitle: string; sellingPoint: string; shotType: string; description: string; subjectRatio: string };
export type RemakeImagePromptReference<T extends RemakeImagePromptAsset> = { key: string; label: string; asset: T };
export type RemakeImagePromptInputs<T extends RemakeImagePromptAsset = RemakeImagePromptAsset> = { contactSheet?: T; character?: T; background?: T; product?: T };

const GROUP_IDS = ["1-12", "13-24", "25-36", "37-48"] as const;

export function remakeStoryboardPrompt(groupId: string, frames: RemakeImagePromptFrame[], reservedProductInfo = "", input?: RemakeImagePromptInputs) {
    const segmented = frames.some((frame) => frame.segmentIndex !== undefined);
    if (!segmented) return legacyStoryboardPrompt(groupId, frames, reservedProductInfo, input);
    const group = remakePersonFrameGroups(frames).find((item) => item.id === groupId);
    if (!group) throw new Error("换人分镜组无效");
    const count = group.endFrame - group.startFrame + 1;
    const { columns, rows } = remakePersonGridLayout(count);
    const sheetName = "分镜拼图";
    const prompt = segmentedStoryboardInstructions(count, columns, rows);
    if (reservedProductInfo.trim()) throw new Error("换人不换品流程不能提供产品替换信息");
    if (!input) return prompt;
    const references = remakeStoryboardPromptReferences(input);
    const firstOrdinal = Number(groupId.split("-")[0]);
    const cellMapping = Array.from({ length: count }, (_, index) => `第${index + 1}格=全片分镜${firstOrdinal + index}`).join("、");
    const bindings = references.map((reference, index) => {
        const tag = `@图片${index + 1}（实际输入的第${index + 1}张图片）`;
        if (reference.key === "source-contact-sheet") {
            return `${tag}：来源${sheetName}（${columns}列×${rows}行，按从左到右、从上到下排列的${count}个实际镜头），是本次输出的唯一权威，其${count}个镜头逐格一一对应本次输出的${sheetName}：${cellMapping}。每格的构图、景别、人物动作、姿势、眼神、人物与产品互动，以及产品是否出现、数量、位置、角度和状态均以对应格为准。`;
        }
        if (reference.key === "background") return `${tag}：背景图，只提供目标背景场景；人物与产品的位置关系、动作和原分镜的风格光线保持不变，不照搬背景图中的人物或产品。`;
        if (reference.key === "character") return `${tag}：人物六宫格图，只参考人物外貌和服装款式，不参考其中的姿势、动作、眼神、背景或产品。是否出现人物、可见身体范围仍以对应原始分镜为准，人脸继续按正文要求模糊处理。`;
        return `${tag}：原产品参考图，用于校准原产品的包装、品牌标识、包装文字、配色、形状和材质细节。产品是否出现、对应款式、数量、位置、角度、画面占比、状态和手部互动仍以对应原始分镜为准。参考图有多款产品时逐款匹配，不把所有款式添加到每格；未覆盖的款式保留原分镜外观。不照搬产品参考图的背景、人物、摆放构图。清理画面字幕和水印时保留产品包装本身的标识与文字。`;
    });
    return `${prompt}\n\n## 【本次输入图片编号与用途】\n\n以下编号严格对应本次请求中实际附带图片的顺序，@图片N 指第N张输入图片。逐张按指定用途使用，不得交换角色。\n\n${bindings.join("\n\n")}\n\n仅输入第1张来源${sheetName}的${count}个实际镜头分别对应输出的${count}个镜头，按从左到右、从上到下排列。不足网格的位置保持空白，不补镜头。其余图片只作指定用途的参考，不得作为额外分镜拼入输出；不要把图片编号、用途说明或标签绘制到画面中。`;
}

export function remakeStoryboardPromptReferences<T extends RemakeImagePromptAsset>(input: RemakeImagePromptInputs<T>): RemakeImagePromptReference<T>[] {
    if (!input.contactSheet?.url) throw new Error("换人生图需要来源十二宫格拼图");
    if (!input.background?.url) throw new Error("换人生图需要背景图");
    return [
        { key: "source-contact-sheet", label: "来源分镜拼图", asset: input.contactSheet },
        { key: "background", label: "背景图", asset: input.background },
        ...(input.character?.url ? [{ key: "character", label: "人物六宫格图", asset: input.character }] : []),
        ...(input.product?.url ? [{ key: "product", label: "原产品参考图", asset: input.product }] : []),
    ];
}

// 保留已核对的生图规则，仅将输入形式、镜头数与布局替换为本组实际值。
function segmentedStoryboardInstructions(count: number, columns: number, rows: number) {
    return REMAKE_FEISHU_IMAGE_PROMPT
        .replace(/```yaml[\s\S]*?```/u, Array.from({ length: rows }, (_, row) =>
            Array.from({ length: columns }, (_, column) => {
                const index = row * columns + column + 1;
                return index <= count ? `[第${index}格]` : "[空白]";
            }).join(" ")
        ).join("\n"))
        .replace(/12张分镜图片/gu, `1张来源分镜拼图（内含${count}个实际镜头）`)
        .replace(/12张图，宽高比一致/gu, `1张拼图，${columns}列×${rows}行`)
        .replace(/12张分镜/gu, `${count}个分镜`)
        .replace(/12张图/gu, `${count}个镜头区域`)
        .replace(/12个分镜区域/gu, `${count}个有效分镜区域，余格留空`)
        .replace(/分镜1-12/gu, `本组第1-${count}个分镜`)
        .replace(/十二宫格/gu, "分镜拼图")
        .replace(/4行3列/gu, `${rows}行${columns}列`)
        .replace(/4×3/gu, `${rows}×${columns}`);
}

function legacyStoryboardPrompt(groupId: string, _frames: RemakeImagePromptFrame[], reservedProductInfo = "", input?: RemakeImagePromptInputs) {
    if (!(GROUP_IDS as readonly string[]).includes(groupId)) throw new Error("换人分镜组无效");
    if (reservedProductInfo.trim()) throw new Error("换人不换品流程不能提供产品替换信息");
    if (!input) return REMAKE_FEISHU_IMAGE_PROMPT;
    const references = remakeStoryboardPromptReferences(input);
    const firstOrdinal = Number(groupId.split("-")[0]);
    const cellMapping = Array.from({ length: 12 }, (_, index) => `第${index + 1}格=全片分镜${firstOrdinal + index}`).join("、");
    const bindings = references.map((reference, index) => {
        const tag = `@图片${index + 1}（实际输入的第${index + 1}张图片）`;
        if (reference.key === "source-contact-sheet") {
            return `${tag}：来源十二宫格拼图（3列×4行，按从左到右、从上到下排列的12格），是本次输出的唯一权威，其12格逐格一一对应本次输出的十二宫格：${cellMapping}。每格的构图、景别、人物动作、姿势、眼神、人物与产品互动，以及产品是否出现、数量、位置、角度和状态均以对应格为准。`;
        }
        if (reference.key === "background") return `${tag}：背景图，只提供目标背景场景；人物与产品的位置关系、动作和原分镜的风格光线保持不变，不照搬背景图中的人物或产品。`;
        if (reference.key === "character") return `${tag}：人物六宫格图，只参考人物外貌和服装款式，不参考其中的姿势、动作、眼神、背景或产品。是否出现人物、可见身体范围仍以对应原始分镜为准，人脸继续按正文要求模糊处理。`;
        return `${tag}：原产品参考图，用于校准原产品的包装、品牌标识、包装文字、配色、形状和材质细节。产品是否出现、对应款式、数量、位置、角度、画面占比、状态和手部互动仍以对应原始分镜为准。参考图有多款产品时逐款匹配，不把所有款式添加到每格；未覆盖的款式保留原分镜外观。不照搬产品参考图的背景、人物、摆放构图。清理画面字幕和水印时保留产品包装本身的标识与文字。`;
    });
    return `${REMAKE_FEISHU_IMAGE_PROMPT}\n\n## 【本次输入图片编号与用途】\n\n以下编号严格对应本次请求中实际附带图片的顺序，@图片N 指第N张输入图片。逐张按指定用途使用，不得交换角色。\n\n${bindings.join("\n\n")}\n\n仅输入第1张来源十二宫格拼图的12格分别对应输出的12格，按从左到右、从上到下排列。其余图片只作指定用途的参考，不得作为额外分镜拼入输出；不要把图片编号、用途说明或标签绘制到画面中。`;
}
