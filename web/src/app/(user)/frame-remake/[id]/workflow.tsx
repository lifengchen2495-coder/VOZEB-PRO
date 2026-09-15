"use client";

import Link from "next/link";
import { Drawer } from "antd";
import { useState, type ReactNode } from "react";
import { ArrowLeft, Check, ChevronRight, FileOutput, Images, LoaderCircle, PanelLeft, Pause, Play, RefreshCw, Save, SlidersHorizontal, Upload, Video, X } from "lucide-react";
import { ModelPicker } from "@/components/model-picker";
import { useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import {
    FRAME_REMAKE_ANALYSIS_LABELS,
    frameRemakeAnalysisResult,
    frameRemakeBusy,
    frameRemakeSeconds,
    frameRemakeTime,
    type FrameRemakeAnalysisStage,
    type FrameRemakeGenerationKind,
    type FrameRemakeGroup,
    type FrameRemakeOperationKind,
    type FrameRemakePatch,
    type FrameRemakeProject,
    type FrameRemakeWorkflowStage,
} from "@/lib/frame-remake-contract";
import { frameRemakeWorkflowReadiness } from "@/lib/frame-remake-steps";
import { Button, Field, Textarea } from "../../bangbang/controls";
import { Media, TextOutput } from "./outputs";

const roles = { product: "产品", character: "人物", background: "背景" } as const;
const stageItems = [
    { key: "analysis", label: "来源分析", icon: Video },
    { key: "images", label: "分镜重绘", icon: Images },
    { key: "production", label: "生产内容", icon: FileOutput },
] as const;
const taskLabels = { idle: "待生成", queued: "正在确认提交", running: "生成中", completed: "已完成", error: "生成失败" };
type Props = {
    project: FrameRemakeProject;
    display: FrameRemakeProject;
    group?: FrameRemakeGroup;
    stage: FrameRemakeWorkflowStage;
    dirty: boolean;
    working: boolean;
    editingDisabled: boolean;
    disabled: boolean;
    groupLocked: boolean;
    error: string;
    onStage: (stage: FrameRemakeWorkflowStage) => void;
    onGroup: (id: string) => void;
    onChange: (patch: FrameRemakePatch) => void;
    onEditGroup: (stage: FrameRemakeAnalysisStage, value: string) => void;
    onSave: () => Promise<void>;
    onDiscard: () => void;
    onRefresh: () => Promise<void>;
    onControl: (mode: "start" | "step" | "pause") => Promise<void>;
    onOperation: (kind: FrameRemakeOperationKind, groupId?: string, stage?: FrameRemakeAnalysisStage) => Promise<void>;
    onGenerate: (id: string, kind: FrameRemakeGenerationKind) => Promise<void>;
    onAbandon: (id: string, kind: FrameRemakeGenerationKind) => Promise<void>;
    onUpload: (file: File, role: keyof typeof roles | "video") => Promise<void>;
};
export function FrameRemakeWorkflow(props: Props) {
    const { project, display, group, stage, dirty, working, disabled, editingDisabled } = props;
    const [sourceOpen, setSourceOpen] = useState(false),
        [editorOpen, setEditorOpen] = useState(false);
    const ready = frameRemakeWorkflowReadiness(project),
        running = project.automation?.status === "running";
    const allowed = stage === "analysis" ? Boolean(project.sourceVideo) : stage === "images" ? ready.analysis : ready.images;
    const currentIndex = stageItems.findIndex((item) => item.key === stage);
    const source = <SourcePanel {...props} />;
    const editor = <ScriptPanel {...props} />;
    const frameCount = project.groups.reduce((sum, item) => sum + item.frames.length, 0);
    const changeStage = (stage: FrameRemakeWorkflowStage) => {
        props.onStage(stage);
        setSourceOpen(false);
        setEditorOpen(false);
    };
    return (
        <main className="flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground" aria-label="原时长电商复刻工作区">
            <header className="flex min-h-14 shrink-0 items-center justify-between gap-2 border-b bg-card px-2 py-2 sm:px-3">
                <div className="flex min-w-0 items-center gap-2">
                    <Link
                        href="/frame-remake"
                        aria-label="返回复刻项目"
                        className="shrink-0 rounded p-2 hover:bg-muted"
                        onClick={(event) => {
                            if (dirty && !window.confirm("还有未保存的修改，确认返回项目列表？")) event.preventDefault();
                        }}
                    >
                        <ArrowLeft className="size-4" />
                    </Link>
                    <div className="min-w-0">
                        <input
                            aria-label="项目名称"
                            value={display.title}
                            maxLength={160}
                            disabled={editingDisabled}
                            onChange={(event) => props.onChange({ title: event.target.value })}
                            className="w-full min-w-0 max-w-72 bg-transparent text-sm font-semibold outline-none"
                        />
                        <p className="text-[11px] text-muted-foreground">{project.durationMs ? `原片 ${frameRemakeTime(project.durationMs)} · ${project.groups.length} 组` : "按原片实际时长复刻"}</p>
                    </div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                    <Button variant="ghost" aria-label="刷新项目" disabled={working} onClick={() => void props.onRefresh()}>
                        <RefreshCw className="size-4" />
                    </Button>
                    <Button aria-label="保存修改" disabled={!dirty || editingDisabled} onClick={() => void props.onSave()}>
                        <Save className="size-4" />
                        <span className="hidden sm:inline">保存修改</span>
                    </Button>
                </div>
            </header>
            <nav className="flex shrink-0 items-stretch border-b bg-card sm:justify-center" aria-label="原时长复刻流程">
                {stageItems.map((item, index) => {
                    const Icon = item.icon;
                    return (
                        <button
                            key={item.key}
                            aria-current={stage === item.key ? "step" : undefined}
                            onClick={() => changeStage(item.key)}
                            className={`flex min-w-0 flex-1 items-center justify-center gap-1.5 border-b-2 px-1 py-3 text-xs font-medium sm:max-w-52 sm:gap-2 sm:px-4 ${stage === item.key ? "border-foreground" : "border-transparent text-muted-foreground hover:bg-muted/30"}`}
                        >
                            <span
                                className={`grid size-6 shrink-0 place-items-center rounded-full border ${ready[item.key] ? "border-emerald-600 bg-emerald-600 text-white" : stage === item.key ? "border-foreground bg-foreground text-background" : "border-border"}`}
                            >
                                {ready[item.key] ? <Check className="size-3.5" /> : index + 1}
                            </span>
                            <Icon className="hidden size-4 sm:block" />
                            <span className="whitespace-nowrap">{item.label}</span>
                        </button>
                    );
                })}
            </nav>
            {(props.error || project.error || dirty) && (
                <div className="max-h-28 shrink-0 overflow-y-auto border-b px-3 py-2 text-xs">
                    {(props.error || project.error) && (
                        <p role="alert" className="break-words text-destructive">
                            {props.error || project.error}
                        </p>
                    )}
                    {dirty && (
                        <div className="flex items-center justify-between gap-2">
                            <span>修改尚未保存，保存后再执行。</span>
                            <Button variant="ghost" onClick={props.onDiscard}>
                                放弃修改
                            </Button>
                        </div>
                    )}
                </div>
            )}
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
                <div>
                    <p className="text-[11px] text-muted-foreground">阶段 0{currentIndex + 1}</p>
                    <h1 className="text-sm font-semibold">{stage === "analysis" ? `来源视频理解与${frameCount ? ` ${frameCount} 个` : "全部"}分镜解析` : stage === "images" ? "产品脚本与分镜图重绘" : "视频提示词、分段视频与成片"}</h1>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                    <Button variant="ghost" className="min-[1200px]:hidden" onClick={() => setSourceOpen(true)}>
                        <PanelLeft className="size-4" />
                        {stage === "analysis" ? "来源素材" : "素材设置"}
                    </Button>
                    <Button variant="ghost" className="min-[1200px]:hidden" onClick={() => setEditorOpen(true)}>
                        <SlidersHorizontal className="size-4" />
                        本组脚本
                    </Button>
                    {running ? (
                        <Button variant="outline" disabled={working} onClick={() => void props.onControl("pause")}>
                            <Pause className="size-4" />
                            暂停
                        </Button>
                    ) : (
                        <>
                            <Button variant="outline" disabled={disabled || !allowed || ready[stage]} onClick={() => void props.onControl("step")}>
                                只执行下一步
                            </Button>
                            <Button disabled={disabled || !allowed || ready[stage]} onClick={() => void props.onControl("start")}>
                                <Play className="size-4" />
                                {stage === "analysis" ? "开始分析" : stage === "images" ? "开始重绘" : "开始制作"}
                            </Button>
                        </>
                    )}
                    {ready[stage] && stage !== "production" && (
                        <Button variant="outline" onClick={() => changeStage(stage === "analysis" ? "images" : "production")}>
                            下一阶段
                            <ChevronRight className="size-4" />
                        </Button>
                    )}
                </div>
            </div>
            <div role="status" className="flex shrink-0 items-center gap-2 border-b bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                {(running || frameRemakeBusy(project)) && <LoaderCircle className="size-3.5 shrink-0 animate-spin" />}
                <span className="min-w-0 break-words">
                    {project.operation?.progress ||
                        (running
                            ? project.automation?.progress
                            : ready[stage]
                              ? "本阶段已完成，可审阅结果。"
                              : !allowed
                                ? stage === "analysis"
                                    ? "上传来源视频后开始分析。"
                                    : "请先完成前一个阶段。"
                                : "每次独立执行一个步骤并保存结果；本阶段完成后暂停。分析和生成按模型计费。")}
                </span>
            </div>
            <div className="grid min-h-0 min-w-0 flex-1 grid-cols-1 min-[1200px]:grid-cols-[280px_minmax(0,1fr)_340px]">
                <aside key={`source-${stage}`} className="hidden min-h-0 overflow-y-auto overscroll-y-contain border-r min-[1200px]:block" aria-label="来源与素材设置">
                    {source}
                </aside>
                <section className="flex min-h-0 min-w-0 flex-col" aria-label="分镜与制作结果">
                    {project.groups.length > 0 && (
                        <nav className="flex shrink-0 gap-1 overflow-x-auto border-b p-2" aria-label="分组时间线">
                            {project.groups.map((item) => (
                                <button
                                    key={item.id}
                                    disabled={props.groupLocked && group?.id !== item.id}
                                    onClick={() => props.onGroup(item.id)}
                                    className={`shrink-0 rounded-lg border px-3 py-2 text-left text-xs disabled:opacity-50 ${group?.id === item.id ? "border-primary bg-primary/5" : "border-transparent hover:bg-muted"}`}
                                >
                                    <span className="block font-medium">
                                        第 {item.number} 组 · {frameRemakeSeconds(item)} 秒
                                    </span>
                                    <span className="mt-1 block text-[11px] text-muted-foreground">
                                        {item.startMs / 1000}–{item.endMs / 1000} 秒 · {groupStatus(item, stage)}
                                    </span>
                                </button>
                            ))}
                        </nav>
                    )}
                    <div key={`${stage}-${group?.id}`} className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-y-contain p-3 sm:p-4" aria-label="当前阶段结果">
                        {!group ? (
                            <div className="grid min-h-64 place-items-center rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                                <div>
                                    <Video className="mx-auto mb-3 size-8" />
                                    上传来源视频并开始分析，按实际时长建立分组、提取原帧。
                                    <Button variant="outline" className="mx-auto mt-4 flex min-[1200px]:hidden" onClick={() => setSourceOpen(true)}>
                                        上传来源视频
                                    </Button>
                                </div>
                            </div>
                        ) : stage === "analysis" ? (
                            <FrameBoard group={group} />
                        ) : stage === "images" ? (
                            <div className="space-y-5">
                                {group.contactSheet && (
                                    <details className="rounded-lg border p-3">
                                        <summary className="cursor-pointer text-sm font-medium">本组原片分镜总览</summary>
                                        <div className="mt-3">
                                            <Media media={group.contactSheet} label={`第 ${group.number} 组原片总览`} />
                                        </div>
                                    </details>
                                )}
                                <GenerationResult {...props} group={group} kind="template" />
                                <GenerationResult {...props} group={group} kind="image" />
                            </div>
                        ) : (
                            <div className="space-y-6">
                                <GenerationResult {...props} group={group} kind="video" />
                                <section className="space-y-3 rounded-lg border p-4">
                                    <h2 className="text-sm font-semibold">合成原时长成片</h2>
                                    <p className="text-xs leading-6 text-muted-foreground">
                                        按第 1–{project.groups.length} 组的顺序合并，目标时长 {frameRemakeTime(project.durationMs)}。
                                        {project.audioMode === "source" ? "保留原片音轨（无音轨时静音）。" : project.audioMode === "generated" ? "使用生成视频的声音。" : "输出静音。"}
                                    </p>
                                    <Button disabled={disabled || project.groups.some((item) => item.video.status !== "completed")} onClick={() => void props.onOperation("merge")}>
                                        合成 {frameRemakeTime(project.durationMs)}视频
                                    </Button>
                                    {project.mergedVideo && (
                                        <>
                                            <Media media={project.mergedVideo} label="复刻成片" downloadLabel="下载成片" />
                                            <p className="text-xs">实际成片：{frameRemakeTime((project.mergedVideo.duration || 0) * 1000)}</p>
                                        </>
                                    )}
                                </section>
                            </div>
                        )}
                    </div>
                </section>
                <aside key={`editor-${stage}-${group?.id}`} className="hidden min-h-0 overflow-y-auto overscroll-y-contain border-l min-[1200px]:block" aria-label="本组脚本与提示词">
                    {editor}
                </aside>
            </div>
            <Drawer title="来源与素材设置" placement="left" size={340} open={sourceOpen} onClose={() => setSourceOpen(false)} styles={{ wrapper: { maxWidth: "calc(100vw - 20px)" }, body: { padding: 0 } }}>
                {source}
            </Drawer>
            <Drawer title="本组脚本与提示词" placement="right" size={360} open={editorOpen} onClose={() => setEditorOpen(false)} styles={{ wrapper: { maxWidth: "calc(100vw - 20px)" }, body: { padding: 0 } }}>
                {editor}
            </Drawer>
        </main>
    );
}
function SourcePanel(props: Props) {
    const { project, display, stage, editingDisabled, disabled } = props;
    return (
        <div className="space-y-5 p-3">
            {stage === "analysis" ? (
                <>
                    <h2 className="text-sm font-semibold">来源视频</h2>
                    {project.sourceVideo ? (
                        <Media media={project.sourceVideo} label="来源视频" />
                    ) : (
                        <div className="rounded-lg border border-dashed p-8 text-center text-xs text-muted-foreground">
                            MP4 / MOV / WebM
                            <br />
                            最大 200 MB
                        </div>
                    )}
                    <UploadControl label={project.sourceVideo ? "更换来源视频" : "上传来源视频"} accept="video/mp4,video/quicktime,video/webm" disabled={disabled} onFile={(file) => void props.onUpload(file, "video")} />
                    {project.durationMs > 0 && (
                        <dl className="space-y-2 text-xs text-muted-foreground">
                            <div>实际时长：{frameRemakeTime(project.durationMs)}</div>
                            <div>
                                视频尺寸：{project.sourceVideo?.width} × {project.sourceVideo?.height}
                            </div>
                            <div>
                                {project.groups.length} 组 · {project.groups.reduce((sum, g) => sum + g.frames.filter((f) => f.media).length, 0)} 帧已保存
                            </div>
                        </dl>
                    )}
                    <Field label="复刻要求">
                        <Textarea rows={7} value={display.instructions} disabled={editingDisabled} maxLength={20000} placeholder="描述要保留或替换的产品、人物、背景及动作要求。" onChange={(event) => props.onChange({ instructions: event.target.value })} />
                    </Field>
                    <ModelSetting {...props} kind="analysis" label="画面分析模型" />
                    <Field label="每组最长秒数">
                        <select
                            className="w-full rounded-lg border bg-background p-2 text-sm"
                            aria-label="每组最长秒数"
                            disabled={editingDisabled}
                            value={display.maxSegmentSeconds}
                            onChange={(event) => props.onChange({ maxSegmentSeconds: Number(event.target.value) })}
                        >
                            {Array.from({ length: 12 }, (_, i) => i + 4).map((value) => (
                                <option key={value} value={value}>
                                    {value} 秒
                                </option>
                            ))}
                        </select>
                    </Field>
                    <p className="text-xs leading-6 text-muted-foreground">全片没有固定时长，末组保留实际余量。调整分组时长或更换原片后需要重新分析。</p>
                </>
            ) : stage === "images" ? (
                <>
                    <h2 className="text-sm font-semibold">替换素材</h2>
                    <p className="text-xs leading-6 text-muted-foreground">按原流程先清理模板、替换人物，再融合产品和背景。未上传的对象沿用原片。</p>
                    {(Object.keys(roles) as Array<keyof typeof roles>).map((role) => (
                        <section key={role} className="space-y-3 border-b pb-4">
                            <h3 className="text-xs font-semibold">
                                {roles[role]}参考图 · {display.references[role].length}/2
                            </h3>
                            {display.references[role].map((media, index) => (
                                <div key={media.url} className="relative">
                                    <Media media={media} label={`${roles[role]}参考图 ${index + 1}`} />
                                    <button
                                        aria-label={`移除${roles[role]}图 ${index + 1}`}
                                        disabled={editingDisabled}
                                        className="absolute right-1 top-1 rounded-full border bg-background p-1 disabled:opacity-50"
                                        onClick={() => props.onChange({ references: { ...display.references, [role]: display.references[role].filter((_, i) => i !== index) } })}
                                    >
                                        <X className="size-3.5" />
                                    </button>
                                </div>
                            ))}
                            <UploadControl label={`上传${roles[role]}图`} accept="image/png,image/jpeg,image/webp" disabled={disabled || display.references[role].length >= 2} onFile={(file) => void props.onUpload(file, role)} />
                        </section>
                    ))}
                    <ModelSetting {...props} kind="analysis" label="脚本模型" />
                    <ModelSetting {...props} kind="image" label="生图模型" />
                    <p className="text-xs leading-6 text-muted-foreground">保存替换素材后，需要重新执行产品脚本及后续制作。</p>
                </>
            ) : (
                <>
                    <h2 className="text-sm font-semibold">生产设置</h2>
                    <p className="text-xs leading-6 text-muted-foreground">读取已完成的分镜图，逐组编写视频提示词并生成视频，最后按原片时长合成。</p>
                    <ModelSetting {...props} kind="analysis" label="视频提示词模型" />
                    <ModelSetting {...props} kind="video" label="视频生成模型" />
                    <Field label="成片声音">
                        <select
                            className="w-full rounded-lg border bg-background p-2 text-sm"
                            aria-label="成片声音"
                            disabled={editingDisabled}
                            value={display.audioMode}
                            onChange={(event) => props.onChange({ audioMode: event.target.value as FrameRemakeProject["audioMode"] })}
                        >
                            <option value="source">保留原片声音</option>
                            <option value="generated">使用生成视频声音</option>
                            <option value="silent">静音</option>
                        </select>
                    </Field>
                    <div className="space-y-2 rounded-lg border p-3 text-xs">
                        <p>成片目标：{frameRemakeTime(project.durationMs)}</p>
                        <p>
                            已完成视频：{project.groups.filter((g) => g.video.status === "completed").length}/{project.groups.length} 组
                        </p>
                        {project.groups.map((g) => (
                            <p key={g.id}>
                                第 {g.number} 组：{frameRemakeSeconds(g)} 秒
                            </p>
                        ))}
                    </div>
                </>
            )}
            {props.dirty && (
                <Button disabled={editingDisabled} onClick={() => void props.onSave()}>
                    保存修改
                </Button>
            )}
        </div>
    );
}
function ModelSetting(props: Props & { kind: "analysis" | "image" | "video"; label: string }) {
    const config = useEffectiveConfig(),
        open = useConfigStore((state) => state.openConfigDialog);
    return (
        <fieldset disabled={props.editingDisabled} className={props.editingDisabled ? "pointer-events-none opacity-50" : ""}>
            <Field label={props.label}>
                <ModelPicker
                    config={config}
                    capability={props.kind === "analysis" ? "text" : props.kind}
                    value={props.display.modelSelection[props.kind]}
                    fullWidth
                    placeholder="平台默认模型"
                    onMissingConfig={() => open(true)}
                    onChange={(value) => props.onChange({ modelSelection: { ...props.display.modelSelection, [props.kind]: value } })}
                />
            </Field>
        </fieldset>
    );
}
function ScriptPanel(props: Props) {
    const { group, stage, project } = props;
    if (!group) return <p className="p-5 text-sm leading-6 text-muted-foreground">建立分组后，在这里查看完整解析、脚本和实际发送的提示词。</p>;
    const keys: FrameRemakeAnalysisStage[] = stage === "analysis" ? ["analysis"] : stage === "images" ? ["productScript", "imagePrompt"] : ["videoPrompt"];
    return (
        <div className="space-y-5 p-3">
            <h2 className="text-sm font-semibold">
                第 {group.number} 组 · {group.startMs / 1000}–{group.endMs / 1000} 秒
            </h2>
            {keys.map((key) => {
                const text = frameRemakeAnalysisResult(group, key),
                    record = group.analysisSteps?.[key];
                const prerequisite =
                    key === "analysis" ? Boolean(group.contactSheet) : key === "productScript" ? Boolean(group.analysis) : key === "imagePrompt" ? Boolean(frameRemakeAnalysisResult(group, "productScript")) : group.image.status === "completed";
                const active = project.operation?.kind === "analyze" && project.operation.groupId === group.id && project.operation.analysisStage === key;
                return (
                    <section key={key} className="space-y-3 border-b pb-4">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <h3 className="text-xs font-semibold">{FRAME_REMAKE_ANALYSIS_LABELS[key]}</h3>
                            <Button variant="outline" disabled={props.disabled || !prerequisite} onClick={() => void props.onOperation("analyze", group.id, key)}>
                                {active ? "执行中" : text ? "重新生成" : "生成本步"}
                            </Button>
                        </div>
                        {record?.error && (
                            <p role="alert" className="text-xs text-destructive">
                                {record.error}
                            </p>
                        )}
                        {text ? (
                            <TextOutput title="本步完整结果" text={text} name={`第${group.number}组-${FRAME_REMAKE_ANALYSIS_LABELS[key]}`} />
                        ) : (
                            <p className="rounded-lg border border-dashed p-4 text-xs text-muted-foreground">{active ? "正在生成，完成后自动保存。" : "本步完成后在这里输出完整结果。"}</p>
                        )}
                        {record?.elapsedMs !== undefined && <p className="text-[11px] text-muted-foreground">模型耗时 {(record.elapsedMs / 1000).toFixed(1)} 秒</p>}
                        <details>
                            <summary className="cursor-pointer text-xs">编辑本步结果</summary>
                            <Textarea aria-label={`编辑${FRAME_REMAKE_ANALYSIS_LABELS[key]}`} className="mt-3" rows={8} value={text} maxLength={30000} disabled={props.editingDisabled} onChange={(event) => props.onEditGroup(key, event.target.value)} />
                            <p className="mt-2 text-[11px] leading-5 text-muted-foreground">修改并保存后，依赖本步的后续结果需要重新生成。</p>
                            {props.dirty && (
                                <Button className="mt-2" disabled={props.editingDisabled} onClick={() => void props.onSave()}>
                                    保存修改
                                </Button>
                            )}
                        </details>
                        {record?.prompt && (
                            <details>
                                <summary className="cursor-pointer text-xs">实际发送的提示词</summary>
                                <div className="mt-3">
                                    <TextOutput title="本次模型输入" text={record.prompt} name={`第${group.number}组-${key}-实际提示词`} />
                                </div>
                            </details>
                        )}
                    </section>
                );
            })}
        </div>
    );
}
function FrameBoard({ group }: { group: FrameRemakeGroup }) {
    const [selected, setSelected] = useState(0);
    const frame = group.frames.find((frame) => frame.number === selected) || group.frames[0];
    return (
        <div className="space-y-5">
            <div className="flex items-center justify-between text-xs">
                <h2 className="font-semibold">
                    原片抽帧 · 第 {group.frames[0].number}–{group.frames.at(-1)!.number} 帧
                </h2>
                <span className="text-muted-foreground">
                    已保存 {group.frames.filter((f) => f.media).length}/{group.frames.length}
                </span>
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 2xl:grid-cols-4">
                {group.frames.map((item) => (
                    <button
                        key={item.number}
                        onClick={() => setSelected(item.number)}
                        aria-pressed={frame.number === item.number}
                        aria-label={`查看第 ${item.number} 帧`}
                        className={`min-w-0 overflow-hidden rounded-lg border text-left ${frame.number === item.number ? "border-primary ring-1 ring-primary" : "border-border"}`}
                    >
                        {item.media ? (
                            <img src={item.media.url} alt={`原片第 ${item.number} 帧`} loading="lazy" className="aspect-[3/4] max-h-44 w-full bg-muted object-contain" />
                        ) : (
                            <div className="grid aspect-[3/4] place-items-center text-xs text-muted-foreground">等待拆帧</div>
                        )}
                        <div className="p-2 text-xs">
                            <span className="font-medium">#{item.number}</span>
                            <span className="ml-2 text-muted-foreground">{item.sampleMs / 1000} 秒</span>
                        </div>
                    </button>
                ))}
            </div>
            {frame.media && (
                <section className="space-y-3 rounded-lg border p-3">
                    <h3 className="text-xs font-semibold">
                        第 {frame.number} 帧 · 采样 {frame.sampleMs / 1000} 秒
                    </h3>
                    <Media media={frame.media} label={`原片第 ${frame.number} 帧原图`} />
                </section>
            )}
            {group.contactSheet && (
                <section className="space-y-3 rounded-lg border p-3">
                    <h3 className="text-xs font-semibold">本组分镜总览</h3>
                    <Media media={group.contactSheet} label={`第 ${group.number} 组原片总览`} />
                </section>
            )}
        </div>
    );
}
function GenerationResult(props: Props & { group: FrameRemakeGroup; kind: FrameRemakeGenerationKind }) {
    const { group, kind } = props,
        task = group[kind];
    const label = kind === "template" ? "清理模板、替换人物" : kind === "image" ? "融合产品与背景" : "生成本组视频";
    const ready = kind === "template" ? group.contactSheet && group.imagePrompt : kind === "image" ? group.template.status === "completed" && group.imagePrompt : group.image.status === "completed" && group.videoPrompt;
    return (
        <section className="space-y-3 rounded-lg border bg-card p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-sm font-semibold">{label}</h2>
                <span className="text-xs text-muted-foreground">{taskLabels[task.status]}</span>
            </div>
            {task.result ? (
                <Media media={task.result} label={`第 ${group.number} 组${kind === "template" ? "模板图" : kind === "image" ? "复刻分镜图" : "分段视频"}`} />
            ) : (
                <div className="grid min-h-44 place-items-center rounded-lg border border-dashed p-5 text-center text-xs text-muted-foreground">
                    {ready ? taskLabels[task.status] : kind === "template" ? "完成产品脚本和分镜脚本后生成模板图。" : kind === "image" ? "完成模板图后融合产品与背景。" : "完成分镜图和视频提示词后生成本组视频。"}
                </div>
            )}
            {task.error && (
                <p role="alert" className="text-xs text-destructive">
                    {task.error}
                </p>
            )}
            <div className="flex flex-wrap gap-2">
                <Button variant="outline" disabled={(task.status === "queued" ? props.working || props.dirty : props.disabled) || !ready || task.status === "running"} onClick={() => void props.onGenerate(group.id, kind)}>
                    {task.status === "queued" ? "继续确认提交" : task.status === "completed" ? "重新生成" : task.status === "error" ? "重试生成" : label}
                </Button>
                {task.status === "queued" && (
                    <Button variant="ghost" disabled={props.working} onClick={() => void props.onAbandon(group.id, kind)}>
                        撤销未确认提交
                    </Button>
                )}
            </div>
            {kind === "video" && (
                <p className="text-xs text-muted-foreground">
                    原片 {group.startMs / 1000}–{group.endMs / 1000} 秒；本组采用 {frameRemakeSeconds(group)} 秒{task.seconds ? `，模型生成 ${task.seconds} 秒。` : "。"}
                </p>
            )}
            {task.prompt && (
                <details>
                    <summary className="cursor-pointer text-xs">实际提交的完整提示词</summary>
                    <div className="mt-3">
                        <TextOutput title="本次生成输入" text={task.prompt} name={`第${group.number}组-${kind}-实际提示词`} />
                    </div>
                </details>
            )}
        </section>
    );
}
function UploadControl({ label, accept, disabled, onFile }: { label: string; accept: string; disabled: boolean; onFile: (file: File) => void }) {
    return (
        <label className={`inline-flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-xs focus-within:ring-2 ${disabled ? "opacity-50" : "hover:bg-muted"}`}>
            <Upload className="size-3.5" />
            {label}
            <input
                aria-label={label}
                type="file"
                accept={accept}
                disabled={disabled}
                className="sr-only"
                onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    if (file) onFile(file);
                }}
            />
        </label>
    );
}
function groupStatus(group: FrameRemakeGroup, stage: FrameRemakeWorkflowStage): ReactNode {
    return stage === "analysis"
        ? group.analysis
            ? "解析已完成"
            : group.contactSheet
              ? "待解析"
              : "待拆帧"
        : stage === "images"
          ? group.image.status === "completed"
              ? "重绘已完成"
              : group.template.status === "completed"
                ? "模板已完成"
                : group.imagePrompt
                  ? "脚本已完成"
                  : "待写脚本"
          : taskLabels[group.video.status];
}
