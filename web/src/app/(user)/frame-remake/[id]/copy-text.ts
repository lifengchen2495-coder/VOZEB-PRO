import type { FrameRemakeGroup, FrameRemakeProject } from "@/lib/frame-remake-contract";

// 与生成步骤使用相同的文案优先级，预览和导出不会隐藏已提取的原文。
export function frameRemakeGroupCopyText(project: FrameRemakeProject, group: FrameRemakeGroup) {
    if (project.sourceCopy?.trim() === "不需要人物口播") return "";
    if (group.copyBlocks?.length) return group.copyBlocks.map((block) => block.text).join("");
    return group.copy?.trim() || group.sourceCopy?.trim() || (project.groups.length === 1 ? project.sourceCopy?.trim() || "" : "");
}
