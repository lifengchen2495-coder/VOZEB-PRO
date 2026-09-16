"use client";
import { App, Button, Input, Segmented } from "antd";
import { useState } from "react";
import copy from "copy-to-clipboard";
import { Copy, Download, FileText, Sparkles, Video } from "lucide-react";
import { frameRemakeTime, frameRemakeSeconds, frameRemakeAspectRatio } from "@/lib/frame-remake-contract";
import { frameRemakeTemplates } from "@/lib/frame-remake-prompt-templates";
import { frameRemakeWorkflowReadiness } from "@/lib/frame-remake-steps";
import { VideoGroupCard } from "../../remake15/[id]/remake-production-stage";
import { ModelControl, type WorkflowProps } from "./workflow-controls";
import { downloadFrameRemakeProductionBundle } from "./production-export";
import { Media, TextOutput } from "./outputs";
export function FrameProductionStage(props: WorkflowProps) {
    const { project, display } = props,
        ready = frameRemakeWorkflowReadiness(project);
    const { message } = App.useApp();
    const [exporting, setExporting] = useState(false);
    const promptsReady = project.groups.length > 0 && project.groups.every((g) => g.videoPrompt);
    const productionReady = ready.images && promptsReady && project.groups.every((g) => g.video.status === "completed" && g.video.result);
    const report = display.groups.map((g) => `=== 分镜 ${g.frames[0].number}–${g.frames.at(-1)!.number} ===\n${g.copy || ""}`).join("\n\n");
    const copyText = async (text: string) => {
        if (await copy(text)) void message.success("完整输出已复制");
        else void message.error("复制失败，请手动选择正文复制");
    };
    const exportBundle = async () => {
        setExporting(true);
        try {
            await downloadFrameRemakeProductionBundle(project);
            void message.success("生产包已下载");
        } catch (e) {
            void message.error((e as Error).message);
        } finally {
            setExporting(false);
        }
    };
    return (
        <section className="h-full min-h-0 overflow-y-auto bg-background" aria-label="生产内容">
            <div className="mx-auto w-full max-w-[1480px] px-3 py-4 sm:px-5 sm:py-5">
                <div className="flex min-w-0 flex-col gap-3 border-b border-border pb-4 lg:flex-row lg:items-end lg:justify-between">
                    <div className="min-w-0">
                        <div className="text-xs font-medium text-muted-foreground">阶段 04</div>
                        <h2 className="mt-1 text-lg font-semibold">Prompt 与独立视频</h2>
                        <p className="mt-1 text-sm text-muted-foreground">
                            {project.groups.reduce((n, g) => n + g.frames.length, 0)} 个分镜 · {project.groups.length} 条独立视频 · 原时长 {frameRemakeTime(project.durationMs)}
                        </p>
                    </div>
                    <div className="flex shrink-0 flex-wrap items-end gap-2">
                        <ModelControl props={props} kind="analysis" label="Prompt 文本模型" />
                        <ModelControl props={props} kind="video" label="视频模型" />
                        <Button icon={<Download className="size-4" />} loading={exporting} disabled={!productionReady || props.dirty || props.working} onClick={() => void exportBundle()}>
                            下载生产包
                        </Button>
                        <Button type="primary" icon={<Sparkles className="size-4" />} disabled={props.disabled || !ready.images} onClick={() => void props.onControl("start", true, promptsReady ? { restartFrom: "videoPrompt" } : undefined)}>
                            {promptsReady ? "重新生成视频 Prompt" : "生成视频 Prompt"}
                        </Button>
                    </div>
                </div>
                <div className="space-y-3 border-b py-4">
                    <div className="text-sm font-semibold">成片声音</div>
                    <Segmented
                        disabled={props.editingDisabled}
                        value={display.audioMode}
                        options={[
                            { label: "保留原声", value: "source" },
                            { label: "模型声音", value: "generated" },
                            { label: "静音", value: "silent" },
                        ]}
                        onChange={(value) => props.onChange({ audioMode: value as typeof display.audioMode })}
                    />
                    <p className="text-xs text-muted-foreground">原版生成15秒视频。尾段合成时使用完整视频调整到原片剩余时长，保留原声时使用原片音轨。</p>
                </div>
                {!ready.images && <div className="border-b bg-amber-50 px-3 py-2.5 text-xs text-amber-800">请先完成第一步模板图和最终分镜图，再生成视频提示词。</div>}
                <div className="grid min-w-0 gap-4 py-4 xl:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
                    <section className="min-w-0 rounded-lg border border-border bg-card" aria-label="原文案">
                        <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2.5">
                            <div className="flex items-center gap-2 text-sm font-semibold">
                                <FileText className="size-4" />
                                原文案（选填）
                            </div>
                            <Button type="text" size="small" icon={<Copy className="size-3.5" />} aria-label="复制原文案（选填）输出" onClick={() => copyText(report)} />
                        </div>
                        <div className="p-3">
                            <Input.TextArea readOnly value={report} autoSize={{ minRows: 24, maxRows: 42 }} />
                        </div>
                    </section>
                    <section className="min-w-0" aria-label="视频提示词与视频">
                        <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
                            <div className="flex items-center gap-2 text-sm font-semibold">
                                <Video className="size-4" />
                                视频提示词与成片
                            </div>
                            <Button size="small" icon={<Copy className="size-3.5" />} disabled={!promptsReady} onClick={() => copyText(display.groups.map((g) => g.videoPrompt).join("\n\n"))}>
                                复制视频 Prompt
                            </Button>
                        </div>
                        <div className="grid gap-3">
                            {display.groups.map((g) => (
                                <div key={g.id} className="space-y-2">
                                    <VideoGroupCard
                                        group={{
                                            id: `${g.frames[0].number}–${g.frames.at(-1)!.number}`,
                                            ordinal: g.number,
                                            imageGeneration: { ...g.image, prompt: g.image.prompt || "" },
                                            videoGeneration: { ...g.video, needsReview: g.video.status === "running" && Boolean(g.video.error) },
                                            videoPrompt: g.videoPrompt,
                                            videoPromptInstructions: undefined,
                                        }}
                                        description={`原片 ${frameRemakeSeconds(g)} 秒 · 12个镜头 · 生成15秒 · ${frameRemakeAspectRatio(project)}`}
                                        defaultInstructions={frameRemakeTemplates(display, g).video}
                                        instructionsReadOnly
                                        instructionsDisabled={true}
                                        instructionsDirty={props.dirty}
                                        onInstructionsChange={() => undefined}
                                        onSaveInstructions={props.onSave}
                                        building={project.operation?.groupId === g.id && project.operation.analysisStage === "videoPrompt"}
                                        promptDisabled={props.disabled || !ready.images}
                                        disabled={props.disabled || !g.videoPrompt || !g.image.result}
                                        onBuild={() => void props.onOperation("analyze", g.id, "videoPrompt")}
                                        onGenerate={() => void (g.video.status === "running" && g.video.error ? props.onRefresh() : props.onGenerate(g.id, "video"))}
                                        onCopy={copyText}
                                    />
                                    {g.analysisSteps?.videoPrompt?.prompt && (
                                        <details className="rounded border p-3">
                                            <summary className="cursor-pointer text-xs">实际发送的视频提示词生成输入</summary>
                                            <TextOutput title="原版模型输入" text={g.analysisSteps.videoPrompt.prompt} name={`${g.id}-video-prompt-input`} />
                                        </details>
                                    )}
                                </div>
                            ))}
                        </div>
                    </section>
                </div>
                <section className="space-y-3 border-t border-border pt-4" aria-label="原时长成片">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                            <h2 className="text-sm font-semibold">合成原时长成片</h2>
                            <p className="mt-1 text-xs text-muted-foreground">按分镜顺序合并，目标 {frameRemakeTime(project.durationMs)}。</p>
                        </div>
                        <Button type="primary" disabled={props.disabled || !productionReady} onClick={() => void props.onOperation("merge")}>
                            合成成片
                        </Button>
                    </div>
                    {project.mergedVideo && <Media media={project.mergedVideo} label="复刻成片" downloadLabel="下载成片" />}
                </section>
            </div>
        </section>
    );
}
