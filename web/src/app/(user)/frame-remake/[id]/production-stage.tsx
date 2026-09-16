"use client";
import { App, Button, Input, Segmented, Tag } from "antd";
import { useState } from "react";
import copy from "copy-to-clipboard";
import { Copy, Download, FileAudio, FileText, Sparkles, Video, VolumeX } from "lucide-react";
import { frameRemakeHasNarration, frameRemakeTime, frameRemakeSeconds, frameRemakeAspectRatio } from "@/lib/frame-remake-contract";
import { frameRemakeTemplates } from "@/lib/frame-remake-prompt-templates";
import { frameRemakeWorkflowReadiness } from "@/lib/frame-remake-steps";
import { VideoGroupCard } from "../../remake15/[id]/remake-production-stage";
import { ModelControl, type WorkflowProps } from "./workflow-controls";
import { downloadFrameRemakeProductionBundle } from "./production-export";
import { Media } from "./outputs";
export function FrameProductionStage(props: WorkflowProps) {
    const { project, display } = props,
        ready = frameRemakeWorkflowReadiness(project);
    const { message } = App.useApp();
    const [exporting, setExporting] = useState(false);
    const promptsReady = project.groups.length > 0 && project.groups.every((g) => g.videoPrompt);
    const productionReady = ready.images && promptsReady && project.groups.every((g) => g.video.status === "completed" && g.video.result);
    const noNarration = !frameRemakeHasNarration(display);
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
                        <div className="text-xs font-medium text-muted-foreground">阶段 03</div>
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
                <div className="grid gap-4 border-b border-border py-4 lg:grid-cols-[minmax(0,1fr)_360px]">
                    <div className="min-w-0">
                        <div className="flex items-center gap-2 text-sm font-semibold">
                            {noNarration ? <VolumeX className="size-4" /> : <FileAudio className="size-4" />}
                            {noNarration ? "口播设置" : "配音选择"}
                        </div>
                        {noNarration ? (
                            <>
                                <Tag className="!mt-2">不需要人物口播</Tag>
                                <p className="mt-2 text-xs leading-5 text-muted-foreground">保留连续分镜动作，不添加口播、配音或音频引用。</p>
                            </>
                        ) : (
                            <>
                                <Segmented
                                    className="!mt-2 !w-full sm:!w-auto"
                                    disabled={props.editingDisabled}
                                    value={display.audioMode === "generated" ? display.voice || "female" : undefined}
                                    options={[
                                        { label: "女性配音", value: "female" },
                                        { label: "男性配音", value: "male" },
                                    ]}
                                    onChange={(value) => props.onChange({ voice: value === "male" ? "male" : "female", audioMode: "generated" })}
                                />
                                <p className="mt-2 text-xs leading-5 text-muted-foreground">视频生成时会把本段原视频音频作为参考音频传入所选视频模型。</p>
                            </>
                        )}
                        <details className="mt-3 text-xs">
                            <summary className="cursor-pointer text-muted-foreground">成片声音设置</summary>
                            <Segmented
                                className="!mt-2"
                                disabled={props.editingDisabled}
                                value={display.audioMode}
                                options={[
                                    { label: "使用配音", value: "generated" },
                                    { label: "保留原声", value: "source" },
                                    { label: "静音", value: "silent" },
                                ]}
                                onChange={(value) => props.onChange({ audioMode: value as typeof display.audioMode })}
                            />
                        </details>
                    </div>
                    <div className="flex min-w-0 items-center gap-3 rounded-lg border border-border bg-card p-3">
                        <div className="grid size-10 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
                            <FileAudio className="size-4.5" />
                        </div>
                        <div className="min-w-0 flex-1">
                            <div className="text-sm font-medium">原视频音频</div>
                            <div className="mt-0.5 text-xs text-muted-foreground">{noNarration ? "当前流程无需参考音频" : `${project.groups.filter((g) => g.sourceAudio).length} / ${project.groups.length} 段已提取；生成 Prompt 时自动补齐`}</div>
                        </div>
                        <Tag className="!m-0">{noNarration ? "无需" : project.groups.every((g) => g.sourceAudio) ? "就绪" : "待提取"}</Tag>
                    </div>
                </div>
                {!ready.images && <div className="border-b bg-amber-50 px-3 py-2.5 text-xs text-amber-800">请先完成两步换品分镜图，再生成视频 Prompt。</div>}
                <div className="grid min-w-0 gap-4 py-4 xl:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
                    <section className="min-w-0 rounded-lg border border-border bg-card" aria-label="文案预处理报告">
                        <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2.5">
                            <div className="flex items-center gap-2 text-sm font-semibold">
                                <FileText className="size-4" />
                                文案预处理
                            </div>
                            <Button type="text" size="small" icon={<Copy className="size-3.5" />} aria-label="复制文案预处理输出" onClick={() => copyText(report)} />
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
                                <VideoGroupCard
                                    key={g.id}
                                    group={{
                                        id: `${g.frames[0].number}–${g.frames.at(-1)!.number}`,
                                        ordinal: g.number,
                                        imageGeneration: { ...g.image, prompt: g.image.prompt || "" },
                                        videoGeneration: { ...g.video, needsReview: g.video.status === "running" && Boolean(g.video.error) },
                                        videoPrompt: g.videoPrompt,
                                        videoPromptInstructions: g.videoPromptInstructions,
                                    }}
                                    description={`${frameRemakeSeconds(g)} 秒 · ${g.frames.length} 个连续镜头 · ${frameRemakeAspectRatio(project)} · 独立文件`}
                                    defaultInstructions={frameRemakeTemplates(display, g).video}
                                    instructionsDisabled={props.editingDisabled}
                                    instructionsDirty={props.dirty}
                                    onInstructionsChange={(value) => props.onChange({ group: { id: g.id, videoPromptInstructions: value } })}
                                    onSaveInstructions={props.onSave}
                                    building={project.operation?.groupId === g.id && project.operation.analysisStage === "videoPrompt"}
                                    promptDisabled={props.disabled || !ready.images}
                                    disabled={props.disabled || !g.videoPrompt || !g.image.result}
                                    onBuild={() => void props.onOperation("analyze", g.id, "videoPrompt")}
                                    onGenerate={() => void (g.video.status === "running" && g.video.error ? props.onRefresh() : props.onGenerate(g.id, "video"))}
                                    onCopy={copyText}
                                />
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
