export type DramaAnalysisTaskStatus = "pending" | "running" | "success" | "error" | "cancelled";

export type DramaAnalysisTask = {
    id: string;
    status: DramaAnalysisTaskStatus;
    result?: unknown;
    error?: string;
    createdAt: number;
    updatedAt: number;
};
