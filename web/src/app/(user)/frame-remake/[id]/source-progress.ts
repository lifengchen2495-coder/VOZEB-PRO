import { frameRemakeIsBasicWorkflow, frameRemakeSourceCopyReady, type FrameRemakeGroup, type FrameRemakeProject } from "@/lib/frame-remake-contract";

export function frameRemakeSourceGroupReady(group: FrameRemakeGroup, project?: FrameRemakeProject) {
    const framesReady = Boolean(group.analysis && group.contactSheet && group.frames.length && group.frames.every((frame) => frame.media?.url));
    const copyReady = !project || !frameRemakeIsBasicWorkflow(project) || frameRemakeSourceCopyReady(project, group);
    return framesReady && copyReady;
}

export function frameRemakeSourceGroupProgress(project: FrameRemakeProject, group: FrameRemakeGroup): { label: string; color: "default" | "processing" | "success" | "error"; detail: string } {
    const inScope = (!project.automation?.groupId || project.automation.groupId === group.id) && (!project.automation?.stageScope || project.automation.stageScope === "analysis");
    const paused = project.automation?.status === "paused" && inScope;
    const operation = project.operation?.groupId === group.id ? project.operation : undefined;
    if (operation?.kind === "analyze" && operation.analysisStage === "analysis") return { label: "分析中", color: "processing", detail: "正在理解本组来源视频" };
    if (operation?.kind === "extract") return { label: "拆帧中", color: "processing", detail: "正在按分析结果提取画面" };
    if (operation?.kind === "transcribe") return { label: "转录中", color: "processing", detail: "正在提取本组原视频文案" };
    if (frameRemakeSourceGroupReady(group, project)) return { label: "已完成", color: "success", detail: frameRemakeIsBasicWorkflow(project) ? "分析、抽帧和原文案已保存" : "分析和抽帧结果已保存" };
    const error = group.analysisSteps?.analysis?.error;
    if (error && project.automation?.status === "running" && inScope) return { label: "等待", color: "default", detail: "等待重新分析本组" };
    if (error) return { label: "失败", color: "error", detail: error };
    if (group.analysis && group.contactSheet && group.frames.every((frame) => frame.media?.url)) return { label: "待原文案", color: "default", detail: paused ? "画面已完成，继续后转录；也可手动填写原文案" : "画面已完成，等待转录或手动填写原文案" };
    if (group.analysis) return { label: "待拆帧", color: "default", detail: paused ? "分析结果已保存，继续后拆帧" : "分析结果已保存，等待提取画面" };
    const nextGroup = project.groups.find((g) => (!project.automation?.groupId || project.automation.groupId === g.id) && !frameRemakeSourceGroupReady(g, project));
    if (paused && nextGroup?.id === group.id) return { label: "已暂停", color: "default", detail: "继续后分析本组" };
    return { label: "等待", color: "default", detail: paused ? "流程已暂停，尚未开始分析本组" : "尚未开始分析本组" };
}
