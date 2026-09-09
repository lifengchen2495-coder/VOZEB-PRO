import type { DramaWorkflowArtifact, DramaWorkflowIntent, DramaWorkflowStage } from "@/lib/drama-workflow-contract";
import type { DramaProject } from "@/lib/drama-project-contract";

export type DramaWorkflowRequest =
    | { action: "generate" | "save"; stage: DramaWorkflowStage; intent?: DramaWorkflowIntent; episodeId?: string; expectedInput: string; requestId: string; instructions?: string; data?: unknown }
    | { action: "analyze"; stage: Exclude<DramaWorkflowStage, "script">; intent?: "analysis"; episodeId?: string; expectedInput: string; requestId: string; instructions?: string; data?: never }
    | { action: "adopt"; artifactId: string; expectedInput: string };

export type DramaWorkflowResponse = { project: DramaProject; artifact: DramaWorkflowArtifact };
