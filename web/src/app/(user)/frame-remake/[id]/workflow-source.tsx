"use client";
import { Select } from "antd";
import { frameRemakeWorkflowSource, type FrameRemakeProject } from "@/lib/frame-remake-contract";
import { frameRemakeMissingPromptFields } from "@/lib/frame-remake-prompt-templates";
import type { WorkflowProps } from "./workflow-controls";

export function FrameWorkflowSource({ props }: { props: WorkflowProps }) {
    const source = frameRemakeWorkflowSource(props.display);
    const missing = frameRemakeMissingPromptFields(props.display);
    return (
        <section className="shrink-0 space-y-1.5 border-b bg-card px-3 py-2 text-xs" aria-label="飞书原版工作流">
            <div className="flex flex-wrap items-center gap-2">
                <label htmlFor="frame-remake-workflow-source" className="font-medium">飞书工作流</label>
                <Select
                    id="frame-remake-workflow-source"
                    aria-label="选择飞书工作流"
                    className="w-full max-w-80"
                    size="small"
                    value={source}
                    disabled={props.editingDisabled}
                    options={[
                        { value: "product-basic", label: "换品基础流程 · 原文已齐" },
                        { value: "person-basic", label: "跟品换人／背景流程 · 原文已齐" },
                        { value: "combined-original", label: "换品＋指定人物流程 · 原文待补齐", disabled: true },
                    ]}
                    onChange={(workflowSource: NonNullable<FrameRemakeProject["workflowSource"]>) => props.onChange({ workflowSource })}
                />
                <span className="text-muted-foreground">切换后保留视频、分析和拆帧，重新制作后续内容。</span>
            </div>
            <p className="leading-5 text-muted-foreground">
                {source === "product-basic"
                    ? "采用上方“换品_不换人基础版”的原提示词：替换人物手持产品，并重绘出现的人物；不能指定人物或背景。"
                    : source === "person-basic"
                      ? "采用上方“不换品_换人基础版”的原提示词：保留原产品，使用背景参考图，可选人物参考图。"
                      : "此项目沿用换品＋换人流程。部分关键提示词只有模块引用，补齐正文后才能继续生成；可切换到原文完整的基础流程。"}
            </p>
            {missing.length > 0 && <p role="status" className="text-amber-700">缺少原文：{missing.join("、")}。已有结果仍可查看。</p>}
        </section>
    );
}

// 原文尚缺失或输入未齐时，预览不能使整个工作区渲染失败。
export function frameRemakePromptPreview(build: () => string) {
    try {
        return build();
    } catch (error) {
        return error instanceof Error ? error.message : "当前提示词暂不可预览。";
    }
}
