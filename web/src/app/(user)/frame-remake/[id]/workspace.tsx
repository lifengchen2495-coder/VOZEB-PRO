"use client";
import Link from "next/link";
import { FrameRemakeFlow } from "./flow";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Download, RefreshCw, ScanSearch, Upload, X } from "lucide-react";
import { ModelPicker } from "@/components/model-picker";
import { useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import {
    FRAME_REMAKE_ANALYSIS_LABELS,
    frameRemakeAnalysisResult,
    nextFrameRemakeAnalysisStage,
    type FrameRemakeAnalysisStage,
    type FrameRemakeOperationKind,
    frameRemakeBusy,
    frameRemakeSeconds,
    frameRemakeTime,
    type FrameRemakeGenerationKind,
    type FrameRemakeGroup,
    type FrameRemakePatch,
    type FrameRemakeProject,
    type FrameRemakeTask,
} from "@/lib/frame-remake-contract";
import { frameRemakeImagePrompt, frameRemakeVideoPrompt } from "@/lib/frame-remake-prompts";
import { frameRemakeProjectPath, frameRemakeRequest, uploadFrameRemakeMedia } from "../api";
import { Button, Field, Input, Textarea } from "../../bangbang/controls";

const roles = { product: "产品", character: "人物", background: "背景" } as const;
const labels = { idle: "待生成", queued: "正在确认提交", running: "生成中", completed: "已完成", error: "生成失败" };
export function FrameRemakeWorkspace({ id }: { id: string }) {
    const [project, setProject] = useState<FrameRemakeProject>();
    const [draft, setDraft] = useState<FrameRemakePatch>({});
    const [selected, setSelected] = useState("G1");
    const [working, setWorking] = useState(false);
    const [batch, setBatch] = useState<FrameRemakeGenerationKind>();
    const [error, setError] = useState("");
    const current = useRef<FrameRemakeProject>(undefined);
    const lock = useRef(false);
    const batchActive = useRef(false);
    const mounted = useRef(true);
    const config = useEffectiveConfig();
    const openConfig = useConfigStore((state) => state.openConfigDialog);
    const path = frameRemakeProjectPath(id);
    const accept = useCallback(
        (value: FrameRemakeProject) => {
            if (mounted.current && value.id === id && (!current.current || value.revision >= current.current.revision)) {
                current.current = value;
                setProject(value);
            }
            return value;
        },
        [id],
    );
    const refresh = useCallback(async () => accept(await frameRemakeRequest<FrameRemakeProject>(frameRemakeProjectPath(id))), [accept, id]);
    useEffect(() => {
        mounted.current = true;
        let stopped = false;
        let timer: ReturnType<typeof setTimeout>;
        const poll = async () => {
            try {
                if (!lock.current) await refresh();
            } catch (error) {
                if (!stopped) setError((error as Error).message);
            }
            if (!stopped) timer = setTimeout(poll, current.current && (frameRemakeBusy(current.current) || current.current.automation?.status === "running") ? 4000 : 20000);
        };
        void poll();
        return () => {
            stopped = true;
            mounted.current = false;
            batchActive.current = false;
            clearTimeout(timer);
        };
    }, [refresh]);
    const dirty = Object.keys(draft).length > 0;
    useEffect(() => {
        if (!dirty) return;
        const warn = (event: BeforeUnloadEvent) => event.preventDefault();
        window.addEventListener("beforeunload", warn);
        return () => window.removeEventListener("beforeunload", warn);
    }, [dirty]);
    const action = async (fn: () => Promise<unknown>) => {
        if (lock.current) return;
        lock.current = true;
        setWorking(true);
        setError("");
        try {
            await fn();
        } catch (error) {
            if (mounted.current) setError((error as Error).message);
            await refresh().catch(() => undefined);
        } finally {
            lock.current = false;
            if (mounted.current) setWorking(false);
        }
    };
    const save = () =>
        action(async () => {
            accept(await frameRemakeRequest<FrameRemakeProject>(path, { ...draft, revision: current.current!.revision }, "PATCH"));
            setDraft({});
        });
    const operation = (kind: FrameRemakeOperationKind, groupId?: string, analysisStage?: FrameRemakeAnalysisStage) =>
        action(async () => accept(await frameRemakeRequest<FrameRemakeProject>(`${path}/operations`, { revision: current.current!.revision, kind, groupId, analysisStage })));
    const control = (mode: "start" | "step" | "pause") =>
        action(async () => {
            const latest = await refresh();
            accept(await frameRemakeRequest<FrameRemakeProject>(`${path}/run`, { revision: latest.revision, action: mode }));
        });
    const generate = (groupId: string, kind: FrameRemakeGenerationKind) => action(async () => accept(await frameRemakeRequest<FrameRemakeProject>(`${path}/groups/${groupId}/${kind}`, { revision: current.current!.revision })));
    const abandon = (groupId: string, kind: FrameRemakeGenerationKind) => action(async () => accept(await frameRemakeRequest<FrameRemakeProject>(`${path}/groups/${groupId}/${kind}`, undefined, "DELETE")));
    const upload = (file: File, role: keyof typeof roles | "video") =>
        action(async () => {
            const media = await uploadFrameRemakeMedia(id, file);
            const latest = await refresh();
            const patch = role === "video" ? { sourceVideo: media } : { references: { ...latest.references, [role]: [...latest.references[role], media] } };
            accept(await frameRemakeRequest<FrameRemakeProject>(path, { ...patch, revision: latest.revision }, "PATCH"));
        });
    const generateAll = (kind: FrameRemakeGenerationKind) =>
        action(async () => {
            batchActive.current = true;
            setBatch(kind);
            try {
                let latest = await refresh();
                while (batchActive.current) {
                    const group = latest.groups.find((group) => group[kind].status !== "completed");
                    if (!group) break;
                    latest = accept(await frameRemakeRequest<FrameRemakeProject>(`${path}/groups/${group.id}/${kind}`, { revision: latest.revision }));
                    while (batchActive.current && frameRemakeBusy(latest)) {
                        await new Promise((resolve) => setTimeout(resolve, 4000));
                        if (!batchActive.current) break;
                        latest = await refresh();
                        const task = latest.groups.find((item) => item.id === group.id)?.[kind];
                        if (task?.error) throw new Error(`第 ${group.number} 组：${task.error}`);
                    }
                    if (!batchActive.current) break;
                    const finished = latest.groups.find((item) => item.id === group.id)?.[kind];
                    if (finished?.status !== "completed") throw new Error(`第 ${group.number} 组未完成，已停止后续生成。${finished?.error || "请检查当前任务"}`);
                }
            } finally {
                batchActive.current = false;
                if (mounted.current) setBatch(undefined);
            }
        });
    if (!project)
        return (
            <main className="p-8">
                <Link href="/frame-remake">返回项目列表</Link>
                <p className="mt-6" role={error ? "alert" : undefined}>
                    {error || "正在读取项目…"}
                </p>
                <Button className="mt-4" variant="outline" onClick={() => void action(refresh)}>
                    重新读取
                </Button>
            </main>
        );
    const busy = frameRemakeBusy(project);
    const editingDisabled = working || busy || project.automation?.status === "running";
    const disabled = editingDisabled || dirty;
    const display = { ...project, ...draft } as FrameRemakeProject;
    const selectedGroup = project.groups.find((group) => group.id === selected) || project.groups[0];
    const group = selectedGroup && draft.group?.id === selectedGroup.id ? { ...selectedGroup, ...draft.group } : selectedGroup;
    const extracted = project.groups.length > 0 && project.groups.every((group) => group.contactSheet && group.frames.every((frame) => frame.media));
    const analyzed = extracted && project.groups.every((group) => !nextFrameRemakeAnalysisStage(group));
    const templatesReady = analyzed && project.groups.every((group) => group.template.status === "completed");
    const imagesReady = templatesReady && project.groups.every((group) => group.image.status === "completed");
    const videosReady = imagesReady && project.groups.every((group) => group.video.status === "completed");
    const change = (patch: FrameRemakePatch) => setDraft((current) => ({ ...current, ...patch }));
    const editGroup = (key: FrameRemakeAnalysisStage, value: string) =>
        group && change({ group: { id: group.id, analysis: group.analysis, productScript: frameRemakeAnalysisResult(group, "productScript"), imagePrompt: group.imagePrompt, videoPrompt: group.videoPrompt, [key]: value } });
    return (
        <main className="min-h-screen bg-background">
            <header className="sticky top-0 z-20 flex flex-wrap items-center justify-between gap-3 border-b bg-background/95 px-5 py-3 backdrop-blur">
                <div className="flex min-w-0 items-center gap-3">
                    <Link href="/frame-remake" aria-label="返回项目列表">
                        <ArrowLeft className="size-5" />
                    </Link>
                    <ScanSearch className="size-5" />
                    <div className="min-w-0">
                        <h1 className="truncate font-semibold">{project.title}</h1>
                        <p className="text-xs text-muted-foreground">原时长拆帧复刻 · {project.durationMs ? frameRemakeTime(project.durationMs) : "等待拆帧"}</p>
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    <Button variant="outline" disabled={working} onClick={() => void action(refresh)}>
                        <RefreshCw className="size-4" />
                        刷新
                    </Button>
                    <Button disabled={!dirty || editingDisabled} onClick={() => void save()}>
                        保存修改
                    </Button>
                </div>
            </header>
            <div className="mx-auto max-w-screen-2xl space-y-6 p-4 md:p-7">
                {(error || project.error) && (
                    <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
                        {error || project.error}
                    </p>
                )}
                {dirty && (
                    <div className="flex flex-wrap items-center gap-3 rounded-lg bg-muted p-3 text-sm">
                        修改尚未保存。保存后再开始处理。
                        <Button variant="ghost" onClick={() => setDraft({})}>
                            放弃修改
                        </Button>
                    </div>
                )}
                {(project.operation || batch) && (
                    <div role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-primary/30 bg-primary/5 p-4 text-sm">
                        <span>{project.operation?.progress || `正在逐组生成${batch === "image" ? "分镜图" : "视频"}，已完成的分组会自动保存。`}</span>
                        {batch && (
                            <Button
                                variant="outline"
                                onClick={() => {
                                    batchActive.current = false;
                                }}
                            >
                                停止后续生成
                            </Button>
                        )}
                    </div>
                )}
                <FrameRemakeFlow project={project} disabled={working || dirty} control={control} />
                <details className="space-y-6">
                    <summary className="cursor-pointer rounded-lg border p-4 text-sm font-medium">素材、模型设置与分组详情</summary>
                    <section className="rounded-xl border bg-card p-5">
                        <h2 className="text-lg font-semibold">1. 原视频与替换素材</h2>
                        <p className="mt-2 text-sm leading-6 text-muted-foreground">成片跟随原片实际时长，长视频自动分组。每组上限需匹配视频模型；单个视频最大 200 MB。未上传替换图的对象沿用原片。</p>
                        <div className="mt-5 grid gap-6 lg:grid-cols-2">
                            <div className="space-y-4">
                                <Field label="项目名称">
                                    <Input value={display.title} maxLength={160} disabled={editingDisabled} onChange={(event) => change({ title: event.target.value })} />
                                </Field>
                                {project.sourceVideo ? (
                                    <video controls preload="metadata" src={project.sourceVideo.url} className="max-h-80 w-full rounded-lg bg-black" />
                                ) : (
                                    <div className="flex aspect-video items-center justify-center rounded-lg border border-dashed bg-muted/30 text-sm text-muted-foreground">上传视频，开始按原时长拆帧</div>
                                )}
                                <UploadControl label={project.sourceVideo ? "更换原视频" : "上传原视频"} accept="video/mp4,video/quicktime,video/webm" disabled={disabled} onFile={(file) => void upload(file, "video")} />
                                <div className="grid gap-4 sm:grid-cols-2">
                                    <Field label="每组最长秒数">
                                        <select
                                            aria-label="每组最长秒数"
                                            className="h-10 w-full rounded-lg border bg-background px-3 text-sm"
                                            value={display.maxSegmentSeconds}
                                            disabled={editingDisabled}
                                            onChange={(event) => change({ maxSegmentSeconds: Number(event.target.value) })}
                                        >
                                            {Array.from({ length: 12 }, (_, index) => index + 4).map((value) => (
                                                <option key={value} value={value}>
                                                    {value} 秒
                                                </option>
                                            ))}
                                        </select>
                                    </Field>
                                    <Field label="成片声音">
                                        <select
                                            aria-label="成片声音"
                                            className="h-10 w-full rounded-lg border bg-background px-3 text-sm"
                                            value={display.audioMode}
                                            disabled={editingDisabled}
                                            onChange={(event) => change({ audioMode: event.target.value as FrameRemakeProject["audioMode"] })}
                                        >
                                            <option value="source">保留原片声音</option>
                                            <option value="generated">使用生成视频声音</option>
                                            <option value="silent">静音</option>
                                        </select>
                                    </Field>
                                </div>
                                <p className="text-xs leading-6 text-muted-foreground">更换原视频或每组秒数需要重新拆帧。更换参考图或复刻要求需要重新解析和生成。</p>
                            </div>
                            <div className="space-y-5">
                                {(Object.keys(roles) as Array<keyof typeof roles>).map((role) => (
                                    <div key={role} className="space-y-3">
                                        <div className="flex items-center justify-between gap-3">
                                            <h3 className="text-sm font-medium">{roles[role]}参考图 · 可选</h3>
                                            <UploadControl label={`上传${roles[role]}图`} accept="image/png,image/jpeg,image/webp" disabled={disabled || display.references[role].length >= 2} onFile={(file) => void upload(file, role)} />
                                        </div>
                                        {display.references[role].length ? (
                                            <div className="flex gap-3">
                                                {display.references[role].map((media) => (
                                                    <div className="relative" key={media.url}>
                                                        <a href={media.url} target="_blank" rel="noreferrer">
                                                            <img src={media.url} alt={`${roles[role]}参考图`} className="h-28 w-28 rounded-lg border object-contain" />
                                                        </a>
                                                        <button
                                                            aria-label={`移除${roles[role]}参考图`}
                                                            className="absolute right-1 top-1 rounded-full border bg-background p-1"
                                                            disabled={editingDisabled}
                                                            onClick={() => change({ references: { ...display.references, [role]: display.references[role].filter((item) => item.url !== media.url) } })}
                                                        >
                                                            <X className="size-3" />
                                                        </button>
                                                    </div>
                                                ))}
                                            </div>
                                        ) : (
                                            <p className="text-xs text-muted-foreground">保留原片{roles[role]}；每类最多 2 张。</p>
                                        )}
                                    </div>
                                ))}
                                <Field label="复刻要求">
                                    <Textarea value={display.instructions} maxLength={20000} disabled={editingDisabled} placeholder="需要替换的对象、必须保留的画面和动作、其他要求" onChange={(event) => change({ instructions: event.target.value })} />
                                </Field>
                            </div>
                        </div>
                        <fieldset disabled={editingDisabled} className={`mt-6 grid gap-4 border-t pt-5 md:grid-cols-3 ${editingDisabled ? "pointer-events-none opacity-50" : ""}`}>
                            {(
                                [
                                    ["analysis", "画面分析模型", "text"],
                                    ["image", "分镜生图模型", "image"],
                                    ["video", "视频生成模型", "video"],
                                ] as const
                            ).map(([key, label, capability]) => (
                                <div key={key} className="min-w-0 space-y-2">
                                    <p className="text-sm font-medium">{label}</p>
                                    <ModelPicker
                                        config={config}
                                        capability={capability}
                                        value={display.modelSelection[key]}
                                        placeholder="使用平台默认模型"
                                        fullWidth
                                        onChange={(value) => {
                                            if (!editingDisabled) change({ modelSelection: { ...display.modelSelection, [key]: value } });
                                        }}
                                        onMissingConfig={() => openConfig(true)}
                                    />
                                </div>
                            ))}
                        </fieldset>
                    </section>
                    <section className="space-y-4 rounded-xl border bg-card p-5">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                            <div>
                                <h2 className="text-lg font-semibold">2. 完整拆帧与分组制作</h2>
                                <p className="mt-2 text-sm text-muted-foreground">
                                    {project.durationMs ? `${frameRemakeTime(project.durationMs)} · ${project.groups.length} 组 · ${project.groups.reduce((sum, group) => sum + group.frames.length, 0)} 帧` : "先拆帧读取原片实际时长"}
                                </p>
                            </div>
                            <div className="flex flex-wrap gap-2">
                                <Button variant="outline" disabled={disabled || !project.sourceVideo || extracted} onClick={() => void operation("extract")}>
                                    {project.groups.length ? "拆下一组帧" : "读取视频信息"}
                                </Button>
                                <Button variant="outline" disabled={disabled || !extracted || analyzed} onClick={() => void operation("analyze")}>
                                    执行下一个分析步骤
                                </Button>
                                <Button variant="outline" disabled={disabled || !analyzed || templatesReady} onClick={() => void generateAll("template")}>
                                    生成全部模板图
                                </Button>
                                <Button variant="outline" disabled={disabled || !templatesReady || imagesReady} onClick={() => void generateAll("image")}>
                                    生成全部分镜图
                                </Button>
                                <Button disabled={disabled || !imagesReady || videosReady} onClick={() => void generateAll("video")}>
                                    生成全部分组视频
                                </Button>
                            </div>
                        </div>
                        <p className="text-xs leading-6 text-muted-foreground">解析、生图和视频按所选模型计费。批量生成会跳过已完成分组，失败即停止；请保持页面打开，关闭后已提交任务继续执行，回来可继续剩余分组。</p>
                        {project.groups.length > 0 && (
                            <>
                                <nav aria-label="分组时间线" className="flex gap-2 overflow-x-auto pb-2">
                                    {project.groups.map((item) => (
                                        <button
                                            key={item.id}
                                            disabled={Boolean(draft.group)}
                                            onClick={() => setSelected(item.id)}
                                            className={`shrink-0 space-y-1 rounded-lg border px-4 py-3 text-left text-xs disabled:opacity-50 ${group?.id === item.id ? "border-primary bg-primary/5" : "hover:bg-muted"}`}
                                        >
                                            <span className="block font-semibold">
                                                第 {item.number} 组 · {frameRemakeSeconds(item)} 秒
                                            </span>
                                            <span className="block text-muted-foreground">
                                                {item.startMs / 1000}–{item.endMs / 1000} 秒
                                            </span>
                                            <span className="block">
                                                {item.video.status === "completed" ? "视频已完成" : item.image.status === "completed" ? "分镜图已完成" : item.analysis ? "解析已完成" : item.contactSheet ? "拆帧已完成" : "等待拆帧"}
                                            </span>
                                        </button>
                                    ))}
                                </nav>
                                {group && (
                                    <div className="space-y-5 border-t pt-5">
                                        <div className="grid gap-6 lg:grid-cols-4">
                                            <div className="space-y-3">
                                                <h3 className="font-medium">
                                                    原片抽帧 · 第 {group.frames[0].number}–{group.frames.at(-1)!.number} 帧
                                                </h3>
                                                {group.contactSheet ? (
                                                    <a href={group.contactSheet.url} target="_blank" rel="noreferrer">
                                                        <img src={group.contactSheet.url} alt={`第 ${group.number} 组原片抽帧`} className="max-h-[480px] w-full rounded-lg border object-contain" />
                                                    </a>
                                                ) : (
                                                    <p className="rounded-lg border border-dashed p-8 text-sm">等待拆帧</p>
                                                )}
                                                <details className="text-sm">
                                                    <summary className="cursor-pointer">逐帧查看及采样时间</summary>
                                                    <div className="mt-3 grid grid-cols-3 gap-2">
                                                        {group.frames.map((frame) => (
                                                            <div key={frame.number}>
                                                                {frame.media && (
                                                                    <a href={frame.media.url} target="_blank" rel="noreferrer">
                                                                        <img src={frame.media.url} alt={`原片第 ${frame.number} 帧`} loading="lazy" className="aspect-[3/4] w-full rounded border object-contain" />
                                                                    </a>
                                                                )}
                                                                <p className="mt-1 text-xs">
                                                                    #{frame.number} · {frame.sampleMs / 1000}s
                                                                </p>
                                                            </div>
                                                        ))}
                                                    </div>
                                                </details>
                                            </div>
                                            <ResultPanel group={group} kind="template" disabled={disabled} working={working} generate={generate} abandon={abandon} />
                                            <ResultPanel group={group} kind="image" disabled={disabled} working={working} generate={generate} abandon={abandon} />
                                            <ResultPanel group={group} kind="video" disabled={disabled} working={working} generate={generate} abandon={abandon} />
                                        </div>
                                        <details className="rounded-lg border p-4">
                                            <summary className="cursor-pointer font-medium">查看和编辑本组解析、提示词</summary>
                                            <div className="mt-4 space-y-4">
                                                <p className="text-xs leading-6 text-muted-foreground">
                                                    各步沿用既有模板，并读取前一步已保存结果。修改画面分析或产品脚本会清空依赖它的后续脚本、图片和视频；修改分镜脚本会清空视频提示词、图片和视频；修改视频提示词只重置视频。
                                                </p>
                                                <Button variant="outline" disabled={disabled || !group.contactSheet} onClick={() => void operation("analyze", group.id)}>
                                                    {nextFrameRemakeAnalysisStage(group) ? `执行：${FRAME_REMAKE_ANALYSIS_LABELS[nextFrameRemakeAnalysisStage(group)!]}` : "从画面分析重新执行本组"}
                                                </Button>
                                                {(
                                                    [
                                                        ["analysis", "画面解析"],
                                                        ["productScript", "产品脚本"],
                                                        ["imagePrompt", "分镜图提示词"],
                                                        ["videoPrompt", "视频提示词"],
                                                    ] as const
                                                ).map(([key, label]) => (
                                                    <Field key={key} label={label}>
                                                        <Textarea rows={6} value={frameRemakeAnalysisResult(group, key)} maxLength={30000} disabled={editingDisabled} onChange={(event) => editGroup(key, event.target.value)} />
                                                    </Field>
                                                ))}
                                                <details>
                                                    <summary className="cursor-pointer text-sm">实际发送的完整提示词</summary>
                                                    <p className="mt-3 text-xs text-muted-foreground">已提交任务显示提交时原文；未提交任务显示当前预览，视频秒数以模型支持值为准。</p>
                                                    <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap rounded bg-muted p-3 text-xs">{group.image.prompt || frameRemakeImagePrompt(project, group)}</pre>
                                                    <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap rounded bg-muted p-3 text-xs">{group.video.prompt || frameRemakeVideoPrompt(project, group, Math.ceil(frameRemakeSeconds(group)))}</pre>
                                                </details>
                                            </div>
                                        </details>
                                    </div>
                                )}
                            </>
                        )}
                    </section>
                    <section className="space-y-4 rounded-xl border bg-card p-5">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                            <div>
                                <h2 className="text-lg font-semibold">3. 按原时长合成成片</h2>
                                <p className="mt-2 text-sm text-muted-foreground">按原片顺序合并，尾组只取实际需要的时长。全部视频就绪后可以合成。</p>
                            </div>
                            <Button disabled={disabled || !videosReady} onClick={() => void operation("merge")}>
                                合成 {project.durationMs ? frameRemakeTime(project.durationMs) : "完整"}视频
                            </Button>
                        </div>
                        {project.mergedVideo && (
                            <div className="space-y-3">
                                <video src={project.mergedVideo.url} controls preload="metadata" className="max-h-[560px] w-full rounded-lg bg-black" />
                                <div className="flex flex-wrap items-center gap-4 text-sm">
                                    <span>实际成片：{frameRemakeTime((project.mergedVideo.duration || 0) * 1000)}</span>
                                    <a href={project.mergedVideo.url} download={project.mergedVideo.originalName} className="inline-flex items-center gap-2 underline underline-offset-4">
                                        <Download className="size-4" />
                                        下载成片
                                    </a>
                                </div>
                            </div>
                        )}
                    </section>
                </details>
            </div>
        </main>
    );
}
function UploadControl({ label, accept, disabled, onFile }: { label: string; accept: string; disabled: boolean; onFile: (file: File) => void }) {
    return (
        <label className={`inline-flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm focus-within:ring-2 ${disabled ? "opacity-50" : "hover:bg-muted"}`}>
            <Upload className="size-4" />
            {label}
            <input
                aria-label={label}
                className="sr-only"
                type="file"
                accept={accept}
                disabled={disabled}
                onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    if (file) onFile(file);
                }}
            />
        </label>
    );
}
function ResultPanel({
    group,
    kind,
    disabled,
    working,
    generate,
    abandon,
}: {
    group: FrameRemakeGroup;
    kind: FrameRemakeGenerationKind;
    disabled: boolean;
    working: boolean;
    generate: (id: string, kind: FrameRemakeGenerationKind) => Promise<void>;
    abandon: (id: string, kind: FrameRemakeGenerationKind) => Promise<void>;
}) {
    const task: FrameRemakeTask = group[kind];
    const ready = kind === "template" ? group.contactSheet && group.imagePrompt : kind === "image" ? group.template.status === "completed" && group.imagePrompt : group.image.status === "completed" && group.videoPrompt;
    return (
        <div className="space-y-3">
            <h3 className="font-medium">
                {kind === "template" ? "清理模板图" : kind === "image" ? "复刻分镜图" : "分组视频"} · {labels[task.status]}
            </h3>
            {task.result ? (
                kind !== "video" ? (
                    <a href={task.result.url} target="_blank" rel="noreferrer">
                        <img src={task.result.url} alt={`第 ${group.number} 组复刻分镜图`} className="max-h-[480px] w-full rounded-lg border object-contain" />
                    </a>
                ) : (
                    <video src={task.result.url} controls preload="metadata" className="max-h-[480px] w-full rounded-lg bg-black" />
                )
            ) : (
                <div className="flex min-h-44 items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">{labels[task.status]}</div>
            )}
            {task.error && (
                <p role="alert" className="text-sm text-destructive">
                    {task.error}
                </p>
            )}
            <div className="flex flex-wrap gap-2">
                <Button variant="outline" disabled={(task.status === "queued" ? working : disabled) || !ready || task.status === "running"} onClick={() => void generate(group.id, kind)}>
                    {task.status === "queued" ? "继续确认提交" : task.status === "completed" ? "重新生成" : task.status === "error" ? "重试生成" : `生成${kind === "template" ? "模板图" : kind === "image" ? "分镜图" : "视频"}`}
                </Button>
                {task.status === "queued" && (
                    <Button variant="ghost" disabled={working} onClick={() => void abandon(group.id, kind)}>
                        撤销未确认提交
                    </Button>
                )}
            </div>
            {kind === "video" && task.seconds && (
                <p className="text-xs text-muted-foreground">
                    模型生成 {task.seconds} 秒，合成采用前 {frameRemakeSeconds(group)} 秒。
                </p>
            )}
        </div>
    );
}
