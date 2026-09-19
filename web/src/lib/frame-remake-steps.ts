import { FRAME_REMAKE_ANALYSIS_LABELS, frameRemakeAnalysisResult, frameRemakeInputError, frameRemakeUsesTemplate, frameRemakeIsBasicWorkflow, frameRemakeSourceCopyReady, type FrameRemakeProject } from "./frame-remake-contract";

export function frameRemakeWorkflowReadiness(project: FrameRemakeProject) {
    const analysis = project.workflowVersion === "feishu-original-15s" && project.groups.length > 0 && project.groups.every((group) => group.contactSheet && group.frames.every((frame) => frame.media) && group.analysis && (!frameRemakeIsBasicWorkflow(project) || frameRemakeSourceCopyReady(project, group)));
    const planning = analysis && !frameRemakeInputError(project) && (frameRemakeIsBasicWorkflow(project) || project.groups.every((group) => frameRemakeAnalysisResult(group, "productScript") && group.imagePrompt));
    const images = planning && project.groups.every((group) => (!frameRemakeUsesTemplate(project) || (group.template.status === "completed" && group.template.result)) && group.image.status === "completed" && group.image.result);
    return { analysis, planning, images, production: Boolean(project.mergedVideo) };
}
export function recoveredFrameRemakeWorkflowStage(project: FrameRemakeProject) {
    const ready = frameRemakeWorkflowReadiness(project);
    const scope = project.automation?.stageScope;
    if (scope === "analysis" || (scope === "planning" && ready.analysis) || (scope === "images" && ready.planning) || (scope === "production" && ready.images)) return scope;
    return ready.images ? ("production" as const) : ready.planning ? ("images" as const) : ready.analysis ? ("planning" as const) : ("analysis" as const);
}

// 每轮只执行一组的一项工作，原表各步独立保存。
export function frameRemakeAutomationView(project: FrameRemakeProject) {
    return project.automation?.groupId ? { ...project, groups: project.groups.filter((g) => g.id === project.automation!.groupId) } : project;
}
export function nextFrameRemakeStep(project: FrameRemakeProject) {
    const totalGroups = project.groups.length;
    project = frameRemakeAutomationView(project);
    if (!project.sourceVideo) throw new Error("请先上传原视频");
    if (project.workflowVersion !== "feishu-original-15s" || !project.durationMs || !project.groups.length) return { kind: "inspect" as const, workflowStage: "analysis" as const, label: "读取原片信息与时间线" };
    for (const group of project.groups) {
        if (!group.analysis) return { kind: "analyze" as const, workflowStage: "analysis" as const, groupId: group.id, analysisStage: "analysis" as const, label: `第 ${group.number} / ${totalGroups} 组：理解来源视频` };
        if (!group.contactSheet || group.frames.some((frame) => !frame.media)) return { kind: "extract" as const, workflowStage: "analysis" as const, groupId: group.id, label: `第 ${group.number} / ${totalGroups} 组：按分析结果拆帧` };
        if (frameRemakeIsBasicWorkflow(project) && !frameRemakeSourceCopyReady(project, group)) return { kind: "transcribe" as const, workflowStage: "analysis" as const, groupId: group.id, label: `第 ${group.number} / ${totalGroups} 组：音视频转原文案` };
    }
    for (const group of frameRemakeIsBasicWorkflow(project) ? [] : project.groups) {
        for (const analysisStage of ["productScript", "imagePrompt"] as const)
            if (!frameRemakeAnalysisResult(group, analysisStage))
                return { kind: "analyze" as const, workflowStage: "planning" as const, groupId: group.id, analysisStage, label: `第 ${group.number} / ${totalGroups} 组：${FRAME_REMAKE_ANALYSIS_LABELS[analysisStage]}` };
    }
    for (const group of project.groups) {
        for (const kind of frameRemakeUsesTemplate(project) ? (["template", "image"] as const) : (["image"] as const)) {
            if (group[kind].status === "error") throw new Error(`第 ${group.number} 组：${group[kind].error || "生成失败"}`);
            if (group[kind].status !== "completed") return { kind, workflowStage: "images" as const, groupId: group.id, label: `第 ${group.number} / ${totalGroups} 组：${kind === "template" ? "还原模板与替换人物" : "生成最终分镜图"}` };
        }
    }
    for (const group of project.groups) {
        if (frameRemakeIsBasicWorkflow(project) && !group.copy) return { kind: "analyze" as const, workflowStage: "production" as const, groupId: group.id, analysisStage: "copy" as const, label: `第 ${group.number} / ${totalGroups} 组：文案预处理` };
        if (!group.videoPrompt) return { kind: "analyze" as const, workflowStage: "production" as const, groupId: group.id, analysisStage: "videoPrompt" as const, label: `第 ${group.number} / ${totalGroups} 组：生成视频提示词` };
    }
    for (const group of project.groups) {
        if (group.video.status === "error") throw new Error(`第 ${group.number} 组：${group.video.error || "生成失败"}`);
        if (group.video.status !== "completed") return { kind: "video" as const, workflowStage: "production" as const, groupId: group.id, label: `第 ${group.number} / ${totalGroups} 组：生成视频` };
    }
    if (!project.mergedVideo) return { kind: "merge" as const, workflowStage: "production" as const, label: "按原片时长合成视频" };
    return undefined;
}
