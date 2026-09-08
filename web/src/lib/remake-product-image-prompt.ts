export type RemakeImagePromptAsset = { url?: string };
export type RemakeImagePromptFrame = { ordinal: number; time: number; endTime: number; subtitle: string; sellingPoint: string; shotType: string; description: string; subjectRatio: string };
export type RemakeImagePromptReference<T extends RemakeImagePromptAsset> = { key: "source-contact-sheet" | "product"; label: string; asset: T };

const GROUP_IDS = ["1-12", "13-24", "25-36", "37-48"] as const;

export function remakeStoryboardPrompt(groupId: string, frames: RemakeImagePromptFrame[], productInfo: string) {
    if (!(GROUP_IDS as readonly string[]).includes(groupId)) throw new Error("换品分镜组无效");
    const [start, end] = groupId.split("-").map(Number);
    const selected = frames.filter((frame) => frame.ordinal >= start && frame.ordinal <= end);
    return `# 十二宫格换品重绘：保留原人物\n\n根据原图十二宫格和新产品图，一次生成一张完整的 9:16 竖屏图片。图片内部为 3 列 × 4 行，共 12 格；按从左到右、从上到下排列，严格保持原格位及分镜数量。\n\n## 人物与场景锁定\n原视频人物身份、脸部特征、年龄、发型、肤色、服装、身体比例、手部、姿势、眼神与动作必须保持不变。禁止换人、换脸、换衣服、补全原本未出现的身体部位或增加人物。保持原背景、构图、镜头角度和景别，不搬到新的场景。\n\n## 只替换手中产品\n逐格查看原图：有人物或手部持有原产品时，使用新产品图替换该产品；没有人物、只有场景、人物手里没有产品的镜头不得强行放入产品。保持持握位置、角度、遮挡、相对尺寸和人物与产品的互动。新产品颜色、包装、形状、材质、标签图案和细节以产品图为准，产品形态与使用状态参考产品信息。禁止继续出现旧产品。\n\n## 清理与输出\n去除字幕、价格贴纸、水印、平台 UI、黑边和圆角，自然修复原背景，禁止白底；产品包装自身标识按产品图保留。不要新增画面字幕、编号或边框。保持真实自然的颜色和光线，输出高清照片质感。\n\n## 新产品信息\n${productInfo.trim()}\n\n## 分镜 ${groupId} 的来源解析\n${selected.map((frame) => `分镜${frame.ordinal}：${frame.description || "以对应原图为准"}；景别：${frame.shotType || "保持原图"}；人物占比：${frame.subjectRatio || "保持原图"}`).join("\n")}`;
}

export function remakeStoryboardPromptReferences<T extends RemakeImagePromptAsset>(input: { sourceContactSheet?: T; product?: T }): RemakeImagePromptReference<T>[] {
    const references: Array<RemakeImagePromptReference<T> | null> = [
        input.sourceContactSheet ? { key: "source-contact-sheet", label: "原图十二宫格：锁定原人物和场景", asset: input.sourceContactSheet } : null,
        input.product ? { key: "product", label: "新产品图", asset: input.product } : null,
    ];
    return references.filter((reference): reference is RemakeImagePromptReference<T> => Boolean(reference?.asset.url));
}
