"use client";
import { Button, Segmented, Tag } from "antd";
import { FileAudio, FileText, Video } from "lucide-react";
import { frameRemakeTime } from "@/lib/frame-remake-contract";
import { frameRemakeWorkflowReadiness } from "@/lib/frame-remake-steps";
import { ModelControl, ScriptResult, type WorkflowProps } from "./workflow-controls";
import { GenerationControl } from "./image-stage";
import { Media, TextOutput } from "./outputs";
export function FrameProductionStage(props: WorkflowProps) {
    const { project, display } = props,
        ready = frameRemakeWorkflowReadiness(project),
        promptsReady = project.groups.length > 0 && project.groups.every((g) => g.videoPrompt);
    return (
        <section className="h-full min-h-0 overflow-y-auto bg-background" aria-label="生产内容">
            <div className="mx-auto w-full max-w-[1480px] px-3 py-4 sm:px-5 sm:py-5">
                <header className="flex flex-col gap-3 border-b pb-4 lg:flex-row lg:items-end lg:justify-between">
                    <div>
                        <p className="text-xs font-medium text-muted-foreground">阶段 03</p>
                        <h1 className="mt-1 text-lg font-semibold">Prompt 与独立视频</h1>
                        <p className="mt-1 text-sm text-muted-foreground">
                            {project.groups.reduce((n, g) => n + g.frames.length, 0)} 个分镜 · {project.groups.length} 条分段视频 · 原时长 {frameRemakeTime(project.durationMs)}
                        </p>
                    </div>
                    <div className="flex flex-wrap items-end gap-2">
                        <ModelControl props={props} kind="analysis" label="Prompt 文本模型" />
                        <ModelControl props={props} kind="video" label="视频模型" />
                        <Button type="primary" disabled={props.disabled || !ready.images || promptsReady} onClick={() => void props.onControl("start", true)}>
                            生成视频 Prompt
                        </Button>
                    </div>
                </header>
                <div className="grid gap-4 border-b py-4 lg:grid-cols-[minmax(0,1fr)_360px]">
                    <div>
                        <h2 className="flex items-center gap-2 text-sm font-semibold">
                            <FileAudio className="size-4" />
                            声音设置
                        </h2>
                        <Segmented
                            className="!mt-2"
                            disabled={props.editingDisabled}
                            value={display.audioMode}
                            options={[
                                { label: "保留原声", value: "source" },
                                { label: "生成声音", value: "generated" },
                                { label: "静音", value: "silent" },
                            ]}
                            onChange={(value) => props.onChange({ audioMode: value as typeof project.audioMode })}
                        />
                        <p className="mt-2 text-xs leading-5 text-muted-foreground">保留原声时，成片使用原视频音轨；无口播内容不新增台词。</p>
                    </div>
                    <div className="rounded-lg border bg-card p-3">
                        <p className="text-sm font-medium">原视频音频</p>
                        {project.sourceVideo && <audio src={project.sourceVideo.url} controls preload="none" className="mt-2 h-8 w-full" aria-label="原视频音频" />}
                    </div>
                </div>
                {!ready.images && <p className="border-b bg-amber-50 px-3 py-2 text-xs text-amber-800">先完成分镜图，再读取最终图生成视频提示词。</p>}
                <div className="grid min-w-0 gap-4 py-4 xl:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
                    <section className="min-w-0 rounded-lg border bg-card" aria-label="文案预处理报告">
                        <h2 className="flex items-center gap-2 border-b px-3 py-2.5 text-sm font-semibold">
                            <FileText className="size-4" />
                            文案预处理
                        </h2>
                        <div className="space-y-3 p-3">
                            {display.groups.map((g) => (
                                <div key={g.id}>
                                    <h3 className="mb-2 text-xs font-medium">
                                        第 {g.number} 组 · {g.startMs / 1000}–{g.endMs / 1000} 秒
                                    </h3>
                                    {g.copy ? <TextOutput title="完整报告" text={g.copy} name={`${g.id}-copy-report`} /> : <p className="text-xs text-muted-foreground">尚未完成文案处理</p>}
                                </div>
                            ))}
                        </div>
                    </section>
                    <section className="min-w-0" aria-label="视频提示词与视频">
                        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
                            <Video className="size-4" />
                            分段视频提示词与成片
                        </h2>
                        <div className="space-y-4">
                            {display.groups.map((g) => (
                                <article key={g.id} className="min-w-0 overflow-hidden rounded-lg border bg-card">
                                    <header className="flex items-center justify-between border-b p-3">
                                        <h3 className="text-sm font-semibold">
                                            第 {g.number} 组 · {g.startMs / 1000}–{g.endMs / 1000} 秒
                                        </h3>
                                        <Tag className="!m-0">{(g.endMs - g.startMs) / 1000} 秒</Tag>
                                    </header>
                                    <div className="p-3">
                                        <ScriptResult props={props} group={g} stage="videoPrompt" />
                                        <div className="mt-3 grid gap-3 sm:grid-cols-[110px_minmax(0,1fr)]">
                                            <div>{g.image.result && <Media media={g.image.result} label={`第${g.number}组最终分镜图`} />}</div>
                                            <div className="space-y-3">
                                                {g.video.result && <Media media={g.video.result} label={`第${g.number}组视频`} />}
                                                <GenerationControl props={props} group={g} kind="video" />
                                                {g.video.prompt && (
                                                    <details>
                                                        <summary className="cursor-pointer text-xs">实际提交的视频生成提示词</summary>
                                                        <TextOutput title="生成输入" text={g.video.prompt} name={`${g.id}-video-input`} />
                                                    </details>
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                </article>
                            ))}
                        </div>
                    </section>
                </div>
                <section className="space-y-3 border-t pt-4" aria-label="原时长成片">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                            <h2 className="text-sm font-semibold">合成原时长成片</h2>
                            <p className="mt-1 text-xs text-muted-foreground">按分组顺序合并，目标 {frameRemakeTime(project.durationMs)}。</p>
                        </div>
                        <Button type="primary" disabled={props.disabled || !project.groups.length || project.groups.some((g) => g.video.status !== "completed" || !g.video.result)} onClick={() => void props.onOperation("merge")}>
                            合成成片
                        </Button>
                    </div>
                    {project.mergedVideo && <Media media={project.mergedVideo} label="复刻成片" downloadLabel="下载成片" />}
                </section>
            </div>
        </section>
    );
}
