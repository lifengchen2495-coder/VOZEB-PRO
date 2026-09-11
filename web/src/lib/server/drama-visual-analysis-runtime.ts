import type { DramaVisualAnalysis, DramaVideoPromptAnalysis } from "@/lib/drama-project-contract";
import { normalizeDramaVisualAnalysis } from "@/lib/server/drama-analysis";
import { selectDramaVisualInput, type NormalizedDramaVisualInput } from "@/lib/server/drama-analysis-input";
import { normalizeDramaVideoPromptAnalysis } from "@/lib/server/drama-video-prompt-analysis";
import type { DramaSkillReport } from "@/lib/drama-skill-contract";
import { mergeDramaSkillReports } from "@/lib/server/drama-skill-analysis";

type VisualBatchResponse<TCall> = {
    value: unknown;
    call: TCall;
};

type VisualBatchRuntime<TCall> = {
    input: NormalizedDramaVisualInput;
    requestBatch: (input: NormalizedDramaVisualInput) => Promise<VisualBatchResponse<TCall>>;
    releaseCall: (call: TCall) => Promise<unknown>;
    shouldSplitError: (error: unknown) => boolean;
};

export async function analyzeDramaVisualBatches<TCall>(runtime: VisualBatchRuntime<TCall>): Promise<{ data: DramaVisualAnalysis; calls: TCall[] }> {
    return analyzeDramaShotBatches(runtime, normalizeDramaVisualAnalysis);
}

export async function analyzeDramaVideoPromptBatches<TCall>(runtime: VisualBatchRuntime<TCall>): Promise<{ data: DramaVideoPromptAnalysis; calls: TCall[] }> {
    return analyzeDramaShotBatches(runtime, normalizeDramaVideoPromptAnalysis);
}

async function analyzeDramaShotBatches<TCall, TShot extends { shotId: string }>(runtime: VisualBatchRuntime<TCall>, normalize: (value: unknown, shotIds: string[]) => { shots: TShot[]; skill?: DramaSkillReport }): Promise<{ data: { shots: TShot[]; skill?: DramaSkillReport }; calls: TCall[] }> {
    const acceptedCalls: TCall[] = [];
    const reports: DramaSkillReport[] = [];
    try {
        const shots = await analyzeBatch(runtime.input);
        const byId = new Map(shots.map((shot) => [shot.shotId, shot]));
        const skill = mergeDramaSkillReports(reports);
        return { data: { shots: runtime.input.shotIds.flatMap((shotId) => (byId.has(shotId) ? [byId.get(shotId)!] : [])), ...(skill ? { skill } : {}) }, calls: acceptedCalls };
    } catch (error) {
        for (const call of acceptedCalls) await runtime.releaseCall(call);
        throw error;
    }

    async function analyzeBatch(input: NormalizedDramaVisualInput): Promise<TShot[]> {
        let response: VisualBatchResponse<TCall>;
        try {
            response = await runtime.requestBatch(input);
        } catch (error) {
            if (input.shotIds.length <= 1 || !runtime.shouldSplitError(error)) throw error;
            return analyzeHalves(input);
        }

        const normalized = normalize(response.value, input.shotIds);
        if (!normalized.shots.length) {
            await runtime.releaseCall(response.call);
            if (input.shotIds.length <= 1) throw new Error(`模型没有为镜头 ${input.shotIds[0]} 返回视觉结构`);
            return analyzeHalves(input);
        }

        acceptedCalls.push(response.call);
        if (normalized.skill) reports.push(normalized.skill);
        const returnedIds = new Set(normalized.shots.map((shot) => shot.shotId));
        const missingIds = input.shotIds.filter((shotId) => !returnedIds.has(shotId));
        if (!missingIds.length) return normalized.shots;
        return [...normalized.shots, ...(await analyzeBatch(selectDramaVisualInput(input, missingIds)))];
    }

    async function analyzeHalves(input: NormalizedDramaVisualInput) {
        const middle = Math.ceil(input.shotIds.length / 2);
        const left = await analyzeBatch(selectDramaVisualInput(input, input.shotIds.slice(0, middle)));
        const right = await analyzeBatch(selectDramaVisualInput(input, input.shotIds.slice(middle)));
        return [...left, ...right];
    }
}
