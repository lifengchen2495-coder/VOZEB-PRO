"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { App, Button, Image, Input, InputNumber, Popconfirm, Segmented, Skeleton, Tag } from "antd";
import { ArrowLeft, Check, Download, Film, RefreshCw, Save, Scissors, Shirt, Sparkles, Trash2, Upload } from "lucide-react";

import { ModelPicker } from "@/components/model-picker";
import { browserReadableMediaUrl } from "@/lib/browser-media-url";
import { omniClothingStatusLabel, type OmniClothingProject, type OmniClothingSegment } from "@/lib/omni-clothing-contract";
import { cancelServerVideoGenerationTask, createServerVideoGenerationTask, recoverVideoGenerationTask } from "@/services/api/video";
import type { VideoGenerationTask } from "@/services/api/video-types";
import { useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";

import { clothingAction, downloadClothingBundle, loadClothingProject, saveClothingProject, uploadClothingAsset } from "../omni-clothing-api";

type Draft = Pick<OmniClothingProject, "title" | "garmentDescription" | "audioStrategy" | "model" | "maxSegmentSeconds" | "referenceImages" | "sourceVideo">;
function draftFrom(project: OmniClothingProject): Draft {
    return {
        title: project.title,
        garmentDescription: project.garmentDescription,
        audioStrategy: project.audioStrategy,
        model: project.model,
        maxSegmentSeconds: project.maxSegmentSeconds,
        referenceImages: project.referenceImages,
        sourceVideo: project.sourceVideo,
    };
}
function taskFrom(segment: OmniClothingSegment, model: string): VideoGenerationTask {
    return { id: segment.videoTaskId!, serverTaskId: segment.videoTaskId, model, provider: "generation", pollPath: "server" };
}

export function OmniClothingWorkspace() {
    const { id } = useParams<{ id: string }>();
    const { message } = App.useApp();
    const config = useEffectiveConfig();
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const [project, setProject] = useState<OmniClothingProject | null>(null);
    const [draft, setDraft] = useState<Draft | null>(null);
    const [busy, setBusy] = useState("");
    const [error, setError] = useState("");
    const [boundaries, setBoundaries] = useState("");
    const projectRef = useRef<OmniClothingProject | null>(null);
    const busyRef = useRef(false);
    const mountedRef = useRef(true);
    const sourceInputRef = useRef<HTMLInputElement>(null);
    const imageInputRef = useRef<HTMLInputElement>(null);
    const accept = useCallback((next: OmniClothingProject) => {
        if (!mountedRef.current || (projectRef.current && projectRef.current.id === next.id && projectRef.current.revision > next.revision)) return next;
        projectRef.current = next;
        setProject(next);
        setDraft(draftFrom(next));
        return next;
    }, []);
    useEffect(() => {
        mountedRef.current = true;
        let cancelled = false;
        void loadClothingProject(id)
            .then((next) => {
                if (!cancelled) accept(next);
            })
            .catch((reason) => {
                if (!cancelled) setError(reason instanceof Error ? reason.message : "项目加载失败");
            });
        return () => {
            cancelled = true;
            mountedRef.current = false;
        };
    }, [accept, id]);
    const active = Boolean(project?.operation || project?.segments.some((segment) => ["submitting", "running"].includes(segment.videoStatus)));
    useEffect(() => {
        if (!active) return;
        let cancelled = false;
        let pending = false;
        const timer = window.setInterval(() => {
            if (busyRef.current || pending) return;
            pending = true;
            void loadClothingProject(id)
                .then((next) => {
                    if (!cancelled && !busyRef.current) accept(next);
                })
                .catch((reason) => {
                    if (!cancelled) setError(reason instanceof Error ? reason.message : "视频状态刷新失败");
                })
                .finally(() => {
                    pending = false;
                });
        }, 10_000);
        return () => {
            cancelled = true;
            window.clearInterval(timer);
        };
    }, [accept, active, id]);

    async function run(label: string, action: () => Promise<void>) {
        if (busyRef.current) return;
        busyRef.current = true;
        setBusy(label);
        setError("");
        try {
            await action();
        } catch (reason) {
            const text = reason instanceof Error ? reason.message : "操作失败";
            setError(text);
            message.error(text);
        } finally {
            busyRef.current = false;
            if (mountedRef.current) setBusy("");
        }
    }
    async function saveDraft(nextDraft = draft!) {
        const current = projectRef.current!;
        if (JSON.stringify(nextDraft) === JSON.stringify(draftFrom(current))) return current;
        return accept(await saveClothingProject(id, { ...nextDraft, revision: current.revision }));
    }
    async function action(name: string, values: Record<string, unknown> = {}) {
        const current = await saveDraft();
        return accept(await clothingAction(id, name, { revision: current.revision, ...values }));
    }
    async function upload(files: File[], type: "image" | "video") {
        await run(type === "image" ? "上传服装参考图" : "上传源视频", async () => {
            if (type === "image" && draft!.referenceImages.length + files.length > 5) throw new Error("最多上传 5 张服装参考图");
            const current = await saveDraft();
            const assets = [];
            for (const file of type === "video" ? files.slice(0, 1) : files) assets.push(await uploadClothingAsset(id, file, type));
            await saveDraft({ ...draftFrom(current), ...(type === "video" ? { sourceVideo: assets[0] } : { referenceImages: [...current.referenceImages, ...assets] }) });
            message.success(type === "video" ? "源视频已保存" : "服装参考图已保存");
        });
    }
    async function generate(segmentId: string) {
        await run("提交视频任务", async () => {
            await saveDraft();
            let current = accept(await loadClothingProject(id));
            let segment = current.segments.find((item) => item.id === segmentId)!;
            if (segment.videoStatus === "running") return;
            if (segment.videoStatus !== "submitting") {
                current = accept(await clothingAction(id, "attempt", { revision: current.revision, segmentId }));
                segment = current.segments.find((item) => item.id === segmentId)!;
            }
            const generationConfig = {
                ...config,
                model: current.model,
                videoModel: current.model,
                videoSeconds: String(segment.generationDurationSeconds),
                videoGenerateAudio: "false",
                videoWatermark: "false",
                size: sourceRatio(current),
                vquality: config.vquality || "720",
            };
            try {
                const task = await createServerVideoGenerationTask(
                    generationConfig,
                    segment.prompt,
                    current.referenceImages.map((asset, index) => ({ id: `clothing-${index + 1}`, name: asset.name, type: asset.mimeType, dataUrl: "", url: asset.url, serverUrl: asset.url, storageKey: asset.storageKey })),
                    [
                        {
                            id: segment.id,
                            name: segment.sourceVideo.name,
                            type: segment.sourceVideo.mimeType,
                            url: segment.sourceVideo.url,
                            storageKey: segment.sourceVideo.storageKey,
                            durationMs: Math.round(segment.durationSeconds * 1000),
                            bytes: segment.sourceVideo.bytes,
                        },
                    ],
                    [],
                    { projectId: current.id, generationSlotId: `omni-clothing-video:${segment.id}`, clientRequestId: segment.clientRequestId, attemptNo: segment.attemptNo, source: "video-workbench" },
                );
                accept(await clothingAction(id, "bind", { segmentId, taskId: task.serverTaskId || task.id }));
                message.success(`片段 ${segment.index} 已提交，刷新页面也可继续查看`);
            } catch (reason) {
                try {
                    accept(await clothingAction(id, "submission-failed", { segmentId, attemptNo: segment.attemptNo, clientRequestId: segment.clientRequestId }));
                } catch (recordError) {
                    console.warn("服装视频提交状态未保存", recordError);
                }
                throw reason;
            }
        });
    }

    if (!project || !draft)
        return (
            <main className="h-full overflow-y-auto p-6">
                <Link href="/omni-clothing" className="text-sm text-muted-foreground">
                    返回服装复刻
                </Link>
                {error ? (
                    <div role="alert" className="mt-6">
                        <p>{error}</p>
                        <Button
                            className="mt-3"
                            onClick={() =>
                                void run("重新加载", async () => {
                                    accept(await loadClothingProject(id));
                                })
                            }
                        >
                            重新加载
                        </Button>
                    </div>
                ) : (
                    <Skeleton active className="mt-8" />
                )}
            </main>
        );
    const locked = Boolean(busy || active);
    const dirty = JSON.stringify(draft) !== JSON.stringify(draftFrom(project));
    const imagesReady = draft.referenceImages.length >= 4 && draft.referenceImages.length <= 5;
    const allDone = project.segments.length > 0 && project.segments.every((segment) => segment.videoStatus === "success");
    const patchDraft = (patch: Partial<Draft>) => setDraft((value) => (value ? { ...value, ...patch } : value));
    return (
        <main className="h-full overflow-y-auto bg-background text-foreground">
            <div className="mx-auto max-w-7xl px-4 py-5 sm:px-6 sm:py-7">
                <header className="flex flex-wrap items-center justify-between gap-4 border-b border-border pb-5">
                    <div className="min-w-0">
                        <Link href="/omni-clothing" className="inline-flex items-center gap-1 text-sm text-muted-foreground">
                            <ArrowLeft className="size-4" />
                            服装视频复刻
                        </Link>
                        <h1 className="mt-2 truncate text-xl font-semibold">{project.title}</h1>
                        <p className="mt-1 text-sm text-muted-foreground">替换服装，保留人物、背景、动作和镜头节奏</p>
                    </div>
                    <div className="flex items-center gap-2">
                        <Tag>{omniClothingStatusLabel(project.status)}</Tag>
                        <Button
                            disabled={Boolean(busy)}
                            icon={<RefreshCw className="size-4" />}
                            onClick={() =>
                                void run("刷新项目", async () => {
                                    accept(await loadClothingProject(id));
                                })
                            }
                        >
                            刷新
                        </Button>
                        <Button
                            disabled={!dirty || locked}
                            icon={<Save className="size-4" />}
                            onClick={() =>
                                void run("保存素材", async () => {
                                    await saveDraft();
                                    message.success("项目已保存");
                                })
                            }
                        >
                            保存
                        </Button>
                    </div>
                </header>
                {(error || project.error) && (
                    <div role="alert" className="mt-4 rounded-lg border border-rose-300 bg-rose-50/50 p-3 text-sm text-rose-800 dark:border-rose-900 dark:bg-rose-950/30 dark:text-rose-200">
                        {error || project.error}
                    </div>
                )}
                {(busy || project.operation) && (
                    <div role="status" className="mt-4 flex items-center gap-2 rounded-lg bg-muted px-4 py-3 text-sm">
                        <RefreshCw className="size-4 animate-spin" />
                        {busy || (project.operation?.kind === "split" ? "正在检测自然边界并切片" : "正在合并视频")}，请稍候。
                    </div>
                )}

                <section className="mt-6 grid gap-5 lg:grid-cols-[minmax(260px,0.8fr)_minmax(0,1.5fr)]">
                    <div className="rounded-xl border border-border p-4">
                        <h2 className="flex items-center gap-2 font-semibold">
                            <Film className="size-4" />
                            1. 服装源视频
                        </h2>
                        <p className="mt-2 text-xs leading-5 text-muted-foreground">上传 MP4、MOV 或 WebM，最大 200 MB。总时长按实际视频保留。</p>
                        <div className="mt-4 flex min-h-52 items-center justify-center overflow-hidden rounded-lg bg-muted">
                            {draft.sourceVideo ? <video src={browserReadableMediaUrl(draft.sourceVideo.url)} controls preload="metadata" className="max-h-80 w-full" /> : <Film className="size-10 text-muted-foreground" />}
                        </div>
                        {draft.sourceVideo && (
                            <p className="mt-2 break-all text-xs text-muted-foreground">
                                {draft.sourceVideo.name}
                                {draft.sourceVideo.durationSeconds ? ` · ${draft.sourceVideo.durationSeconds} 秒` : ""}
                            </p>
                        )}
                        <input
                            hidden
                            ref={sourceInputRef}
                            type="file"
                            accept="video/mp4,video/quicktime,video/webm"
                            onChange={(event) => {
                                const files = Array.from(event.target.files || []);
                                event.target.value = "";
                                if (files.length) void upload(files, "video");
                            }}
                        />
                        <Button className="mt-4 w-full" disabled={locked} icon={<Upload className="size-4" />} onClick={() => sourceInputRef.current?.click()}>
                            {draft.sourceVideo ? "更换源视频" : "上传源视频"}
                        </Button>
                    </div>
                    <div className="rounded-xl border border-border p-4">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                            <h2 className="flex items-center gap-2 font-semibold">
                                <Shirt className="size-4" />
                                2. 新服装参考图
                            </h2>
                            <Tag color={imagesReady ? "green" : undefined}>{draft.referenceImages.length} / 4–5 张</Tag>
                        </div>
                        <p className="mt-2 text-xs leading-5 text-muted-foreground">建议包含正面、背面、侧面和材质细节，均为同一套目标服装。</p>
                        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
                            <Image.PreviewGroup>
                                {draft.referenceImages.map((asset, index) => (
                                    <div key={asset.storageKey} className="min-w-0 rounded-lg border border-border p-2">
                                        <Image src={asset.url} alt={`服装参考 ${index + 1}`} className="!aspect-[3/4] !w-full !object-contain" />
                                        <div className="mt-2 flex items-center justify-between gap-1">
                                            <span className="truncate text-xs text-muted-foreground">参考 {index + 1}</span>
                                            <Button
                                                size="small"
                                                type="text"
                                                danger
                                                disabled={locked}
                                                aria-label={`移除参考图 ${index + 1}`}
                                                icon={<Trash2 className="size-3.5" />}
                                                onClick={() => patchDraft({ referenceImages: draft.referenceImages.filter((item) => item.storageKey !== asset.storageKey) })}
                                            />
                                        </div>
                                    </div>
                                ))}
                            </Image.PreviewGroup>
                            {draft.referenceImages.length < 5 && (
                                <button
                                    disabled={locked}
                                    className="flex min-h-36 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border text-sm text-muted-foreground disabled:opacity-40"
                                    onClick={() => imageInputRef.current?.click()}
                                >
                                    <Upload className="size-5" />
                                    添加服装图
                                </button>
                            )}
                        </div>
                        <input
                            hidden
                            ref={imageInputRef}
                            type="file"
                            multiple
                            accept="image/jpeg,image/png,image/webp"
                            onChange={(event) => {
                                const files = Array.from(event.target.files || []);
                                event.target.value = "";
                                if (files.length) void upload(files, "image");
                            }}
                        />
                        <label className="mt-5 block text-sm" htmlFor="clothing-description">
                            服装细节说明
                        </label>
                        <Input.TextArea
                            id="clothing-description"
                            className="mt-2"
                            disabled={locked}
                            rows={3}
                            maxLength={6000}
                            value={draft.garmentDescription}
                            placeholder="例如：深绿色圆领连衣裙，七分袖、收腰、不对称腰部垂片；参考图是服装外观的依据。"
                            onChange={(event) => patchDraft({ garmentDescription: event.target.value })}
                        />
                    </div>
                </section>

                <section className="mt-5 rounded-xl border border-border p-4">
                    <h2 className="font-semibold">3. 视频切片与声音</h2>
                    <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                        <div>
                            <label className="mb-2 block text-sm" htmlFor="clothing-title">
                                项目名称
                            </label>
                            <Input id="clothing-title" value={draft.title} disabled={locked} maxLength={120} onChange={(event) => patchDraft({ title: event.target.value })} />
                        </div>
                        <div>
                            <span className="mb-2 block text-sm">视频编辑模型</span>
                            <div className={locked ? "pointer-events-none opacity-50" : ""}>
                                <ModelPicker config={config} value={draft.model} capability="video" fullWidth onChange={(model) => patchDraft({ model })} onMissingConfig={() => openConfigDialog(true)} />
                            </div>
                        </div>
                        <div>
                            <label className="mb-2 block text-sm" htmlFor="clothing-max-seconds">
                                单片时长上限
                            </label>
                            <div className="flex items-center gap-2">
                                <InputNumber id="clothing-max-seconds" min={2} max={60} value={draft.maxSegmentSeconds} disabled={locked} onChange={(value) => patchDraft({ maxSegmentSeconds: value || 10 })} />
                                <span className="text-sm text-muted-foreground">秒</span>
                            </div>
                        </div>
                        <div>
                            <span className="mb-2 block text-sm">成片音频</span>
                            <Segmented
                                disabled={locked}
                                value={draft.audioStrategy}
                                options={[
                                    { label: "无音频", value: "mute" },
                                    { label: "保留源音频", value: "preserve" },
                                ]}
                                onChange={(value) => patchDraft({ audioStrategy: value as Draft["audioStrategy"] })}
                            />
                        </div>
                    </div>
                    <p className="mt-3 text-xs leading-5 text-muted-foreground">优先在镜头变化处切分，并遵守所选模型时长上限。连续长镜头会按上限拆分，可在下面手动调整切点。保留源音频时，合并阶段会恢复原视频声音。</p>
                    <div className="mt-4 flex flex-wrap items-center gap-3">
                        <Button
                            type="primary"
                            disabled={locked || !draft.sourceVideo || !imagesReady || !draft.model}
                            icon={<Scissors className="size-4" />}
                            onClick={() =>
                                void run("检测自然边界并切片", async () => {
                                    await action("split");
                                    setBoundaries("");
                                    message.success("视频已完成切片");
                                })
                            }
                        >
                            {project.segments.length ? "重新自动切片" : "按自然边界切片"}
                        </Button>
                        <Button
                            disabled={locked || !project.segments.length || !imagesReady}
                            icon={<Sparkles className="size-4" />}
                            onClick={() =>
                                void run("生成视频编辑提示词", async () => {
                                    await action("prompts");
                                    message.success("逐片提示词已保存");
                                })
                            }
                        >
                            {project.segments.some((segment) => segment.prompt) ? "重新生成提示词" : "生成视频编辑提示词"}
                        </Button>
                        {dirty && <span className="text-xs text-amber-600">有未保存的修改，下一步会先保存</span>}
                    </div>
                    {project.segments.length > 0 && (
                        <details className="mt-4 border-t border-border pt-3">
                            <summary className="cursor-pointer text-sm text-muted-foreground">手动调整切点</summary>
                            <div className="mt-3 flex flex-wrap gap-2">
                                <Input className="!w-72" aria-label="手动切点秒数" placeholder="中间切点秒数，例如：8.7, 17.3" value={boundaries} disabled={locked} onChange={(event) => setBoundaries(event.target.value)} />
                                <Button
                                    disabled={locked || !boundaries.trim()}
                                    onClick={() =>
                                        void run("按指定边界切片", async () => {
                                            const points = boundaries
                                                .split(/[,，\s]+/)
                                                .filter(Boolean)
                                                .map(Number);
                                            if (points.some((value) => !Number.isFinite(value))) throw new Error("请填写有效的切点秒数");
                                            await action("split", { boundaries: points });
                                        })
                                    }
                                >
                                    应用切点
                                </Button>
                            </div>
                            <p className="mt-2 text-xs text-muted-foreground">仅填写中间切点，无需填写 0 和视频结尾。每段连续衔接，不重叠、不遗漏。</p>
                        </details>
                    )}
                </section>

                {project.segments.length > 0 && (
                    <section className="mt-6">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                            <h2 className="text-lg font-semibold">4. 逐片生成 · 共 {project.segments.length} 段</h2>
                            <span className="text-sm text-muted-foreground">已完成 {project.segments.filter((segment) => segment.videoStatus === "success").length} 段</span>
                        </div>
                        <div className="mt-4 space-y-4">
                            {project.segments.map((segment) => (
                                <ClothingSegmentCard
                                    key={`${segment.id}:${segment.prompt}`}
                                    segment={segment}
                                    disabled={Boolean(busy || project.operation || dirty)}
                                    editingDisabled={locked || dirty}
                                    onGenerate={() => void generate(segment.id)}
                                    onPromptSave={(prompt) =>
                                        void run("保存片段提示词", async () => {
                                            accept(await clothingAction(id, "prompt", { revision: projectRef.current!.revision, segmentId: segment.id, prompt }));
                                        })
                                    }
                                    onRecover={() =>
                                        void run("检查原视频任务", async () => {
                                            await recoverVideoGenerationTask(taskFrom(segment, project.model));
                                            accept(await loadClothingProject(id));
                                        })
                                    }
                                    onAbandon={() =>
                                        void run("检查未确认的提交", async () => {
                                            accept(await clothingAction(id, "abandon-submission", { segmentId: segment.id }));
                                        })
                                    }
                                    onCancel={() =>
                                        void run("取消视频任务", async () => {
                                            await cancelServerVideoGenerationTask(taskFrom(segment, project.model));
                                            accept(await loadClothingProject(id));
                                        })
                                    }
                                />
                            ))}
                        </div>
                    </section>
                )}

                <section className="my-6 rounded-xl border border-border p-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                            <h2 className="font-semibold">5. 合并与导出</h2>
                            <p className="mt-2 text-xs text-muted-foreground">按源时间线合并全部片段，自动裁掉模型补足的尾帧。</p>
                        </div>
                        <div className="flex flex-wrap gap-2">
                            <Button
                                disabled={locked || !allDone || dirty}
                                type="primary"
                                icon={<Film className="size-4" />}
                                onClick={() =>
                                    void run("合并全部视频", async () => {
                                        accept(await clothingAction(id, "merge", { revision: projectRef.current!.revision }));
                                        message.success("服装复刻成片已生成");
                                    })
                                }
                            >
                                合并成片
                            </Button>
                            <Button
                                disabled={Boolean(busy || !project.mergedVideo || dirty)}
                                icon={<Download className="size-4" />}
                                onClick={() =>
                                    void run("导出完整素材包", async () => {
                                        await downloadClothingBundle(id, project.title);
                                    })
                                }
                            >
                                完整包 ZIP
                            </Button>
                        </div>
                    </div>
                    {project.mergedVideo && (
                        <div className="mt-5 grid items-start gap-4 sm:grid-cols-[minmax(0,420px)_1fr]">
                            <video src={browserReadableMediaUrl(project.mergedVideo.url)} controls preload="metadata" className="max-h-[560px] w-full rounded-lg bg-black" />
                            <div>
                                <div className="flex items-center gap-2 text-sm text-emerald-600">
                                    <Check className="size-4" />
                                    成片已保存
                                </div>
                                <p className="mt-3 text-sm text-muted-foreground">
                                    {project.mergedVideo.durationSeconds} 秒 · {project.audioStrategy === "preserve" ? "使用源视频音频" : "无音频"}
                                </p>
                                <a href={project.mergedVideo.url} download={project.mergedVideo.name} className="mt-4 inline-flex items-center gap-2 text-sm underline">
                                    <Download className="size-4" />
                                    下载成片 MP4
                                </a>
                                <p className="mt-4 text-xs leading-5 text-muted-foreground">完整包包含源视频、服装参考图、源切片、生成片段、成片和逐片提示词。</p>
                            </div>
                        </div>
                    )}
                </section>
            </div>
        </main>
    );
}

export function ClothingSegmentCard({
    segment,
    disabled,
    editingDisabled,
    onGenerate,
    onPromptSave,
    onRecover,
    onCancel,
    onAbandon,
}: {
    segment: OmniClothingSegment;
    disabled: boolean;
    editingDisabled: boolean;
    onGenerate: () => void;
    onPromptSave: (prompt: string) => void;
    onRecover: () => void;
    onCancel: () => void;
    onAbandon: () => void;
}) {
    const [prompt, setPrompt] = useState(segment.prompt);
    const label = { idle: "待生成", submitting: "等待提交确认", running: "生成中", success: "已完成", error: "生成未完成" }[segment.videoStatus];
    const boundary = { scene: "镜头变化处", duration: "按时长拆分", manual: "手动切点", end: "视频结尾" }[segment.boundary];
    return (
        <article className="rounded-xl border border-border p-4">
            <header className="flex flex-wrap items-center justify-between gap-3">
                <div>
                    <h3 className="font-semibold">
                        片段 {segment.index}{" "}
                        <span className="ml-2 text-sm font-normal text-muted-foreground">
                            {segment.startSeconds}–{segment.endSeconds} 秒
                        </span>
                    </h3>
                    <p className="mt-1 text-xs text-muted-foreground">
                        源片 {segment.durationSeconds} 秒 · 模型输出 {segment.generationDurationSeconds} 秒 · {boundary}
                    </p>
                </div>
                <Tag color={segment.videoStatus === "success" ? "green" : segment.videoStatus === "error" ? "red" : undefined}>{label}</Tag>
            </header>
            <div className="mt-4 grid gap-4 md:grid-cols-[minmax(180px,0.8fr)_minmax(0,1.4fr)_minmax(180px,0.8fr)]">
                <div>
                    <p className="mb-2 text-xs text-muted-foreground">源片段</p>
                    <video src={browserReadableMediaUrl(segment.sourceVideo.url)} controls preload="metadata" className="max-h-72 w-full rounded-lg bg-black" />
                    <a href={segment.sourceVideo.url} download={segment.sourceVideo.name} className="mt-2 inline-block text-xs underline">
                        下载源片段
                    </a>
                </div>
                <div>
                    <label htmlFor={`prompt-${segment.id}`} className="mb-2 block text-xs text-muted-foreground">
                        视频编辑提示词
                    </label>
                    <Input.TextArea id={`prompt-${segment.id}`} rows={9} maxLength={20000} value={prompt} disabled={editingDisabled} placeholder="完成切片后，生成视频编辑提示词" onChange={(event) => setPrompt(event.target.value)} />
                    <div className="mt-2 flex gap-2">
                        <Button size="small" disabled={editingDisabled || !prompt.trim() || prompt === segment.prompt} onClick={() => onPromptSave(prompt)}>
                            保存提示词
                        </Button>
                        <Button size="small" disabled={!prompt} onClick={() => void navigator.clipboard.writeText(prompt)}>
                            复制
                        </Button>
                    </div>
                </div>
                <div>
                    <p className="mb-2 text-xs text-muted-foreground">服装替换结果</p>
                    {segment.videoUrl ? (
                        <video src={browserReadableMediaUrl(segment.videoUrl)} controls preload="metadata" className="max-h-72 w-full rounded-lg bg-black" />
                    ) : (
                        <div className="flex min-h-40 items-center justify-center rounded-lg bg-muted text-sm text-muted-foreground">{segment.videoStatus === "running" ? <RefreshCw className="size-6 animate-spin" /> : <Shirt className="size-8" />}</div>
                    )}
                    <div className="mt-3 flex flex-wrap gap-2">
                        {segment.videoStatus === "running" ? (
                            <>
                                <Button disabled={disabled} onClick={onRecover}>
                                    检查原任务
                                </Button>
                                <Popconfirm title="取消这个片段的视频生成？" onConfirm={onCancel}>
                                    <Button disabled={disabled} danger>
                                        取消任务
                                    </Button>
                                </Popconfirm>
                            </>
                        ) : (
                            <Button type="primary" disabled={disabled || !segment.prompt || prompt !== segment.prompt} icon={<Sparkles className="size-4" />} onClick={onGenerate}>
                                {segment.videoStatus === "submitting" ? "继续提交" : segment.videoStatus === "success" ? "重新生成" : "生成本片段"}
                            </Button>
                        )}
                        {segment.videoStatus === "submitting" && segment.error && (
                            <Button disabled={disabled} onClick={onAbandon}>
                                检查并放弃未提交任务
                            </Button>
                        )}
                    </div>
                    {segment.videoUrl && (
                        <a href={browserReadableMediaUrl(segment.videoUrl)} download={`服装片段-${segment.index}.mp4`} className="mt-2 inline-block text-xs underline">
                            下载生成片段
                        </a>
                    )}
                    {segment.error && (
                        <p role="alert" className="mt-2 text-xs leading-5 text-rose-600">
                            {segment.error}
                        </p>
                    )}
                </div>
            </div>
        </article>
    );
}

function sourceRatio(project: OmniClothingProject) {
    const ratio = (project.sourceVideo?.width || 720) / (project.sourceVideo?.height || 1280);
    return ratio > 0.9 && ratio < 1.1 ? "1:1" : ratio > 1 ? "16:9" : "9:16";
}
