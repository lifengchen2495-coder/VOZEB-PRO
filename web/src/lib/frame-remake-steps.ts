import { FRAME_REMAKE_ANALYSIS_LABELS, nextFrameRemakeAnalysisStage, type FrameRemakeProject } from "./frame-remake-contract";

// 每轮仅领取一个组的一项工作。已保存的前序结果是下一轮的输入和恢复点。
export function nextFrameRemakeStep(project: FrameRemakeProject) {
    if (!project.sourceVideo) throw new Error("请先上传原视频");
    if (!project.durationMs || !project.groups.length) return { kind: "inspect" as const, label: "读取原片信息与时间线" };
    const frames = project.groups.find((group) => !group.contactSheet || group.frames.some((frame) => !frame.media));
    if (frames) return { kind: "extract" as const, groupId: frames.id, label: `第 ${frames.number} / ${project.groups.length} 组：拆帧` };
    for (const group of project.groups) {
        const analysisStage = nextFrameRemakeAnalysisStage(group);
        if (analysisStage) return { kind: "analyze" as const, groupId: group.id, analysisStage, label: `第 ${group.number} / ${project.groups.length} 组：${FRAME_REMAKE_ANALYSIS_LABELS[analysisStage]}` };
    }
    for (const group of project.groups)
        for (const kind of ["template", "image", "video"] as const) {
            if (group[kind].status === "error") throw new Error(`第 ${group.number} 组：${group[kind].error || "生成失败"}`);
            if (group[kind].status !== "completed") return { kind, groupId: group.id, label: `第 ${group.number} / ${project.groups.length} 组：${kind === "template" ? "还原模板与替换人物" : kind === "image" ? "融合产品与背景" : "生成视频"}` };
        }
    if (!project.mergedVideo) return { kind: "merge" as const, label: "按原片时长合成视频" };
    return undefined;
}
