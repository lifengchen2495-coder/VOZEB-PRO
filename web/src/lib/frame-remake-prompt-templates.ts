import { REMAKE_FEISHU_ANALYSIS_PROMPT, REMAKE_FEISHU_PRODUCT_SCRIPT_PROMPT, REMAKE_FEISHU_STORYBOARD_SCRIPT_PROMPT, REMAKE_FEISHU_IMAGE_PROMPTS, REMAKE_FEISHU_VIDEO_PROMPTS } from "./remake15-feishu-prompts";
import { frameRemakeAspectRatio, frameRemakeGrid, frameRemakeSeconds, type FrameRemakeGroup, type FrameRemakeProject } from "./frame-remake-contract";

// 直接读取既有流程模板，适配本组帧数、时长、素材顺序与结构化输出。既有流程保持原样。
export const FRAME_REMAKE_PROMPT_SOURCE = "remake15-feishu-prompts.ts";
export function frameRemakeTemplates(project: FrameRemakeProject, group: FrameRemakeGroup) {
    const count = group.frames.length;
    const first = group.frames[0].number,
        last = group.frames.at(-1)!.number;
    const grid = frameRemakeGrid(count),
        layout = `${grid.columns}列${grid.rows}行`;
    const seconds = frameRemakeSeconds(group);
    const adapt = (text: string) =>
        text
            .replaceAll("1-12", `${first}-${last}`)
            .replaceAll("分镜 1 至分镜 12", `分镜 ${first} 至分镜 ${last}`)
            .replaceAll("“分镜1:”至“分镜12:”", `“分镜${first}:”至“分镜${last}:”`)
            .replaceAll("三列四行", layout)
            .replaceAll("十二宫格", `${layout}分镜图`)
            .replace(/12(?=\s*(?:个|镜头|分镜|项))/g, String(count))
            .replaceAll("15 秒", `${seconds} 秒`)
            .replaceAll("15秒", `${seconds}秒`)
            .replaceAll("原片时间码用于溯源；最终成片在后续阶段压缩为", "原片时间码用于溯源；本组成片保持实际时长")
            .replaceAll("共 12", `共 ${count}`)
            .replaceAll("禁止改成九宫格、增减分镜、合并格子", "禁止改变当前网格布局、增减有效分镜或合并格子")
            .replaceAll("禁止合并、遗漏、重复分镜或额外文字、空格", `禁止合并、遗漏、重复有效分镜或添加文字；仅最后 ${grid.columns * grid.rows - count} 个未使用格子保持纯灰`);
    const analysis = adapt(REMAKE_FEISHU_ANALYSIS_PROMPT).replace("完整观看原视频", "读取本组全部实际抽帧及时间码");
    const productScript = adapt(REMAKE_FEISHU_PRODUCT_SCRIPT_PROMPT);
    const storyboardScript = adapt(REMAKE_FEISHU_STORYBOARD_SCRIPT_PROMPT);
    let replacement = adapt(REMAKE_FEISHU_IMAGE_PROMPTS["1-12"].replacement);
    if (!project.references.product.length) replacement = replacement.replace("移除旧产品但保留握持姿势、接触位置与遮挡关系", "保留原产品及握持姿势、接触位置与遮挡关系");
    let storyboard = adapt(REMAKE_FEISHU_IMAGE_PROMPTS["1-12"].storyboard);
    if (!project.references.product.length)
        storyboard = storyboard
            .replace("参考图 2 是新产品图。以产品图锁定形状、颜色、材质、细节、结构和配件，不恢复旧产品", "未提供新产品图，保留模板中的原产品形状、颜色、材质、细节、结构和配件")
            .replace("把新产品自然放回指定手中、身上或场景", "保留原产品在指定手中、身上或场景中的状态");
    // 原视频模板中的四段口播、固定编号改用当前帧的真实时间表，声音遵守项目选项。
    const videoSource = REMAKE_FEISHU_VIDEO_PROMPTS["1-12"];
    const audioStart = videoSource.indexOf("## 口播"),
        structureStart = videoSource.indexOf("## 严格输出结构");
    if (audioStart < 0 || structureStart < audioStart) throw new Error("现有视频提示词结构已变化，请检查动态时长适配");
    const video =
        adapt(videoSource.slice(0, audioStart)).replaceAll("9:16 竖屏", `${frameRemakeAspectRatio(project)} 画面`) +
        `
## 声音
${project.audioMode === "generated" ? "按可见动作生成自然同步声音，不虚构台词。" : "不生成口播、音乐或音效，合成时使用项目选择的原片声音或静音。"}
## 输出结构
以“${seconds}秒”开始，写明风格、${frameRemakeAspectRatio(project)}、场景、产品及实际出镜人物。
正在执行本组分镜图的动作，依次呈现 ${count} 个连续分镜，使用如下本组相对时间，逐项写出具体动作与运镜：
${group.frames.map((frame) => `分镜${frame.number}，${(frame.startMs - group.startMs) / 1000}–${(frame.endMs - group.startMs) / 1000}秒`).join("\n")}
无文字，禁止画面出现字幕、水印和平台 UI。所有分镜恰好出现一次，不输出本组以外的分镜，不添加解释或模板占位符。`;
    return { analysis, productScript, storyboardScript, replacement, storyboard, video };
}
