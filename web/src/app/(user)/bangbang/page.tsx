"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Clapperboard, Plus, Trash2 } from "lucide-react";
import { bangbangActiveSteps, bangbangCreationMode, bangbangBusy, type BangbangProject, type BangbangProjectList } from "@/lib/bangbang-contract";
import { bangbangProjectPath, bangbangRequest } from "./bangbang-api";
import { Button, Input } from "./controls";

export default function BangbangPage() {
    const router = useRouter();
    const [list, setList] = useState<BangbangProjectList>();
    const [title, setTitle] = useState("");
    const [page, setPage] = useState(1);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const lock = useRef(false);
    useEffect(() => {
        let active = true;
        bangbangRequest<BangbangProjectList>(`/projects?page=${page}`)
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
        if (lock.current) return;
        lock.current = true;
        setBusy(true);
        setError("");
        try {
            const project = await bangbangRequest<BangbangProject>("/projects", { title });
            router.push(`/bangbang/${project.id}`);
        } catch (error) {
            setError((error as Error).message);
            lock.current = false;
            setBusy(false);
        }
    };
    const remove = async (project: BangbangProject) => {
        if (lock.current || !window.confirm(`删除项目“${project.title}”及其生产记录？`)) return;
        lock.current = true;
        setBusy(true);
        setError("");
        try {
            await bangbangRequest(bangbangProjectPath(project.id), undefined, "DELETE");
            const value = await bangbangRequest<BangbangProjectList>(`/projects?page=${page}`);
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
        <main className="mx-auto w-full max-w-6xl space-y-7 p-5 md:p-10">
            <header className="space-y-3">
                <div className="flex items-center gap-3">
                    <Clapperboard className="size-7" />
                    <h1 className="text-2xl font-semibold">带货短剧裂变</h1>
                </div>
                <p className="max-w-2xl text-sm leading-6 text-muted-foreground">上传产品图即可原创带货短剧，也可以按对标视频裂变。剧本、九宫格与视频提示词在同一个项目里连续完成。</p>
            </header>
            <form
                className="flex max-w-xl flex-wrap gap-3"
                onSubmit={(event) => {
                    event.preventDefault();
                    void create();
                }}
            >
                <Input className="min-w-44 flex-1" aria-label="新项目名称" value={title} maxLength={160} placeholder="项目名称，例如：秋季护肤短剧" disabled={busy} onChange={(event) => setTitle(event.target.value)} />
                <Button type="submit" disabled={busy}>
                    <Plus className="size-4" />
                    新建项目
                </Button>
            </form>
            {error && (
                <p role="alert" className="text-sm text-destructive">
                    {error}
                </p>
            )}
            {!list ? (
                <p className="text-sm text-muted-foreground">正在读取项目…</p>
            ) : !list.items.length ? (
                <div className="rounded-xl border border-dashed px-5 py-16 text-center">
                    <Clapperboard className="mx-auto mb-4 size-8 text-muted-foreground" />
                    <p className="font-medium">建立你的第一个短剧项目</p>
                    <p className="mt-2 text-sm text-muted-foreground">从一张产品图开始原创剧本，也支持对标视频和已有分镜规划表。</p>
                </div>
            ) : (
                <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                    {list.items.map((project) => (
                        <article key={project.id} className="overflow-hidden rounded-xl border bg-card">
                            <Link href={`/bangbang/${project.id}`} className="block p-5 hover:bg-muted/40">
                                <div className="mb-4 flex items-center justify-between gap-2">
                                    <Clapperboard className="size-5 text-muted-foreground" />
                                    <span className="text-xs text-muted-foreground">{bangbangBusy(project) ? "处理中" : project.error ? "需要处理" : "已保存"}</span>
                                </div>
                                <h2 className="truncate font-medium">{project.title}</h2>
                                <p className="mt-2 text-xs text-muted-foreground">{bangbangCreationMode(project) === "product" ? "产品原创" : "对标裂变"}</p>
                                <p className="mt-2 text-sm text-muted-foreground">
                                    {project.groups.length
                                        ? `${project.groups.length} 组九宫格 · 已确认 ${project.groups.filter((group) => group.image.status === "approved").length} 组`
                                        : `${bangbangActiveSteps(project).filter((step) => project.outputs[step]?.text).length} 个环节已完成`}
                                </p>
                                <p className="mt-3 text-xs text-muted-foreground">{new Date(project.updatedAt).toLocaleString("zh-CN")}</p>
                            </Link>
                            <div className="border-t px-3 py-2">
                                <Button variant="ghost" disabled={busy || bangbangBusy(project)} onClick={() => void remove(project)}>
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
                    <span className="text-sm">第 {page} 页</span>
                    <Button variant="outline" disabled={busy || page * list.pageSize >= list.total} onClick={() => setPage(page + 1)}>
                        下一页
                    </Button>
                </div>
            )}
        </main>
    );
}
