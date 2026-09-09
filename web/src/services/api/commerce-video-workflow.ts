"use client";

import type { CommerceVideoWorkflow, CommerceVideoWorkflowInput } from "@/lib/commerce-video-workflow";
import { refreshUserPointsIfSystem } from "@/services/api/points";
import { throwIfClientSessionExpired } from "@/services/api/session-expiration";

export type CommerceVideoWorkflowResult = {
    workflow: CommerceVideoWorkflow;
    skill: { id: string; name: string; instructionsHash?: string };
    modelId: string;
    generatedAt: string;
};

export async function generateCommerceVideoWorkflow(input: CommerceVideoWorkflowInput, signal?: AbortSignal): Promise<CommerceVideoWorkflowResult> {
    try {
        const response = await fetch("/api/commerce/video/workflow", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(input),
            signal,
        });
        throwIfClientSessionExpired(response);
        const payload = await response.json().catch(() => null) as { data?: CommerceVideoWorkflowResult; msg?: string } | null;
        if (!response.ok || !payload?.data?.workflow) throw new Error(payload?.msg || "视频流程生成失败，请重试");
        return payload.data;
    } finally {
        void refreshUserPointsIfSystem("system");
    }
}
