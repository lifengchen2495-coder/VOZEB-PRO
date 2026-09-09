"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, ScanSearch, Trash2 } from "lucide-react";
import { Button, Input } from "./controls";
import type { OmniProjectList, OmniProject } from "@/lib/omni-remake-contract";
import { omniRequest } from "./omni-api";

export default function OmniRemakePage() {
    const router = useRouter();
    const [list, setList] = useState<OmniProjectList>();
    const [page, setPage] = useState(1);
    const [title, setTitle] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const refresh = useCallback(() => omniRequest<OmniProjectList>(`/projects?page=${page}`).then(setList), [page]);
    useEffect(() => {
        let active = true;
        omniRequest<OmniProjectList>(`/projects?page=${page}`)
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
        if (busy) return;
        setBusy(true);
        setError("");
        try {
            const project = await omniRequest<OmniProject>("/projects", { title });
            router.push(`/omni-remake/${project.id}`);
        } catch (error) {
            setError((error as Error).message);
            setBusy(false);
        }
    };
    const remove = async (project: OmniProject) => {
        if (!window.confirm(`删除项目“${project.title}”？`)) return;
        setBusy(true);
        try {
            await omniRequest(`/projects/${project.id}`, undefined, "DELETE");
            await refresh();
        } catch (error) {
            setError((error as Error).message);
        } finally {
            setBusy(false);
        }
    };
    return (
        <main className="mx-auto w-full max-w-6xl space-y-8 p-6 md:p-10">
            <header className="space-y-3">
                <div className="flex items-center gap-3">
                    <ScanSearch className="size-7" />
                    <h1 className="text-2xl font-semibold">Omni 全品类复刻</h1>
                </div>
                <p className="text-sm text-muted-foreground">导入原片分析，准备参考片段、产品／人物／背景图和提示词；下载后手动生成，再回传合并成片。</p>
            </header>
            <form
                className="flex max-w-xl gap-3"
                onSubmit={(event) => {
                    event.preventDefault();
                    void create();
                }}
            >
                <Input aria-label="新项目名称" placeholder="项目名称（选填）" value={title} maxLength={120} onChange={(event) => setTitle(event.target.value)} disabled={busy} />
                <Button type="submit" disabled={busy}>
                    <Plus className="mr-2 size-4" />
                    新建项目
                </Button>
            </form>
            {error && (
                <p role="alert" className="text-sm text-destructive">
                    {error}
                </p>
            )}
            {!list ? (
                <p className="text-muted-foreground">正在读取项目…</p>
            ) : !list.items.length ? (
                <div className="rounded-xl border border-dashed p-12 text-center text-muted-foreground">还没有全品类项目，从上传一条参考视频开始。</div>
            ) : (
                <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                    {list.items.map((project) => (
                        <article key={project.id} className="rounded-xl border bg-card p-5">
                            <Link href={`/omni-remake/${project.id}`} className="block space-y-3">
                                <h2 className="truncate font-medium">{project.title}</h2>
                                <p className="text-sm text-muted-foreground">
                                    {project.segments.length ? `${project.segments.length} 个片段 · 已完成 ${project.segments.filter((segment) => segment.video.status === "completed").length} 个` : "待上传与分析"}
                                </p>
                                <p className="text-xs text-muted-foreground">{new Date(project.updatedAt).toLocaleString("zh-CN")}</p>
                            </Link>
                            <Button variant="ghost" size="sm" className="mt-3" disabled={busy} onClick={() => void remove(project)}>
                                <Trash2 className="mr-2 size-3" />
                                删除
                            </Button>
                        </article>
                    ))}
                </div>
            )}
            {list && list.total > 20 && (
                <div className="flex items-center gap-4">
                    <Button variant="outline" disabled={page === 1} onClick={() => setPage(page - 1)}>
                        上一页
                    </Button>
                    <span className="text-sm">第 {page} 页</span>
                    <Button variant="outline" disabled={page * 20 >= list.total} onClick={() => setPage(page + 1)}>
                        下一页
                    </Button>
                </div>
            )}
        </main>
    );
}
