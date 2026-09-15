import { frameRemakeGrid, frameRemakeSeconds, frameRemakeAnalysisResult, FRAME_REMAKE_ANALYSIS_LABELS, type FrameRemakeAnalysisStage, type FrameRemakeGroup, type FrameRemakeProject } from "./frame-remake-contract";
import { frameRemakeTemplates } from "./frame-remake-prompt-templates";

export const FRAME_REMAKE_PROMPT_VERSION = "2026-09-15.5";
export function frameRemakeAnalysisPrompt(project: FrameRemakeProject, group: FrameRemakeGroup, stage: FrameRemakeAnalysisStage) {
    const templates = frameRemakeTemplates(project, group);
    const task = {
        analysis: [templates.analysis],
        copy: [group.copy || ""],
        productScript: [templates.productScript, `已保存的原片画面分析：\n${group.analysis}`],
        imagePrompt: [templates.storyboardScript, `已保存的产品脚本：\n${frameRemakeAnalysisResult(group, "productScript")}`],
        videoPrompt: [templates.video, `已保存的分镜脚本：\n${group.imagePrompt}`, group.image.result ? "依据附图中的最终分镜图编写视频动作，人物、产品和构图以该图为准。" : "最终分镜图尚未生成；当前只规划视频动作，实际人物、产品和构图以后续最终图为准。"],
    }[stage];
    return [
        `本次只执行“${FRAME_REMAKE_ANALYSIS_LABELS[stage]}”。完成本步即结束，不执行后续步骤。`,
        `全片 ${project.durationMs / 1000} 秒；本组为第 ${group.number} 组，原片 ${group.startMs / 1000}–${group.endMs / 1000} 秒，实际 ${frameRemakeSeconds(group)} 秒。不得把整片压缩到本组时长。`,
        `原帧编号及全片时间：${JSON.stringify(group.frames.map(({ number, startMs, endMs }) => ({ number, start: startMs / 1000, end: endMs / 1000 })))}`,
        stage === "analysis"
            ? "附图仅为本组原片实际抽帧。只分析原片可见内容，产品、人物和背景的替换要求留到后续产品脚本阶段。"
            : `附图：第1张为${stage === "videoPrompt" && group.image.result ? "本组已完成的最终分镜图" : "本组原片实际抽帧"}，随后依次为 ${project.references.product.length} 张产品图、${project.references.character.length} 张人物图、${project.references.background.length} 张背景图。未提供替换图的对象沿用原片，不引用不存在的素材。`,
        "静态抽帧只能证明可见画面及相邻变化，不声称听过音频、不编造台词或看不到的动作。产品功能只采用用户已确认信息。原片有人脸或只有手部的分布逐帧判断。",
        ...task,
        `已校对文案与实际时间区间：\n${group.copy || "无口播"}`,
        `产品信息：${project.productInfo || "沿用原产品"}\n补充要求：${project.instructions || "无"}`,
        `输出为 JSON：${JSON.stringify({ [stage]: `本步完整正文，覆盖本组全部 ${group.frames.length} 帧，保留模板所需字段及汇总` })}。只返回这一个非空字段，不输出其他步骤。`,
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
        `产品信息：${project.productInfo || "沿用原产品"}\n补充要求：${project.instructions || "无"}`,
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
export function parseFrameRemakeAnalysis(raw: string, stage: FrameRemakeAnalysisStage) {
    const text = raw
        .trim()
        .replace(/^```(?:json)?\s*/, "")
        .replace(/\s*```$/, "");
    const value = JSON.parse(text) as Record<string, unknown>;
    if (!value || Array.isArray(value) || typeof value[stage] !== "string" || !value[stage].trim() || value[stage].length > 30000) throw new Error(`模型未返回完整的${FRAME_REMAKE_ANALYSIS_LABELS[stage]}结果`);
    return value[stage].trim();
}
