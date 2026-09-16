"use client";
import { Button, Input, Tag } from "antd";
import { useRef } from "react";
import { Check } from "lucide-react";
import { frameRemakeWorkflowReadiness } from "@/lib/frame-remake-steps";
import { frameRemakeGrid, frameRemakeSeconds } from "@/lib/frame-remake-contract";
import { frameRemakeImagePrompt } from "@/lib/frame-remake-prompts";
import { RemakeGroupCard, ReferenceSlot } from "../../remake15/[id]/remake-image-stage";
import { ModelControl, type WorkflowProps } from "./workflow-controls";

export function FrameImageStage(props: WorkflowProps) {
    const { project, display } = props,
        ready = frameRemakeWorkflowReadiness(project);
    const inputs = useRef<Partial<Record<"product" | "character", HTMLInputElement | null>>>({});
    const referencesReady = Boolean(display.references.product.length);
    const hasScripts = project.groups.some((g) => g.productScript || g.imagePrompt);
    const building = project.operation?.kind === "analyze" || (project.automation?.status === "running" && project.automation.stopAfterPrompts);
    return (
        <section className="h-full min-h-0 overflow-y-auto bg-background" aria-label="分镜重绘">
            <div className="mx-auto w-full max-w-[1480px] px-3 py-4 sm:px-5 sm:py-5">
                <div className="flex min-w-0 flex-col gap-3 border-b border-border pb-4 sm:flex-row sm:items-end sm:justify-between">
                    <div className="min-w-0">
                        <div className="text-xs font-medium text-muted-foreground">阶段 02</div>
                        <h2 className="mt-1 text-lg font-semibold">新产品脚本与分镜重绘</h2>
                        <p className="mt-1 text-sm text-muted-foreground">结合产品信息生成 {project.groups.reduce((n, g) => n + g.frames.length, 0)} 分镜脚本，审阅后两步生成最终分镜图。</p>
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center gap-2">
                        <ModelControl props={props} kind="image" label="生图模型" />
                        <Tag className="!m-0">
                            {project.groups.filter((g) => g.image.status === "completed").length} / {project.groups.length} 已完成
                        </Tag>
                    </div>
                </div>
                <div className="grid gap-3 border-b border-border py-4 md:grid-cols-2">
                    {(
                        [
                            { key: "product", label: "新产品图", detail: "用于替换原视频中的产品", required: true },
                            { key: "character", label: "人物图", detail: "不上传时保留原人物", required: false },
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
                                className="hidden"
                                type="file"
                                accept="image/*"
                                disabled={props.editingDisabled}
                                onChange={(e) => {
                                    const file = e.target.files?.[0];
                                    e.target.value = "";
                                    if (file) void props.onUpload(file, slot.key);
                                }}
                            />
                        </ReferenceSlot>
                    ))}
                </div>
                <section className="grid gap-3 border-b border-border py-4" aria-label="新产品脚本">
                    <label className="grid gap-2 text-sm font-medium">
                        新产品信息
                        <Input.TextArea
                            value={display.productInfo || ""}
                            disabled={props.editingDisabled}
                            maxLength={20000}
                            autoSize={{ minRows: 3, maxRows: 8 }}
                            placeholder="填写新产品名称、核心卖点、规格及适用场景。"
                            onChange={(e) => props.onChange({ productInfo: e.target.value })}
                        />
                    </label>
                    <div className="flex flex-wrap items-end gap-2">
                        <ModelControl props={props} kind="analysis" label="脚本文本模型" />
                        <Button
                            loading={Boolean(building)}
                            disabled={props.disabled || !ready.analysis || !referencesReady || !display.productInfo?.trim()}
                            onClick={() => void props.onControl("start", true, hasScripts && !project.error ? { restartFrom: "productScript" } : undefined)}
                        >
                            {project.error && hasScripts ? "继续生成新产品脚本" : hasScripts ? "重新生成新产品脚本" : "生成新产品脚本"}
                        </Button>
                    </div>
                    {hasScripts && (
                        <details>
                            <summary className="cursor-pointer text-sm font-medium">查看新产品分镜脚本</summary>
                            <Input.TextArea
                                readOnly
                                value={display.groups.map((g) => `=== 分镜 ${g.frames[0].number}–${g.frames.at(-1)!.number} ===\n${g.productScript || "等待生成"}`).join("\n\n")}
                                autoSize={{ minRows: 4, maxRows: 12 }}
                                className="!mt-2"
                            />
                        </details>
                    )}
                    {display.groups
                        .filter((g) => g.imagePrompt)
                        .map((g) => (
                            <label key={g.id} className="grid gap-2 text-sm font-medium">
                                {g.frames[0].number}–{g.frames.at(-1)!.number} 分镜提示词 · 审阅后生图
                                <Input.TextArea value={g.imagePrompt} disabled={props.editingDisabled} autoSize={{ minRows: 7, maxRows: 16 }} onChange={(e) => props.onEditGroup("imagePrompt", e.target.value, g.id)} />
                            </label>
                        ))}
                </section>
                {!referencesReady && <div className="border-b border-amber-300/70 bg-amber-50 px-3 py-2.5 text-xs leading-5 text-amber-800">请上传新产品图。人物图可选；不上传时保留原人物。</div>}
                <div className="grid items-start gap-3 py-4">
                    {display.groups.map((g) => {
                        const grid = frameRemakeGrid(g.frames.length);
                        return (
                            <RemakeGroupCard
                                key={g.id}
                                group={{
                                    id: `${g.frames[0].number}–${g.frames.at(-1)!.number}`,
                                    sourceContactSheet: g.contactSheet,
                                    replacementGeneration: { ...g.template, prompt: g.template.prompt || "" },
                                    imageGeneration: { ...g.image, prompt: g.image.prompt || "" },
                                }}
                                title={`分镜 ${g.frames[0].number}–${g.frames.at(-1)!.number} · ${g.frames.length} 宫格`}
                                description={`${grid.columns} 列 × ${grid.rows} 行 · 两步生成 · ${frameRemakeSeconds(g)} 秒`}
                                sourceLabel="来源分镜图"
                                prompts={{ replacement: g.template.prompt || frameRemakeImagePrompt(display, g, "template"), storyboard: g.image.prompt || frameRemakeImagePrompt(display, g, "image") }}
                                disabled={props.disabled || !referencesReady || !display.productInfo?.trim() || !g.productScript || !g.imagePrompt}
                                onGenerate={() => void props.onControl("start", false, { groupId: g.id, restartFrom: "images" })}
                            />
                        );
                    })}
                </div>
                <div className="flex justify-end border-t border-border pt-4">
                    <Button type="primary" icon={<Check className="size-4" />} disabled={!ready.images} onClick={() => props.onStage("production")}>
                        进入生产内容
                    </Button>
                </div>
            </div>
        </section>
    );
}
