import { REMAKE_FEISHU_IMAGE_PROMPTS } from "@/lib/remake15-feishu-prompts";

export type RemakeImagePromptAsset = { url?: string };
export type RemakeImagePromptReference<T extends RemakeImagePromptAsset> = {
    key: "source-contact-sheet" | "replacement-contact-sheet" | "product" | "character";
    label: string;
    asset: T;
};
export type RemakeImagePromptFrame = {
    ordinal: number;
    time: number;
    endTime: number;
    subtitle: string;
    sellingPoint: string;
    shotType: string;
    description: string;
    subjectRatio: string;
};

export function remakeReplacementPersonPrompt(groupId: string, frames: RemakeImagePromptFrame[], hasCharacter: boolean, storyboardScript?: string) {
    assertGroup(groupId);
    return appendContext(REMAKE_FEISHU_IMAGE_PROMPTS["1-12"].replacement, frames, hasCharacter ? "已上传，按人物图替换实际出镜人物" : "未上传，保留原人物身份", storyboardScript);
}

export function remakeStoryboardPrompt(groupId: string, frames: RemakeImagePromptFrame[], storyboardScript?: string) {
    assertGroup(groupId);
    return appendContext(REMAKE_FEISHU_IMAGE_PROMPTS["1-12"].storyboard, frames, "沿用上一步模板图中的人物", storyboardScript);
}

export function remakeReplacementPromptReferences<T extends RemakeImagePromptAsset>(input: { sourceContactSheet?: T; character?: T }): RemakeImagePromptReference<T>[] {
    const references: RemakeImagePromptReference<T>[] = [];
    if (input.sourceContactSheet?.url) references.push({ key: "source-contact-sheet", label: "原图十二宫格分镜图", asset: input.sourceContactSheet });
    if (input.character?.url) references.push({ key: "character", label: "人物图", asset: input.character });
    return references;
}

export function remakeStoryboardPromptReferences<T extends RemakeImagePromptAsset>(input: { replacementContactSheet?: T; product?: T }): RemakeImagePromptReference<T>[] {
    const references: RemakeImagePromptReference<T>[] = [];
    if (input.replacementContactSheet?.url) references.push({ key: "replacement-contact-sheet", label: "第一步模板图", asset: input.replacementContactSheet });
    if (input.product?.url) references.push({ key: "product", label: "产品图", asset: input.product });
    return references;
}

function assertGroup(groupId: string) {
    if (groupId !== "1-12") throw new Error("15 秒复刻仅支持分镜 1-12");
}

function appendContext(prompt: string, frames: RemakeImagePromptFrame[], characterRule: string, storyboardScript?: string) {
    const script = storyboardScript?.trim();
    // 脚本生成前也展示预览；服务端负责阻止缺少脚本的生成请求。
    const context =
        script ||
        frames
            .filter((frame) => frame.ordinal >= 1 && frame.ordinal <= 12)
            .map((frame) => [`分镜${frame.ordinal}:`, `时间: ${frame.time}-${frame.endTime}`, `景别: ${frame.shotType}`, `画面描述: ${frame.description}`, `人物占比: ${frame.subjectRatio}`].join("\n"))
            .join("\n\n");
    return `${prompt}\n\n## 当前记录输入\n人物图：${characterRule}\n\n1-12分镜提示词：\n${context || "待生成新产品脚本和分镜提示词"}`;
}
