import type { DramaVideoPromptAnalysis } from "@/lib/drama-project-contract";
import { normalizeDramaSkillReport } from "@/lib/drama-skill-contract";

export const dramaVideoPromptTool = {
    name: "design_drama_video_prompts",
    description: "按已审核镜头生成视频提示词",
    parameters: {
        type: "object",
        properties: { shots: { type: "array", items: { type: "object", properties: { shotId: { type: "string" }, videoPrompt: { type: "string" } }, required: ["shotId", "videoPrompt"], additionalProperties: false } } },
        required: ["shots"],
        additionalProperties: false,
    },
};

export function normalizeDramaVideoPromptAnalysis(value: unknown, shotIds: string[]): DramaVideoPromptAnalysis {
    const source = value && typeof value === "object" && "shots" in value && Array.isArray(value.shots) ? value.shots : [];
    const allowed = new Set(shotIds);
    const seen = new Set<string>();
    const skill = normalizeDramaSkillReport(value && typeof value === "object" && "skill" in value ? value.skill : undefined);
    return {
        ...(skill ? { skill } : {}),
        shots: source.flatMap((value: unknown) => {
            if (!value || typeof value !== "object" || !("shotId" in value) || !("videoPrompt" in value)) return [];
            const shotId = typeof value.shotId === "string" ? value.shotId.trim() : "";
            const videoPrompt = typeof value.videoPrompt === "string" ? value.videoPrompt.trim() : "";
            if (!allowed.has(shotId) || seen.has(shotId) || !videoPrompt) return [];
            seen.add(shotId);
            return [{ shotId, videoPrompt }];
        }),
    };
}
