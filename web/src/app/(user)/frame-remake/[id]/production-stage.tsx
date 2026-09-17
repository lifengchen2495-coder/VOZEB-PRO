"use client";
import { App, Button, Input, Segmented } from "antd";
import { useState } from "react";
import copy from "copy-to-clipboard";
import { Copy, Download, FileText, Sparkles, Video } from "lucide-react";
import { frameRemakeTime, frameRemakeSeconds, frameRemakeAspectRatio, frameRemakeGenerationSeconds } from "@/lib/frame-remake-contract";
import { frameRemakeMissingPromptFields, frameRemakeTemplates } from "@/lib/frame-remake-prompt-templates";
import { frameRemakeWorkflowReadiness } from "@/lib/frame-remake-steps";
import { VideoGroupCard } from "../../remake15/[id]/remake-production-stage";
import { ModelControl, ScriptResult, type WorkflowProps } from "./workflow-controls";
import { downloadFrameRemakeProductionBundle } from "./production-export";
import { Media, TextOutput } from "./outputs";
import { frameRemakeGroupCopyText } from "./copy-text";
import { frameRemakePromptPreview } from "./workflow-source";
export function FrameProductionStage(props: WorkflowProps) {
    const { project, display } = props,
        ready = frameRemakeWorkflowReadiness(project);
    const { message } = App.useApp();
    const [exporting, setExporting] = useState(false);
    const promptsReady = project.groups.length > 0 && project.groups.every((g) => g.videoPrompt);
    const copyReady = project.groups.length > 0 && project.groups.every((g) => g.copy?.trim());
    const copyInputMissing = display.copyMode === "custom" && !display.copyInstructions?.trim();
    const missingSource = frameRemakeMissingPromptFields(display).length > 0;
    const nextCopyGroup = project.groups.find((g) => !g.copy?.trim());
    const productionReady = ready.images && promptsReady && project.groups.every((g) => g.video.status === "completed" && g.video.result);
    const report = display.groups.map((g) => `=== 分镜 ${g.frames[0].number}–${g.frames.at(-1)!.number} ===\n${g.copy || "尚未执行文案预处理"}`).join("\n\n");
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
                        <h2 className="mt-1 text-lg font-semibold">文案预处理 → 视频提示词 → 视频生成</h2>
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
                        <Button type="primary" icon={<Sparkles className="size-4" />} disabled={props.disabled || !ready.images || !copyReady || copyInputMissing || missingSource} onClick={() => void props.onControl("start", true, promptsReady ? { restartFrom: "videoPrompt" } : undefined)}>
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
                    <p className="text-xs text-muted-foreground">分组生成视频后，按原片时长合成。各组生成时长按所选模型支持范围确定，成片对齐原片时间；保留原声时使用原片音轨。</p>
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                        <span>飞书配音选择</span>
                        <Segmented size="small" disabled={props.editingDisabled} value={display.voice || "female"} options={[{ label: "女声", value: "female" }, { label: "男声", value: "male" }]} onChange={(value) => props.onChange({ voice: value as "female" | "male" })} />
                    </div>
                    {display.sourceCopy?.trim() === "不需要人物口播" && (
                        <div className="space-y-2">
                            <p role="status" className="text-xs text-muted-foreground">当前项目已设置“不需要人物口播”，提取和校对文案不用于生成口播。恢复使用文案后，请重新生成视频 Prompt。</p>
                            <Button size="small" disabled={props.editingDisabled} onClick={() => props.onChange({ sourceCopy: "" })}>
                                恢复使用文案
                            </Button>
                        </div>
                    )}
                </div>
                {!ready.images && <div className="border-b bg-amber-50 px-3 py-2.5 text-xs text-amber-800">请先完成十二宫格重绘，再依次执行文案预处理和视频提示词。</div>}
                <div className="grid min-w-0 gap-4 py-4 xl:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
                    <section className="min-w-0 rounded-lg border border-border bg-card" aria-label="文案预处理">
                        <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2.5">
                            <div className="flex items-center gap-2 text-sm font-semibold">
                                <FileText className="size-4" />
                                1. 文案预处理
                            </div>
                            <Button type="text" size="small" icon={<Copy className="size-3.5" />} aria-label="复制文案预处理结果" disabled={!display.groups.some((g) => g.copy?.trim())} onClick={() => copyText(report)} />
                        </div>
                        <div className="space-y-3 p-3">
                            <p className="text-xs leading-5 text-muted-foreground">按飞书原文处理本组原文案和镜头分析。每组保留完整结果，确认后再生成视频提示词。</p>
                            <label className="grid gap-2 text-xs">
                                <span className="font-medium">原表文案选项</span>
                                <Segmented block disabled={props.editingDisabled} value={display.copyMode || "original"} options={[{ label: "A · 保持原文", value: "original" }, { label: "B · 自定义优化", value: "custom" }]} onChange={(value) => props.onChange({ copyMode: value as "original" | "custom" })} />
                            </label>
                            {display.copyMode === "custom" && <label className="grid gap-2 text-xs">
                                <span className="font-medium">自定义优化需求</span>
                                <Input.TextArea aria-label="文案自定义优化需求" rows={4} maxLength={20000} value={display.copyInstructions || ""} disabled={props.editingDisabled} placeholder="填写你的文案优化需求，按原表选项 B 处理。" onChange={(event) => props.onChange({ copyInstructions: event.target.value })} />
                            </label>}
                            {copyInputMissing && <p role="status" className="text-xs text-amber-700">请先填写自定义优化需求。</p>}
                            {nextCopyGroup && <Button size="small" disabled={props.disabled || !ready.images || copyInputMissing || missingSource} onClick={() => void props.onOperation("analyze", nextCopyGroup.id, "copy")}>预处理第 {nextCopyGroup.number} 组文案</Button>}
                            {display.groups.map((group) => (
                                <div key={group.id} className="space-y-2">
                                    <h3 className="text-sm font-medium">第 {group.number} 组 · {frameRemakeTime(group.startMs)}—{frameRemakeTime(group.endMs)}</h3>
                                    <ScriptResult props={{ ...props, disabled: props.disabled || copyInputMissing }} group={group} stage="copy" />
                                    {group.copy && <p className="text-xs text-muted-foreground">{frameRemakeGroupCopyText(display, group) ? "本组处理结果已保存，将绑定到视频提示词。" : "本组已设置不需要人物口播。"}</p>}
                                </div>
                            ))}
                        </div>
                    </section>
                    <section className="min-w-0" aria-label="视频提示词与视频">
                        <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
                            <div className="flex items-center gap-2 text-sm font-semibold">
                                <Video className="size-4" />
                                2. 视频提示词与成片
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
                                        description={`原片 ${frameRemakeSeconds(g)} 秒 · ${g.frames.length}个镜头 · ${g.video.seconds ? "实际生成" : "预计生成"} ${g.video.seconds || frameRemakeGenerationSeconds(g)} 秒 · ${frameRemakeAspectRatio(project)}`}
                                        defaultInstructions={frameRemakePromptPreview(() => frameRemakeTemplates(display, g).video)}
                                        instructionsReadOnly
                                        instructionsDisabled={true}
                                        instructionsDirty={props.dirty}
                                        onInstructionsChange={() => undefined}
                                        onSaveInstructions={props.onSave}
                                        building={project.operation?.groupId === g.id && project.operation.analysisStage === "videoPrompt"}
                                        promptDisabled={props.disabled || !ready.images || !g.copy?.trim() || copyInputMissing || missingSource}
                                        disabled={props.disabled || !g.videoPrompt || !g.image.result || copyInputMissing || missingSource}
                                        onBuild={() => void props.onOperation("analyze", g.id, "videoPrompt")}
                                        onGenerate={() => void (g.video.status === "running" && g.video.error ? props.onRefresh() : props.onGenerate(g.id, "video"))}
                                        onCopy={copyText}
                                    />
                                    <details className="rounded border p-3">
                                        <summary className="cursor-pointer text-xs">编辑视频提示词</summary>
                                        <Input.TextArea className="!mt-2" aria-label={`编辑第${g.number}组视频提示词`} value={g.videoPrompt} rows={7} maxLength={30000} disabled={props.editingDisabled} onChange={(event) => props.onEditGroup("videoPrompt", event.target.value, g.id)} />
                                    </details>
                                    {g.analysisSteps?.videoPrompt?.prompt && (
                                        <details className="rounded border p-3">
                                            <summary className="cursor-pointer text-xs">实际发送的视频提示词生成输入</summary>
                                            <TextOutput title="模型输入" text={g.analysisSteps.videoPrompt.prompt} name={`${g.id}-video-prompt-input`} />
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
                        <Button type="primary" disabled={props.disabled || !productionReady || missingSource} onClick={() => void props.onOperation("merge")}>
                            合成成片
                        </Button>
                    </div>
                    {project.mergedVideo && <Media media={project.mergedVideo} label="复刻成片" downloadLabel="下载成片" />}
                </section>
            </div>
        </section>
    );
}
