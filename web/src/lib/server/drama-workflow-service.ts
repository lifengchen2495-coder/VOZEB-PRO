import { createHash } from "node:crypto";

import type { DramaProject } from "@/lib/drama-project-contract";
import { adoptDramaWorkflowArtifact, appendDramaWorkflowArtifact, createDramaWorkflowArtifact, DRAMA_WORKFLOW_STAGES, DramaWorkflowError, dramaWorkflowFingerprint } from "@/lib/drama-workflow";
import type { DramaWorkflowRequest, DramaWorkflowResponse } from "@/lib/drama-workflow-request";
import type { DramaWorkflowStage } from "@/lib/drama-workflow-contract";
import { getDramaProjectForUser } from "@/lib/server/drama-project-service";
import { DramaProjectStoreError, updateDramaProject } from "@/lib/server/drama-project-store";
import { createDramaProjectVersion } from "@/lib/server/drama-project-version-store";

type Generation = { data: unknown; headers?: Headers; refund: () => Promise<unknown> };

export function parseDramaWorkflowRequest(value: unknown): DramaWorkflowRequest {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new DramaWorkflowError("创作请求格式无效");
    const input = value as Record<string, unknown>;
    if (typeof input.expectedInput !== "string" || !input.expectedInput || input.expectedInput.length > 256) throw new DramaWorkflowError("缺少当前创作版本，请刷新后重试");
    if (input.action === "adopt") {
        if (typeof input.artifactId !== "string" || !input.artifactId || input.artifactId.length > 200) throw new DramaWorkflowError("请选择候选稿");
        return { action: "adopt", artifactId: input.artifactId, expectedInput: input.expectedInput };
    }
    if (input.action !== "generate" && input.action !== "save") throw new DramaWorkflowError("创作操作无效");
    if (!DRAMA_WORKFLOW_STAGES.includes(input.stage as never)) throw new DramaWorkflowError("创作阶段无效");
    if (typeof input.requestId !== "string" || !/^[\w:-]{1,150}$/.test(input.requestId)) throw new DramaWorkflowError("请求编号无效");
    if (input.instructions !== undefined && (typeof input.instructions !== "string" || input.instructions.length > 10000)) throw new DramaWorkflowError("补充要求不能超过 10000 字");
    if (input.episodeId !== undefined && (typeof input.episodeId !== "string" || input.episodeId.length > 200)) throw new DramaWorkflowError("剧集编号无效");
    return {
        action: input.action,
        stage: input.stage as DramaWorkflowStage,
        episodeId: input.episodeId as string | undefined,
        expectedInput: input.expectedInput,
        requestId: input.requestId,
        instructions: input.instructions as string | undefined,
        data: input.data,
    };
}

export async function runDramaWorkflowAction(userId: string, projectId: string, input: DramaWorkflowRequest, generate: (project: DramaProject, requestId: string) => Promise<Generation>): Promise<DramaWorkflowResponse & { headers?: Headers }> {
    const key = createHash("sha256")
        .update(JSON.stringify([userId, projectId, input]))
        .digest("hex");
    const pending = inFlight.get(key);
    if (pending) return pending;
    const operation = executeDramaWorkflowAction(userId, projectId, input, generate);
    inFlight.set(key, operation);
    try {
        return await operation;
    } finally {
        if (inFlight.get(key) === operation) inFlight.delete(key);
    }
}

const inFlight = new Map<string, Promise<DramaWorkflowResponse & { headers?: Headers }>>();

async function executeDramaWorkflowAction(userId: string, projectId: string, input: DramaWorkflowRequest, generate: (project: DramaProject, requestId: string) => Promise<Generation>): Promise<DramaWorkflowResponse & { headers?: Headers }> {
    const snapshot = await getDramaProjectForUser(userId, projectId);
    if (input.action === "adopt") {
        const artifact = snapshot.workflow?.artifacts.find((item) => item.id === input.artifactId);
        if (!artifact) throw new DramaWorkflowError("候选稿不存在", 409);
        if (artifact.status === "adopted") return { project: adoptDramaWorkflowArtifact(snapshot, artifact.id), artifact };
        if (input.expectedInput !== dramaWorkflowFingerprint(snapshot, artifact.stage, artifact.episodeId)) throw new DramaWorkflowError("创作内容已更新，请刷新候选稿后再采用", 409);
        const next = adoptDramaWorkflowArtifact(snapshot, artifact.id);
        if (next === snapshot) return { project: snapshot, artifact };
        await createDramaProjectVersion(userId, projectId, "采用创作稿前", snapshot);
        const saved = await save(userId, next, snapshot.updatedAt);
        return { project: saved, artifact: saved.workflow!.artifacts.find((item) => item.id === artifact.id)! };
    }
    const id = `workflow-${createHash("sha256")
        .update(JSON.stringify([projectId, input.action, input.requestId, input.stage, input.episodeId, input.expectedInput, input.instructions, input.data]))
        .digest("hex")
        .slice(0, 40)}`;
    const existing = snapshot.workflow?.artifacts.find((artifact) => artifact.id === id);
    if (existing) return { project: snapshot, artifact: existing };
    if (input.expectedInput !== dramaWorkflowFingerprint(snapshot, input.stage, input.episodeId)) throw new DramaWorkflowError("创作内容已更新，请同步后重试", 409);
    const result: Generation = input.action === "generate" ? await generate(snapshot, id) : { data: input.data, refund: async () => undefined };
    try {
        const artifact = { ...createDramaWorkflowArtifact(snapshot, { ...input, data: result.data, source: input.action === "generate" ? "ai" : "manual" }), id };
        for (let attempt = 0; attempt < 3; attempt++) {
            const current = await getDramaProjectForUser(userId, projectId);
            const duplicate = current.workflow?.artifacts.find((item) => item.id === id);
            if (duplicate) {
                await result.refund();
                return { project: current, artifact: duplicate };
            }
            try {
                const next = appendDramaWorkflowArtifact(current, artifact);
                const saved = await save(userId, next, current.updatedAt);
                return { project: saved, artifact: saved.workflow!.artifacts.find((item) => item.id === id)!, headers: result.headers };
            } catch (error) {
                if (!(error instanceof DramaProjectStoreError && error.status === 409) || attempt === 2) throw error;
            }
        }
        throw new DramaWorkflowError("项目正在更新，候选稿保存失败，请重试", 409);
    } catch (error) {
        await result.refund();
        throw error;
    }
}

function save(userId: string, project: DramaProject, expectedUpdatedAt: string) {
    if (Buffer.byteLength(JSON.stringify(project), "utf8") > 2 * 1024 * 1024) throw new DramaWorkflowError("项目内容超过 2 MB，请精简后重试");
    const updatedAt = new Date(Math.max(Date.now(), Date.parse(expectedUpdatedAt) + 1)).toISOString();
    return updateDramaProject(userId, { ...project, updatedAt }, expectedUpdatedAt);
}
