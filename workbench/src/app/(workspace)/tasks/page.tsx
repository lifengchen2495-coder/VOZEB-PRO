"use client";

import { Button } from "antd";
import { Clapperboard, Image as ImageIcon, RotateCcw } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import type { Task } from "@/lib/types";
import { useWorkbench, workbench } from "@/stores/workbench";
import { paramSummary } from "../../components/composer";
import { Pill, StatusTag, Tag, card, timeAgo } from "../../components/ui";

const filters: { key: string; label: string; test: (t: Task) => boolean }[] = [
    { key: "all", label: "全部", test: () => true },
    { key: "pending", label: "进行中", test: (t) => t.status === "pending" },
    { key: "done", label: "已完成", test: (t) => t.status === "done" },
    { key: "failed", label: "失败", test: (t) => t.status === "failed" },
];

function duration(task: Task) {
    if (!task.finishedAt) return "";
    const seconds = Math.max(1, Math.round((task.finishedAt - task.createdAt) / 1000));
    return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

export default function TasksPage() {
    const tasks = useWorkbench((s) => s.workspace?.tasks);
    const [filter, setFilter] = useState("all");
    const [retrying, setRetrying] = useState("");
    const all = tasks || [];
    const shown = all.filter(filters.find((f) => f.key === filter)!.test);

    const retry = async (task: Task) => {
        setRetrying(task.id);
        await workbench.retryTask(task.conversationId, task.id);
        setRetrying("");
    };

    return (
        <div className={`${card} flex h-full flex-col overflow-hidden`}>
            <div className="flex flex-col gap-3 border-b border-[var(--line)] p-4">
                <div>
                    <div className="text-xs text-[var(--accent)]">图片与视频</div>
                    <h1 className="flex items-baseline gap-2 text-lg font-semibold">
                        生成任务 <span className="text-sm font-normal text-[var(--accent)]">{all.length}</span>
                    </h1>
                </div>
                <div className="flex gap-1 overflow-x-auto">
                    {filters.map((f) => (
                        <Pill key={f.key} active={filter === f.key} onClick={() => setFilter(f.key)} count={all.filter(f.test).length}>
                            {f.label}
                        </Pill>
                    ))}
                </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
                {tasks && !shown.length && <p className="py-16 text-center text-sm text-[var(--text-3)]">{all.length ? "这个分类下没有任务" : "生成图片或视频后，任务会显示在这里"}</p>}
                {shown.map((task) => {
                    const cover = task.results?.[0];
                    const Icon = task.mode === "video" ? Clapperboard : ImageIcon;
                    return (
                        <div key={task.id} className="flex items-center gap-3 border-b border-[var(--line)] px-4 py-3 last:border-b-0" data-task={task.id}>
                            <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-[var(--panel-2)] text-[var(--text-3)]">
                                {cover ? cover.kind === "video" ? <video src={cover.url} muted preload="metadata" className="h-full w-full object-cover" /> : <img src={cover.url} alt="" className="h-full w-full object-cover" /> : <Icon size={20} />}
                            </div>
                            <div className="min-w-0 flex-1">
                                <div className="flex min-w-0 items-center gap-2">
                                    <Tag>{task.mode === "video" ? "视频" : "图片"}</Tag>
                                    <span className="min-w-0 truncate text-[13px] font-medium">{task.prompt}</span>
                                </div>
                                <div className="mt-1 truncate text-xs text-[var(--text-3)]">
                                    {[task.conversationTitle, task.model, paramSummary(task.mode, task.params), timeAgo(task.createdAt), duration(task) && `耗时 ${duration(task)}`].filter(Boolean).join(" · ")}
                                </div>
                                {task.status === "failed" && task.error && <div className="mt-1 truncate text-xs text-[var(--coral)]">{task.error}</div>}
                            </div>
                            <div className="flex shrink-0 items-center gap-3">
                                <StatusTag status={task.status} />
                                <div className="flex gap-1">
                                    {task.status === "failed" && (
                                        <Button size="small" icon={<RotateCcw size={13} />} loading={retrying === task.id} onClick={() => void retry(task)}>
                                            重试
                                        </Button>
                                    )}
                                    <Link href={`/studio?c=${task.conversationId}`} className="flex h-6 items-center rounded-md px-2 text-xs text-[var(--text-2)] hover:bg-[var(--hover)] hover:text-[var(--accent)]">
                                        查看
                                    </Link>
                                </div>
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
