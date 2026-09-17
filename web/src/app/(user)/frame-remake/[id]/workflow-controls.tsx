"use client";
import { Button, Input } from "antd";
import { useRef, type ReactNode } from "react";
import { Upload } from "lucide-react";
import { ModelPicker } from "@/components/model-picker";
import { useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import {
    FRAME_REMAKE_ANALYSIS_STAGES,
    FRAME_REMAKE_ANALYSIS_LABELS,
    frameRemakeAnalysisResult,
    frameRemakeIsBasicWorkflow,
    type FrameRemakeAnalysisStage,
    type FrameRemakeRunOptions,
    type FrameRemakeGenerationKind,
    type FrameRemakeGroup,
    type FrameRemakeOperationKind,
    type FrameRemakePatch,
    type FrameRemakeProject,
    type FrameRemakeWorkflowStage,
} from "@/lib/frame-remake-contract";
import { frameRemakeAnalysisPrompt } from "@/lib/frame-remake-prompts";
import { frameRemakeMissingPromptFields, frameRemakeTemplates } from "@/lib/frame-remake-prompt-templates";
import { TextOutput } from "./outputs";
import { frameRemakePromptPreview } from "./workflow-source";
export type WorkflowProps = {
    project: FrameRemakeProject;
    display: FrameRemakeProject;
    group?: FrameRemakeGroup;
    stage: FrameRemakeWorkflowStage;
    dirty: boolean;
    saving?: boolean;
    working: boolean;
    controlling?: boolean;
    editingDisabled: boolean;
    disabled: boolean;
    groupLocked: boolean;
    error: string;
    onStage: (stage: FrameRemakeWorkflowStage) => void;
    onGroup: (id: string) => void;
    onChange: (patch: FrameRemakePatch) => void;
    onEditGroup: (stage: FrameRemakeAnalysisStage, value: string, groupId?: string) => void;
    onSave: () => Promise<void>;
    onDiscard: () => void;
    onRefresh: () => Promise<void>;
    onControl: (mode: "start" | "step" | "pause", stopAfterPrompts?: boolean, options?: FrameRemakeRunOptions) => Promise<void>;
    onOperation: (kind: FrameRemakeOperationKind, groupId?: string, stage?: FrameRemakeAnalysisStage) => Promise<void>;
    onGenerate: (id: string, kind: FrameRemakeGenerationKind) => Promise<void>;
    onAbandon: (id: string, kind: FrameRemakeGenerationKind) => Promise<void>;
    onUpload: (file: File, role: "product" | "character" | "background" | "video") => Promise<void>;
};
export const taskLabels = { idle: "待生成", queued: "待确认提交", running: "生成中", completed: "已完成", error: "生成失败" };
export function ModelControl({ props, kind, label }: { props: WorkflowProps; kind: "analysis" | "image" | "video"; label: string }) {
    const config = useEffectiveConfig(),
        open = useConfigStore((s) => s.openConfigDialog);
    return (
        <fieldset disabled={props.editingDisabled} className={`grid min-w-0 gap-1 text-[11px] text-muted-foreground ${props.editingDisabled ? "pointer-events-none opacity-60" : ""}`}>
            <legend className="mb-1">{label}</legend>
            <ModelPicker
                config={config}
                capability={kind === "analysis" ? "text" : kind}
                value={props.display.modelSelection[kind]}
                onChange={(value) => props.onChange({ modelSelection: { ...props.display.modelSelection, [kind]: value } })}
                onMissingConfig={() => open(true)}
                placeholder="平台默认模型"
            />
        </fieldset>
    );
}
export function UploadControl({ label, accept, disabled, onFile }: { label: string; accept: string; disabled: boolean; onFile: (file: File) => void }) {
    const ref = useRef<HTMLInputElement>(null);
    return (
        <>
            <Button size="small" icon={<Upload className="size-3.5" />} disabled={disabled} onClick={() => ref.current?.click()}>
                {label}
            </Button>
            <input
                ref={ref}
                aria-label={label}
                type="file"
                accept={accept}
                disabled={disabled}
                className="hidden"
                onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    if (file) onFile(file);
                }}
            />
        </>
    );
}
export function Field({ label, children }: { label: string; children: ReactNode }) {
    return (
        <label className="grid min-w-0 gap-2 text-xs font-medium">
            <span>{label}</span>
            {children}
        </label>
    );
}
export function ScriptResult({ props, group, stage }: { props: WorkflowProps; group: FrameRemakeGroup; stage: FrameRemakeAnalysisStage }) {
    const record = group.analysisSteps?.[stage],
        text = frameRemakeAnalysisResult(group, stage),
        label = stage === "copy" ? "文案预处理" : FRAME_REMAKE_ANALYSIS_LABELS[stage];
    const basic = frameRemakeIsBasicWorkflow(props.display);
    const promptSource = record?.promptSource ?? (!record?.prompt && stage === "videoPrompt" && basic ? frameRemakeTemplates(props.display, group).videoSource : undefined);
    const prerequisiteMissing = basic
        ? stage === "copy" ? !group.analysis || !group.image.result : stage === "videoPrompt" ? !group.copy?.trim() || !group.image.result : false
        : FRAME_REMAKE_ANALYSIS_STAGES.slice(0, FRAME_REMAKE_ANALYSIS_STAGES.indexOf(stage)).some((key) => !frameRemakeAnalysisResult(group, key));
    const missingSource = frameRemakeMissingPromptFields(props.display).length > 0;
    return (
        <section className="min-w-0 space-y-3 rounded-lg border bg-card p-3" aria-label={`第${group.number}组${label}`}>
            <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold">{label}</h3>
                <Button
                    size="small"
                    loading={props.project.operation?.groupId === group.id && props.project.operation.analysisStage === stage}
                    disabled={props.disabled || prerequisiteMissing || missingSource || (stage === "videoPrompt" && !group.image.result)}
                    onClick={() => void props.onOperation("analyze", group.id, stage)}
                >
                    {text ? "重新生成" : "生成本步"}
                </Button>
            </div>
            {record?.error && (
                <p role="alert" className="text-xs text-destructive">
                    {record.error}
                </p>
            )}
            {text ? <TextOutput title="完整结果" text={text} name={`第${group.number}组-${label}`} /> : <p className="py-4 text-xs text-muted-foreground">生成后显示完整结果。</p>}
            <details>
                <summary className="cursor-pointer text-xs">编辑本步结果</summary>
                <Input.TextArea
                    aria-label={`编辑第${group.number}组${label}`}
                    className="!mt-2"
                    rows={7}
                    value={text}
                    maxLength={30000}
                    disabled={props.editingDisabled || (props.groupLocked && props.group?.id !== group.id)}
                    onChange={(e) => props.onEditGroup(stage, e.target.value, group.id)}
                />
            </details>
            {(record?.prompt || !text) && (
                <details>
                    <summary className="cursor-pointer text-xs">{record?.prompt ? "本次执行记录的提示词" : "提示词模板预览（尚未发送）"}{record?.elapsedMs !== undefined ? ` · ${(record.elapsedMs / 1000).toFixed(1)} 秒` : ""}</summary>
                    {promptSource && <p className="my-2 text-xs text-muted-foreground">原文来源：<a className="underline" href={promptSource.url} target="_blank" rel="noreferrer">{promptSource.tableId === "tblWsGmy3C9igdZ2" ? "不换品_换人基础版" : "换品_不换人基础版"} · {promptSource.field}</a>{promptSource.shared ? "（共用该表后续分组的视频模板）" : ""}。按本组镜头编号和时长绑定。</p>}
                    <TextOutput title="模型输入" text={record?.prompt || frameRemakePromptPreview(() => frameRemakeAnalysisPrompt(props.display, group, stage))} name={`第${group.number}组-${stage}-input`} />
                </details>
            )}
        </section>
    );
}
