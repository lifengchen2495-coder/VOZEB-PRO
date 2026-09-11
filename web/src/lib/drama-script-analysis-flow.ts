import { nanoid } from "nanoid";
import { isCurrentDramaSkillReport } from "@/lib/drama-skill-contract";
import type { DramaContentAnalysis, DramaProject, DramaVisualAnalysis } from "@/lib/drama-project-contract";
import type { DramaWorkflowRequest, DramaWorkflowResponse } from "@/lib/drama-workflow-request";
import { DRAMA_WORKFLOW_METHOD_VERSION, dramaWorkflowArtifactIsStale, dramaWorkflowFingerprint, dramaWorkflowSourceFingerprint, latestDramaWorkflowArtifact } from "@/lib/drama-workflow";
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
        if (dramaWorkflowSourceFingerprint(deps.current(), "story") !== source) throw new Error("创作期间剧本已修改，已完成的结果已保留，请基于最新原稿继续创作");
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
        ["story", "1/6 · 自动理解原稿"],
        ["characters", "2/6 · 创作完整人物小传"],
        ["beats", "3/6 · 设计爽点与秒级节奏"],
        ["script", "4/6 · 创作详细改编剧本"],
    ] as const) {
        assertSource();
        deps.progress(label);
        const snapshot = await deps.flush();
        assertSource();
        const scope = stage === "beats" || stage === "script" ? episodeId : undefined;
        const intent = stage === "story" ? "analysis" : "creation";
        const existing = latestDramaWorkflowArtifact(snapshot, stage, scope, "adopted", intent);
        const complete = existing && (existing.stage === "story" || (existing.methodVersion === DRAMA_WORKFLOW_METHOD_VERSION && isCurrentDramaSkillReport(existing.stage, existing.data.skill)));
        if (complete && !dramaWorkflowArtifactIsStale(snapshot, existing)) {
            if (stage === "characters") await mergeResult(existing);
            continue;
        }
        const candidate = stage === "story" ? undefined : latestDramaWorkflowArtifact(snapshot, stage, scope, "candidate", "creation");
        const reusableCandidate = candidate && candidate.methodVersion === DRAMA_WORKFLOW_METHOD_VERSION && isCurrentDramaSkillReport(candidate.stage, candidate.data.skill) && !dramaWorkflowArtifactIsStale(snapshot, candidate);
        let result = reusableCandidate
            ? { project: snapshot, artifact: candidate }
            : await deps.workflow({
                  action: stage === "story" ? "analyze" : "generate",
                  stage,
                  intent,
                  episodeId: scope,
                  expectedInput: dramaWorkflowFingerprint(snapshot, stage, scope, intent),
                  requestId: `drama-skills:${snapshot.id}:${stage}:${nanoid()}`,
              } as DramaWorkflowRequest);
        await mergeResult(result.artifact);
        assertSource();
        if (stage !== "story") {
            if (result.artifact.stage !== stage || !isCurrentDramaSkillReport(stage, result.artifact.data.skill)) throw new Error("模型未返回当前版本的完整 Skill 产物，本次结果已留存，请重试当前阶段");
            const candidate = await deps.flush();
            assertSource();
            if (dramaWorkflowArtifactIsStale(candidate, result.artifact)) throw new Error("创作输入已改变，本次结果已留存，请基于最新内容继续创作");
            if (result.artifact.status !== "adopted") {
                result = await deps.workflow({ action: "adopt", artifactId: result.artifact.id, expectedInput: dramaWorkflowFingerprint(candidate, stage, scope, intent) });
                await mergeResult(result.artifact);
                assertSource();
            }
        }
        if (result.artifact.status !== "adopted" || dramaWorkflowArtifactIsStale(deps.current(), result.artifact)) throw new Error("创作输入已改变，本次结果已留存，请基于最新内容继续创作");
        await deps.flush();
    }
    deps.progress("5/6 · 生成标准分镜脚本");
    let snapshot = await deps.flush();
    assertSource();
    const episode = snapshot.episodes.find((item) => item.id === episodeId)!;
    if (!episode.shots.length || !isCurrentDramaSkillReport("content", episode.storyboardSkill) || episode.contentStale || episode.reviewStatus === "draft") {
        const expectedInput = dramaContentAnalysisFingerprint(snapshot, episodeId);
        let content = await deps.content(snapshot, episodeId);
        assertSource();
        if (!isCurrentDramaSkillReport("content", content.skill)) throw new Error("模型未返回当前版本的标准分镜 Skill 产物，请重试标准分镜阶段");
        const beats = latestDramaWorkflowArtifact(snapshot, "beats", episodeId, "adopted", "creation");
        if (beats && !dramaWorkflowArtifactIsStale(snapshot, beats)) content = { ...content, episode: { ...content.episode, outline: beats.data.outline, hook: beats.data.hook, nextPreview: beats.data.nextPreview } };
        deps.mutate((current) => reconcileDramaContentAnalysis(current, episodeId, content, expectedInput));
    }
    deps.progress("6/6 · 生成 Seedance 提示词");
    snapshot = await deps.flush();
    assertSource();
    const prepared = snapshot.episodes.find((item) => item.id === episodeId)!;
    if (!prepared.shots.length || prepared.contentStale) throw new Error("未提取到可用镜头，请检查剧本内容后重试");
    if (prepared.reviewStatus !== "visual_ready" || !isCurrentDramaSkillReport("visual", prepared.seedanceSkill)) {
        const expectedInput = dramaVisualAnalysisFingerprint(snapshot, episodeId);
        const visual = await deps.visual(snapshot, episodeId);
        assertSource();
        if (!isCurrentDramaSkillReport("visual", visual.skill)) throw new Error("模型未返回当前版本的 Seedance Skill 产物，请重试提示词阶段");
        deps.mutate((current) => reconcileDramaVisualAnalysis(current, episodeId, visual, expectedInput));
    }
    await deps.flush();
    assertSource();
}
