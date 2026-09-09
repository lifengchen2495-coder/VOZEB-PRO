import { nanoid } from "nanoid";
import type { DramaContentAnalysis, DramaProject, DramaVisualAnalysis } from "@/lib/drama-project-contract";
import type { DramaWorkflowRequest, DramaWorkflowResponse } from "@/lib/drama-workflow-request";
import { dramaWorkflowArtifactIsStale, dramaWorkflowFingerprint, dramaWorkflowSourceFingerprint, latestDramaWorkflowArtifact } from "@/lib/drama-workflow";
import { DramaWorkflowMergeConflict, mergeDramaWorkflowArtifactResult } from "@/lib/drama-workflow-response";
import type { DramaWorkflowArtifact } from "@/lib/drama-workflow-contract";
import { dramaContentAnalysisFingerprint, dramaVisualAnalysisFingerprint, reconcileDramaContentAnalysis, reconcileDramaVisualAnalysis } from "@/lib/drama-analysis-reconcile";

type AnalysisFlowDependencies = {
    episodeId: string;
    current: () => DramaProject;
    flush: () => Promise<DramaProject>;
    mutate: (update: (project: DramaProject) => DramaProject) => void;
    workflow: (input: DramaWorkflowRequest) => Promise<DramaWorkflowResponse>;
    content: (project: DramaProject, episodeId: string) => Promise<DramaContentAnalysis>;
    visual: (project: DramaProject, episodeId: string) => Promise<DramaVisualAnalysis>;
    saveVersion: (project: DramaProject) => Promise<void>;
    progress: (label: string) => void;
};

export async function analyzeDramaScriptFlow(deps: AnalysisFlowDependencies): Promise<void> {
    const { episodeId } = deps;
    const initial = await deps.flush();
    if (!initial.episodes.find((episode) => episode.id === episodeId)?.script.trim()) throw new Error("请先粘贴或导入本集剧本");
    const source = dramaWorkflowSourceFingerprint(initial, "story");
    const assertSource = () => {
        if (dramaWorkflowSourceFingerprint(deps.current(), "story") !== source) throw new Error("分析期间剧本已修改，已完成的结果已保留，请重新点击 AI 一键分析");
    };
    const mergeResult = async (artifact: DramaWorkflowArtifact) => {
        let conflict: DramaWorkflowMergeConflict | undefined;
        deps.mutate((current) => {
            try {
                return mergeDramaWorkflowArtifactResult(current, artifact);
            } catch (error) {
                if (!(error instanceof DramaWorkflowMergeConflict)) throw error;
                conflict = error;
                return error.project;
            }
        });
        if (conflict) {
            await deps.flush();
            throw conflict;
        }
    };
    await deps.saveVersion(initial);
    for (const [stage, label] of [
        ["story", "1/5 · 分析全剧故事"],
        ["characters", "2/5 · 识别全剧人物"],
        ["beats", "3/5 · 分析本集节奏"],
    ] as const) {
        assertSource();
        deps.progress(label);
        const snapshot = await deps.flush();
        assertSource();
        const scope = stage === "beats" ? episodeId : undefined;
        const existing = latestDramaWorkflowArtifact(snapshot, stage, scope, "adopted", "analysis");
        if (existing && !dramaWorkflowArtifactIsStale(snapshot, existing)) {
            if (stage === "characters") await mergeResult(existing);
            continue;
        }
        const result = await deps.workflow({ action: "analyze", stage, episodeId: scope, expectedInput: dramaWorkflowFingerprint(snapshot, stage, scope, "analysis"), requestId: `drama-analysis:${snapshot.id}:${stage}:${nanoid()}` });
        await mergeResult(result.artifact);
        assertSource();
        if (result.artifact.status !== "adopted" || dramaWorkflowArtifactIsStale(deps.current(), result.artifact)) throw new Error("分析输入已改变，本次结果已留存，请基于最新内容继续分析");
    }
    deps.progress("4/5 · 提取本集场景与镜头");
    let snapshot = await deps.flush();
    assertSource();
    const episode = snapshot.episodes.find((item) => item.id === episodeId)!;
    if (!episode.shots.length || episode.contentStale || episode.reviewStatus === "draft") {
        const expectedInput = dramaContentAnalysisFingerprint(snapshot, episodeId);
        let content = await deps.content(snapshot, episodeId);
        assertSource();
        const beats = latestDramaWorkflowArtifact(snapshot, "beats", episodeId, "adopted", "analysis");
        if (beats && !dramaWorkflowArtifactIsStale(snapshot, beats)) content = { ...content, episode: { ...content.episode, outline: beats.data.outline, hook: beats.data.hook, nextPreview: beats.data.nextPreview } };
        deps.mutate((current) => reconcileDramaContentAnalysis(current, episodeId, content, expectedInput));
    }
    deps.progress("5/5 · 生成本集分镜方案");
    snapshot = await deps.flush();
    assertSource();
    const prepared = snapshot.episodes.find((item) => item.id === episodeId)!;
    if (!prepared.shots.length || prepared.contentStale) throw new Error("未提取到可用镜头，请检查剧本内容后重试");
    if (prepared.reviewStatus !== "visual_ready") {
        const expectedInput = dramaVisualAnalysisFingerprint(snapshot, episodeId);
        const visual = await deps.visual(snapshot, episodeId);
        assertSource();
        deps.mutate((current) => reconcileDramaVisualAnalysis(current, episodeId, visual, expectedInput));
    }
    await deps.flush();
    assertSource();
}
