import type { DramaEpisode, DramaProject, DramaVideoPromptAnalysis } from "@/lib/drama-project-contract";

export const DRAMA_DEFAULT_VIDEO_PROMPT_INSTRUCTIONS = `你是影视动态镜头导演。依据已审核的剧本、人物与场景设定，为每个镜头编写可直接用于视频生成的 videoPrompt。
描述人物的动作起点、动作过程和结束状态，明确景别、机位、构图、镜头运动、人物站位与视线、屏幕运动方向、轴线和节奏。
保持人物外观与服装、道具、空间、光线及前后镜头的动作和视线连续；已有起始帧、结束帧与连续性设定是画面依据。
将动作安排在输入的镜头时长内，不增删镜头或改变已审核的剧情、人物、场景、对白和旁白。对白与旁白逐句保留，说话人与声音要求明确。
使用具体、可拍摄的中文描述，避免抽象口号，不加入未经提供的情节或产品事实。`;

export function dramaVideoPromptInstructions(value?: string) {
    return value?.trim() || DRAMA_DEFAULT_VIDEO_PROMPT_INSTRUCTIONS;
}

export function dramaVideoPromptInput(project: DramaProject, episode: DramaEpisode) {
    return {
        summary: project.summary,
        style: project.style,
        ratio: project.ratio,
        sourceScript: episode.script,
        adoptedWorkflow: project.workflow?.artifacts.filter((item) => item.status === "adopted" && (!item.episodeId || item.episodeId === episode.id)),
        videoPromptInstructions: project.videoPromptInstructions,
        episode: { id: episode.id, title: episode.title, outline: episode.outline, hook: episode.hook, nextPreview: episode.nextPreview, sourceRange: episode.sourceRange, storyboardSkill: episode.storyboardSkill },
        characters: project.characters,
        scenes: project.scenes,
        props: project.props,
        clues: project.clues,
        shots: episode.shots,
    };
}

export function dramaEpisodeHasActiveMedia(episode: DramaEpisode) {
    return (
        episode.renderTask?.status === "pending" ||
        episode.renderTask?.status === "running" ||
        episode.shots.some((shot) => [shot.storyboardStatus, shot.storyboardEndStatus, shot.generationStatus, shot.audioStatus].some((status) => status === "queued" || status === "running"))
    );
}

export function applyDramaVideoPromptAnalysis(episode: DramaEpisode, analysis: DramaVideoPromptAnalysis): DramaEpisode {
    const prompts = new Map(analysis.shots.map((shot) => [shot.shotId, shot.videoPrompt.trim()]));
    if (prompts.size !== episode.shots.length || episode.shots.some((shot) => !prompts.get(shot.id))) throw new Error("视频提示词未覆盖全部镜头，请重新生成");
    return {
        ...episode,
        seedanceSkill: analysis.skill,
        renderTask: undefined,
        visualReview: undefined,
        shots: episode.shots.map((shot) => ({
            ...shot,
            videoPrompt: prompts.get(shot.id)!,
            generationStatus: "idle",
            generationAttempt: (shot.generationAttempt || 0) + 1,
            generationTaskId: undefined,
            generationError: undefined,
            videoUrl: undefined,
            audioStatus: "idle",
            audioAttempt: (shot.audioAttempt || 0) + 1,
            audioTaskId: undefined,
            audioError: undefined,
            audioUrl: undefined,
        })),
    };
}
