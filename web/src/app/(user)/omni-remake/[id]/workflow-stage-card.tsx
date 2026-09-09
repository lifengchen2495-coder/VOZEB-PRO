"use client";

import { useEffect, useState } from "react";
import { Check, Copy, Download, Play, RotateCcw, Save } from "lucide-react";
import { VideoPromptInstructionEditor } from "@/components/video-prompt-instruction-editor";
import type { OmniProject, OmniWorkflowStage } from "@/lib/omni-remake-contract";
import { OMNI_STAGE_OUTPUT_LIMIT, omniDefaultStageInstructions, omniStageLabel, omniStageOutput, omniStagePrerequisite } from "@/lib/omni-remake-workflow";
import { Button, Textarea } from "../controls";

type Props = {
    stage: OmniWorkflowStage;
    step: number;
    project: OmniProject;
    draftProject: OmniProject;
    disabled: boolean;
    settingsDirty: boolean;
    otherOutputDirty: boolean;
    anyOutputDirty: boolean;
    onEditedChange: (stage: OmniWorkflowStage, dirty: boolean) => void;
    onInstructionsChange: (value: string) => void;
    onSaveInstructions: () => Promise<void>;
    onGenerate: () => Promise<void>;
    onSaveOutput: (value: string) => Promise<string | undefined>;
    onDownloadAnalysis: () => Promise<void>;
};

const descriptions: Record<OmniWorkflowStage, string> = {
    analysis: "分析原视频的时间段、人物、口型和音频，直接生成可查看、修改和下载的 JSON。",
    analysisText: "把分析 JSON 整理为易读的视频拆解，保留片段时间和音频判断。",
    materialAnalysis: "分析上传的产品、人物与背景参考图，确定替换对象、素材编号和使用方式。",
    plan: "结合原视频分析、目标素材和补充要求，生成整体替换计划。",
    classification: "按镜头中的人物、产品、背景及音频策略分类，确定哪些片段共用同一组提示词。",
    promptSummary: "根据分类汇总英文提示词，将各组提示词对应到每个片段。",
    promptTranslation: "逐组翻译英文提示词，生成与英文对应的中文提示词。",
};

const customInstruction = (project: OmniProject, stage: OmniWorkflowStage) => project.stageInstructions?.[stage] ?? (stage === "promptSummary" ? project.videoPromptInstructions : undefined);

export function OmniWorkflowStageCard({ stage, step, project, draftProject, disabled, settingsDirty, otherOutputDirty, anyOutputDirty, onEditedChange, onInstructionsChange, onSaveInstructions, onGenerate, onSaveOutput, onDownloadAnalysis }: Props) {
    const output = omniStageOutput(project, stage);
    const [value, setValue] = useState(output);
    const [notice, setNotice] = useState("");
    const edited = value !== output;
    const outputReadOnly = stage === "promptSummary" || stage === "promptTranslation";
    const label = omniStageLabel(stage);
    const prerequisite = omniStagePrerequisite(draftProject, stage);
    const model = stage === "analysis" ? draftProject.modelSelection.analysis : draftProject.modelSelection.prompt;
    const instructions = customInstruction(draftProject, stage);
    const instructionsDirty = (instructions || "").trim() !== (customInstruction(project, stage) || "").trim();
    const defaultInstructions = omniDefaultStageInstructions(stage);
    const instructionText = instructions?.trim() ? instructions : defaultInstructions;
    const invalidInstructions = !instructionText.trim() || instructionText.length > 50_000;
    const exportDisabled = disabled || settingsDirty || anyOutputDirty || !output.trim();
    const generationDisabled = disabled || anyOutputDirty || Boolean(prerequisite) || !model || invalidInstructions;

    useEffect(() => {
        onEditedChange(stage, edited);
        return () => onEditedChange(stage, false);
    }, [stage, edited, onEditedChange]);

    const run = async (action: () => Promise<void>) => {
        setNotice("");
        try { await action(); }
        catch (reason) { setNotice(reason instanceof Error ? reason.message : "操作失败，请重试"); }
    };
    const download = async () => {
        if (stage === "analysis") return onDownloadAnalysis();
        const url = URL.createObjectURL(new Blob([output], { type: "text/plain;charset=utf-8" }));
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = `${step}-${label}.txt`;
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 30_000);
    };

    return (
        <details open={stage === "analysis"} className="min-w-0 rounded-xl border bg-background p-4 sm:p-5">
            <summary className="cursor-pointer text-base font-medium">
                <span>{step}. {label}</span>
                <span className="ml-3 inline-flex items-center gap-1 text-xs font-normal text-muted-foreground">{edited ? "结果未采用" : instructionsDirty ? "指令未保存" : output ? <><Check className="size-3" />已保存结果</> : "待生成"}</span>
            </summary>
            <div className="mt-4 min-w-0 space-y-4">
                <p className="text-sm leading-6 text-muted-foreground">{descriptions[stage]}</p>
                <div className="flex flex-wrap items-center gap-3">
                    <Button disabled={generationDisabled} onClick={() => void run(onGenerate)}>
                        <Play className="mr-2 size-4" />
                        {stage === "analysis" ? output ? "重新分析视频，生成 JSON" : "分析视频，生成 JSON" : `${output ? "重新生成" : "生成"}${label.replace(/^生成/, "")}`}
                    </Button>
                    {settingsDirty && !anyOutputDirty && <span className="text-xs text-muted-foreground">生成前会先保存当前素材、模型和指令。</span>}
                </div>
                {prerequisite && <p className="text-xs leading-6 text-muted-foreground">{prerequisite}</p>}
                {!model && <p className="text-xs text-muted-foreground">请在上方选择本阶段使用的模型。</p>}
                {output && <p className="text-xs leading-6 text-muted-foreground">重新生成或采用修改会更新本阶段结果，并清除依赖它的后续内容。</p>}
                <details className="rounded-lg border p-3 sm:p-4">
                    <summary className="cursor-pointer text-sm">查看和修改生成指令 · {instructions?.trim() ? "自定义指令" : "飞书默认指令"}{instructionsDirty ? "（未保存）" : ""}</summary>
                    <div className="mt-3 min-w-0">
                        {stage !== "promptSummary" && stage !== "promptTranslation" ? <div className="space-y-3">
                            <p className="text-xs leading-6 text-muted-foreground">以下全文用于生成本阶段结果。修改后保存并重新生成即可生效；清空或恢复默认会采用飞书原始指令。</p>
                            <Textarea aria-label={`${label}生成指令全文`} value={instructionText} disabled={disabled || anyOutputDirty} maxLength={50_000} onChange={(event) => onInstructionsChange(event.target.value)} className="min-h-64 font-mono text-[13px] leading-6" />
                            <p className="text-xs text-muted-foreground">{instructionText.length.toLocaleString("zh-CN")} / 50,000 字</p>
                            <div className="flex flex-wrap gap-2">
                                <Button size="sm" variant="outline" onClick={() => void run(async () => { await navigator.clipboard.writeText(instructionText); setNotice("已复制生成指令"); })}><Copy className="mr-2 size-3" />复制指令</Button>
                                <Button size="sm" variant="outline" disabled={disabled || anyOutputDirty || !instructionsDirty || invalidInstructions} onClick={() => void run(onSaveInstructions)}><Save className="mr-2 size-3" />保存生成指令</Button>
                                <Button size="sm" variant="ghost" disabled={disabled || anyOutputDirty || !instructions?.trim()} onClick={() => onInstructionsChange("")}><RotateCcw className="mr-2 size-3" />恢复默认</Button>
                            </div>
                        </div> : <VideoPromptInstructionEditor
                            label={`${label}生成指令`}
                            defaultText={defaultInstructions}
                            value={instructions}
                            disabled={disabled || anyOutputDirty}
                            dirty={instructionsDirty}
                            hasOutput={Boolean(output)}
                            onChange={onInstructionsChange}
                            onSave={onSaveInstructions}
                        />}
                    </div>
                </details>
                <div className="space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <h3 className="text-sm font-medium">{stage === "analysis" ? "视频分析 JSON" : `${label}结果`}</h3>
                        <div className="flex flex-wrap gap-2">
                            <Button size="sm" variant="outline" disabled={exportDisabled} onClick={() => void run(async () => { await navigator.clipboard.writeText(output); setNotice(`已复制${label}`); })}><Copy className="mr-2 size-3" />复制结果</Button>
                            <Button size="sm" variant="outline" disabled={exportDisabled} onClick={() => void run(download)}><Download className="mr-2 size-3" />{stage === "analysis" ? "下载 JSON" : "下载结果"}</Button>
                        </div>
                    </div>
                    <Textarea
                        aria-label={`${label}结果`}
                        value={value}
                        disabled={disabled || settingsDirty || otherOutputDirty || (stage === "analysis" && !project.sourceVideo)}
                        readOnly={outputReadOnly}
                        maxLength={OMNI_STAGE_OUTPUT_LIMIT}
                        onChange={(event) => { setValue(event.target.value); setNotice(""); }}
                        placeholder={stage === "analysis" ? "点击上方按钮，由系统生成分析 JSON；也可以粘贴已有 JSON 后采用。" : outputReadOnly ? "生成后在这里查看完整结果。" : "生成后在这里查看和编辑结果，也可以粘贴已有内容后采用。"}
                        className={`min-h-48 max-h-[36rem] resize-y leading-6 ${stage === "analysis" ? "font-mono text-[13px]" : ""}`}
                    />
                    {outputReadOnly && <p className="text-xs leading-6 text-muted-foreground">完整汇总保留在此处。调整最终提示词请使用下方各片段的编辑入口；要整体重写，请修改本阶段生成指令后重新生成。</p>}
                    {settingsDirty && <p className="text-xs text-muted-foreground">请先保存当前项目修改，再编辑阶段结果。</p>}
                    {edited && <div className="flex flex-wrap gap-2">
                        <Button size="sm" disabled={disabled || settingsDirty || otherOutputDirty || !value.trim()} onClick={() => void run(async () => { const savedOutput = await onSaveOutput(value); if (savedOutput !== undefined) setValue(savedOutput); })}><Save className="mr-2 size-3" />采用并保存结果</Button>
                        <Button size="sm" variant="ghost" disabled={disabled} onClick={() => { setValue(output); setNotice(""); }}>放弃修改</Button>
                    </div>}
                </div>
                {notice && <p role="status" className="text-xs leading-6 text-muted-foreground">{notice}</p>}
            </div>
        </details>
    );
}
