import { nextFrameRemakeStep, frameRemakeWorkflowReadiness, frameRemakeAutomationView } from "@/lib/frame-remake-steps";
export { nextFrameRemakeStep } from "@/lib/frame-remake-steps";
import { randomUUID } from "node:crypto";
import { frameRemakeInputError, frameRemakeBusy, idleFrameRemakeTask, resetFrameRemakeAnalysisFrom, type FrameRemakeRunOptions, type FrameRemakeWorkflowStage } from "@/lib/frame-remake-contract";
import { changedFrameRemake, pausedFrameRemakeProject, FrameRemakeError, assertFrameRemakeRevision, assertFrameRemakeAnalysisPromptReady, getFrameRemakeProjectForUser, mutateFrameRemake, startFrameRemakeOperation, submitFrameRemakeGeneration } from "./frame-remake-project-service";
import { assertFrameRemakePromptResolved } from "@/lib/frame-remake-feishu-workflow";
import { frameRemakeImagePrompt, frameRemakeVideoPrompt } from "@/lib/frame-remake-prompts";
import { listRunnableFrameRemakeProjects } from "./frame-remake-project-store";
import { runFrameRemakeOperation } from "./frame-remake-runtime";
import { isWorkerTokenConfigured, maintenanceWorkerContext } from "./maintenance-auth";
import { toSafeGenerationErrorMessage } from "./generation-errors";

export async function controlFrameRemakeAutomation(userId: string, id: string, revision: number, action: "start" | "step" | "pause", stageScope?: FrameRemakeWorkflowStage, stopAfterPrompts = false, options: FrameRemakeRunOptions = {}) {
    if (action !== "pause" && !isWorkerTokenConfigured()) throw new FrameRemakeError("请先配置生成 Worker，才能自动执行复刻流程", 503);
    return mutateFrameRemake(userId, id, (project) => {
        // A stop request must win over polling/worker revisions and invalidate old workers.
        if (action === "pause") return changedFrameRemake(pausedFrameRemakeProject(project));
        assertFrameRemakeRevision(project, revision);
        if (!project.sourceVideo) throw new FrameRemakeError("请先上传原视频");
        if (project.automation?.status === "running") return project;
        const ready = frameRemakeWorkflowReadiness(project);
        if ((stageScope === "planning" && !ready.analysis) || (stageScope === "images" && !ready.planning) || (stageScope === "production" && !ready.images)) throw new FrameRemakeError("请先完成前一个阶段，再开始本阶段");
        if (options.restartFrom && frameRemakeBusy(project)) throw new FrameRemakeError("请等待当前步骤完成后再开始", 409);
        if (options.groupId && !project.groups.some((g) => g.id === options.groupId)) throw new FrameRemakeError("分组不存在", 404);
        const restartStage = options.restartFrom === "productScript" ? "planning" : options.restartFrom === "images" ? "images" : options.restartFrom === "videoPrompt" ? "production" : "analysis";
        if (options.restartFrom && restartStage !== stageScope) throw new FrameRemakeError("重新生成的步骤与当前阶段不一致");
        if (stageScope !== "analysis" && frameRemakeInputError(project)) throw new FrameRemakeError(frameRemakeInputError(project));
        if (options.restartFrom === "images" && project.groups.filter((g) => !options.groupId || g.id === options.groupId).some((g) => !g.productScript?.trim() || !g.imagePrompt.trim()))
            throw new FrameRemakeError("请先完成新产品脚本和分镜提示词，再开始两步生图");
        // 继续由用户明确发起。仅重置失败步骤，已提交的未知结果继续复用原请求。
        const groups = project.groups.map((original) => {
            if (options.groupId && original.id !== options.groupId) return original;
            let group = original;
            if (options.restartFrom === "images" && group.image.status === "completed") {
                group = { ...resetFrameRemakeAnalysisFrom(group, "videoPrompt"), template: idleFrameRemakeTask(group.template.attemptNo), image: idleFrameRemakeTask(group.image.attemptNo) };
            } else if (options.restartFrom && options.restartFrom !== "images") group = resetFrameRemakeAnalysisFrom(group, options.restartFrom);
            return {
                ...group,
                ...Object.fromEntries(
                    (["template", "image", "video"] as const).map((kind) => [
                        kind,
                        group[kind].status === "queued" ? { ...group[kind], submissionPaused: false } : group[kind].status === "error" && (!stageScope || (stageScope === "images" && kind !== "video") || (stageScope === "production" && kind === "video")) ? idleFrameRemakeTask(group[kind].attemptNo) : group[kind],
                    ]),
                ),
            };
        });
        const now = new Date().toISOString();
        const next = {
            ...project,
            groups,
            error: undefined,
            mergedVideo: options.restartFrom ? undefined : project.mergedVideo,
            automation: {
                id: randomUUID(),
                status: "running" as const,
                mode: action === "step" ? "step" as const : "auto" as const,
                stageScope,
                stopAfterPrompts,
                groupId: options.groupId,
                startedAt: project.automation?.startedAt || now,
                updatedAt: now,
                progress: "开始执行复刻流程",
            },
        };
        // 校验拟执行步骤后才保存重置结果，缺失原文不会清空已完成的内容。
        const step = nextFrameRemakeStep(next);
        if (step?.kind === "inspect") assertFrameRemakeAnalysisPromptReady(next, undefined, "analysis");
        if (step?.kind === "analyze") assertFrameRemakeAnalysisPromptReady(next, step.groupId, step.analysisStage);
        if (step && (step.kind === "template" || step.kind === "image" || step.kind === "video")) {
            const group = next.groups.find((item) => item.id === step.groupId);
            if (group) assertFrameRemakePromptResolved(step.kind === "video" ? frameRemakeVideoPrompt(next, group, 15) : frameRemakeImagePrompt(next, group, step.kind));
        }
        return changedFrameRemake(next);
    });
}

export async function runFrameRemakeAutomationBatch(origin: string) {
    if (!isWorkerTokenConfigured()) return { claimed: 0 };
    const candidates = await listRunnableFrameRemakeProjects();
    let claimed = 0;
    for (const { userId, project: snapshot } of candidates) {
        const leaseId = randomUUID();
        const project = await mutateFrameRemake(userId, snapshot.id, (current) => {
            if (current.automation?.id !== snapshot.automation?.id || current.automation?.status !== "running" || (current.automation.leaseUntil && Date.parse(current.automation.leaseUntil) > Date.now())) return current;
            return changedFrameRemake({ ...current, automation: { ...current.automation, leaseId, leaseUntil: new Date(Date.now() + 30 * 60_000).toISOString() } });
        }).catch(() => undefined);
        if (project?.automation?.leaseId !== leaseId) continue;
        claimed++;
        const finish = (status: "running" | "paused" | "error" | "completed", progress: string, error?: string) =>
            mutateFrameRemake(userId, project.id, (current) => {
                if (current.automation?.id !== project.automation?.id || current.automation?.leaseId !== leaseId) return current;
                return changedFrameRemake({
                    ...current,
                    error: error || current.error,
                    automation: {
                        ...current.automation,
                        status: current.automation.status === "paused" ? "paused" : status,
                        pendingGeneration: status === "running" ? current.automation.pendingGeneration : undefined,
                        leaseId: undefined,
                        leaseUntil: undefined,
                        updatedAt: new Date().toISOString(),
                        progress,
                    },
                });
            });
        try {
            const current = await getFrameRemakeProjectForUser(userId, project.id);
            if (current.automation?.status !== "running") {
                await finish("running", "已暂停");
                continue;
            }
            if (current.error) throw new Error(current.error);
            const review = current.groups.flatMap((group) => [group.template, group.image, group.video]).find((task) => task.error && task.status === "running");
            if (review) throw new Error(review.error);
            if (frameRemakeBusy(current)) {
                // 未确认提交复用同一个请求；后台已创建的任务只查询状态。
                const queued = current.groups.flatMap((group) => (["template", "image", "video"] as const).map((kind) => ({ group, kind }))).find(({ group, kind }) => group[kind].status === "queued");
                if (queued) await submitFrameRemakeGeneration({ userId, projectId: current.id, revision: current.revision, groupId: queued.group.id, kind: queued.kind, automationLeaseId: leaseId, origin, credential: maintenanceWorkerContext(userId) });
                await finish("running", current.operation?.progress || current.automation!.progress);
                continue;
            }
            if (current.automation?.mode === "step" && current.automation.pendingGeneration) {
                const pending = current.automation.pendingGeneration;
                const task = current.groups.find((group) => group.id === pending.groupId)?.[pending.kind];
                if (task?.status !== "completed") throw new Error(task?.error || "本步生成未完成，请检查原任务");
                await finish("paused", "本步已完成并保存，可以执行下一步");
                continue;
            }
            if (current.automation.stageScope && frameRemakeWorkflowReadiness(frameRemakeAutomationView(current))[current.automation.stageScope]) {
                await finish(current.mergedVideo ? "completed" : "paused", current.mergedVideo ? "复刻完成，成片已保存" : "本阶段已完成，请检查结果后进入下一阶段");
                continue;
            }
            const step = nextFrameRemakeStep(current);
            if (!step) {
                await finish("completed", "复刻完成，成片已保存");
                continue;
            }
            if (current.automation.stageScope && step.workflowStage !== current.automation.stageScope) {
                if (!frameRemakeWorkflowReadiness(frameRemakeAutomationView(current))[current.automation.stageScope]) throw new Error("前序阶段尚未完成，请先检查前序结果");
                await finish("paused", "本阶段已完成，请检查结果后进入下一阶段");
                continue;
            }
            if (current.automation.stopAfterPrompts && ["template", "image", "video", "merge"].includes(step.kind)) {
                await finish("paused", "脚本已保存，请审阅后单独开始生成");
                continue;
            }
            const ready = await mutateFrameRemake(userId, current.id, (latest) => {
                if (latest.automation?.status !== "running" || latest.automation.leaseId !== leaseId) throw new Error("后续步骤已暂停");
                return changedFrameRemake({ ...latest, automation: { ...latest.automation, progress: step.label, updatedAt: new Date().toISOString() } });
            });
            if (step.kind === "inspect" || step.kind === "extract" || step.kind === "analyze" || step.kind === "merge") {
                const active = await startFrameRemakeOperation(userId, ready.id, ready.revision, step.kind, step.groupId, leaseId, step.analysisStage);
                await runFrameRemakeOperation({ userId, project: active, origin, credential: maintenanceWorkerContext(userId) });
            } else {
                await mutateFrameRemake(userId, ready.id, (latest) => {
                    if (latest.automation?.status !== "running" || latest.automation.leaseId !== leaseId) throw new Error("后续步骤已暂停");
                    return changedFrameRemake({ ...latest, automation: { ...latest.automation, pendingGeneration: { groupId: step.groupId, kind: step.kind } } });
                });
                const reserved = await getFrameRemakeProjectForUser(userId, ready.id);
                await submitFrameRemakeGeneration({ userId, projectId: ready.id, revision: reserved.revision, groupId: step.groupId!, kind: step.kind, automationLeaseId: leaseId, origin, credential: maintenanceWorkerContext(userId) });
            }
            const latest = await getFrameRemakeProjectForUser(userId, ready.id);
            if (latest.error) throw new Error(latest.error);
            const singleDone = latest.automation?.mode === "step" && !latest.automation.pendingGeneration;
            const stageDone = latest.automation?.stageScope && frameRemakeWorkflowReadiness(frameRemakeAutomationView(latest))[latest.automation.stageScope];
            await finish(
                latest.mergedVideo ? "completed" : singleDone || stageDone ? "paused" : "running",
                latest.mergedVideo ? "复刻完成，成片已保存" : stageDone ? "本阶段已完成，请检查结果后进入下一阶段" : singleDone ? `${step.label}已完成并保存，可以执行下一步` : step.label,
            );
        } catch (error) {
            const message = toSafeGenerationErrorMessage(error, "复刻已停止，请检查当前步骤");
            await finish("error", message, message).catch(() => undefined);
        }
        // 一次只运行一个可执行项目，其他项目在下一轮领取，避免单次调用累积超时。
        break;
    }
    return { claimed };
}
