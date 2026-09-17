import { frameRemakeActiveReferences, frameRemakeSeconds, frameRemakeUsesTemplate, type FrameRemakeAnalysisStage, type FrameRemakeGroup, type FrameRemakeProject } from "./frame-remake-contract";
import { assertFrameRemakePromptResolved, frameRemakePromptWithContract } from "./frame-remake-feishu-workflow";
import { frameRemakeTemplates } from "./frame-remake-prompt-templates";

export const FRAME_REMAKE_PROMPT_VERSION = "2026-09-17.remake15-templates.1";

function groupTimeline(project: FrameRemakeProject, group: FrameRemakeGroup) {
    return {
        fullVideoSeconds: project.durationMs / 1000,
        group: group.number,
        sourceStartSeconds: group.startMs / 1000,
        sourceEndSeconds: group.endMs / 1000,
        actualSeconds: frameRemakeSeconds(group),
        frames: group.frames.map((frame, index) => ({ ordinal: index + 1, startTime: (frame.startMs - group.startMs) / 1000, endTime: (frame.endMs - group.startMs) / 1000, ...frame.detail })),
    };
}

function groupCopy(project: FrameRemakeProject, group: FrameRemakeGroup) {
    if (project.sourceCopy?.trim() === "不需要人物口播") return "";
    if (group.copyBlocks?.length) return group.copyBlocks.map((block) => block.text).join("");
    return group.copy?.trim() || group.sourceCopy?.trim() || (project.groups.length === 1 ? project.sourceCopy?.trim() || "" : "");
}

function referenceLabels(roles: string[]) {
    return roles.map((role, index) => ({ ordinal: index + 1, role }));
}

function replacementContract(project: FrameRemakeProject, stage: "productScript" | "imagePrompt" | "template" | "image" | "video" = "productScript") {
    const refs = frameRemakeActiveReferences(project);
    const productAttached = stage === "productScript" || stage === "image" || stage === "video";
    const characterAttached = stage === "productScript" || stage === "template" || stage === "video" || (stage === "image" && !frameRemakeUsesTemplate(project));
    const backgroundAttached = stage === "productScript" || stage === "image";
    return [
        "以本次实际参考图对应关系和启用的替换目标执行旧模板；未启用的目标保留原片。",
        refs.product.length ? (productAttached ? "本次替换产品，产品外观以实际产品图为准，功能仅采用产品信息。" : "项目启用了换品，本步不附产品图；以本组脚本中的产品有无及位置执行，不虚构产品外观和功能。") : "本次不替换产品，保留原产品及其动作，不移除原产品、不虚构新产品图、不引用 @产品图。",
        refs.character.length ? (characterAttached ? "本次替换人物，依据实际人物参考图，仅替换原片实际出镜人物。" : "项目启用了换人，本步不附人物图；人物身份采用已保存脚本或已完成模板，不凭空创建另一人物。") : "本次不替换人物，保留原片人物身份，不引用 @人物图。",
        refs.background.length ? (backgroundAttached ? "本次替换环境，背景参考图只控制环境和光线；保持原片镜头顺序、构图、动作、接触与遮挡关系。" : stage === "template" ? "项目启用了换环境，本步不附背景图，仍保留原片场景，环境替换由最终图步骤完成。" : "项目启用了换环境，本步不附背景图；环境沿用本组已保存脚本或最终十二宫格，不引用额外背景图。") : "本次不替换环境，保留原片场景。",
    ];
}

function timelineContract(group: FrameRemakeGroup, generationSeconds = 15) {
    const seconds = frameRemakeSeconds(group);
    return [
        `仅处理当前第 ${group.number} 组：原片 ${group.startMs / 1000}–${group.endMs / 1000} 秒，真实时长 ${seconds} 秒；本组局部分镜编号始终为 1–12，不使用全片帧编号。`,
        "十二个分镜保持输入中的局部起止时间，完整覆盖本组动作；不得把整片内容、其他组镜头或整片文案放进本组。",
        `提交视频模型的时长为 ${generationSeconds} 秒；前 ${seconds} 秒必须依次覆盖本组全部 12 个镜头和全部动作，不改变原片节奏。`,
        generationSeconds > seconds ? `本组是尾段：全部 12 镜头的动作和口播必须在前 ${seconds} 秒内完成；${seconds}–${generationSeconds} 秒只保持最后画面静止，不新增动作、镜头或口播。系统会按原速度保留前 ${seconds} 秒，精确裁掉剩余部分。` : "本组时间线完整覆盖生成视频，不提前结束，也不压缩或延长本组。",
    ];
}

function narrationContract(project: FrameRemakeProject, group: FrameRemakeGroup) {
    const copy = groupCopy(project, group);
    return project.audioMode === "generated" && copy
        ? [`使用${project.voice === "male" ? "男性" : "女性"}配音，仅逐字采用本组原文案；按动作与实际时间顺序分配到四个镜头区间，不得翻译、改写、重复或添加。`, "本次没有音频附件，仅按本组文案生成配音，不引用 @音频文件。"]
        : ["视频模型输出静音，不生成口播、对白、音乐或音效，不引用 @音频文件。" + (project.audioMode === "source" ? "系统将在合并时贴回原片声音。" : "")];
}

export function frameRemakeAnalysisPrompt(project: FrameRemakeProject, group: FrameRemakeGroup, stage: FrameRemakeAnalysisStage) {
    const templates = frameRemakeTemplates(project, group);
    if (stage === "copy") throw new Error("原文案为可选输入，不调用额外文案改写模型");
    const refs = frameRemakeActiveReferences(project);
    const roles = stage === "productScript"
        ? [...refs.product.map(() => "产品图"), ...refs.character.map(() => "人物图"), ...refs.background.map(() => "背景图")]
        : stage === "videoPrompt"
          ? ["本组最终十二宫格图 @十二宫格图", ...refs.product.map(() => "产品图 @产品图"), ...refs.character.map(() => "人物图 @人物图")]
          : stage === "imagePrompt" ? ["本组原视频十二宫格"] : [];
    const template = { analysis: templates.analysis, productScript: templates.productScript, imagePrompt: templates.storyboardScript, videoPrompt: group.videoPromptInstructions?.trim() || templates.video }[stage];
    const input = {
        timeline: groupTimeline(project, group),
        "图片附件位置": referenceLabels(roles),
        "12镜头解析": group.analysis,
        "产品信息": project.productInfo || "",
        "补充要求": project.instructions,
        "新产品-12分镜脚本": group.productScript || "",
        "1-12分镜提示词": group.imagePrompt,
        "本组原文案": groupCopy(project, group),
        "本组文案区间": group.copyBlocks?.map((block) => ({ ordinals: block.frameNumbers.map((number) => group.frames.findIndex((frame) => frame.number === number) + 1), startTime: (block.startMs - group.startMs) / 1000, endTime: (block.endMs - group.startMs) / 1000, text: block.text })) || [],
    };
    return frameRemakePromptWithContract(template, [
        `本次只执行 ${stage} 步骤，输出本步完整正文后结束，不执行后续步骤。`,
        ...timelineContract(group),
        ...(stage === "analysis" ? ["只分析原片实际画面与声音，替换任务留到后续步骤。"] : replacementContract(project, stage === "videoPrompt" ? "video" : stage)),
        ...(stage === "videoPrompt" ? narrationContract(project, group) : ["脚本不新增口播，只适配本组画面；人物、产品和环境依据启用的替换目标。"]),
        stage === "videoPrompt" ? "按旧模板输出四个连续区间分镜1-3、4-6、7-9、10-12；写出真实素材标签的对应关系，未提供的素材标签不得引用。" : "本组局部编号分镜1至分镜12各出现一次，使用旧模板对应正文结构。",
        "只输出正文，不返回其他步骤结果或解释。",
    ], input);
}

export function frameRemakeImagePrompt(project: FrameRemakeProject, group: FrameRemakeGroup, kind: "template" | "image" = "image") {
    const templates = frameRemakeTemplates(project, group);
    const refs = frameRemakeActiveReferences(project);
    const usesTemplate = frameRemakeUsesTemplate(project);
    const roles = kind === "template"
        ? ["本组原视频十二宫格", ...refs.character.map(() => "人物图")]
        : [usesTemplate ? "本组清理后的十二宫格模板" : "本组原视频十二宫格", ...refs.product.map(() => "产品图"), ...(!usesTemplate ? refs.character.map(() => "人物图") : []), ...refs.background.map(() => "背景图")];
    return frameRemakePromptWithContract(kind === "template" ? templates.replacement : templates.storyboard, [
        "本次仅输出一张 9:16、三列四行的十二宫格图片；局部编号 1–12 对应本组，不在图片上绘制编号。",
        ...replacementContract(project, kind),
        "图片附件顺序严格使用下方实际对应关系，旧模板中的固定图号以实际附件位置为准；没有提供的素材不得引用。",
        kind === "template" ? "本步只清理旧产品并完成可选换人；背景沿用原图。背景替换留到最终图步骤，本步没有产品图或背景图附件。" : usesTemplate ? "人物沿用上一步模板；依据产品图填入产品，并按已提供的背景图替换环境。" : "本次没有清理模板步骤，直接依据原视频十二宫格生成最终图，保留原产品；已提供人物图时完成换人，已提供背景图时完成换环境。",
    ], { timeline: groupTimeline(project, group), "图片附件位置": referenceLabels(roles), "1-12分镜提示词": group.imagePrompt, "产品信息": project.productInfo || "", "补充要求": project.instructions });
}

export function frameRemakeVideoPrompt(project: FrameRemakeProject, group: FrameRemakeGroup, generationSeconds: number) {
    const refs = frameRemakeActiveReferences(project);
    return frameRemakePromptWithContract(group.videoPrompt, [
        ...timelineContract(group, generationSeconds),
        "输出正常单画面连续视频，不输出十二宫格拼图、分屏或幻灯片；@十二宫格图 仅作为按顺序执行的分镜依据。",
        ...replacementContract(project, "video"),
        ...narrationContract(project, group),
    ], { timeline: groupTimeline(project, group), "图片附件位置": referenceLabels(["本组最终十二宫格图 @十二宫格图", ...refs.product.map(() => "产品图 @产品图"), ...refs.character.map(() => "人物图 @人物图")]), "本组原文案": groupCopy(project, group) });
}

export function parseFrameRemakeAnalysis(raw: string, stage: FrameRemakeAnalysisStage) {
    let text = raw.trim().replace(/^```(?:json|text|markdown)?\s*\n?/i, "").replace(/\s*```$/, "").trim();
    if (text.startsWith("{")) {
        try {
            const value = JSON.parse(text) as Record<string, unknown>;
            if (typeof value[stage] === "string") text = value[stage].trim();
        } catch {
            // 旧流程输出普通正文，正文中的花括号不作为 JSON 合同判断。
        }
    }
    if (!text || text.length > 100_000) throw new Error("模型未返回有效正文，或本步结果超过长度上限");
    assertFrameRemakePromptResolved(text);
    if (stage === "productScript" || stage === "imagePrompt") {
        const ordinals = [...text.matchAll(/(?:^|\n)\s*(?:#{1,6}\s*)?(?:\*\*)?分镜\s*(\d+)\s*(?:\*\*)?\s*[:：]/gu)].map((match) => Number(match[1]));
        if (ordinals.length !== 12 || ordinals.some((ordinal, index) => ordinal !== index + 1)) throw new Error("分镜脚本须依次包含本组局部分镜1至分镜12，不能缺失、重复或乱序");
    }
    return text;
}
