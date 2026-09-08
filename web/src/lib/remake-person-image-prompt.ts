export type RemakeImagePromptAsset = { url?: string };
export type RemakeImagePromptFrame = { ordinal: number; time: number; endTime: number; subtitle: string; sellingPoint: string; shotType: string; description: string; subjectRatio: string };
export type RemakeImagePromptReference<T extends RemakeImagePromptAsset> = { key: "source-contact-sheet" | "character" | "characterSupplement" | "background"; label: string; asset: T };

const GROUP_IDS = ["1-12", "13-24", "25-36", "37-48"] as const;

export function remakeStoryboardPrompt(groupId: string, frames: RemakeImagePromptFrame[], reservedProductInfo = "") {
    if (!(GROUP_IDS as readonly string[]).includes(groupId)) throw new Error("换人分镜组无效");
    if (reservedProductInfo.trim()) throw new Error("换人不换品流程不能提供产品替换信息");
    const [start, end] = groupId.split("-").map(Number);
    const selected = frames.filter((frame) => frame.ordinal >= start && frame.ordinal <= end);
    return `# 电商视频分镜图生成（跟品版）

根据来源十二宫格、背景图（必需）、人物图（可选）及人物补充（可选），一次生成一张 9:16 竖屏十二宫格。内部 3 列 × 4 行、12 格，严格按从左到右、从上到下排列，无间隙、无分割线，输出 2K 高清照片质感。

## 保留原产品
原分镜图是唯一权威。所有原产品的外观、品牌标识、颜色、包装、材质、数量、位置、角度、状态及展示方式完全不变。原图展示产品才展示，原图没有产品则不得添加。禁止替换、删除、重设计或虚构产品；保留产品包装自身的文字和图案。

## 人物外貌与动作
只有原图有人物时才处理人物。有人物参考图时，仅参考五官、发型、肤色、年龄感和服装款式；人物补充仅补同一人物细节。不提供人物图时沿用原人物外貌和服装。
人物姿势、手部动作、眼神方向、人物与产品的互动、景别、占比全部与来源分镜一模一样。人物图的姿势、眼神与动作不得带入生成结果。原图看产品就看产品，原图看镜头才看镜头。无人物不新增人物；只有手部不补出脸或身体；无人脸的镜头不新增人脸。
按来源表中间分镜图规则，有人脸的格子保留头部轮廓并自然高斯模糊五官，不使用纯色块或颗粒马赛克；最终视频阶段再结合人物图呈现清晰外貌。

## 背景与画面清理
背景替换为背景图场景，保持原镜头光线、色调和氛围，人物与物体的前后遮挡合理，禁止穿模。去掉叠加字幕、水印、边框、黑边、圆角和平台 UI，自然修复背景，禁止白底。不要生成画面字幕、编号或额外文字。

## 分镜 ${groupId} 的来源解析
${selected.map((frame) => `分镜${frame.ordinal}：${frame.description || "以对应原图为准"}；景别：${frame.shotType || "保持原图"}；人物占比：${frame.subjectRatio || "保持原图"}`).join("\n")}`;
}

export function remakeStoryboardPromptReferences<T extends RemakeImagePromptAsset>(input: { sourceContactSheet?: T; character?: T; characterSupplement?: T; background?: T }): RemakeImagePromptReference<T>[] {
    const references: Array<RemakeImagePromptReference<T> | null> = [
        input.sourceContactSheet ? { key: "source-contact-sheet", label: "来源十二宫格：锁定原产品与人物动作", asset: input.sourceContactSheet } : null,
        input.character ? { key: "character", label: "人物图：只参考外貌与服装", asset: input.character } : null,
        input.characterSupplement ? { key: "characterSupplement", label: "人物补充：同一人物外貌细节", asset: input.characterSupplement } : null,
        input.background ? { key: "background", label: "背景图：目标场景", asset: input.background } : null,
    ];
    return references.filter((reference): reference is RemakeImagePromptReference<T> => Boolean(reference?.asset.url));
}
