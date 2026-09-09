import type { DramaWorkflowArtifact, DramaWorkflowStage } from "@/lib/drama-workflow-contract";
import type { DramaProject } from "@/lib/drama-project-contract";

export type DramaWorkflowRequest =
    { action: "generate" | "save"; stage: DramaWorkflowStage; episodeId?: string; expectedInput: string; requestId: string; instructions?: string; data?: unknown } | { action: "adopt"; artifactId: string; expectedInput: string };

export type DramaWorkflowResponse = { project: DramaProject; artifact: DramaWorkflowArtifact };
