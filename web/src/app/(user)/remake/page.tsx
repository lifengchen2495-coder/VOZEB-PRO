"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { App, Button, Input, Modal, Pagination, Skeleton } from "antd";
import { Film, Plus, RefreshCw, ScanSearch } from "lucide-react";
import { useRouter } from "next/navigation";

import { CompactEmptyState } from "@/components/compact-empty-state";

import { createRemakeProject, deleteRemakeProject, listRemakeProjects } from "./remake-api";
import type { RemakeProjectSummary } from "./remake-contract";
import { RemakeProjectCard } from "./remake-project-card";

const PAGE_SIZE = 12;

export default function RemakeProjectsPage() {
    const router = useRouter();
    const { message } = App.useApp();
    const [projects, setProjects] = useState<RemakeProjectSummary[]>([]);
    const [total, setTotal] = useState(0);
    const [page, setPage] = useState(1);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [createOpen, setCreateOpen] = useState(false);
    const [title, setTitle] = useState("");
    const [creating, setCreating] = useState(false);
    const [deletingId, setDeletingId] = useState("");
    const requestIdRef = useRef(0);

    const load = useCallback(async (nextPage = 1) => {
        const requestId = ++requestIdRef.current;
        setLoading(true);
        setError("");
        try {
            const result = await listRemakeProjects({ page: nextPage, pageSize: PAGE_SIZE });
            if (requestId !== requestIdRef.current) return;
            setProjects(result.projects);
            setTotal(result.total);
            setPage(result.page);
        } catch (reason) {
            if (requestId !== requestIdRef.current) return;
            setError(reason instanceof Error ? reason.message : "复刻项目加载失败");
        } finally {
            if (requestId === requestIdRef.current) setLoading(false);
        }
    }, []);

    useEffect(() => {
        void load(1);
        return () => {
            requestIdRef.current += 1;
        };
    }, [load]);

    const create = async () => {
        const nextTitle = title.trim();
        if (!nextTitle) return message.warning("请输入项目名称");
        setCreating(true);
        try {
            const project = await createRemakeProject({ title: nextTitle, copyStrategy: "keep", voice: "source" });
            setCreateOpen(false);
            setTitle("");
            router.push(`/remake/${encodeURIComponent(project.id)}`);
        } catch (reason) {
            message.error(reason instanceof Error ? reason.message : "复刻项目创建失败");
        } finally {
            setCreating(false);
        }
    };

    const remove = async (id: string) => {
        setDeletingId(id);
        try {
            await deleteRemakeProject(id);
            message.success("复刻项目已删除");
            const nextPage = projects.length === 1 && page > 1 ? page - 1 : page;
            await load(nextPage);
        } finally {
            setDeletingId("");
        }
    };

    return (
        <main className="h-full overflow-y-auto bg-background text-foreground">
            <div className="mx-auto w-full max-w-7xl px-2 py-2 sm:px-6 sm:py-8">
                <header className="flex items-end justify-between gap-3 border-b border-border pb-3 sm:gap-5 sm:pb-6">
                    <div className="min-w-0">
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                            <ScanSearch className="size-4" />
                            电商视频复刻
                        </div>
                        <h1 className="mt-1.5 text-xl font-semibold sm:mt-2 sm:text-2xl">复刻项目</h1>
                        <p className="mt-1.5 text-xs leading-5 text-muted-foreground sm:mt-2 sm:text-sm">共 {total} 个项目 · 上传、抽帧、解析与文案交接</p>
                    </div>
                    <Button type="primary" className="!h-9 !shrink-0 !px-3 sm:!px-4" icon={<Plus className="size-4" />} onClick={() => setCreateOpen(true)}>
                        新建复刻
                    </Button>
                </header>

                {error ? (
                    <section className="mt-4 flex min-h-28 items-center justify-between gap-4 border-y border-rose-200 px-3 py-4 text-sm dark:border-rose-900/70">
                        <span className="min-w-0 text-rose-700 dark:text-rose-300">{error}</span>
                        <Button className="shrink-0" icon={<RefreshCw className="size-4" />} onClick={() => void load(page)}>
                            重试
                        </Button>
                    </section>
                ) : loading ? (
                    <section className="grid gap-2 py-3 sm:grid-cols-2 sm:gap-5 sm:py-6 xl:grid-cols-3" aria-label="正在加载复刻项目">
                        {Array.from({ length: 6 }, (_, index) => (
                            <div key={index} className="overflow-hidden rounded-lg border border-border p-3.5">
                                <Skeleton.Image active className="!h-28 !w-full" />
                                <Skeleton active title={{ width: "55%" }} paragraph={{ rows: 2 }} className="mt-3" />
                            </div>
                        ))}
                    </section>
                ) : projects.length ? (
                    <>
                        <section className="grid gap-2 py-3 sm:grid-cols-2 sm:gap-5 sm:py-6 xl:grid-cols-3">
                            {projects.map((project) => (
                                <RemakeProjectCard key={project.id} project={project} deleting={deletingId === project.id} onDelete={remove} />
                            ))}
                        </section>
                        {total > PAGE_SIZE ? (
                            <div className="flex justify-center pb-4 sm:pb-8">
                                <Pagination current={page} pageSize={PAGE_SIZE} total={total} showSizeChanger={false} onChange={(nextPage) => void load(nextPage)} />
                            </div>
                        ) : null}
                    </>
                ) : (
                    <CompactEmptyState
                        title="还没有复刻项目"
                        description="创建项目并上传第一条来源视频。"
                        icon={<Film className="size-4" />}
                        className="mt-3 min-h-32 sm:mt-6 sm:min-h-52"
                        action={
                            <Button type="primary" icon={<Plus className="size-4" />} onClick={() => setCreateOpen(true)}>
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
                confirmLoading={creating}
                okText="创建并进入"
                cancelText="取消"
                onCancel={() => setCreateOpen(false)}
                onOk={() => void create()}
            >
                <div className="grid gap-1.5 pt-1">
                    <label htmlFor="remake-project-title" className="text-sm font-medium leading-5">
                        项目名称
                    </label>
                    <Input id="remake-project-title" autoFocus maxLength={80} value={title} placeholder="例如：车载支架视频复刻" onChange={(event) => setTitle(event.target.value)} onPressEnter={() => void create()} />
                </div>
            </Modal>
        </main>
    );
}
