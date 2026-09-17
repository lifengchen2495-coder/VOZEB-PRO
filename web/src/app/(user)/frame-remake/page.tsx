"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { App, Input, Modal, Pagination, Skeleton } from "antd";
import { Film, Pause, Plus, RefreshCw, ScanSearch, Trash2 } from "lucide-react";
import { CompactEmptyState } from "@/components/compact-empty-state";
import { frameRemakeTime, frameRemakeBusy, type FrameRemakeProject, type FrameRemakeProjectList } from "@/lib/frame-remake-contract";
import { frameRemakeWorkflowReadiness } from "@/lib/frame-remake-steps";
import { frameRemakeProjectPath, frameRemakeRequest } from "./api";
import { Button } from "../bangbang/controls";

export default function FrameRemakePage() {
    const router = useRouter();
    const { modal, message } = App.useApp();
    const [list, setList] = useState<FrameRemakeProjectList>();
    const [loading, setLoading] = useState(true);
    const [createOpen, setCreateOpen] = useState(false);
    const [title, setTitle] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const lock = useRef(false);
    const requestId = useRef(0);
    const load = useCallback(async (page = 1) => {
        const request = ++requestId.current;
        setLoading(true);
        setError("");
        try {
            const value = await frameRemakeRequest<FrameRemakeProjectList>(`/projects?page=${page}&pageSize=12`);
            if (request === requestId.current) setList(value);
        } catch (reason) {
            if (request === requestId.current) setError((reason as Error).message);
        } finally {
            if (request === requestId.current) setLoading(false);
        }
    }, []);
    useEffect(() => {
        void load();
        return () => {
            requestId.current++;
        };
    }, [load]);
    const create = async () => {
        if (lock.current) return;
        if (!title.trim()) {
            void message.warning("请输入项目名称");
            return;
        }
        lock.current = true;
        setBusy(true);
        try {
            const project = await frameRemakeRequest<FrameRemakeProject>("/projects", { title: title.trim() });
            setCreateOpen(false);
            router.push(`/frame-remake/${encodeURIComponent(project.id)}`);
        } catch (reason) {
            void message.error((reason as Error).message);
        } finally {
            lock.current = false;
            setBusy(false);
        }
    };
    const remove = (project: FrameRemakeProject) => {
        modal.confirm({
            title: `删除“${project.title}”？`,
            content: "项目及其生产记录将一并删除。",
            okText: "删除项目",
            cancelText: "取消",
            okButtonProps: { danger: true },
            onOk: async () => {
                if (lock.current) return;
                lock.current = true;
                setBusy(true);
                try {
                    await frameRemakeRequest(frameRemakeProjectPath(project.id), undefined, "DELETE");
                    await load(list?.items.length === 1 && list.page > 1 ? list.page - 1 : list?.page);
                } catch (reason) {
                    void message.error((reason as Error).message);
                    throw reason;
                } finally {
                    lock.current = false;
                    setBusy(false);
                }
            },
        });
    };
    const pause = async (project: FrameRemakeProject) => {
        if (lock.current) return;
        lock.current = true;
        setBusy(true);
        try {
            const paused = await frameRemakeRequest<FrameRemakeProject>(`${frameRemakeProjectPath(project.id)}/run`, { revision: project.revision, action: "pause" });
            setList((current) => current ? { ...current, items: current.items.map((item) => item.id === paused.id ? paused : item) } : current);
        } catch (reason) {
            void message.error((reason as Error).message);
        } finally {
            lock.current = false;
            setBusy(false);
        }
    };
    return (
        <main className="h-full overflow-y-auto bg-background text-foreground">
            <div className="mx-auto w-full max-w-7xl px-2 py-2 sm:px-6 sm:py-8">
                <header className="flex items-end justify-between gap-3 border-b pb-3 sm:gap-5 sm:pb-6">
                    <div className="min-w-0">
                        <p className="flex items-center gap-2 text-sm text-muted-foreground">
                            <ScanSearch className="size-4" />
                            原时长电商复刻
                        </p>
                        <h1 className="mt-2 text-xl font-semibold sm:text-2xl">复刻项目</h1>
                        <p className="mt-2 text-xs leading-6 text-muted-foreground sm:text-sm">共 {list?.total || 0} 个项目 · 来源分析 → 十二宫格重绘 → 生产内容</p>
                        <p className="text-xs leading-6 text-muted-foreground">时长跟随原片：15 秒做 15 秒，20 秒做 20 秒，120 秒做 120 秒。</p>
                    </div>
                    <Button className="shrink-0" disabled={busy} onClick={() => setCreateOpen(true)}>
                        <Plus className="size-4" />
                        新建复刻
                    </Button>
                </header>
                {error ? (
                    <section role="alert" className="mt-4 flex items-center justify-between gap-3 rounded-lg border p-4 text-sm">
                        <span className="text-destructive">{error}</span>
                        <Button variant="outline" onClick={() => void load(list?.page)}>
                            <RefreshCw className="size-4" />
                            重试
                        </Button>
                    </section>
                ) : loading ? (
                    <section aria-label="正在读取复刻项目" className="grid gap-4 py-6 sm:grid-cols-2 xl:grid-cols-3">
                        {Array.from({ length: 6 }, (_, i) => (
                            <div key={i} className="rounded-lg border p-4">
                                <Skeleton active paragraph={{ rows: 3 }} />
                            </div>
                        ))}
                    </section>
                ) : list?.items.length ? (
                    <>
                        <section className="grid gap-3 py-4 sm:grid-cols-2 sm:gap-5 sm:py-6 xl:grid-cols-3">
                            {list.items.map((project) => {
                                const ready = frameRemakeWorkflowReadiness(project),
                                    active = frameRemakeBusy(project) || project.automation?.status === "running",
                                    paused = project.automation?.status === "paused",
                                    failed = Boolean(project.error || project.groups.some((group) => [group.template, group.image, group.video].some((task) => task.status === "error")));
                                return (
                                    <article key={project.id} className="min-w-0 overflow-hidden rounded-lg border bg-card">
                                        <Link href={`/frame-remake/${encodeURIComponent(project.id)}`} className="block space-y-3 p-4 hover:bg-muted/30">
                                            <div className="flex items-center justify-between gap-2">
                                                <Film className="size-5" />
                                                <span className="text-xs text-muted-foreground">
                                                    {paused ? active ? "已暂停 · 任务仍在处理" : "已暂停" : active ? "执行中" : failed ? "需要处理" : ready.production ? "已完成" : ready.images ? "待生产内容" : ready.planning ? "待分镜重绘" : ready.analysis ? "待分镜脚本" : "待来源分析"}
                                                </span>
                                            </div>
                                            <h2 className="truncate text-sm font-semibold">{project.title}</h2>
                                            <p className="text-xs text-muted-foreground">
                                                {project.durationMs ? `原片 ${frameRemakeTime(project.durationMs)}` : "等待上传与分析"} · {project.groups.length} 组分镜
                                            </p>
                                            <p className="text-xs text-muted-foreground">
                                                {project.groups.filter((group) => group.video.status === "completed").length}/{project.groups.length} 组视频已生成
                                            </p>
                                        </Link>
                                        <div className="flex flex-wrap items-center justify-end gap-2 border-t px-3 py-2">
                                            {active && (!paused || project.operation) && (
                                                <Button variant="ghost" disabled={busy} onClick={() => void pause(project)}>
                                                    <Pause className="size-3.5" />
                                                    暂停执行
                                                </Button>
                                            )}
                                            {active && (
                                                <Link href={`/frame-remake/${encodeURIComponent(project.id)}`} className="text-xs underline underline-offset-2">进入项目取消任务</Link>
                                            )}
                                            <Button variant="ghost" aria-label={`删除${project.title}`} title={active ? "先暂停执行并取消当前任务，再删除项目" : undefined} disabled={busy || active} onClick={() => remove(project)}>
                                                <Trash2 className="size-3.5" />
                                                删除项目
                                            </Button>
                                        </div>
                                    </article>
                                );
                            })}
                        </section>
                        {list.total > list.pageSize && (
                            <div className="flex justify-center pb-6">
                                <Pagination current={list.page} pageSize={list.pageSize} total={list.total} showSizeChanger={false} disabled={busy} onChange={(page) => void load(page)} />
                            </div>
                        )}
                    </>
                ) : (
                    <CompactEmptyState
                        title="还没有复刻项目"
                        description="创建项目后，先上传来源视频并完成分析，再逐阶段制作。"
                        icon={<Film className="size-4" />}
                        className="mt-4 min-h-52"
                        action={
                            <Button onClick={() => setCreateOpen(true)}>
                                <Plus className="size-4" />
                                新建第一个项目
                            </Button>
                        }
                    />
                )}
            </div>
            <Modal
                title="新建复刻项目"
                open={createOpen}
                width={480}
                destroyOnHidden
                style={{ maxWidth: "calc(100vw - 24px)" }}
                confirmLoading={busy}
                okText="创建并进入"
                cancelText="取消"
                onCancel={() => {
                    if (!busy) setCreateOpen(false);
                }}
                onOk={() => void create()}
            >
                <div className="space-y-2 pt-2">
                    <label htmlFor="frame-remake-title" className="text-sm font-medium">
                        项目名称
                    </label>
                    <Input id="frame-remake-title" autoFocus maxLength={160} value={title} disabled={busy} placeholder="例如：产品视频原时长复刻" onChange={(event) => setTitle(event.target.value)} onPressEnter={() => void create()} />
                    <p className="text-xs leading-6 text-muted-foreground">创建后进入来源分析。每个阶段完成后，可检查结果再继续；原视频最大 200 MB。</p>
                </div>
            </Modal>
        </main>
    );
}
