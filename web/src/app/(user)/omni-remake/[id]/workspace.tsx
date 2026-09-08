"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Check, Download, Loader2, Save, Upload, X } from "lucide-react";
import { Button, Input, Textarea } from "../controls";
import { ModelPicker } from "@/components/model-picker";
import { useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import { uploadImage } from "@/services/image-storage";
import { OMNI_SOURCE_URL, type OmniProject, type OmniSegment } from "@/lib/omni-remake-contract";
import { omniEditable, omniProjectPath, omniRequest, uploadOmniVideo } from "../omni-api";

const statuses = { idle: "待生成", queued: "提交待确认", running: "生成中", completed: "已完成", error: "失败" };
const operationNames = { analysis: "分析原片", prepare: "准备计划与片段", merge: "合并成片" };

export function OmniWorkspace({ id }: { id: string }) {
    const [project, setProject] = useState<OmniProject>();
    const [draft, setDraft] = useState<ReturnType<typeof omniEditable>>();
    const [dirty, setDirty] = useState(false);
    const [busy, setBusy] = useState("");
    const [error, setError] = useState("");
    const lock = useRef(false);
    const current = useRef<OmniProject | undefined>(undefined);
    const config = useEffectiveConfig();
    const openConfig = useConfigStore((state) => state.openConfigDialog);
    const accept = useCallback((value: OmniProject) => {
        current.current = value;
        setProject(value);
        setDraft(omniEditable(value));
        setDirty(false);
    }, []);
    const load = useCallback(() => omniRequest<OmniProject>(omniProjectPath(id)), [id]);
    useEffect(() => {
        let active = true;
        load()
            .then((value) => {
                if (active) accept(value);
            })
            .catch((error: Error) => {
                if (active) setError(error.message);
            });
        return () => {
            active = false;
        };
    }, [load, accept]);
    const running = Boolean(project?.operation || project?.segments.some((segment) => segment.video.status === "running" || segment.video.status === "queued"));
    useEffect(() => {
        if (!running) return;
        let active = true;
        let inFlight = false;
        const timer = setInterval(async () => {
            if (lock.current || inFlight) return;
            inFlight = true;
            try {
                const value = await load();
                if (active && !lock.current && value.revision >= (current.current?.revision || 0)) accept(value);
            } catch (error) {
                if (active) setError((error as Error).message);
            } finally {
                inFlight = false;
            }
        }, 4000);
        return () => {
            active = false;
            clearInterval(timer);
        };
    }, [running, load, accept]);
    useEffect(() => {
        const warn = (event: BeforeUnloadEvent) => {
            if (dirty) {
                event.preventDefault();
                event.returnValue = "";
            }
        };
        window.addEventListener("beforeunload", warn);
        return () => window.removeEventListener("beforeunload", warn);
    }, [dirty]);
    const change = (patch: Partial<ReturnType<typeof omniEditable>>) => {
        setDraft((value) => (value ? { ...value, ...patch } : value));
        setDirty(true);
    };
    const action = async (label: string, run: () => Promise<void>) => {
        if (lock.current) return;
        lock.current = true;
        setBusy(label);
        setError("");
        try {
            await run();
        } catch (error) {
            setError((error as Error).message);
        } finally {
            lock.current = false;
            setBusy("");
        }
    };
    const save = async () => {
        if (!current.current || !draft) throw new Error("项目尚未加载");
        if (!dirty) return current.current;
        const next = await omniRequest<OmniProject>(omniProjectPath(id), { ...draft, revision: current.current.revision }, "PATCH");
        accept(next);
        return next;
    };
    const operation = (kind: "analysis" | "prepare" | "merge") =>
        action(operationNames[kind], async () => {
            const saved = await save();
            accept(await omniRequest<OmniProject>(`${omniProjectPath(id)}/operations`, { revision: saved.revision, kind }));
        });
    const video = (segment: OmniSegment) =>
        action("提交片段视频", async () => {
            const saved = await save();
            try {
                accept(await omniRequest<OmniProject>(`${omniProjectPath(id)}/segments/${segment.id}/video`, { revision: saved.revision }));
            } catch (error) {
                accept(await load());
                throw error;
            }
        });
    const taskAction = (segment: OmniSegment, kind: "recover" | "cancel" | "abandon") =>
        action(kind === "recover" ? "检查原任务" : "结束本次任务", async () => {
            if (kind === "abandon") {
                accept(await omniRequest<OmniProject>(`${omniProjectPath(id)}/segments/${segment.id}/video`, undefined, "DELETE"));
                return;
            }
            if (!segment.video.taskId) throw new Error("没有可检查的原任务");
            if (kind === "cancel" && !window.confirm("取消当前片段任务？已经提交的上游任务会按系统取消规则处理。")) return;
            const response = await fetch(`/api/video-tasks/${encodeURIComponent(segment.video.taskId)}`, { method: kind === "recover" ? "POST" : "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: kind }) });
            const result = await response.json().catch(() => ({}));
            accept(await load());
            if (!response.ok) throw new Error(result.error || "原任务处理失败");
        });
    const download = (format: "zip" | "video") =>
        action("准备下载", async () => {
            if (dirty) throw new Error("请先保存修改，再导出当前项目");
            if (current.current?.operation) throw new Error("请等待当前处理步骤完成");
            const response = await fetch(`/api/omni-remake${omniProjectPath(id)}/export?format=${format}`);
            if (!response.ok) {
                const result = await response.json();
                throw new Error(result.msg || "导出失败");
            }
            const url = URL.createObjectURL(await response.blob());
            const anchor = document.createElement("a");
            anchor.href = url;
            anchor.download = `omni-remake.${format === "video" ? "mp4" : "zip"}`;
            anchor.click();
            setTimeout(() => URL.revokeObjectURL(url), 30000);
        });
    if (!project || !draft)
        return (
            <main className="p-8">
                <Link href="/omni-remake">返回全品类项目</Link>
                <p role={error ? "alert" : undefined} className="mt-4">
                    {error || "正在加载项目…"}
                </p>
            </main>
        );
    const disabled = Boolean(busy || running);
    const complete = project.segments.length > 0 && project.segments.every((segment) => segment.video.status === "completed");
    return (
        <main className="h-full overflow-y-auto bg-background">
            <header className="sticky top-0 z-20 flex flex-wrap items-center justify-between gap-3 border-b bg-background/95 px-5 py-3 backdrop-blur">
                <div className="flex items-center gap-3">
                    <Link href="/omni-remake" aria-label="返回全品类项目">
                        <ArrowLeft className="size-5" />
                    </Link>
                    <div>
                        <h1 className="font-semibold">{project.title}</h1>
                        <p className="text-xs text-muted-foreground">Omni 全品类复刻 · {dirty ? "有未保存修改" : "已保存"}</p>
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    <Button variant="outline" disabled={Boolean(busy) || dirty} onClick={() => void action("检查状态", async () => accept(await load()))}>
                        检查状态
                    </Button>
                    <Button
                        disabled={disabled || !dirty}
                        onClick={() =>
                            void action("保存项目", async () => {
                                await save();
                            })
                        }
                    >
                        <Save className="mr-2 size-4" />
                        保存
                    </Button>
                </div>
            </header>
            <div className="mx-auto max-w-7xl space-y-6 p-5 md:p-8">
                {(busy || project.operation) && (
                    <p role="status" className="flex items-center gap-2 rounded-lg bg-muted p-3 text-sm">
                        <Loader2 className="size-4 animate-spin" />
                        {busy || operationNames[project.operation!.kind]}…
                    </p>
                )}
                {(error || project.error) && (
                    <p role="alert" className="rounded-lg border border-destructive/30 p-3 text-sm text-destructive">
                        {error || project.error}
                    </p>
                )}
                <section className="grid gap-6 lg:grid-cols-[1fr_1.3fr]">
                    <div className="space-y-4 rounded-xl border p-5">
                        <h2 className="text-lg font-medium">1. 参考视频</h2>
                        <Input aria-label="项目名称" value={draft.title} maxLength={120} disabled={disabled} onChange={(event) => change({ title: event.target.value })} />
                        {draft.sourceVideo && <video controls preload="metadata" src={draft.sourceVideo.url} className="max-h-72 w-full rounded-lg bg-black" />}
                        <label className={`flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed p-5 text-sm ${disabled ? "pointer-events-none opacity-50" : ""}`}>
                            <Upload className="size-4" />
                            {draft.sourceVideo ? "更换参考视频" : "上传参考视频"}
                            <input
                                aria-label="上传参考视频"
                                className="sr-only"
                                type="file"
                                accept="video/*"
                                disabled={disabled}
                                onChange={(event) => {
                                    const file = event.target.files?.[0];
                                    event.target.value = "";
                                    if (file) void action("上传视频", async () => change({ sourceVideo: await uploadOmniVideo(id, file) }));
                                }}
                            />
                        </label>
                        <p className="text-xs text-muted-foreground">支持按原片时长处理。单文件最多 200 MB，每个生成片段不超过 10 秒。</p>
                        <label className="block space-y-2 text-sm">
                            <span>原声音频</span>
                            <select aria-label="原声音频" className="w-full rounded-md border bg-background p-2" value={draft.audioMode} disabled={disabled} onChange={(event) => change({ audioMode: event.target.value as OmniProject["audioMode"] })}>
                                <option value="auto">按口型判断：单人清晰说话保留，其余移除</option>
                                <option value="silent">全部静音</option>
                                <option value="source">全部保留原声</option>
                            </select>
                        </label>
                        <Button disabled={disabled || !draft.sourceVideo} onClick={() => void operation("analysis")}>
                            {project.segments.length ? "重新分析原片" : "分析原片"}
                        </Button>
                    </div>
                    <div className="space-y-4 rounded-xl border p-5">
                        <h2 className="text-lg font-medium">2. 目标素材</h2>
                        <div className="flex flex-wrap gap-4 text-sm">
                            <label className="flex items-center gap-2">
                                <input type="checkbox" checked={draft.productStrategy === "replace"} disabled={disabled} onChange={(event) => change({ productStrategy: event.target.checked ? "replace" : "preserve" })} />
                                替换产品
                            </label>
                            <label className="flex items-center gap-2">
                                <input type="checkbox" checked={draft.replaceCharacter} disabled={disabled} onChange={(event) => change({ replaceCharacter: event.target.checked })} />
                                替换人物
                            </label>
                            <label className="flex items-center gap-2">
                                <input type="checkbox" checked={draft.replaceBackground} disabled={disabled} onChange={(event) => change({ replaceBackground: event.target.checked })} />
                                替换背景
                            </label>
                        </div>
                        <Input
                            aria-label="产品名称"
                            placeholder={draft.productStrategy === "replace" ? "新产品名称（换品必填）" : "原产品名称（选填）"}
                            value={draft.productName}
                            disabled={disabled}
                            onChange={(event) => change({ productName: event.target.value })}
                        />
                        {(["product", "character", "background"] as const)
                            .filter((role) => role === "product" || (role === "character" ? draft.replaceCharacter : draft.replaceBackground))
                            .map((role) => (
                                <div key={role} className="space-y-2">
                                    <p className="text-sm">{{ product: draft.productStrategy === "replace" ? "新产品参考图" : "原产品细节图（选填）", character: "人物参考图", background: "背景参考图" }[role]}</p>
                                    <div className="flex flex-wrap gap-2">
                                        {draft.references[role].map((asset, index) => (
                                            <div key={asset.url} className="relative">
                                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                                <img src={asset.url} alt={`${role} 参考图 ${index + 1}`} className="size-20 rounded-lg border object-cover" />
                                                <button
                                                    aria-label={`移除 ${role} 参考图 ${index + 1}`}
                                                    disabled={disabled}
                                                    className="absolute right-0 top-0 rounded-full bg-background p-1"
                                                    onClick={() => change({ references: { ...draft.references, [role]: draft.references[role].filter((_, itemIndex) => itemIndex !== index) } })}
                                                >
                                                    <X className="size-3" />
                                                </button>
                                            </div>
                                        ))}
                                        <label className={`flex size-20 cursor-pointer items-center justify-center rounded-lg border border-dashed ${disabled ? "pointer-events-none opacity-50" : ""}`}>
                                            <Upload className="size-4" />
                                            <input
                                                aria-label={`上传${{ product: "产品", character: "人物", background: "背景" }[role]}图`}
                                                className="sr-only"
                                                type="file"
                                                accept="image/*"
                                                multiple
                                                disabled={disabled}
                                                onChange={(event) => {
                                                    const files = Array.from(event.target.files || []);
                                                    event.target.value = "";
                                                    if (files.length)
                                                        void action("上传参考图", async () => {
                                                            if (files.length + draft.references[role].length > 5 || files.length + Object.values(draft.references).flat().length > 10) throw new Error("每类最多 5 张，合计最多 10 张");
                                                            const assets = [];
                                                            for (const file of files) assets.push({ ...(await uploadImage(file)), originalName: file.name });
                                                            change({ references: { ...draft.references, [role]: [...draft.references[role], ...assets] } });
                                                        });
                                                }}
                                            />
                                        </label>
                                    </div>
                                </div>
                            ))}
                        <Textarea aria-label="产品人物补充" placeholder="产品特征、人物或背景补充要求" value={draft.instructions} disabled={disabled} onChange={(event) => change({ instructions: event.target.value })} />
                    </div>
                </section>
                <section className="space-y-4 rounded-xl border p-5">
                    <h2 className="text-lg font-medium">3. 片段计划</h2>
                    <div className="flex flex-wrap items-center gap-3">
                        <ModelPicker
                            config={config}
                            capability="text"
                            value={draft.modelSelection.prompt || config.textModel || ""}
                            onChange={(value) => change({ modelSelection: { ...draft.modelSelection, prompt: value } })}
                            onMissingConfig={() => openConfig(true)}
                            placeholder="选择视觉文本模型"
                            className={disabled ? "pointer-events-none opacity-50" : ""}
                        />
                        <Button disabled={disabled || !project.segments.length} onClick={() => void operation("prepare")}>
                            生成计划并准备片段
                        </Button>
                        <a href={OMNI_SOURCE_URL} target="_blank" rel="noreferrer" className="text-xs text-muted-foreground underline">
                            来源表格
                        </a>
                    </div>
                    {project.analysisSummary && <p className="whitespace-pre-wrap text-sm text-muted-foreground">{project.analysisSummary}</p>}
                    {project.plan && (
                        <details>
                            <summary className="cursor-pointer text-sm">查看素材分析与总计划</summary>
                            <div className="mt-3 whitespace-pre-wrap rounded-lg bg-muted p-4 text-sm">
                                {project.materialAnalysis}
                                {"\n\n"}
                                {project.plan}
                            </div>
                        </details>
                    )}
                </section>
                <section className="space-y-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                        <h2 className="text-lg font-medium">4. 逐段生成</h2>
                        <ModelPicker
                            config={config}
                            capability="video"
                            value={draft.modelSelection.video || config.videoModel || ""}
                            onChange={(value) => change({ modelSelection: { ...draft.modelSelection, video: value } })}
                            onMissingConfig={() => openConfig(true)}
                            placeholder="选择支持视频参考的模型"
                            className={disabled ? "pointer-events-none opacity-50" : ""}
                        />
                    </div>
                    {!project.segments.length && <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">分析完成后在这里查看片段。</p>}
                    <div className="grid gap-4 xl:grid-cols-2">
                        {project.segments.map((segment) => (
                            <SegmentCard
                                key={`${segment.id}:${segment.prompt}:${segment.promptZh}`}
                                segment={segment}
                                disabled={disabled}
                                canManageTask={!busy}
                                onTaskAction={(kind) => void taskAction(segment, kind)}
                                canRetryQueued={!busy && !project.operation && segment.video.status === "queued"}
                                onVideo={() => void video(segment)}
                                onSave={(prompt, promptZh) =>
                                    action("保存片段提示词", async () => {
                                        const saved = await save();
                                        accept(await omniRequest<OmniProject>(`${omniProjectPath(id)}/segments/${segment.id}`, { revision: saved.revision, prompt, promptZh }, "PATCH"));
                                    })
                                }
                            />
                        ))}
                    </div>
                </section>
                <section className="space-y-4 rounded-xl border p-5">
                    <h2 className="text-lg font-medium">5. 成片与导出</h2>
                    <div className="flex flex-wrap gap-3">
                        <Button disabled={disabled || !complete || dirty} onClick={() => void operation("merge")}>
                            合并全部片段
                        </Button>
                        <Button variant="outline" disabled={Boolean(busy || project.operation) || dirty || !project.segments.every((segment) => segment.sourceClip) || !project.segments.length} onClick={() => void download("zip")}>
                            <Download className="mr-2 size-4" />
                            下载片段与提示词
                        </Button>
                        {project.mergedVideo && (
                            <Button variant="outline" disabled={Boolean(busy || project.operation) || dirty} onClick={() => void download("video")}>
                                <Download className="mr-2 size-4" />
                                下载成片
                            </Button>
                        )}
                    </div>
                    {project.mergedVideo && <video controls src={project.mergedVideo.url} className="max-h-96 w-full rounded-lg bg-black" />}
                </section>
            </div>
        </main>
    );
}

function SegmentCard({
    segment,
    disabled,
    canRetryQueued,
    canManageTask,
    onTaskAction,
    onSave,
    onVideo,
}: {
    segment: OmniSegment;
    disabled: boolean;
    canRetryQueued: boolean;
    canManageTask: boolean;
    onTaskAction: (kind: "recover" | "cancel" | "abandon") => void;
    onSave: (prompt: string, promptZh: string) => Promise<void>;
    onVideo: () => void;
}) {
    const [prompt, setPrompt] = useState(segment.prompt);
    const [promptZh, setPromptZh] = useState(segment.promptZh);
    const edited = prompt !== segment.prompt || promptZh !== segment.promptZh;
    return (
        <article className="space-y-3 rounded-xl border p-5">
            <div className="flex items-center justify-between">
                <h3 className="font-medium">
                    {segment.id} · {segment.start}—{segment.end} 秒
                </h3>
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    {segment.video.status === "completed" && <Check className="size-3" />}
                    {segment.video.needsReview ? "需要检查原任务" : statuses[segment.video.status]}
                </span>
            </div>
            <p className="text-xs text-muted-foreground">
                {segment.audioStrategy === "preserve_audio" ? "保留原声" : "移除音频"} · {segment.description}
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
                {segment.sourceClip && (
                    <figure>
                        <video controls preload="metadata" src={segment.sourceClip.url} className="max-h-56 w-full rounded-lg bg-black" />
                        <figcaption className="mt-1 text-xs text-muted-foreground">原片段</figcaption>
                    </figure>
                )}
                {segment.video.result && (
                    <figure>
                        <video controls preload="metadata" src={segment.video.result.url} className="max-h-56 w-full rounded-lg bg-black" />
                        <figcaption className="mt-1 text-xs">
                            <a download href={segment.video.result.url} className="underline">
                                下载生成片段
                            </a>
                        </figcaption>
                    </figure>
                )}
            </div>
            {segment.prompt && (
                <details>
                    <summary className="cursor-pointer text-sm">查看和编辑中英文提示词{edited ? "（未保存）" : ""}</summary>
                    <div className="mt-3 space-y-3">
                        <Textarea aria-label={`${segment.id} 中文提示词`} value={promptZh} disabled={disabled} onChange={(event) => setPromptZh(event.target.value)} className="min-h-32" />
                        <Textarea aria-label={`${segment.id} 英文提示词`} value={prompt} disabled={disabled} onChange={(event) => setPrompt(event.target.value)} className="min-h-40" />
                        <Button size="sm" variant="outline" disabled={disabled || !edited || !prompt.trim()} onClick={() => void onSave(prompt, promptZh)}>
                            保存提示词
                        </Button>
                    </div>
                </details>
            )}
            {segment.video.error && (
                <p role="alert" className="text-sm text-destructive">
                    {segment.video.error}
                </p>
            )}
            <Button size="sm" disabled={(disabled && !canRetryQueued) || edited || !segment.prompt || !segment.sourceClip} onClick={onVideo}>
                {segment.video.status === "queued" ? "检查或继续提交" : segment.video.status === "completed" || segment.video.status === "error" ? "重新生成此片段" : "生成此片段"}
            </Button>
            {segment.video.status === "queued" && (
                <Button className="ml-2" size="sm" variant="outline" disabled={!canManageTask} onClick={() => onTaskAction("abandon")}>
                    检查并解除未提交任务
                </Button>
            )}
            {segment.video.status === "running" && segment.video.taskId && (
                <div className="flex gap-2">
                    <Button size="sm" variant="outline" disabled={!canManageTask} onClick={() => onTaskAction("recover")}>
                        检查原任务
                    </Button>
                    <Button size="sm" variant="ghost" disabled={!canManageTask} onClick={() => onTaskAction("cancel")}>
                        取消原任务
                    </Button>
                </div>
            )}
        </article>
    );
}
