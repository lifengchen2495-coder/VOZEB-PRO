"use client";
import { Button, Input } from "antd";
import { useRef } from "react";
import { frameRemakeInputError, frameRemakeTime } from "@/lib/frame-remake-contract";
import { frameRemakeWorkflowReadiness } from "@/lib/frame-remake-steps";
import { FRAME_REMAKE_FEISHU_URL } from "@/lib/frame-remake-feishu-workflow";
import { ReferenceSlot } from "../../remake15/[id]/remake-image-stage";
import { ModelControl, ScriptResult, type WorkflowProps } from "./workflow-controls";

export function FramePlanningStage(props: WorkflowProps) {
    const { project, display } = props;
    const ready = frameRemakeWorkflowReadiness(project);
    const inputs = useRef<Partial<Record<"product" | "character", HTMLInputElement | null>>>({});
    const inputError = frameRemakeInputError(display);
    return (
        <section className="h-full min-h-0 overflow-y-auto" aria-label="新产品脚本与分镜提示词">
            <div className="mx-auto w-full max-w-[1480px] space-y-4 px-3 py-4 sm:px-5">
                <header className="border-b pb-4">
                    <p className="text-xs text-muted-foreground">阶段 02</p>
                    <h2 className="mt-1 text-lg font-semibold">新产品脚本与分镜提示词</h2>
                    <p className="mt-1 text-sm text-muted-foreground">按原表依次生成「新产品-12分镜脚本」和「1-12分镜提示词」。每组独立执行并保存结果。</p>
                </header>
                <div className="grid gap-3 md:grid-cols-2">
                    {(
                        [
                            { key: "product", label: "产品图", detail: "原版必填素材", required: true },
                            { key: "character", label: "人物图", detail: "选填；不上传则沿用原人物", required: false },
                        ] as const
                    ).map((slot) => (
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
                {display.references.background.length > 0 && (
                    <Button disabled={props.editingDisabled} onClick={() => props.onChange({ references: { ...display.references, background: [] } })}>
                        移除旧版环境参考图
                    </Button>
                )}
                <label className="grid gap-2 text-sm font-medium">
                    产品信息
                    <Input.TextArea value={display.productInfo || ""} disabled={props.editingDisabled} maxLength={20000} autoSize={{ minRows: 3, maxRows: 8 }} onChange={(event) => props.onChange({ productInfo: event.target.value })} />
                </label>
                <label className="grid gap-2 text-sm font-medium">
                    产品备注（可选）
                    <Input.TextArea value={display.instructions} disabled={props.editingDisabled} maxLength={20000} autoSize={{ minRows: 2, maxRows: 8 }} onChange={(event) => props.onChange({ instructions: event.target.value })} />
                </label>
                <div className="flex flex-wrap items-end gap-2 border-y py-3">
                    <ModelControl props={props} kind="analysis" label="脚本模型" />
                    <Button type="primary" disabled={props.disabled || !ready.analysis || ready.planning || Boolean(inputError)} onClick={() => void props.onControl("step", true)}>
                        执行下一步
                    </Button>
                    <Button disabled={props.disabled || !ready.analysis || Boolean(inputError)} onClick={() => void props.onControl("start", true, ready.planning ? { restartFrom: "productScript" } : undefined)}>
                        {ready.planning ? "重新生成本阶段" : "继续生成本阶段"}
                    </Button>
                </div>
                {inputError && (
                    <p role="status" className="text-sm text-amber-700">
                        {inputError}
                    </p>
                )}
                <p className="text-xs text-muted-foreground">
                    原版来源：
                    <a className="underline" href={FRAME_REMAKE_FEISHU_URL} target="_blank" rel="noreferrer">
                        15秒拆帧实操版
                    </a>
                    。仅绑定原表字段；产品信息和产品备注共同填入原表的「产品信息」。缺失的提示词正文需要补齐后才能生成。
                </p>
                {display.groups.map((group) => (
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
                    <Button type="primary" disabled={!ready.planning} onClick={() => props.onStage("images")}>
                        进入两步生图
                    </Button>
                </div>
            </div>
        </section>
    );
}
