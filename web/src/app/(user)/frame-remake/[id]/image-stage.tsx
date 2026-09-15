"use client";
import { Button, Input, Tag } from "antd";
import { Images, Trash2 } from "lucide-react";
import { frameRemakeWorkflowReadiness } from "@/lib/frame-remake-steps";
import { frameRemakeGrid, frameRemakeSeconds, type FrameRemakeGroup, type FrameRemakeGenerationKind } from "@/lib/frame-remake-contract";
import { frameRemakeScriptsReady } from "@/lib/frame-remake-source";
import { Media, TextOutput } from "./outputs";
import { ModelControl, ScriptResult, UploadControl, taskLabels, type WorkflowProps } from "./workflow-controls";
export function FrameImageStage(props: WorkflowProps) {
    const { project, display } = props,
        ready = frameRemakeWorkflowReadiness(project),
        scriptsReady = frameRemakeScriptsReady(project);
    return (
        <section className="h-full min-h-0 overflow-y-auto bg-background" aria-label="分镜重绘">
            <div className="mx-auto w-full max-w-[1480px] px-3 py-4 sm:px-5 sm:py-5">
                <div className="flex flex-col gap-3 border-b pb-4 sm:flex-row sm:items-end sm:justify-between">
                    <div>
                        <p className="text-xs font-medium text-muted-foreground">阶段 02</p>
                        <h1 className="mt-1 text-lg font-semibold">新产品脚本与分镜重绘</h1>
                        <p className="mt-1 text-sm text-muted-foreground">审阅脚本后，按“来源分镜 → 清理换人 → 产品融合”两步制作。</p>
                    </div>
                    <div className="flex flex-wrap items-end gap-2">
                        <ModelControl props={props} kind="image" label="生图模型" />
                        <Tag className="!m-0">
                            {project.groups.filter((g) => g.image.status === "completed").length}/{project.groups.length} 已完成
                        </Tag>
                    </div>
                </div>
                <div className="grid gap-3 border-b py-4 md:grid-cols-3">
                    {(
                        [
                            ["product", "新产品图"],
                            ["character", "人物图"],
                            ["background", "背景图"],
                        ] as const
                    ).map(([role, label]) => (
                        <section key={role} className="min-w-0 rounded-lg border bg-card p-3">
                            <div className="flex items-center justify-between">
                                <h2 className="text-sm font-semibold">{label}</h2>
                                <Tag>可选</Tag>
                            </div>
                            <p className="mb-2 text-xs text-muted-foreground">未上传则保留原片内容 · 最多两张</p>
                            <div className="flex gap-2">
                                {display.references[role].map((media, i) => (
                                    <div key={media.url} className="min-w-0 flex-1">
                                        <Media media={media} label={`${label}${i + 1}`} />
                                        <Button
                                            type="text"
                                            size="small"
                                            danger
                                            disabled={props.editingDisabled}
                                            aria-label={`移除${label}${i + 1}`}
                                            icon={<Trash2 className="size-3.5" />}
                                            onClick={() => props.onChange({ references: { ...display.references, [role]: display.references[role].filter((_, n) => n !== i) } })}
                                        />
                                    </div>
                                ))}
                            </div>
                            <UploadControl label={`上传${label}`} accept="image/png,image/jpeg,image/webp" disabled={props.disabled || display.references[role].length >= 2} onFile={(file) => void props.onUpload(file, role)} />
                        </section>
                    ))}
                </div>
                <section className="grid gap-3 border-b py-4" aria-label="新产品脚本">
                    <label className="grid gap-2 text-sm font-medium">
                        新产品信息
                        <Input.TextArea
                            aria-label="新产品信息"
                            rows={3}
                            maxLength={20000}
                            value={display.productInfo || ""}
                            disabled={props.editingDisabled}
                            placeholder="填写产品名称、卖点与使用场景；不换产品可留空。"
                            onChange={(e) => props.onChange({ productInfo: e.target.value })}
                        />
                    </label>
                    <div className="flex flex-wrap items-end gap-2">
                        <ModelControl props={props} kind="analysis" label="脚本文本模型" />
                        <Button type="primary" disabled={props.disabled || !ready.analysis || scriptsReady} onClick={() => void props.onControl("start", true)}>
                            生成新产品脚本
                        </Button>
                        <span className="text-xs text-muted-foreground">逐组生成产品脚本与分镜提示词，完成后暂停供你审阅。</span>
                    </div>
                    {!ready.analysis && <p className="text-xs text-amber-700">先完成来源视频分析和文案处理。</p>}
                    <div className="space-y-3">
                        {display.groups.map((g) => (
                            <details key={g.id} className="rounded-lg border bg-card p-3">
                                <summary className="cursor-pointer text-sm">
                                    第 {g.number} 组 · {frameRemakeSeconds(g)} 秒 · 产品脚本与分镜提示词
                                </summary>
                                <div className="mt-3 grid gap-3 lg:grid-cols-2">
                                    <ScriptResult props={props} group={g} stage="productScript" />
                                    <ScriptResult props={props} group={g} stage="imagePrompt" />
                                </div>
                            </details>
                        ))}
                    </div>
                </section>
                <div className="space-y-4 py-4">
                    {display.groups.map((g) => (
                        <ImageGroup key={g.id} props={props} group={g} />
                    ))}
                </div>
                <div className="flex justify-end border-t pt-4">
                    <Button type="primary" disabled={!ready.images || props.disabled} onClick={() => props.onStage("production")}>
                        继续生产内容
                    </Button>
                </div>
            </div>
        </section>
    );
}
function ImageGroup({ props, group }: { props: WorkflowProps; group: FrameRemakeGroup }) {
    const grid = frameRemakeGrid(group.frames.length);
    return (
        <article className="min-w-0 overflow-hidden rounded-lg border bg-card" aria-label={`分镜 ${group.id}`}>
            <header className="flex items-center justify-between gap-2 border-b px-3 py-2.5">
                <div>
                    <h3 className="text-sm font-semibold">
                        分镜 {group.frames[0]?.number}–{group.frames.at(-1)?.number} · 第 {group.number} 组
                    </h3>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                        {grid.columns} 列 × {grid.rows} 行 · {frameRemakeSeconds(group)} 秒 · 两步生成
                    </p>
                </div>
                <Tag className="!m-0">{taskLabels[group.image.status]}</Tag>
            </header>
            <div className="grid grid-cols-1 gap-px bg-border sm:grid-cols-3">
                <div className="min-w-0 bg-card p-3">
                    <p className="mb-2 text-xs font-medium">来源分镜图</p>
                    {group.contactSheet ? <Media media={group.contactSheet} label={`第${group.number}组来源分镜图`} /> : <Waiting />}
                </div>
                {(
                    [
                        ["template", "第一步：清理 / 换人"],
                        ["image", "第二步：融合产品 / 背景"],
                    ] as const
                ).map(([kind, label]) => (
                    <div key={kind} className="min-w-0 bg-card p-3">
                        <p className="mb-2 text-xs font-medium">{label}</p>
                        {group[kind].result ? <Media media={group[kind].result} label={`第${group.number}组${label}`} /> : <Waiting text={taskLabels[group[kind].status]} />}
                        <div className="mt-3">
                            <GenerationControl props={props} group={group} kind={kind} />
                        </div>
                    </div>
                ))}
            </div>
            {(["template", "image"] as const).map(
                (kind) =>
                    group[kind].prompt && (
                        <details key={kind} className="border-t px-3 py-2">
                            <summary className="cursor-pointer text-xs">{kind === "template" ? "第一步" : "第二步"}完整提示词</summary>
                            <TextOutput title="实际提交内容" text={group[kind].prompt!} name={`${group.id}-${kind}`} />
                        </details>
                    ),
            )}
        </article>
    );
}
function Waiting({ text = "等待图片" }: { text?: string }) {
    return (
        <div className="mx-auto grid aspect-[9/16] w-full max-w-[240px] place-items-center rounded-md border bg-[#15181c] text-xs text-white/60">
            <div>
                <Images className="mx-auto mb-2 size-5" />
                {text}
            </div>
        </div>
    );
}
export function GenerationControl({ props, group, kind }: { props: WorkflowProps; group: FrameRemakeGroup; kind: FrameRemakeGenerationKind }) {
    const task = group[kind],
        ready = kind === "template" ? Boolean(group.imagePrompt && group.contactSheet) : kind === "image" ? Boolean(group.template.result && group.imagePrompt) : Boolean(group.image.result && group.videoPrompt);
    return (
        <div className="space-y-2">
            {task.error && (
                <p role="alert" className="break-words text-xs leading-5 text-destructive">
                    {task.error}
                </p>
            )}
            <div className="flex flex-wrap gap-2">
                <Button size="small" type="primary" disabled={!ready || task.status === "running" || (task.status === "queued" ? props.working || props.dirty : props.disabled)} onClick={() => void props.onGenerate(group.id, kind)}>
                    {task.status === "queued" ? "继续确认提交" : task.status === "completed" ? "重新生成" : task.status === "error" ? "重试生成" : kind === "template" ? "生成第一步" : kind === "image" ? "生成第二步" : "生成视频"}
                </Button>
                {task.status === "queued" && (
                    <Button size="small" disabled={props.working} onClick={() => void props.onAbandon(group.id, kind)}>
                        撤销未确认提交
                    </Button>
                )}
            </div>
        </div>
    );
}
