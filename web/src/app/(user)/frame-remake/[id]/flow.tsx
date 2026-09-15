"use client";

import copy from "copy-to-clipboard";
import { Check, ChevronDown, Circle, CircleAlert, Copy, Download, LoaderCircle, Pause, Play, Sparkles } from "lucide-react";
import { useState, type ReactNode } from "react";
import { frameRemakeBusy, frameRemakeTime, type FrameRemakeMedia, type FrameRemakeProject, type FrameRemakeTask } from "@/lib/frame-remake-contract";
import { Button } from "../../bangbang/controls";

export function FrameRemakeFlow({ project, disabled, control }: { project: FrameRemakeProject; disabled: boolean; control: (action: "start" | "pause") => Promise<void> }) {
    const running = project.automation?.status === "running";
    const extracted = project.groups.length > 0 && project.groups.every((group) => group.contactSheet && group.frames.every((frame) => frame.media));
    const analyzed = extracted && project.groups.every((group) => group.analysis && group.imagePrompt && group.videoPrompt);
    const frameCount = project.groups.reduce((sum, group) => sum + group.frames.length, 0);
    const savedFrameCount = project.groups.reduce((sum, group) => sum + group.frames.filter((frame) => frame.media).length, 0);
    const videosReady = project.groups.length > 0 && project.groups.every((group) => group.video.status === "completed");
    return (
        <section className="mx-auto max-w-4xl space-y-7 py-4">
            <div className="ml-auto max-w-xl rounded-2xl rounded-tr-sm bg-muted p-5">
                <p className="whitespace-pre-wrap text-sm leading-7">{project.instructions || "按原视频完整时长复刻，保留原片动作和镜头顺序。"}</p>
                {project.sourceVideo && (
                    <div className="mt-3 flex items-center gap-3 rounded-xl border bg-background p-3">
                        <video src={project.sourceVideo.url} preload="metadata" className="h-20 w-28 rounded-lg bg-black object-contain" />
                        <div className="min-w-0 text-sm">
                            <p className="truncate">{project.sourceVideo.originalName || "原视频"}</p>
                            <p className="mt-1 text-xs text-muted-foreground">{project.durationMs ? frameRemakeTime(project.durationMs) : "等待读取实际时长"}</p>
                        </div>
                    </div>
                )}
            </div>
            <div className="flex gap-3">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                    <Sparkles className="size-5" />
                </div>
                <div className="min-w-0 flex-1 space-y-4">
                    <p className="text-sm leading-7">我会读取原视频，按时间线拆帧和分析，再逐组制作模板图、复刻分镜图与视频，最后合成与原片等长的成片。每一步的文字、图片和视频都会在下方输出，完成一组就展示一组。</p>
                    <div className="flex flex-wrap items-center gap-3">
                        {running ? (
                            <Button variant="outline" disabled={disabled} onClick={() => void control("pause")}>
                                <Pause className="size-4" />
                                暂停后续步骤
                            </Button>
                        ) : (
                            <Button disabled={disabled || !project.sourceVideo || frameRemakeBusy(project) || Boolean(project.mergedVideo)} onClick={() => void control("start")}>
                                <Play className="size-4" />
                                {project.mergedVideo ? "已完成" : project.automation ? "继续执行" : "开始自动复刻"}
                            </Button>
                        )}
                        <span role="status" className="text-xs text-muted-foreground">
                            {project.operation?.progress || project.automation?.progress || "准备就绪后，点击开始"}
                        </span>
                    </div>
                    <p className="text-xs leading-6 text-muted-foreground">后台执行，关闭页面也会继续。分析和生成按所选模型计费；失败时停止，不自动重新收费重试。</p>
                </div>
            </div>
            <div className="ml-4 space-y-5 border-l pl-7">
                <Step title="1. 读取视频信息" done={project.durationMs > 0} active={project.operation?.kind === "extract" && !project.durationMs} error={!project.durationMs ? project.error : undefined}>
                    {project.durationMs > 0 ? (
                        <dl className="grid grid-cols-1 gap-3 rounded-lg border p-4 sm:grid-cols-2">
                            <VideoInfo label="原视频" value={project.sourceVideo?.originalName || "原视频"} />
                            <VideoInfo label="实际时长" value={frameRemakeTime(project.durationMs)} />
                            <VideoInfo label="视频尺寸" value={`${project.sourceVideo?.width} × ${project.sourceVideo?.height}`} />
                            <VideoInfo label="成片目标时长" value={frameRemakeTime(project.durationMs)} />
                            {project.sourceVideo?.mimeType && <VideoInfo label="文件类型" value={project.sourceVideo.mimeType} />}
                            {project.sourceVideo?.bytes !== undefined && <VideoInfo label="文件大小" value={`${(project.sourceVideo.bytes / 1024 / 1024).toFixed(2)} MB`} />}
                        </dl>
                    ) : (
                        <p>等待读取原片，读取后输出实际时长、尺寸和文件信息。</p>
                    )}
                </Step>
                <Step title="2. 按完整时间线拆帧" done={extracted} active={project.operation?.kind === "extract" && project.durationMs > 0} error={project.durationMs > 0 && !extracted ? project.error : undefined}>
                    {project.groups.length > 0 ? (
                        <>
                            <p>
                                划分 {project.groups.length} 组，已输出 {savedFrameCount} / {frameCount} 帧。每张原帧标注采样时刻，编号连续覆盖到原片结尾。
                            </p>
                            <div className="mt-3 space-y-4">
                                {project.groups.map((group) => (
                                    <details key={group.id} open className="rounded-lg border p-4">
                                        <summary className="cursor-pointer font-medium text-foreground">
                                            第 {group.number} 组原帧 · {group.startMs / 1000}–{group.endMs / 1000} 秒 · 已输出 {group.frames.filter((frame) => frame.media).length}/{group.frames.length} 帧
                                        </summary>
                                        {group.contactSheet && (
                                            <div className="mt-4 space-y-2">
                                                <p className="font-medium">本组分镜总览</p>
                                                <Media media={group.contactSheet} label={`第 ${group.number} 组分镜总览`} />
                                            </div>
                                        )}
                                        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                                            {group.frames.map((frame) => (
                                                <div key={frame.number} className="min-w-0 space-y-2">
                                                    <p className="text-xs font-medium">
                                                        第 {frame.number} 帧 · {frame.sampleMs / 1000} 秒
                                                    </p>
                                                    {frame.media ? <Media media={frame.media} label={`原片第 ${frame.number} 帧`} /> : <p className="rounded-lg border border-dashed p-4 text-xs">等待抽取</p>}
                                                </div>
                                            ))}
                                        </div>
                                    </details>
                                ))}
                            </div>
                        </>
                    ) : (
                        <p>读取时长后输出分组时间线、每组总览图和全部单帧图片。</p>
                    )}
                </Step>
                <Step title="3. 分析画面与生成分镜脚本" done={analyzed} active={project.operation?.kind === "analyze"} error={extracted && !analyzed ? project.error : undefined}>
                    <p>沿用已有复刻流程的解析、产品适配、分镜优化和视频提示词模板，按本组实际帧号及秒数执行。</p>
                    <div className="mt-3 space-y-5">
                        {project.groups.map((group) => (
                            <div key={group.id} className="space-y-3">
                                <h4 className="font-medium text-foreground">
                                    第 {group.number} 组 · {group.startMs / 1000}–{group.endMs / 1000} 秒
                                </h4>
                                {group.analysis || group.imagePrompt || group.videoPrompt ? (
                                    <>
                                        {group.analysis && <TextOutput title="画面分析与产品脚本" text={group.analysis} name={`第${group.number}组-画面分析与产品脚本`} />}
                                        {group.imagePrompt && <TextOutput title="分镜脚本与生图提示词" text={group.imagePrompt} name={`第${group.number}组-分镜脚本`} />}
                                        {group.videoPrompt && <TextOutput title="视频生成提示词" text={group.videoPrompt} name={`第${group.number}组-视频生成提示词`} />}
                                    </>
                                ) : (
                                    <p className="rounded-lg border border-dashed p-4">等待本组分析，完成后输出完整画面解析、分镜脚本和视频提示词。</p>
                                )}
                            </div>
                        ))}
                    </div>
                </Step>
                {project.groups.flatMap((group, groupIndex) =>
                    (
                        [
                            ["template", "还原模板、替换人物", "模板图"],
                            ["image", "融合产品与背景", "复刻分镜图"],
                            ["video", "生成本组视频", "分段视频"],
                        ] as const
                    ).map(([kind, label, resultLabel], index) => (
                        <GenerationStep key={`${group.id}-${kind}`} title={`${4 + groupIndex * 3 + index}. 第 ${group.number} 组 · ${label}`} label={`第 ${group.number} 组${resultLabel}`} task={group[kind]}>
                            原片区间 {group.startMs / 1000}–{group.endMs / 1000} 秒，本组采用 {frameRemakeTime(group.endMs - group.startMs)}。
                        </GenerationStep>
                    )),
                )}
                <Step title={`${4 + project.groups.length * 3}. 合成原时长成片`} done={Boolean(project.mergedVideo)} active={project.operation?.kind === "merge"} error={videosReady && !project.mergedVideo ? project.error : undefined}>
                    {project.mergedVideo ? (
                        <div className="space-y-3">
                            <Media media={project.mergedVideo} label="复刻成片" downloadLabel="下载成片" />
                            <p>
                                原片时长：{frameRemakeTime(project.durationMs)}；实际成片：{frameRemakeTime((project.mergedVideo.duration || 0) * 1000)}。
                            </p>
                            <p>合成顺序：{project.groups.map((group) => `第 ${group.number} 组（${group.startMs / 1000}–${group.endMs / 1000} 秒）`).join(" → ")}。</p>
                            <p>声音设置：{project.audioMode === "source" ? "保留原片声音（原片无音轨时输出静音）" : project.audioMode === "generated" ? "使用生成视频的声音" : "静音"}。</p>
                        </div>
                    ) : (
                        <p>所有分组视频完成后，按原片顺序合并，输出可播放和下载的成片及实际时长。</p>
                    )}
                </Step>
            </div>
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <ChevronDown className="size-4" />
                需要调整素材、模型或提示词，可暂停后展开下方详情。
            </p>
        </section>
    );
}
function Step({ title, done, active, error, children }: { title: string; done: boolean; active: boolean; error?: string; children?: ReactNode }) {
    return (
        <article className="relative space-y-3">
            <span className="absolute -left-[39px] top-0 rounded-full bg-background p-1">
                {error ? (
                    <CircleAlert className="size-4 text-destructive" />
                ) : done ? (
                    <Check className="size-4 text-emerald-600" />
                ) : active ? (
                    <LoaderCircle className="size-4 animate-spin text-primary" />
                ) : (
                    <Circle className="size-4 text-muted-foreground/50" />
                )}
            </span>
            <h3 className={`font-medium ${done || active ? "" : "text-muted-foreground"}`}>{title}</h3>
            <div className="min-w-0 text-sm leading-6 text-muted-foreground">{children}</div>
            {error && (
                <p role="alert" className="rounded-lg border border-destructive/30 p-3 text-sm text-destructive">
                    {error}
                </p>
            )}
        </article>
    );
}
function VideoInfo({ label, value }: { label: string; value: string }) {
    return (
        <div className="min-w-0">
            <dt className="text-xs">{label}</dt>
            <dd className="mt-1 break-words text-foreground">{value}</dd>
        </div>
    );
}
function GenerationStep({ title, label, task, children }: { title: string; label: string; task: FrameRemakeTask; children: ReactNode }) {
    return (
        <Step title={title} done={task.status === "completed"} active={task.status === "queued" || task.status === "running"} error={task.error || (task.status === "error" ? "本步生成失败，可检查后继续执行。" : undefined)}>
            <div className="space-y-3">
                <p>{children}</p>
                {task.result ? (
                    <Media media={task.result} label={label} />
                ) : (
                    <p className="rounded-lg border border-dashed p-4">
                        {task.status === "running" ? "正在生成，结果返回后会显示在这里…" : task.status === "queued" ? "正在确认提交…" : task.status === "error" ? "本步暂未生成结果。" : "等待前序步骤，完成后在这里输出结果。"}
                    </p>
                )}
                {task.result?.duration !== undefined && <p>生成视频实际时长：{frameRemakeTime(task.result.duration * 1000)}。</p>}
                {task.prompt && <TextOutput title="实际发送的完整提示词" text={task.prompt} name={`${label}-实际发送提示词`} />}
            </div>
        </Step>
    );
}
function TextOutput({ title, text, name }: { title: string; text: string; name: string }) {
    const [copied, setCopied] = useState("");
    const [copyFailed, setCopyFailed] = useState(false);
    async function copyOutput() {
        let success = false;
        try {
            success = await copy(text);
        } catch {
            /* Keep the full text available for manual selection. */
        }
        setCopied(success ? text : "");
        setCopyFailed(!success);
    }
    function downloadOutput() {
        const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
        const link = document.createElement("a");
        link.href = url;
        link.download = `${name}.txt`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    return (
        <div className="min-w-0 rounded-lg border bg-background p-4">
            <details open>
                <summary className="cursor-pointer font-medium text-foreground">{title}</summary>
                <pre className="mt-3 whitespace-pre-wrap break-words font-sans text-sm leading-7 text-foreground [overflow-wrap:anywhere]">{text}</pre>
            </details>
            <div className="mt-3 flex flex-wrap items-center gap-2 border-t pt-3">
                <Button variant="ghost" aria-label={`复制${name}`} onClick={copyOutput}>
                    <Copy className="size-3.5" />
                    {copied === text ? "已复制" : "复制全文"}
                </Button>
                <Button variant="ghost" aria-label={`下载${name}`} onClick={downloadOutput}>
                    <Download className="size-3.5" />
                    下载文本
                </Button>
                {copyFailed && (
                    <p role="status" className="text-xs text-destructive">
                        复制失败，请选择正文手动复制，或下载文本。
                    </p>
                )}
            </div>
        </div>
    );
}
function Media({ media, label, downloadLabel = "下载" }: { media: FrameRemakeMedia; label: string; downloadLabel?: string }) {
    const video = media.mimeType.startsWith("video/");
    return (
        <div className="min-w-0 space-y-2">
            {video ? (
                <video src={media.url} controls preload="metadata" aria-label={label} className="max-h-[520px] w-full rounded-lg bg-black" />
            ) : (
                <a href={media.url} target="_blank" rel="noreferrer">
                    <img src={media.url} alt={label} loading="lazy" className="max-h-96 w-full rounded-lg border object-contain" />
                </a>
            )}
            <div className="flex flex-wrap items-center gap-3 text-xs">
                <a href={media.url} target="_blank" rel="noreferrer" aria-label={`打开${label}`} className="underline underline-offset-4">
                    {video ? "打开视频" : "查看原图"}
                </a>
                <a href={media.url} download={media.originalName || label} aria-label={`下载${label}`} className="inline-flex items-center gap-1 underline underline-offset-4">
                    <Download className="size-3.5" />
                    {downloadLabel}
                </a>
            </div>
        </div>
    );
}
