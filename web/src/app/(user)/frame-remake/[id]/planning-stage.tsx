"use client";
import { Button, Checkbox, Input } from "antd";
import { useRef } from "react";
import { ReferenceImageGenerator } from "@/components/reference-image-generator";
import { frameRemakeInputError, frameRemakeIsBasicWorkflow, frameRemakeReplacement, frameRemakeTime, frameRemakeWorkflowSource } from "@/lib/frame-remake-contract";
import { frameRemakeWorkflowReadiness } from "@/lib/frame-remake-steps";
import { frameRemakeMissingPromptFields } from "@/lib/frame-remake-prompt-templates";
import { ReferenceSlot } from "../../remake15/[id]/remake-image-stage";
import { ModelControl, ScriptResult, type WorkflowProps } from "./workflow-controls";

export function FramePlanningStage(props: WorkflowProps) {
    const { project, display } = props;
    const ready = frameRemakeWorkflowReadiness(project);
    const inputs = useRef<Partial<Record<"product" | "character" | "background", HTMLInputElement | null>>>({});
    const replacement = frameRemakeReplacement(display);
    const inputError = frameRemakeInputError(display);
    const basic = frameRemakeIsBasicWorkflow(display),
        source = frameRemakeWorkflowSource(display),
        missingSource = frameRemakeMissingPromptFields(display).length > 0;
    const slots = source === "product-basic"
        ? [{ key: "product" as const, label: "新产品图", detail: "原文按此图替换人物手持的产品", required: true }]
        : source === "person-basic"
          ? [{ key: "character" as const, label: "人物图（可选）", detail: "提供时采用此人物；留空按原提示词处理", required: false }, { key: "background" as const, label: "背景图", detail: "原工作流要求的背景参考图", required: true }]
          : ([{ key: "product", label: "新产品图", detail: "换品时必填，用于确定新产品外观", required: true }, { key: "character", label: "人物图", detail: "换人时必填，用于确定目标人物", required: true }, { key: "background", label: "环境图", detail: "换环境时必填，用于确定目标场景", required: true }] as const).filter((slot) => replacement[slot.key]);
    return (
        <section className="h-full min-h-0 overflow-y-auto" aria-label="分镜脚本与替换素材">
            <div className="mx-auto w-full max-w-[1480px] space-y-4 px-3 py-4 sm:px-5">
                <header className="border-b pb-4">
                    <p className="text-xs text-muted-foreground">阶段 02</p>
                    <h2 className="mt-1 text-lg font-semibold">{basic ? "替换素材" : "分镜脚本与替换素材"}</h2>
                    <p className="mt-1 text-sm text-muted-foreground">{basic ? "按所选飞书流程准备素材，使用原文提示词直接生成分镜图。每组独立执行并保留结果。" : "此流程需先补齐飞书脚本与生图提示词正文，已有结果可继续查看。"}</p>
                    {slots.some((slot) => slot.key !== "product") && <p className="mt-1 text-sm text-muted-foreground">人物图和背景图可手动上传，也可点击“AI 生成”，预览后采用并自动保存。</p>}
                </header>
                {!basic && <fieldset className="space-y-2" disabled={props.editingDisabled}>
                    <legend className="mb-2 text-sm font-medium">本次替换</legend>
                    <div className="flex flex-wrap gap-4">
                        {([{ key: "product", label: "换品" }, { key: "character", label: "换人" }, { key: "background", label: "换环境" }] as const).map((option) => (
                            <Checkbox key={option.key} checked={replacement[option.key]} disabled={props.editingDisabled} onChange={(event) => props.onChange({ replacement: { ...replacement, [option.key]: event.target.checked } })}>
                                {option.label}
                            </Checkbox>
                        ))}
                    </div>
                    <p className="text-xs text-muted-foreground">未勾选的内容沿用原视频。关闭选项会保留已上传素材，重新勾选即可继续使用。</p>
                </fieldset>}
                <div className={`grid gap-3 ${slots.length === 2 ? "md:grid-cols-2" : "md:grid-cols-3"}`}>
                    {slots.map((slot) => (
                        <ReferenceSlot
                            key={slot.key}
                            label={slot.label}
                            detail={slot.detail}
                            required={slot.required}
                            asset={display.references[slot.key][0]}
                            loading={false}
                            disabled={props.editingDisabled}
                            onChoose={() => inputs.current[slot.key]?.click()}
                            onRemove={() => props.onChange({ references: { ...display.references, [slot.key]: [] } })}
                            generateAction={slot.key !== "product" ? (
                                <ReferenceImageGenerator
                                    projectId={project.id}
                                    role={slot.key}
                                    context={display.productInfo}
                                    imageModel={display.modelSelection.image}
                                    disabled={props.editingDisabled}
                                    className="!h-7 !px-1.5"
                                    onSelect={async (asset) => {
                                        if (props.editingDisabled) throw new Error("请等待当前操作完成后再采用参考图");
                                        props.onChange({ references: { ...display.references, [slot.key]: [asset] } });
                                        await props.onSave();
                                    }}
                                />
                            ) : undefined}
                        >
                            <input
                                ref={(node) => {
                                    inputs.current[slot.key] = node;
                                }}
                                type="file"
                                accept="image/*"
                                className="hidden"
                                aria-label={`上传${slot.label}`}
                                disabled={props.editingDisabled}
                                onChange={(event) => {
                                    const file = event.target.files?.[0];
                                    event.target.value = "";
                                    if (file) void props.onUpload(file, slot.key);
                                }}
                            />
                        </ReferenceSlot>
                    ))}
                </div>
                <label className="grid gap-2 text-sm font-medium">
                    {replacement.product ? "新产品信息" : "产品信息（可选）"}
                    <Input.TextArea value={display.productInfo || ""} disabled={props.editingDisabled} maxLength={20000} autoSize={{ minRows: 3, maxRows: 8 }} placeholder={replacement.product ? "填写新产品名称、核心卖点、规格及适用场景。" : "可补充原产品信息，留空时依据原片分析。"} onChange={(event) => props.onChange({ productInfo: event.target.value })} />
                </label>
                {!basic && <label className="grid gap-2 text-sm font-medium">
                    补充要求（可选）
                    <Input.TextArea value={display.instructions} disabled={props.editingDisabled} maxLength={20000} autoSize={{ minRows: 2, maxRows: 8 }} onChange={(event) => props.onChange({ instructions: event.target.value })} />
                </label>}
                {!basic && <div className="flex flex-wrap items-end gap-2 border-y py-3">
                    <ModelControl props={props} kind="analysis" label="脚本模型" />
                    <Button type="primary" disabled={props.disabled || !ready.analysis || ready.planning || Boolean(inputError) || missingSource} onClick={() => void props.onControl("step", true)}>
                        执行下一步
                    </Button>
                    <Button disabled={props.disabled || !ready.analysis || Boolean(inputError) || missingSource} onClick={() => void props.onControl("start", true, ready.planning ? { restartFrom: "productScript" } : undefined)}>
                        {ready.planning ? "重新生成分镜脚本" : "生成分镜脚本"}
                    </Button>
                </div>}
                {inputError && (
                    <p role="status" className="text-sm text-amber-700">
                        {inputError}
                    </p>
                )}
                <p className="text-xs text-muted-foreground">使用已配置的站内模型。每一步完成后，可查看完整输出、编辑并保存，再继续下一步。</p>
                {!basic && display.groups.map((group) => (
                    <section key={group.id} className="space-y-3 rounded-lg border p-3" aria-label={`第${group.number}组分镜脚本`}>
                        <h3 className="text-sm font-semibold">
                            第 {group.number} 组 · 原片 {frameRemakeTime(group.startMs)}—{frameRemakeTime(group.endMs)} · 组内分镜 1–12
                        </h3>
                        {(["productScript", "imagePrompt"] as const).map((step) => (
                            <ScriptResult key={step} props={{ ...props, disabled: props.disabled || Boolean(inputError) }} group={group} stage={step} />
                        ))}
                    </section>
                ))}
                <div className="flex justify-end border-t pt-4">
                    <Button type="primary" disabled={!ready.planning || Boolean(inputError) || missingSource} onClick={() => props.onStage("images")}>
                        {basic ? "继续单步分镜生图" : "继续分镜重绘"}
                    </Button>
                </div>
            </div>
        </section>
    );
}
