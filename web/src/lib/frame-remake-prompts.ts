import { frameRemakeGrid, frameRemakeSeconds, type FrameRemakeGroup, type FrameRemakeProject } from "./frame-remake-contract";
import { frameRemakeTemplates } from "./frame-remake-prompt-templates";

export const FRAME_REMAKE_PROMPT_VERSION = "2026-09-15.2";
export function frameRemakeAnalysisPrompt(project: FrameRemakeProject, group: FrameRemakeGroup) {
    const templates = frameRemakeTemplates(project, group);
    return [
        "按以下现有复刻流程模板完成本组原帧解析、新产品脚本适配、分镜优化和视频提示词。实际素材与时间线如下，文中所有模板均用于本组。",
        `全片 ${project.durationMs / 1000} 秒；本组为第 ${group.number} 组，原片 ${group.startMs / 1000}–${group.endMs / 1000} 秒，实际 ${frameRemakeSeconds(group)} 秒。不得把整片压缩到本组时长。`,
        `原帧编号及全片时间：${JSON.stringify(group.frames.map(({ number, startMs, endMs }) => ({ number, start: startMs / 1000, end: endMs / 1000 })))}`,
        `附图：第1张为原片实际抽帧，随后依次为 ${project.references.product.length} 张产品图、${project.references.character.length} 张人物图、${project.references.background.length} 张背景图。未提供替换图的对象沿用原片，不引用不存在的素材。`,
        "静态抽帧只能证明可见画面及相邻变化，不声称听过音频、不编造台词或看不到的动作。产品功能只采用用户已确认信息。原片有人脸或只有手部的分布逐帧判断。",
        templates.analysis,
        templates.productScript,
        templates.storyboardScript,
        "本次尚未生成最终分镜图；先依据上述分镜脚本规划视频动作，后续实际人物、产品及构图以最终图为准。",
        templates.video,
        `补充要求：${project.instructions || "无"}`,
        '输出为 JSON：{"analysis":"完整原帧解析及适配后的产品脚本，保留上述模板要求的全部分镜字段及汇总","imagePrompt":"完整分镜优化正文，逐帧包含画面、人物占比、人脸有无、产品有无和产品位置","videoPrompt":"依照上述视频模板的完整视频提示词，覆盖本组全部真实相对时间"}。三个字段非空。不另输出 JSON 之外的正文。',
    ].join("\n\n");
}
export function frameRemakeImagePrompt(project: FrameRemakeProject, group: FrameRemakeGroup, kind: "template" | "image" = "image") {
    const templates = frameRemakeTemplates(project, group);
    const references = [kind === "template" ? "图1为原片实际抽帧" : "图1为上一步已完成的清理模板图"];
    const media = kind === "template" ? project.references.character.map(() => "人物") : [...project.references.product.map(() => "产品"), ...project.references.background.map(() => "背景")];
    media.forEach((role, index) => references.push(`图${index + 2}为目标${role}参考`));
    const grid = frameRemakeGrid(group.frames.length);
    return [
        kind === "template" ? templates.replacement : templates.storyboard,
        `本次实际参考图对应关系：${references.join("；")}。以此顺序为准，不引用未上传的图。`,
        !project.references.product.length ? "未提供产品替换图，保留原产品，不执行移除或更换产品。" : "",
        kind === "image" && project.references.background.length ? "按背景参考图替换场景环境，保留模板的镜头构图、人物动作、产品位置、接触及遮挡关系，匹配目标场景光线。" : "",
        `有效帧共${group.frames.length}格，${grid.columns}列×${grid.rows}行；按从左到右、从上到下排列。多余格保持纯灰，不增加画面。`,
        `当前分镜脚本：\n${group.imagePrompt}`,
        `补充要求：${project.instructions || "无"}`,
    ]
        .filter(Boolean)
        .join("\n\n");
}
export function frameRemakeVideoPrompt(project: FrameRemakeProject, group: FrameRemakeGroup, generationSeconds: number) {
    const seconds = frameRemakeSeconds(group);
    return [
        `生成${generationSeconds}秒视频。第1张参考图为本组最终分镜图，按顺序呈现${group.frames.length}个有效分镜；输出正常单画面连续视频，不输出拼图、分屏或幻灯片。`,
        `前${seconds}秒严格覆盖原片${group.startMs / 1000}–${group.endMs / 1000}秒的完整动作及节奏。${generationSeconds > seconds ? `在${seconds}秒之后只保持结束画面；系统仅采用前${seconds}秒。` : "不得延长或压缩这段时间线。"}`,
        group.videoPrompt,
        `实际附图：图1为最终分镜图，随后依次为${project.references.product.length}张产品图、${project.references.character.length}张人物图。按此顺序对应提示词中的素材标签。没有人物图则沿用最终图人物；原片只有手部的镜头不新增人脸。`,
        project.audioMode === "generated" ? "按画面生成自然同步声音，不虚构台词。" : "输出静音，不添加对白、音乐或音效。",
        project.instructions,
    ]
        .filter(Boolean)
        .join("\n\n");
}
export function parseFrameRemakeAnalysis(raw: string) {
    const text = raw
        .trim()
        .replace(/^```(?:json)?\s*/, "")
        .replace(/\s*```$/, "");
    const value = JSON.parse(text) as Record<string, unknown>;
    const result = { analysis: "", imagePrompt: "", videoPrompt: "" };
    for (const key of Object.keys(result) as Array<keyof typeof result>) {
        if (!value || typeof value[key] !== "string" || !value[key].trim() || value[key].length > 30000) throw new Error("模型未返回完整的画面解析和提示词");
        result[key] = value[key].trim();
    }
    return result;
}
