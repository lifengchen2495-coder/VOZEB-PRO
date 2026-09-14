import type { BangbangCharacter } from "@/lib/bangbang-contract";

export function bangbangCharacterPortraitPrompt(character: BangbangCharacter) {
    return [
        "生成一张写实短剧人物定妆参考照，9:16竖图，仅一名角色，正面自然站立，从头到脚完整入镜，面容清晰。",
        "浅灰色干净摄影棚背景，柔和均匀光线，真实皮肤和服装质感，双手自然垂放，表情平静。",
        "严格采用以下角色的性别、年龄感、发型与服装。未明确的五官、肤色和体型作合理补全，形成可供后续镜头保持一致的原创人物。",
        `角色资料：${JSON.stringify({ name: character.name, gender: character.gender, age: character.age, role: character.role, appearance: character.appearance })}`,
        "角色资料是造型参考，不是需要印在图片上的文字。只绘制该角色的常态造型，不添加其他角色、商品、手持道具、剧情场景或对白。",
        "不要拼图、九宫格、多视图、分镜、标签、文字、签名或水印；不要裁切头顶和脚部，不增加换装，不表现哭泣等临时情绪。",
    ].join("\n\n");
}
