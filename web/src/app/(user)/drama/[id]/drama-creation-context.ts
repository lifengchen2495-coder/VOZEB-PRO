import type { DramaProject } from "@/lib/drama-project-contract";
import { dramaWorkflowArtifactIsStale, dramaWorkflowInput, latestDramaWorkflowArtifact } from "@/lib/drama-workflow";

export function dramaCreationContext(project: DramaProject, episodeId: string): Record<string, unknown> {
    const script = latestDramaWorkflowArtifact(project, "script", episodeId, "adopted", "creation");
    return {
        ...dramaWorkflowInput(project, "script", episodeId, "creation"),
        detailedScript: script && !dramaWorkflowArtifactIsStale(project, script) ? script.data : undefined,
    };
}
