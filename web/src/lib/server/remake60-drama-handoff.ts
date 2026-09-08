import type { DramaCharacter, DramaProject, DramaShot, DramaSourceAsset } from "@/lib/drama-project-contract";
import type { RemakeCopyBlock, RemakeFrame, RemakeProject } from "@/lib/server/remake60-project-contract";
import { createDramaProjectForUser, DramaProjectServiceError, updateDramaProjectForUser } from "@/lib/server/drama-project-service";
import { findDramaProjectBySourceHandoffId } from "@/lib/server/drama-project-store";
import { getRemakeProjectForUser } from "@/lib/server/remake60-project-service";

const MAX_HANDOFF_ATTEMPTS = 4;

export class RemakeDramaHandoffError extends Error {
    constructor(
        message: string,
        readonly status: number,
    ) {
        super(message);
        this.name = "RemakeDramaHandoffError";
    }
}

export async function handoffRemakeProjectToDrama(userId: string, projectId: string) {
    const project = await getRemakeProjectForUser(userId, projectId);
    assertHandoffReady(project);

    const sourceHandoffId = `remake60-${project.id}`;
    const input = buildRemakeDramaCreateInput(project, sourceHandoffId);
    let candidate = await findDramaProjectBySourceHandoffId(userId, sourceHandoffId);

    for (let attempt = 0; attempt < MAX_HANDOFF_ATTEMPTS; attempt += 1) {
        if (candidate && isPopulatedHandoff(candidate)) return handoffResult(candidate);

        if (!candidate) {
            try {
                candidate = await createDramaProjectForUser(userId, input);
            } catch (error) {
                const recovered = await findDramaProjectBySourceHandoffId(userId, sourceHandoffId).catch(() => null);
                if (!recovered) throwHandoffError(error);
                candidate = recovered;
            }
        }
        if (candidate && isPopulatedHandoff(candidate)) return handoffResult(candidate);

        try {
            const saved = await updateDramaProjectForUser(userId, candidate.id, populateDramaProject(candidate, project));
            if (isPopulatedHandoff(saved)) return handoffResult(saved);
            candidate = (await findDramaProjectBySourceHandoffId(userId, sourceHandoffId).catch(() => null)) || saved;
        } catch (error) {
            const recovered = await findDramaProjectBySourceHandoffId(userId, sourceHandoffId).catch(() => null);
            if (recovered && isPopulatedHandoff(recovered)) return handoffResult(recovered);
            if (!recovered || !isConflict(error)) throwHandoffError(error);
            candidate = recovered;
        }
    }

    const recovered = await findDramaProjectBySourceHandoffId(userId, sourceHandoffId).catch(() => null);
    if (recovered && isPopulatedHandoff(recovered)) return handoffResult(recovered);
    throw new RemakeDramaHandoffError("短剧交接状态已变化，请重试", 409);
}

export function buildRemakeDramaCreateInput(project: RemakeProject, sourceHandoffId = `remake60-${project.id}`) {
    const script = project.copyBlocks.map(resolveCopyText).filter(Boolean).join("\n\n");
    return {
        sourceHandoffId,
        title: project.title,
        summary: `由电商视频复刻项目“${project.title}”交接，共 ${project.copyBlocks.length} 个生产区间。`,
        style: "写实电商广告",
        ratio: resolveDramaRatio(project),
        initialScript: script || project.sourceCopy,
        defaultVideoMode: "storyboard" as const,
        sourceAssets: buildSourceAssets(project),
    };
}

export function buildRemakeDramaShots(project: RemakeProject): DramaShot[] {
    const framesByOrdinal = new Map(project.frames.map((frame) => [frame.ordinal, frame]));
    return project.copyBlocks.map((block, index) => {
        const frames = block.frameOrdinals.map((ordinal) => framesByOrdinal.get(ordinal)).filter((frame): frame is RemakeFrame => Boolean(frame));
        const first = frames[0];
        const last = frames.at(-1);
        if (!first?.frameUrl || !last?.frameUrl) throw new RemakeDramaHandoffError(`第 ${block.ordinal} 个文案区间缺少可用抽帧`, 409);
        return buildShot(project, block, frames, first, last, index);
    });
}

function populateDramaProject(created: DramaProject, project: RemakeProject): DramaProject {
    const episode = created.episodes[0];
    const voiceover = project.voice !== "source";
    const characters: DramaCharacter[] = voiceover ? [narratorCharacter(project.voice), ...created.characters.filter((item) => item.name !== "旁白")] : created.characters;
    return {
        ...created,
        summary: buildRemakeDramaCreateInput(project).summary,
        style: "写实电商广告",
        ratio: resolveDramaRatio(project),
        characters,
        defaultVideoMode: "storyboard",
        activeEpisodeId: episode.id,
        sourceAssets: buildSourceAssets(project),
        episodes: [
            {
                ...episode,
                title: "复刻生产稿",
                script: project.copyBlocks.map(resolveCopyText).filter(Boolean).join("\n\n") || project.sourceCopy,
                outline: "按原视频 48 个抽帧单元组织为 16 个连续生产区间。",
                sourceRange: "电商视频复刻分析结果",
                reviewStatus: "visual_ready",
                shots: buildRemakeDramaShots(project),
            },
        ],
        updatedAt: nextHandoffTimestamp(created.updatedAt),
    };
}

function buildShot(project: RemakeProject, block: RemakeCopyBlock, frames: RemakeFrame[], first: RemakeFrame, last: RemakeFrame, index: number): DramaShot {
    const copy = resolveCopyText(block);
    const descriptions = uniqueText(frames.map((frame) => frame.description));
    const sellingPoints = uniqueText(frames.map((frame) => frame.sellingPoint));
    const shotTypes = uniqueText(frames.map((frame) => frame.shotType));
    const visualFacts = [descriptions.length ? `画面：${descriptions.join("；")}` : "", sellingPoints.length ? `卖点：${sellingPoints.join("；")}` : "", shotTypes.length ? `镜头：${shotTypes.join("、")}` : ""].filter(Boolean).join("。 ");
    const voiceover = project.voice !== "source";
    const duration = Math.max(1, Math.round(Math.max(block.endTime, last.endTime, last.time) - Math.min(block.startTime, first.time)));
    return {
        id: `remake60-shot-${project.id}-${block.ordinal}`,
        order: index + 1,
        title: `复刻区间 ${String(index + 1).padStart(2, "0")}`,
        description: visualFacts || "沿用原视频抽帧的主体、构图和节奏。",
        sourceText: block.sourceText || copy,
        shotBoundary: `${formatSeconds(block.startTime)} - ${formatSeconds(block.endTime)}`,
        dialogue: "",
        narration: voiceover ? copy : "",
        utterances: copy ? [{ id: `remake60-utterance-${project.id}-${block.ordinal}`, order: 1, type: "voiceover", speaker: voiceover ? "旁白" : "", text: copy }] : [],
        imagePrompt: visualFacts || "保持参考帧中的主体、构图、光线与商品细节。",
        videoPrompt: [visualFacts, copy ? `字幕文案：${copy}` : "", "以起止参考帧为准，保持主体和商品细节连续。"].filter(Boolean).join("\n"),
        cameraMotion: shotTypes.join("、") || "保持原镜头节奏",
        startFramePrompt: first.description || undefined,
        endFramePrompt: last.description || undefined,
        continuity: undefined,
        duration,
        characterIds: voiceover ? ["remake60-narrator"] : [],
        propIds: [],
        clueIds: [],
        videoMode: "storyboard",
        storyboardFrameMode: "first_last",
        storyboardStatus: "success",
        storyboardImageUrl: first.frameUrl,
        storyboardImageWidth: project.sourceVideo?.width,
        storyboardImageHeight: project.sourceVideo?.height,
        storyboardEndStatus: "success",
        storyboardEndImageUrl: last.frameUrl,
        storyboardEndImageWidth: project.sourceVideo?.width,
        storyboardEndImageHeight: project.sourceVideo?.height,
        subtitle: copy || undefined,
        audioMode: voiceover ? "voiceover" : "source",
    };
}

function buildSourceAssets(project: RemakeProject): DramaSourceAsset[] {
    const assets: DramaSourceAsset[] = [];
    if (project.sourceVideo?.url) {
        assets.push({
            id: `remake60-source-video-${project.id}`,
            type: "video",
            title: project.sourceVideo.originalName || "复刻原视频",
            storageKey: project.sourceVideo.storageKey,
            serverUrl: project.sourceVideo.url,
            mimeType: project.sourceVideo.mimeType,
            width: project.sourceVideo.width,
            height: project.sourceVideo.height,
        });
    }
    if (project.sourceCopy.trim()) assets.push({ id: `remake60-source-copy-${project.id}`, type: "text", title: "原文案", textContent: project.sourceCopy });
    return assets;
}

function narratorCharacter(voice: RemakeProject["voice"]): DramaCharacter {
    return {
        id: "remake60-narrator",
        name: "旁白",
        description: voice === "female" ? "电商视频女性旁白" : "电商视频男性旁白",
        voiceProfile: {
            voice: "",
            speed: 1,
            instructions: voice === "female" ? "使用自然、清晰、有亲和力的女性声线，准确传达商品卖点。" : "使用自然、清晰、沉稳的男性声线，准确传达商品卖点。",
        },
        references: [],
    };
}

function assertHandoffReady(project: RemakeProject) {
    if (!project.sourceVideo?.url) throw new RemakeDramaHandoffError("请先上传原视频", 409);
    if (project.frames.length !== 48) throw new RemakeDramaHandoffError("请先完成 48 帧抽取", 409);
    if (project.copyBlocks.length !== 16) throw new RemakeDramaHandoffError("请先生成 16 个文案区间", 409);
}

function resolveCopyText(block: RemakeCopyBlock) {
    return (block.text || block.sourceText || "").trim();
}

function resolveDramaRatio(project: RemakeProject) {
    const ratio = project.sourceVideo?.ratio?.trim();
    if (ratio === "9:16" || ratio === "16:9" || ratio === "1:1") return ratio;
    const width = project.sourceVideo?.width || 0;
    const height = project.sourceVideo?.height || 0;
    if (width && height) {
        if (Math.abs(width - height) / Math.max(width, height) < 0.08) return "1:1";
        return width > height ? "16:9" : "9:16";
    }
    return "9:16";
}

function uniqueText(values: string[]) {
    return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function formatSeconds(value: number) {
    return `${Math.max(0, Number(value) || 0).toFixed(2)}s`;
}

function isPopulatedHandoff(project: DramaProject | null | undefined) {
    return Boolean(project?.episodes.some((episode) => episode.shots.length > 0));
}

function isConflict(error: unknown) {
    return Boolean(error && typeof error === "object" && "status" in error && Number((error as { status?: unknown }).status) === 409);
}

function throwHandoffError(error: unknown): never {
    if (error instanceof RemakeDramaHandoffError) throw error;
    if (error instanceof DramaProjectServiceError) throw new RemakeDramaHandoffError(error.message, error.status);
    if (error && typeof error === "object" && "status" in error && Number.isInteger(Number((error as { status?: unknown }).status))) {
        const status = Number((error as { status?: unknown }).status);
        const message = error instanceof Error ? error.message : "短剧交接失败";
        throw new RemakeDramaHandoffError(message, status);
    }
    throw error;
}

function nextHandoffTimestamp(value: string) {
    const previous = Date.parse(value);
    return new Date(Math.max(Date.now(), Number.isFinite(previous) ? previous + 1 : 0)).toISOString();
}

function handoffResult(project: DramaProject) {
    return { projectId: project.id, href: `/drama/${project.id}`, project };
}
