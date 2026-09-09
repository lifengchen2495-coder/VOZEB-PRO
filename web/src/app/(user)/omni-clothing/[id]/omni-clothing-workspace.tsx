"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { App, Button, Image, Input, InputNumber, Popconfirm, Segmented, Skeleton, Tag } from "antd";
import { ArrowLeft, Check, Download, Film, RefreshCw, Save, Scissors, Shirt, Sparkles, Trash2, Upload } from "lucide-react";

import { browserReadableMediaUrl } from "@/lib/browser-media-url";
import { omniClothingStatusLabel, type OmniClothingAsset, type OmniClothingProject, type OmniClothingSegment } from "@/lib/omni-clothing-contract";
import { cancelServerVideoGenerationTask, recoverVideoGenerationTask } from "@/services/api/video";
import type { VideoGenerationTask } from "@/services/api/video-types";
import { useUserStore } from "@/stores/use-user-store";

import { clothingAction, downloadClothingBundle, loadClothingProject, saveClothingProject, uploadClothingAsset } from "../omni-clothing-api";

type Draft = Pick<OmniClothingProject, "title" | "garmentDescription" | "audioStrategy" | "maxSegmentSeconds" | "referenceImages" | "sourceVideo">;
type PendingResult = { asset: OmniClothingAsset; segmentId: string; inputVersion: number; revision: number; prompt: string; previousVideoUrl?: string; uploadedAt: number };
function storedPendingResults(prefix: string) {
    const records: Record<string, PendingResult> = {};
    for (let index = 0; index < localStorage.length; index++) {
        const key = localStorage.key(index);
        if (!key?.startsWith(`${prefix}:upload:`)) continue;
        try {
            const pending = JSON.parse(localStorage.getItem(key) || "null") as PendingResult | null;
            if (!pending?.asset?.storageKey || !pending.segmentId || !Number.isFinite(pending.inputVersion)) continue;
            if (!records[pending.segmentId] || records[pending.segmentId].uploadedAt < pending.uploadedAt) records[pending.segmentId] = pending;
        } catch {
            /* 其他损坏记录不影响可恢复的结果。 */
        }
    }
    return records;
}
function draftFrom(project: OmniClothingProject): Draft {
    return {
        title: project.title,
        garmentDescription: project.garmentDescription,
        audioStrategy: project.audioStrategy,
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
    const userId = useUserStore((state) => state.user?.id || "");
    const [project, setProject] = useState<OmniClothingProject | null>(null);
    const [draft, setDraft] = useState<Draft | null>(null);
    const [busy, setBusy] = useState("");
    const [error, setError] = useState("");
    const [boundaries, setBoundaries] = useState("");
    const [pendingResults, setPendingResults] = useState<Record<string, PendingResult>>({});
    const pendingKey = `omni-clothing-results:${userId}:${id}`;
    const projectRef = useRef<OmniClothingProject | null>(null);
    const busyRef = useRef(false);
    const mountedRef = useRef(true);
    const sourceInputRef = useRef<HTMLInputElement>(null);
    const imageInputRef = useRef<HTMLInputElement>(null);
    const maximumReferenceImages = 5;
    useEffect(() => {
        const restore = () => {
            try {
                setPendingResults(storedPendingResults(pendingKey));
            } catch {
                setPendingResults({});
            }
        };
        restore();
        const onStorage = (event: StorageEvent) => {
            if (event.key?.startsWith(`${pendingKey}:upload:`)) restore();
        };
        window.addEventListener("storage", onStorage);
        return () => window.removeEventListener("storage", onStorage);
    }, [pendingKey]);
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
            if (type === "image" && draft!.referenceImages.length + files.length > maximumReferenceImages) throw new Error(`最多上传 ${maximumReferenceImages} 张服装参考图`);
            const current = await saveDraft();
            const assets = [];
            for (const file of type === "video" ? files.slice(0, 1) : files) assets.push(await uploadClothingAsset(id, file, type));
            await saveDraft({ ...draftFrom(current), ...(type === "video" ? { sourceVideo: assets[0] } : { referenceImages: [...current.referenceImages, ...assets] }) });
            message.success(type === "video" ? "源视频已保存" : "服装参考图已保存");
        });
    }
    function rememberResult(segmentId: string, pending?: PendingResult, adoptedStorageKey?: string) {
        try {
            // 每个上传独立保存；采用 A 时不会删除另一个标签刚上传的 B。
            if (pending) localStorage.setItem(`${pendingKey}:upload:${encodeURIComponent(pending.asset.storageKey)}`, JSON.stringify(pending));
            else if (adoptedStorageKey) localStorage.removeItem(`${pendingKey}:upload:${encodeURIComponent(adoptedStorageKey)}`);
            if (mountedRef.current && projectRef.current?.id === id && useUserStore.getState().user?.id === userId) setPendingResults(storedPendingResults(pendingKey));
        } catch {
            setPendingResults((saved) => {
                if (pending) return { ...saved, [segmentId]: pending };
                if (saved[segmentId]?.asset.storageKey !== adoptedStorageKey) return saved;
                const next = { ...saved };
                delete next[segmentId];
                return next;
            });
            message.warning("浏览器无法保存恢复记录，请在离开页面前完成采用；视频已保留在素材库");
        }
    }
    async function importResult(segmentId: string, file?: File) {
        await run(file ? "上传并保存片段结果" : "重试采用已上传结果", async () => {
            const owner = useUserStore.getState().user?.id;
            if (!owner || owner !== userId) throw new Error("登录状态已变化，请刷新后回传结果");
            let pending = pendingResults[segmentId];
            const current = file ? projectRef.current! : accept(await loadClothingProject(id));
            const segment = current.segments.find((item) => item.id === segmentId);
            if (!segment) throw new Error("片段已被重新切分，请使用当前生成包");
            if (file) {
                const target = { segmentId, inputVersion: current.inputVersion, revision: current.revision };
                const asset = await uploadClothingAsset(id, file, "video", target);
                pending = { ...target, asset, prompt: segment.prompt, previousVideoUrl: segment.videoUrl, uploadedAt: Date.now() };
                rememberResult(segmentId, pending);
            }
            if (!pending) throw new Error("没有待采用的视频，请选择结果文件");
            if (owner !== useUserStore.getState().user?.id || projectRef.current?.id !== id) throw new Error("当前账号或项目已变化，结果已保留，请返回原项目采用");
            if (segment.videoUrl === pending.asset.url) {
                rememberResult(segmentId, undefined, pending.asset.storageKey);
                message.success("该结果已保存");
                return;
            }
            if (current.inputVersion !== pending.inputVersion || segment.prompt !== pending.prompt || segment.videoUrl !== pending.previousVideoUrl) throw new Error("片段素材、提示词或结果已变化；已上传视频保留在素材库，请核对后重新选择结果");
            accept(await clothingAction(id, "import-result", { revision: file ? pending.revision : current.revision, segmentId, inputVersion: pending.inputVersion, asset: pending.asset }));
            rememberResult(segmentId, undefined, pending.asset.storageKey);
            message.success(`片段 ${segment.index} 的结果已保存`);
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
    const imagesReady = draft.referenceImages.length >= 4 && draft.referenceImages.length <= maximumReferenceImages;
    const referenceCountLabel = "4–5";
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
                        <p className="mt-1 text-sm text-muted-foreground">准备素材 → 下载生成包 → 到谷歌手动生成 → 回传合并</p>
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
                            <Tag color={imagesReady ? "green" : undefined}>
                                {draft.referenceImages.length} / {referenceCountLabel} 张
                            </Tag>
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
                            {draft.referenceImages.length < maximumReferenceImages && (
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
                    <div className="mt-4 grid gap-4 sm:grid-cols-3">
                        <div>
                            <label className="mb-2 block text-sm" htmlFor="clothing-title">
                                项目名称
                            </label>
                            <Input id="clothing-title" value={draft.title} disabled={locked} maxLength={120} onChange={(event) => patchDraft({ title: event.target.value })} />
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
                            <span className="mb-2 block text-sm">分段素材与成片音频</span>
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
                    <p className="mt-3 text-xs leading-5 text-muted-foreground">
                        优先在镜头变化处切分，连续长镜头按上限拆分。请按你使用的谷歌工具设置单片上限。无音频模式在切片时即移除音轨；保留源音频时，合并阶段恢复原视频声音。更改音频策略需要重新切片。
                    </p>
                    <div className="mt-4 flex flex-wrap items-center gap-3">
                        <Button
                            type="primary"
                            disabled={locked || !draft.sourceVideo || !imagesReady}
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

                <section className="mt-5 rounded-xl border border-border p-4">
                    <div className="flex flex-wrap items-center justify-between gap-4">
                        <div>
                            <h2 className="font-semibold">4. 下载手动生成包</h2>
                            <p className="mt-2 text-sm text-muted-foreground">包含真实服装图、处理好声音的源片段、逐段英文提示词、中文说明和片段清单，生成前即可下载。</p>
                            <p className="mt-2 text-xs leading-5 text-muted-foreground">解压后按片段顺序到谷歌工具上传素材并粘贴提示词。具体参考输入方式和输出时长以你使用的工具为准，生成结果下载后回传到下方对应片段。</p>
                        </div>
                        <Button
                            type="primary"
                            icon={<Download className="size-4" />}
                            disabled={Boolean(busy || project.operation || dirty || !project.segments.length || project.segments.some((segment) => !segment.prompt))}
                            onClick={() => void run("下载手动生成包", () => downloadClothingBundle(id, project.title))}
                        >
                            下载手动生成包 ZIP
                        </Button>
                    </div>
                    {project.segments.some((segment) => segment.preparedAudioStrategy !== project.audioStrategy) && <p className="mt-3 text-xs text-amber-600">旧切片尚未确认音频策略，请重新切片后再下载生成包。</p>}
                </section>

                {project.segments.length > 0 && (
                    <section className="mt-6">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                            <h2 className="text-lg font-semibold">5. 手动生成与回传 · 共 {project.segments.length} 段</h2>
                            <span className="text-sm text-muted-foreground">已完成 {project.segments.filter((segment) => segment.videoStatus === "success").length} 段</span>
                        </div>
                        <div className="mt-4 space-y-4">
                            {project.segments.map((segment) => (
                                <ClothingSegmentCard
                                    key={`${segment.id}:${segment.prompt}`}
                                    segment={segment}
                                    disabled={Boolean(busy || project.operation || dirty)}
                                    editingDisabled={locked || dirty}
                                    pendingResult={pendingResults[segment.id]?.asset}
                                    onImport={(file) => void importResult(segment.id, file)}
                                    onDiscard={() => {
                                        rememberResult(segment.id, undefined, pendingResults[segment.id]?.asset.storageKey);
                                        message.info("已放弃采用，上传视频仍保留在素材库");
                                    }}
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
                            <h2 className="font-semibold">6. 合并回传结果</h2>
                            <p className="mt-2 text-xs text-muted-foreground">按源时间线合并全部片段，裁掉超过源片段时长的尾部。</p>
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
                                <p className="mt-4 text-xs leading-5 text-muted-foreground">再次下载手动生成包时，也会包含当前已回传片段和成片。</p>
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
    pendingResult,
    onImport,
    onDiscard,
    onPromptSave,
    onRecover,
    onCancel,
    onAbandon,
}: {
    segment: OmniClothingSegment;
    disabled: boolean;
    editingDisabled: boolean;
    pendingResult?: OmniClothingAsset;
    onImport: (file?: File) => void;
    onDiscard: () => void;
    onPromptSave: (prompt: string) => void;
    onRecover: () => void;
    onCancel: () => void;
    onAbandon: () => void;
}) {
    const [prompt, setPrompt] = useState(segment.prompt);
    const [resultFile, setResultFile] = useState<File | undefined>();
    const resultInputRef = useRef<HTMLInputElement>(null);
    const { message } = App.useApp();
    const label = { idle: "待手动生成 / 回传", submitting: "原提交待检查", running: "原任务处理中", success: "结果已保存", error: "待回传结果" }[segment.videoStatus];
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
                        保留 {segment.durationSeconds} 秒源动作 · {boundary}
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
                        <Button
                            size="small"
                            disabled={!prompt}
                            onClick={() =>
                                void navigator.clipboard
                                    .writeText(prompt)
                                    .then(() => message.success("提示词已复制"))
                                    .catch(() => message.error("复制失败，请手动选择提示词复制"))
                            }
                        >
                            复制英文提示词
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
                        ) : segment.videoStatus === "submitting" ? (
                            <Button disabled={disabled} onClick={onAbandon}>
                                检查原提交
                            </Button>
                        ) : (
                            <>
                                <input
                                    ref={resultInputRef}
                                    hidden
                                    type="file"
                                    accept="video/mp4,video/quicktime,video/webm"
                                    onChange={(event) => {
                                        setResultFile(event.target.files?.[0]);
                                        event.target.value = "";
                                    }}
                                />
                                <Button disabled={editingDisabled || !segment.prompt || prompt !== segment.prompt || Boolean(pendingResult)} icon={<Upload className="size-4" />} onClick={() => resultInputRef.current?.click()}>
                                    {segment.videoStatus === "success" ? "选择替换结果" : "选择生成结果"}
                                </Button>
                                {resultFile && !pendingResult && (
                                    <Button type="primary" disabled={editingDisabled || prompt !== segment.prompt} onClick={() => onImport(resultFile)}>
                                        回传结果
                                    </Button>
                                )}
                                {pendingResult && (
                                    <>
                                        <Button type="primary" disabled={editingDisabled} onClick={() => onImport()}>
                                            重试采用已上传结果
                                        </Button>
                                        <Button disabled={disabled} onClick={onDiscard}>
                                            放弃采用
                                        </Button>
                                    </>
                                )}
                            </>
                        )}
                    </div>
                    {(pendingResult || resultFile) && <p className="mt-2 break-all text-xs text-muted-foreground">{pendingResult ? `已上传待采用：${pendingResult.name}` : `已选择：${resultFile?.name}`}</p>}
                    <p className="mt-2 text-xs leading-5 text-muted-foreground">回传 MP4、MOV 或 WebM，最大 200 MB。视频需覆盖本段 {segment.durationSeconds} 秒动作，最长 60 秒；多余尾部会在合并时裁剪。</p>
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
