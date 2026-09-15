import { FRAME_REMAKE_ANALYSIS_LABELS, frameRemakeAnalysisResult, type FrameRemakeProject } from "./frame-remake-contract";

export function frameRemakeWorkflowReadiness(project: FrameRemakeProject) {
    const analysis = project.groups.length > 0 && project.groups.every((group) => group.contactSheet && group.frames.every((frame) => frame.media) && group.analysis && frameRemakeAnalysisResult(group, "copy"));
    const images =
        analysis && project.groups.every((group) => frameRemakeAnalysisResult(group, "productScript") && group.imagePrompt && group.template.status === "completed" && group.template.result && group.image.status === "completed" && group.image.result);
    return { analysis, images, production: Boolean(project.mergedVideo) };
}
export function recoveredFrameRemakeWorkflowStage(project: FrameRemakeProject) {
    const ready = frameRemakeWorkflowReadiness(project);
    const scope = project.automation?.stageScope;
    if (scope === "analysis" || (scope === "images" && ready.analysis) || (scope === "production" && ready.images)) return scope;
    return ready.images ? ("production" as const) : ready.analysis ? ("images" as const) : ("analysis" as const);
}

// 沿用来源分析 → 分镜重绘 → 生产内容，每轮只执行一组的一项工作。
export function nextFrameRemakeStep(project: FrameRemakeProject) {
    if (!project.sourceVideo) throw new Error("请先上传原视频");
    if (!project.durationMs || !project.groups.length) return { kind: "inspect" as const, workflowStage: "analysis" as const, label: "读取原片信息与时间线" };
    for (const group of project.groups) {
        if (!group.analysis) return { kind: "analyze" as const, workflowStage: "analysis" as const, groupId: group.id, analysisStage: "analysis" as const, label: `第 ${group.number} / ${project.groups.length} 组：理解来源视频` };
        if (!group.contactSheet || group.frames.some((frame) => !frame.media)) return { kind: "extract" as const, workflowStage: "analysis" as const, groupId: group.id, label: `第 ${group.number} / ${project.groups.length} 组：按分析结果拆帧` };
        if (!frameRemakeAnalysisResult(group, "copy")) return { kind: "analyze" as const, workflowStage: "analysis" as const, groupId: group.id, analysisStage: "copy" as const, label: `第 ${group.number} / ${project.groups.length} 组：文案预处理` };
    }
    for (const group of project.groups) {
        for (const analysisStage of ["productScript", "imagePrompt"] as const)
            if (!frameRemakeAnalysisResult(group, analysisStage))
                return { kind: "analyze" as const, workflowStage: "images" as const, groupId: group.id, analysisStage, label: `第 ${group.number} / ${project.groups.length} 组：${FRAME_REMAKE_ANALYSIS_LABELS[analysisStage]}` };
    }
    for (const group of project.groups) {
        for (const kind of ["template", "image"] as const) {
            if (group[kind].status === "error") throw new Error(`第 ${group.number} 组：${group[kind].error || "生成失败"}`);
            if (group[kind].status !== "completed") return { kind, workflowStage: "images" as const, groupId: group.id, label: `第 ${group.number} / ${project.groups.length} 组：${kind === "template" ? "还原模板与替换人物" : "融合产品与背景"}` };
        }
    }
    for (const group of project.groups) {
        if (!group.videoPrompt) return { kind: "analyze" as const, workflowStage: "production" as const, groupId: group.id, analysisStage: "videoPrompt" as const, label: `第 ${group.number} / ${project.groups.length} 组：生成视频提示词` };
    }
    for (const group of project.groups) {
        if (group.video.status === "error") throw new Error(`第 ${group.number} 组：${group.video.error || "生成失败"}`);
        if (group.video.status !== "completed") return { kind: "video" as const, workflowStage: "production" as const, groupId: group.id, label: `第 ${group.number} / ${project.groups.length} 组：生成视频` };
    }
    if (!project.mergedVideo) return { kind: "merge" as const, workflowStage: "production" as const, label: "按原片时长合成视频" };
    return undefined;
}
