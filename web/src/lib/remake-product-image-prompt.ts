export type RemakeImagePromptAsset = { url?: string };
export type RemakeImagePromptFrame = { ordinal: number; time: number; endTime: number; subtitle: string; sellingPoint: string; shotType: string; description: string; subjectRatio: string };
export type RemakeImagePromptReference<T extends RemakeImagePromptAsset> = { key: "source-contact-sheet" | "replacement-contact-sheet" | "product"; label: string; asset: T };

const GROUP_IDS = ["1-12", "13-24", "25-36", "37-48"] as const;

function sourceAnalysis(groupId: string, frames: RemakeImagePromptFrame[]) {
    if (!(GROUP_IDS as readonly string[]).includes(groupId)) throw new Error("换品分镜组无效");
    const [start, end] = groupId.split("-").map(Number);
    return frames.filter((frame) => frame.ordinal >= start && frame.ordinal <= end)
        .map((frame) => `分镜${frame.ordinal}：${frame.description || "来源解析未标明产品，不臆造产品位置"}；景别：${frame.shotType || "保持输入图"}；人物占比：${frame.subjectRatio || "保持输入图"}`)
        .join("\n");
}

const PRESERVE_PEOPLE = "原视频人物身份、脸部特征、年龄、发型、肤色、服装、身体比例、手部、姿势、眼神与动作必须保持不变。禁止换人、换脸、换衣服、模糊人脸、给脸部打码、补全原本未出现的身体部位或增加人物。保持原背景、构图、镜头角度、景别、光线与颜色，不搬到新的场景。";
const GRID_OUTPUT = "只输出一张完整的 9:16 竖屏十二宫格图片，内部为 3 列 × 4 行，共 12 格；从左到右、从上到下排列，严格保持格位和分镜数量，不新增字幕、编号、分割线或边框。输出高清照片质感。";

export function remakeReplacementPrompt(groupId: string, frames: RemakeImagePromptFrame[]) {
    return `# 第一步：去除原产品，保留原人物和场景\n\n唯一图片输入是本组来源十二宫格。逐格识别并去除原来正在展示、持握或使用的旧产品，包括产品包装、标签、品牌标识与残片。本步不放入新产品。\n\n## 人物与场景锁定\n${PRESERVE_PEOPLE}\n\n## 局部清理\n只清除旧产品本体与叠加字幕、价格贴纸、水印、平台 UI、黑边和圆角。不要误删手指、脸部、服装、背景家具、固定设施或与产品无关的道具。旧产品遮挡区域仅做最小且自然的背景修复；保留现有手部轮廓、持握手势和遮挡边界，禁止重画人物、改变手势或凭空补出肢体。没有旧产品的格位只清理叠加文字与水印，其余画面保持不变。禁止白底、空洞、残留旧产品和新增产品。\n\n## 输出\n${GRID_OUTPUT}\n\n## 分镜 ${groupId} 的来源解析\n${sourceAnalysis(groupId, frames)}`.trim();
}

export function remakeStoryboardPrompt(groupId: string, frames: RemakeImagePromptFrame[], productInfo: string) {
    return `# 第二步：在去产品图中放入新产品，保留原人物\n\n图片输入只有第一步已经去除旧产品的十二宫格和新产品图。以去产品十二宫格为唯一人物、背景及构图基底；结合下方来源解析确定哪些格位原本出现产品，以及原产品的位置、角度、尺寸、使用状态和人与产品的互动。\n\n## 人物与场景锁定\n${PRESERVE_PEOPLE}\n\n## 放入新产品\n来源解析明确有人物或手部持握、展示、操作旧产品的格位，才在对应原产品区域放入新产品。保持原持握位置、方向、遮挡关系、相对尺寸和互动方式。不能因为清理后的图里看不到产品就跳过本来需要换品的格位；也不能在原来无人、只有场景、人物没有持有产品或来源解析未确认有产品的格位强行添加产品。新产品颜色、包装、形状、材质、标签图案和细节以新产品图为准，形态和使用状态参考产品信息，不复制或恢复旧产品。\n\n## 输出\n${GRID_OUTPUT}\n产品包装自身标识按新产品图保留。\n\n## 新产品信息\n${productInfo.trim()}\n\n## 分镜 ${groupId} 的来源解析\n${sourceAnalysis(groupId, frames)}`.trim();
}

export function remakeReplacementPromptReferences<T extends RemakeImagePromptAsset>(input: { sourceContactSheet?: T }): RemakeImagePromptReference<T>[] {
    return input.sourceContactSheet?.url ? [{ key: "source-contact-sheet", label: "来源十二宫格：去除旧产品，保留原人物和场景", asset: input.sourceContactSheet }] : [];
}

export function remakeStoryboardPromptReferences<T extends RemakeImagePromptAsset>(input: { replacementContactSheet?: T | null; product?: T }): RemakeImagePromptReference<T>[] {
    const references: Array<RemakeImagePromptReference<T> | null> = [
        input.replacementContactSheet ? { key: "replacement-contact-sheet", label: "已去除旧产品的十二宫格：锁定原人物和场景", asset: input.replacementContactSheet } : null,
        input.product ? { key: "product", label: "新产品图", asset: input.product } : null,
    ];
    return references.filter((reference): reference is RemakeImagePromptReference<T> => Boolean(reference?.asset.url));
}
