"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowUp, Film, History, Plus, ScanSearch, Trash2, X } from "lucide-react";
import { ModelPicker } from "@/components/model-picker";
import { useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import { frameRemakeTime, frameRemakeBusy, type FrameRemakeProject, type FrameRemakeProjectList } from "@/lib/frame-remake-contract";
import { frameRemakeProjectPath, frameRemakeRequest, uploadFrameRemakeMedia } from "./api";
import { Button } from "../bangbang/controls";
const referenceLabels = { product: "产品", character: "人物", background: "背景" } as const;
export default function FrameRemakePage() {
    const router = useRouter();
    const [list, setList] = useState<FrameRemakeProjectList>();
    const [page, setPage] = useState(1);
    const [video, setVideo] = useState<File>();
    const [references, setReferences] = useState<Record<keyof typeof referenceLabels, File[]>>({ product: [], character: [], background: [] });
    const [instructions, setInstructions] = useState("");
    const [models, setModels] = useState({ analysis: "", image: "", video: "" });
    const [maxSegmentSeconds, setMaxSegmentSeconds] = useState(15);
    const [busy, setBusy] = useState(false);
    const [progress, setProgress] = useState("");
    const [error, setError] = useState("");
    const lock = useRef(false);
    const draftId = useRef<string>(undefined);
    const input = useRef<HTMLInputElement>(null);
    const config = useEffectiveConfig();
    const openConfig = useConfigStore((state) => state.openConfigDialog);
    useEffect(() => {
        let active = true;
        frameRemakeRequest<FrameRemakeProjectList>(`/projects?page=${page}`)
            .then((value) => {
                if (active) setList(value);
            })
            .catch((error: Error) => {
                if (active) setError(error.message);
            });
        return () => {
            active = false;
        };
    }, [page]);
    const create = async () => {
        if (lock.current || !video) return;
        if (video.size > 200 * 1024 * 1024) {
            setError("原视频不能超过 200 MB");
            return;
        }
        lock.current = true;
        setBusy(true);
        setError("");
        setProgress("准备复刻项目…");
        try {
            let project = draftId.current ? await frameRemakeRequest<FrameRemakeProject>(frameRemakeProjectPath(draftId.current)) : await frameRemakeRequest<FrameRemakeProject>("/projects", { title: video.name.replace(/\.[^.]+$/, "").slice(0, 160) });
            draftId.current = project.id;
            setProgress("正在上传原视频…");
            const sourceVideo = await uploadFrameRemakeMedia(project.id, video);
            const uploaded: FrameRemakeProject["references"] = { product: [], character: [], background: [] };
            for (const role of Object.keys(references) as Array<keyof typeof references>)
                for (const file of references[role]) {
                    setProgress(`正在上传${referenceLabels[role]}参考图…`);
                    uploaded[role].push(await uploadFrameRemakeMedia(project.id, file));
                }
            project = await frameRemakeRequest<FrameRemakeProject>(frameRemakeProjectPath(project.id), { revision: project.revision, sourceVideo, references: uploaded, instructions, modelSelection: models, maxSegmentSeconds }, "PATCH");
            setProgress("开始自动执行…");
            await frameRemakeRequest(`${frameRemakeProjectPath(project.id)}/run`, { revision: project.revision, action: "start" });
            router.push(`/frame-remake/${project.id}`);
        } catch (error) {
            setError((error as Error).message);
            lock.current = false;
            setBusy(false);
            setProgress("");
        }
    };
    const remove = async (project: FrameRemakeProject) => {
        if (lock.current || !window.confirm(`删除项目“${project.title}”及其生产记录？`)) return;
        lock.current = true;
        setBusy(true);
        setError("");
        try {
            await frameRemakeRequest(frameRemakeProjectPath(project.id), undefined, "DELETE");
            const value = await frameRemakeRequest<FrameRemakeProjectList>(`/projects?page=${page}`);
            if (!value.items.length && page > 1) setPage(page - 1);
            else setList(value);
        } catch (error) {
            setError((error as Error).message);
        } finally {
            lock.current = false;
            setBusy(false);
        }
    };
    return (
        <main className="mx-auto w-full max-w-6xl space-y-10 px-4 py-10 md:px-10 md:py-16">
            <header className="space-y-3 text-center">
                <h1 className="text-3xl font-semibold">原时长视频复刻</h1>
                <p className="text-sm leading-7 text-muted-foreground">传入视频，我会一步步分析、拆帧、制作分镜并生成成片。</p>
            </header>
            <form
                className="space-y-4"
                onSubmit={(event) => {
                    event.preventDefault();
                    void create();
                }}
            >
                <div className="overflow-hidden rounded-3xl border bg-card p-5 shadow-sm">
                    <div className="flex items-start gap-4">
                        <button type="button" disabled={busy} aria-label="上传原视频" className="flex size-14 shrink-0 items-center justify-center rounded-2xl border bg-muted/40 text-muted-foreground hover:bg-muted" onClick={() => input.current?.click()}>
                            <Plus className="size-6" />
                        </button>
                        <textarea
                            aria-label="复刻要求"
                            value={instructions}
                            disabled={busy}
                            maxLength={20000}
                            className="min-h-36 w-full resize-y rounded-lg border-0 bg-transparent p-1 text-sm leading-7 outline-none"
                            placeholder="上传视频，告诉我需要换什么产品、人物或背景。15 秒做 15 秒，20 秒做 20 秒，120 秒做 120 秒。"
                            onChange={(event) => setInstructions(event.target.value)}
                        />
                    </div>
                    <input
                        ref={input}
                        type="file"
                        className="sr-only"
                        aria-label="选择原视频文件"
                        accept="video/mp4,video/quicktime,video/webm"
                        disabled={busy}
                        onChange={(event) => {
                            setVideo(event.target.files?.[0]);
                            event.target.value = "";
                        }}
                    />
                    {video && (
                        <div className="mb-4 inline-flex max-w-full items-center gap-3 rounded-xl border bg-muted/30 p-3">
                            <Film className="size-6 text-primary" />
                            <span className="truncate text-sm">{video.name}</span>
                            <span className="shrink-0 text-xs text-muted-foreground">{(video.size / 1024 / 1024).toFixed(1)} MB</span>
                            <button type="button" disabled={busy} aria-label="移除原视频" onClick={() => setVideo(undefined)}>
                                <X className="size-4" />
                            </button>
                        </div>
                    )}
                    <div className="flex flex-wrap items-center justify-between gap-3">
                        <span className="inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-sm">
                            <ScanSearch className="size-4" />
                            自动拆帧复刻
                        </span>
                        <Button type="submit" aria-label="开始复刻" disabled={busy || !video} className="rounded-full px-5">
                            {busy ? progress : "开始复刻"}
                            <ArrowUp className="size-4" />
                        </Button>
                    </div>
                </div>
                <details className="rounded-xl border p-4">
                    <summary className="cursor-pointer text-sm font-medium">替换参考图与模型设置 · 可选</summary>
                    <div className="mt-5 space-y-5">
                        <div className="grid gap-4 sm:grid-cols-3">
                            {(Object.keys(referenceLabels) as Array<keyof typeof referenceLabels>).map((role) => (
                                <div key={role} className="space-y-3">
                                    <label className="block cursor-pointer rounded-lg border p-3 text-center text-sm">
                                        上传{referenceLabels[role]}图
                                        <input
                                            type="file"
                                            aria-label={`上传${referenceLabels[role]}图`}
                                            className="sr-only"
                                            accept="image/png,image/jpeg,image/webp"
                                            multiple
                                            disabled={busy}
                                            onChange={(event) => {
                                                const files = Array.from(event.target.files || []);
                                                event.target.value = "";
                                                if (files.some((file) => file.size > 20 * 1024 * 1024)) {
                                                    setError("参考图最大 20 MB");
                                                    return;
                                                }
                                                setReferences((current) => ({ ...current, [role]: files.slice(0, 2) }));
                                            }}
                                        />
                                    </label>
                                    {references[role].map((file, index) => (
                                        <div key={index} className="flex items-center justify-between gap-2 text-xs">
                                            <span className="truncate">{file.name}</span>
                                            <button type="button" disabled={busy} aria-label={`移除${referenceLabels[role]}图`} onClick={() => setReferences((current) => ({ ...current, [role]: current[role].filter((_, i) => i !== index) }))}>
                                                <X className="size-3" />
                                            </button>
                                        </div>
                                    ))}
                                </div>
                            ))}
                        </div>
                        <fieldset disabled={busy} className={`grid gap-4 md:grid-cols-3 ${busy ? "pointer-events-none opacity-50" : ""}`}>
                            {(
                                [
                                    ["analysis", "分析模型", "text"],
                                    ["image", "生图模型", "image"],
                                    ["video", "视频模型", "video"],
                                ] as const
                            ).map(([key, label, capability]) => (
                                <div key={key} className="min-w-0 space-y-2">
                                    <p className="text-sm">{label}</p>
                                    <ModelPicker
                                        config={config}
                                        capability={capability}
                                        fullWidth
                                        value={models[key]}
                                        placeholder="平台默认模型"
                                        onChange={(value) => setModels((current) => ({ ...current, [key]: value }))}
                                        onMissingConfig={() => openConfig(true)}
                                    />
                                </div>
                            ))}
                        </fieldset>
                        <label className="flex items-center gap-3 text-sm">
                            每组最长秒数
                            <select aria-label="每组最长秒数" disabled={busy} className="rounded-lg border bg-background px-3 py-2" value={maxSegmentSeconds} onChange={(event) => setMaxSegmentSeconds(Number(event.target.value))}>
                                {Array.from({ length: 12 }, (_, i) => i + 4).map((value) => (
                                    <option key={value} value={value}>
                                        {value} 秒
                                    </option>
                                ))}
                            </select>
                        </label>
                    </div>
                </details>
                <p className="text-center text-xs leading-6 text-muted-foreground">不设置固定总时长，单个视频最大 200 MB。默认保留原片声音。分析和生成按所选模型计费。</p>
            </form>
            {error && (
                <p role="alert" className="rounded-lg border border-destructive/30 p-4 text-sm text-destructive">
                    {error}
                    {draftId.current && (
                        <Link className="ml-3 underline" href={`/frame-remake/${draftId.current}`}>
                            打开已保存的草稿
                        </Link>
                    )}
                </p>
            )}
            <section className="space-y-4">
                <h2 className="flex items-center gap-2 text-lg font-semibold">
                    <History className="size-5" />
                    最近复刻
                </h2>
                {!list ? (
                    <p className="text-sm text-muted-foreground">正在读取…</p>
                ) : !list.items.length ? (
                    <p className="py-8 text-center text-sm text-muted-foreground">上传第一个视频，开始复刻流程。</p>
                ) : (
                    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                        {list.items.map((project) => (
                            <article key={project.id} className="rounded-xl border bg-card">
                                <Link href={`/frame-remake/${project.id}`} className="block space-y-3 p-5 hover:bg-muted/40">
                                    <div className="flex justify-between">
                                        <Film className="size-5" />
                                        <span className="text-xs text-muted-foreground">{project.automation?.status === "running" || frameRemakeBusy(project) ? "执行中" : project.error ? "需要处理" : project.mergedVideo ? "已完成" : "已保存"}</span>
                                    </div>
                                    <h3 className="truncate font-medium">{project.title}</h3>
                                    <p className="text-sm text-muted-foreground">
                                        {project.durationMs ? frameRemakeTime(project.durationMs) : "等待拆帧"} · {project.groups.filter((group) => group.video.status === "completed").length}/{project.groups.length} 组视频
                                    </p>
                                </Link>
                                <div className="border-t px-3 py-2">
                                    <Button variant="ghost" disabled={busy || frameRemakeBusy(project) || project.automation?.status === "running"} onClick={() => void remove(project)}>
                                        <Trash2 className="size-3.5" />
                                        删除项目
                                    </Button>
                                </div>
                            </article>
                        ))}
                    </div>
                )}
                {list && list.total > list.pageSize && (
                    <div className="flex items-center gap-4">
                        <Button variant="outline" disabled={busy || page === 1} onClick={() => setPage(page - 1)}>
                            上一页
                        </Button>
                        <span>第 {page} 页</span>
                        <Button variant="outline" disabled={busy || page * list.pageSize >= list.total} onClick={() => setPage(page + 1)}>
                            下一页
                        </Button>
                    </div>
                )}
            </section>
        </main>
    );
}
