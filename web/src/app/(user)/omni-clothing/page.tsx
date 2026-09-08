"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { App, Button, Input, Modal, Pagination, Popconfirm, Skeleton, Tag } from "antd";
import { ArrowUpRight, Plus, RefreshCw, Shirt, Trash2 } from "lucide-react";

import { omniClothingStatusLabel, type OmniClothingProjectSummaryPage } from "@/lib/omni-clothing-contract";

import { createClothingProject, deleteClothingProject, listClothingProjects } from "./omni-clothing-api";

export default function OmniClothingProjectsPage() {
    const router = useRouter();
    const { message } = App.useApp();
    const [data, setData] = useState<OmniClothingProjectSummaryPage>({ items: [], page: 1, pageSize: 12, total: 0 });
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [open, setOpen] = useState(false);
    const [title, setTitle] = useState("");
    const [creating, setCreating] = useState(false);
    const load = useCallback(async (page = 1) => {
        setLoading(true);
        setError("");
        try {
            setData(await listClothingProjects(page));
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : "项目加载失败");
        } finally {
            setLoading(false);
        }
    }, []);
    useEffect(() => {
        void load();
    }, [load]);
    async function create() {
        if (!title.trim()) return message.warning("请输入项目名称");
        setCreating(true);
        try {
            const project = await createClothingProject(title);
            router.push(`/omni-clothing/${project.id}`);
        } catch (reason) {
            message.error(reason instanceof Error ? reason.message : "项目创建失败");
        } finally {
            setCreating(false);
        }
    }
    return (
        <main className="h-full overflow-y-auto bg-background text-foreground">
            <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-8">
                <header className="flex flex-wrap items-end justify-between gap-4 border-b border-border pb-6">
                    <div>
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                            <Shirt className="size-4" />
                            服装视频复刻
                        </div>
                        <h1 className="mt-2 text-2xl font-semibold">换上新衣，保留原片动作</h1>
                        <p className="mt-2 text-sm text-muted-foreground">原视频切片 · 4–5 张新服装参考图 · 逐片替换服装 · 合并成片</p>
                    </div>
                    <Button type="primary" icon={<Plus className="size-4" />} onClick={() => setOpen(true)}>
                        新建服装复刻
                    </Button>
                </header>
                {error ? (
                    <div role="alert" className="mt-6 flex items-center justify-between rounded-xl border border-rose-300 p-4">
                        <span>{error}</span>
                        <Button icon={<RefreshCw className="size-4" />} onClick={() => void load(data.page)}>
                            重试
                        </Button>
                    </div>
                ) : loading ? (
                    <Skeleton active className="mt-8" />
                ) : data.items.length ? (
                    <>
                        <section className="grid gap-4 py-6 sm:grid-cols-2 xl:grid-cols-3">
                            {data.items.map((project) => (
                                <article key={project.id} className="overflow-hidden rounded-xl border border-border bg-card">
                                    <Link href={`/omni-clothing/${project.id}`} className="block p-4">
                                        <div className="flex aspect-video items-center justify-center rounded-lg bg-muted">
                                            {project.thumbnailUrl ? <img src={project.thumbnailUrl} alt={project.title} className="h-full w-full rounded-lg object-contain" /> : <Shirt className="size-12 text-muted-foreground" />}
                                        </div>
                                        <div className="mt-4 flex items-center justify-between gap-3">
                                            <h2 className="truncate font-semibold">{project.title}</h2>
                                            <ArrowUpRight className="size-4 shrink-0" />
                                        </div>
                                        <p className="mt-2 text-sm text-muted-foreground">
                                            {project.completedCount} / {project.segmentCount} 个片段已生成
                                        </p>
                                    </Link>
                                    <div className="flex items-center justify-between border-t border-border px-4 py-3">
                                        <Tag>{omniClothingStatusLabel(project.status)}</Tag>
                                        <Popconfirm
                                            title="删除这个服装复刻项目？"
                                            description="已上传素材仍可在素材管理中查看。"
                                            onConfirm={async () => {
                                                try {
                                                    await deleteClothingProject(project.id);
                                                    await load(data.items.length === 1 ? Math.max(1, data.page - 1) : data.page);
                                                } catch (reason) {
                                                    message.error(reason instanceof Error ? reason.message : "删除失败");
                                                }
                                            }}
                                        >
                                            <Button type="text" danger size="small" aria-label={`删除 ${project.title}`} icon={<Trash2 className="size-4" />} />
                                        </Popconfirm>
                                    </div>
                                </article>
                            ))}
                        </section>
                        <Pagination current={data.page} total={data.total} pageSize={12} showSizeChanger={false} hideOnSinglePage onChange={(page) => void load(page)} />
                    </>
                ) : (
                    <section className="flex min-h-80 flex-col items-center justify-center text-center">
                        <Shirt className="size-10 text-muted-foreground" />
                        <h2 className="mt-4 text-lg font-medium">开始第一条服装复刻</h2>
                        <p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">上传一条服装展示视频和新服装的正面、背面、侧面、细节参考图，沿用原视频中的人物和展示动作。</p>
                        <Button className="mt-5" onClick={() => setOpen(true)}>
                            新建项目
                        </Button>
                    </section>
                )}
                <Modal title="新建服装复刻" open={open} onCancel={() => setOpen(false)} onOk={() => void create()} confirmLoading={creating} okText="创建项目" cancelText="取消">
                    <Input className="mt-3" aria-label="项目名称" placeholder="例如：秋季连衣裙展示" maxLength={120} value={title} onChange={(event) => setTitle(event.target.value)} onPressEnter={() => void create()} />
                </Modal>
            </div>
        </main>
    );
}
