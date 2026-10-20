"use client";

import { App, Badge, Button, Tooltip } from "antd";
import { Bell, Images, LayoutGrid, ListTodo, Plus, Search, SlidersHorizontal, Sparkles } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { brand } from "@/lib/brand";
import { useWorkbench, workbench } from "@/stores/workbench";
import { CommandPalette } from "./command-palette";

export const tabs = [
    { href: "/", label: "总览", icon: LayoutGrid },
    { href: "/studio", label: "AI 创作", icon: Sparkles },
    { href: "/library", label: "素材库", icon: Images },
    { href: "/tasks", label: "生成任务", icon: ListTodo },
    { href: "/settings", label: "模型设置", icon: SlidersHorizontal },
];

export function Shell({ children }: { children: ReactNode }) {
    const { message } = App.useApp();
    const pathname = usePathname();
    const router = useRouter();
    const notice = useWorkbench((s) => s.notice);
    const settings = useWorkbench((s) => s.settings);
    const running = useWorkbench((s) => s.workspace?.stats.running || 0);

    useEffect(() => {
        void workbench.loadSettings();
        void workbench.refreshList();
    }, []);

    useEffect(() => {
        void workbench.loadWorkspace();
    }, [pathname]);

    // 有图片或视频在生成时刷新汇总，任务数和各页面状态保持最新
    useEffect(() => {
        if (!running) return;
        const timer = setInterval(() => void workbench.loadWorkspace(), 3000);
        return () => clearInterval(timer);
    }, [running]);

    useEffect(() => {
        if (notice) void message.open({ type: notice.type, content: notice.text });
    }, [notice, message]);

    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
                event.preventDefault();
                workbench.toggle("paletteOpen");
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, []);

    const create = () => {
        workbench.startNew();
        router.push("/studio");
    };

    return (
        // 只面向电脑端：窗口窄于最小宽度时整体横向滚动，不切换成手机布局
        <div className="h-full overflow-x-auto">
        <div className="flex h-full min-w-[1200px] flex-col">
            <header className="flex h-14 shrink-0 items-center gap-3 px-5">
                <Link href="/" className="flex shrink-0 items-center gap-2">
                    <img src="/logo.svg" alt="" className="h-8 w-8" />
                    <span className="text-[15px] font-semibold tracking-wide">{brand.name}</span>
                    <span className="rounded-md bg-[var(--accent-soft)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--accent)]">AI 工作台</span>
                </Link>
                <button
                    type="button"
                    onClick={() => workbench.toggle("paletteOpen", true)}
                    aria-label="搜索"
                    className="mx-auto ml-6 flex h-9 w-full max-w-[480px] items-center gap-2 rounded-xl border border-[var(--line)] bg-[var(--panel)] px-3 text-[13px] text-[var(--text-3)] transition-colors hover:border-[var(--line-strong)]"
                >
                    <Search size={16} />
                    <span className="flex-1 text-left">搜索对话、素材和操作…</span>
                    <kbd className="rounded-md border border-[var(--line)] px-1.5 font-sans text-[11px]">⌘ K</kbd>
                </button>
                <div className="flex shrink-0 items-center gap-1.5">
                    <Tooltip title="新建创作">
                        <button type="button" onClick={create} aria-label="新建创作" className="flex h-9 w-9 items-center justify-center rounded-xl bg-[var(--coral)] text-white shadow-sm transition-opacity hover:opacity-90">
                            <Plus size={18} />
                        </button>
                    </Tooltip>
                    <Tooltip title={running ? `${running} 个任务生成中` : "生成任务"}>
                        <Link href="/tasks" aria-label="生成任务通知" className="flex h-9 w-9 items-center justify-center rounded-xl text-[var(--text-2)] transition-colors hover:bg-[var(--hover)]">
                            <Badge count={running} size="small" color="var(--coral)">
                                <Bell size={18} className="text-[var(--text-2)]" />
                            </Badge>
                        </Link>
                    </Tooltip>
                </div>
            </header>
            <nav className="mx-5 flex shrink-0 items-center gap-1 rounded-2xl border border-[var(--line)] bg-[var(--panel)] p-1.5" aria-label="工作台模块">
                {tabs.map(({ href, label, icon: Icon }) => {
                    const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
                    return (
                        <Link
                            key={href}
                            href={href}
                            aria-current={active ? "page" : undefined}
                            className={`flex h-9 shrink-0 items-center gap-1.5 rounded-xl px-3.5 text-[13px] transition-colors ${active ? "bg-[var(--accent-soft)] font-medium text-[var(--accent)]" : "text-[var(--text-2)] hover:bg-[var(--hover)] hover:text-[var(--text)]"}`}
                        >
                            <Icon size={15} />
                            {label}
                        </Link>
                    );
                })}
            </nav>
            {settings && !settings.catalog.length && pathname !== "/settings" && (
                <div className="mx-5 mt-3 flex items-center gap-3 rounded-xl border border-[var(--coral)]/25 bg-[var(--coral-soft)] px-4 py-2.5 text-[13px]">
                    <span className="min-w-0 flex-1">还没有可用的模型，填写 API Key 并获取模型后就能开始创作。</span>
                    <Button size="small" onClick={() => router.push("/settings")}>
                        去设置
                    </Button>
                </div>
            )}
            <div className="min-h-0 flex-1 px-5 pb-5 pt-3">{children}</div>
            <CommandPalette />
        </div>
        </div>
    );
}
