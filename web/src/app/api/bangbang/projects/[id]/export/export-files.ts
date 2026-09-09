import { strToU8 } from "fflate";
import { BANGBANG_STEP_LABELS, bangbangActiveSteps, bangbangCreationMode, type BangbangProject } from "@/lib/bangbang-contract";
import { bangbangVideoPromptInstructions } from "@/lib/server/bangbang-prompts";

export function bangbangProductionExportBlockReason(project: BangbangProject): string | undefined {
    if (!project.groups.length || project.groups.some((group) => group.image.status !== "approved" || !group.image.result || group.frames.length !== 9 || !group.optimizedPrompt.trim())) return "请先完成并逐张确认全部九宫格";
    if (!project.videoSegments.length || project.videoSegments.some((segment) => !segment.prompt.trim() || !Number.isFinite(segment.duration) || segment.duration <= 0 || segment.duration > project.maxSegmentSeconds)) return "请先生成完整的视频提示词";
    const covered = project.videoSegments.flatMap((segment) => segment.groupIds);
    if (covered.length !== project.groups.length || covered.some((id, index) => id !== project.groups[index].id)) return "视频提示词必须按顺序完整覆盖全部九宫格";
    return undefined;
}

export function bangbangTextExportFiles(project: BangbangProject) {
    const files: Record<string, Uint8Array> = {};
    files["project.json"] = strToU8(JSON.stringify(project, null, 2));
    files["视频提示词生成指令.txt"] = strToU8(bangbangVideoPromptInstructions(project));
    const productMode = bangbangCreationMode(project) === "product";
    files["完整过程.md"] = strToU8(`# ${project.title}\n\n创作模式：${productMode ? "产品原创" : "对标裂变"}\n\n${bangbangActiveSteps(project).map((step, index) => {
        const output = project.outputs[step];
        return `## ${index + 1}. ${productMode && step === "directions" ? "创作方向" : BANGBANG_STEP_LABELS[step]}\n\n${output ? `${output.text}\n\n生成时间：${output.createdAt}；来源：${output.source}` : "尚未完成"}`;
    }).join("\n\n")}\n`);
    files["分镜规划表.json"] = strToU8(JSON.stringify(project.groups, null, 2));
    files["分镜规划表.csv"] = strToU8(`\uFEFF${[
        ["组号", "组 ID", "开始秒", "结束秒", "场景", "人物", "人物状态", "叙事目标", "台词", "节拍", "产品出镜", "连续性"],
        ...project.groups.map((group) => [group.number, group.id, group.start, group.end, group.scene, group.characterIds.map((id) => project.characters.find((character) => character.id === id)?.name || id).join("、"), group.characterState, group.goal, group.dialogue, group.beats, group.productVisible ? "是" : "否", group.continuity]),
    ].map((row) => row.map(csvCell).join(",")).join("\r\n")}`);
    files["视频提示词.txt"] = strToU8(project.videoSegments.map((segment, index) => `第 ${index + 1} 段｜${segment.duration} 秒｜${segment.groupIds.join("、")}\n\n${segment.prompt}`).join("\n\n---\n\n"));
    for (const [index, group] of project.groups.entries()) files[`九宫格/${String(index + 1).padStart(3, "0")}/生图提示词.txt`] = strToU8(group.optimizedPrompt);
    return files;
}

function csvCell(value: unknown) {
    const text = String(value ?? "");
    // CSV 可能被电子表格打开，禁止将模型文本识别为公式。
    const safe = /^[\s]*[=+@-]/.test(text) ? `'${text}` : text;
    return `"${safe.replace(/"/g, '""')}"`;
}
