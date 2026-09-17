"use client";
import Link from "next/link";
import { Button, Input } from "antd";
import { useState } from "react";
import { ArrowLeft, Check, FileOutput, Images, PanelLeft, Pause, RefreshCw, Save, SlidersHorizontal, Video, WandSparkles } from "lucide-react";
import { frameRemakeWorkflowReadiness } from "@/lib/frame-remake-steps";
import { FrameSourceStage } from "./source-stage";
import { FramePlanningStage } from "./planning-stage";
import { FrameImageStage } from "./image-stage";
import { FrameProductionStage } from "./production-stage";
import type { WorkflowProps } from "./workflow-controls";
export function FrameRemakeWorkflow(props: WorkflowProps) {
    const { project, display, stage, dirty } = props,
        ready = frameRemakeWorkflowReadiness(project),
        running = project.automation?.status === "running";
    const pendingTasks = project.groups.flatMap((group) => (["template", "image", "video"] as const).filter((kind) => group[kind].status === "queued" || group[kind].status === "running").map((kind) => ({ group, kind })));
    const queued = pendingTasks.some(({ group, kind }) => group[kind].status === "queued");
    const paused = project.automation?.status === "paused";
    const canPause = running || Boolean(project.operation) || (pendingTasks.length > 0 && !paused);
    const flowStage = stage === "planning" ? "images" : stage;
    const [sourceOpen, setSourceOpen] = useState(false),
        [editorOpen, setEditorOpen] = useState(false);
    const tabs = [
        { key: "analysis", label: "来源分析", icon: Video },
        { key: "images", label: "十二宫格重绘", icon: Images },
        { key: "production", label: "生产内容", icon: FileOutput },
    ] as const;
    return (
        <main className="flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground" aria-label="原时长电商复刻工作区">
            <header className="flex h-14 shrink-0 items-center justify-between gap-2 border-b bg-card px-2 sm:px-3">
                <div className="flex min-w-0 items-center gap-1.5">
                    <Link
                        href="/frame-remake"
                        aria-label="返回复刻项目"
                        className="rounded-full p-2"
                        onClick={(e) => {
                            if (dirty && !confirm("修改尚未保存，确认返回？")) e.preventDefault();
                        }}
                    >
                        <ArrowLeft className="size-4" />
                    </Link>
                    <Input
                        variant="borderless"
                        className="!w-[min(38vw,320px)] !px-1 !text-sm !font-semibold sm:!text-base"
                        value={display.title}
                        maxLength={160}
                        disabled={props.editingDisabled}
                        aria-label="项目名称"
                        onChange={(e) => props.onChange({ title: e.target.value })}
                    />
                    <span className="hidden text-[11px] text-muted-foreground sm:inline">{props.saving ? "正在保存…" : dirty ? "等待自动保存" : "已保存"}</span>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                    {stage === "analysis" && (
                        <>
                            <Button type="text" shape="circle" className="min-[1200px]:!hidden" icon={<PanelLeft className="size-4" />} aria-label="打开来源视频与原文案" onClick={() => setSourceOpen(true)} />
                            <Button type="text" shape="circle" className="min-[1200px]:!hidden" icon={<SlidersHorizontal className="size-4" />} aria-label="打开当前单元编辑器" onClick={() => setEditorOpen(true)} />
                        </>
                    )}
                    <Button type="text" shape="circle" icon={<RefreshCw className="size-4" />} aria-label="刷新项目" disabled={props.working} onClick={() => void props.onRefresh()} />
                    {dirty && props.error && (
                        <Button icon={<Save className="size-4" />} disabled={props.editingDisabled} onClick={() => void props.onSave()}>
                            保存
                        </Button>
                    )}
                    {canPause ? (
                        <Button icon={<Pause className="size-4" />} loading={props.controlling} disabled={props.controlling} onClick={() => void props.onControl("pause")}>
                            暂停
                        </Button>
                    ) : stage === "analysis" ? (
                        <Button
                            type="primary"
                            className="!h-9 !px-2.5 sm:!px-3"
                            icon={<WandSparkles className="size-4" />}
                            disabled={props.disabled || !project.sourceVideo}
                            onClick={() => void props.onControl("start", false, ready.analysis ? { restartFrom: "analysis" } : undefined)}
                            aria-label={project.error ? "重试分析" : ready.analysis ? "重新分析" : "开始分析"}
                        >
                            <span className="hidden sm:inline">{project.error ? "重试分析" : ready.analysis ? "重新分析" : "开始分析"}</span>
                        </Button>
                    ) : null}
                    {!running && stage === "analysis" && !ready.analysis && (
                        <Button size="small" disabled={props.disabled || !project.sourceVideo} onClick={() => void props.onControl("step")}>
                            执行下一步
                        </Button>
                    )}
                </div>
            </header>
            <nav className="flex h-12 shrink-0 items-stretch overflow-x-auto border-b bg-card px-1 sm:justify-center sm:px-3" aria-label="原时长复刻流程">
                {tabs.map((tab, i) => {
                    const Icon = tab.icon;
                    return (
                        <button
                            key={tab.key}
                            aria-current={flowStage === tab.key ? "step" : undefined}
                            className={`flex min-w-[120px] flex-1 items-center justify-center gap-2 border-b-2 px-2 text-xs font-medium transition sm:max-w-52 sm:min-w-[184px] ${flowStage === tab.key ? "border-foreground" : "border-transparent text-muted-foreground hover:bg-muted/30"}`}
                            onClick={() => {
                                props.onStage(tab.key === "images" ? (stage === "planning" || stage === "images" ? stage : ready.planning ? "images" : "planning") : tab.key);
                                setSourceOpen(false);
                                setEditorOpen(false);
                            }}
                        >
                            <span
                                className={`grid size-6 shrink-0 place-items-center rounded-full border ${ready[tab.key] ? "border-emerald-600 bg-emerald-600 text-white" : flowStage === tab.key ? "border-foreground bg-foreground text-background" : "border-border"}`}
                            >
                                {ready[tab.key] ? <Check className="size-3.5" /> : i + 1}
                            </span>
                            <Icon className="hidden size-4 sm:block" />
                            <span className="whitespace-nowrap">{tab.label}</span>
                        </button>
                    );
                })}
            </nav>
            {(props.error || project.error || pendingTasks.length > 0 || running || paused || project.operation) && (
                <div className="max-h-40 shrink-0 overflow-y-auto border-b px-3 py-2 text-xs leading-5">
                    {(props.error || project.error) && (
                        <p role="alert" className="text-destructive">
                            {props.error || project.error}
                        </p>
                    )}
                    {queued && !running && !paused && (
                        <Button size="small" disabled={props.working || props.controlling} onClick={() => void props.onControl("start")}>
                            检查并继续原任务
                        </Button>
                    )}
                    {(running || project.operation) && <p role="status">{project.operation?.progress || project.automation?.progress}</p>}
                    {paused && <p role="status">{pendingTasks.length ? "后续步骤已暂停。已提交任务仍在处理，可在下方单独取消；已有素材和结果会保留。" : "已暂停，已有素材和结果已保留。"}</p>}
                    {pendingTasks.map(({ group, kind }) => (
                        <div key={`${group.id}:${kind}`} className="flex flex-wrap items-center justify-between gap-2 py-1">
                            <span>第 {group.number} 组 · {kind === "template" ? "第一步模板图" : kind === "image" ? "最终分镜图" : "视频"} · {group[kind].status === "queued" ? "等待确认" : "生成中"}</span>
                            {running ? <span className="text-muted-foreground">暂停后可取消本次任务</span> : (
                                <Button size="small" disabled={props.controlling} onClick={() => void props.onAbandon(group.id, kind)}>
                                    取消本次任务
                                </Button>
                            )}
                        </div>
                    ))}
                </div>
            )}
            <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
                {stage === "analysis" ? (
                    <FrameSourceStage {...props} sourceOpen={sourceOpen} editorOpen={editorOpen} onSourceClose={() => setSourceOpen(false)} onEditorClose={() => setEditorOpen(false)} />
                ) : flowStage === "images" ? (
                    <section className="flex h-full min-h-0 flex-col" aria-label="十二宫格重绘工作区">
                        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-card px-3 py-2" aria-label="重绘步骤">
                            <Button size="small" type={stage === "planning" ? "primary" : "default"} onClick={() => props.onStage("planning")}>
                                1. 分镜脚本{ready.planning ? " · 已完成" : ""}
                            </Button>
                            <Button size="small" type={stage === "images" ? "primary" : "default"} onClick={() => props.onStage("images")}>
                                2. 分镜重绘{ready.images ? " · 已完成" : ""}
                            </Button>
                        </div>
                        <div className="min-h-0 flex-1 overflow-hidden">
                            {stage === "planning" ? <FramePlanningStage {...props} /> : <FrameImageStage {...props} />}
                        </div>
                    </section>
                ) : (
                    <FrameProductionStage {...props} />
                )}
            </div>
        </main>
    );
}
