"use client";

import type { ReactNode } from "react";
import type { Task } from "@/lib/types";

export const card = "rounded-2xl border border-[var(--line)] bg-[var(--panel)]";

// 筛选标签：选中态使用主题绿色浅底
export function Pill({ active, onClick, children, count }: { active: boolean; onClick: () => void; children: ReactNode; count?: number }) {
    return (
        <button
            type="button"
            aria-pressed={active}
            onClick={onClick}
            className={`inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-3 text-[13px] transition-colors ${active ? "bg-[var(--accent-soft)] font-medium text-[var(--accent)]" : "text-[var(--text-2)] hover:bg-[var(--hover)] hover:text-[var(--text)]"}`}
        >
            {children}
            {count !== undefined && <span className={active ? "opacity-80" : "text-[var(--text-3)]"}>{count}</span>}
        </button>
    );
}

const statusStyle: Record<Task["status"], [string, string]> = {
    pending: ["生成中", "border-[var(--blue)]/25 bg-[var(--blue-soft)] text-[var(--blue)]"],
    done: ["已完成", "border-[var(--accent)]/25 bg-[var(--accent-soft)] text-[var(--accent)]"],
    failed: ["失败", "border-[var(--coral)]/30 bg-[var(--coral-soft)] text-[var(--coral)]"],
};

// 过程状态统一使用语义浅底、细描边和可读文字
export function StatusTag({ status }: { status: Task["status"] }) {
    const [label, style] = statusStyle[status];
    return (
        <span className={`inline-flex h-6 shrink-0 items-center gap-1 rounded-md border px-2 text-xs ${style}`}>
            {status === "pending" && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />}
            {label}
        </span>
    );
}

export function Tag({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "accent" | "coral" }) {
    const style = { neutral: "bg-[var(--panel-2)] text-[var(--text-2)] border-[var(--line)]", accent: "bg-[var(--accent-soft)] text-[var(--accent)] border-transparent", coral: "bg-[var(--coral-soft)] text-[var(--coral)] border-transparent" }[tone];
    return <span className={`inline-flex h-5 shrink-0 items-center rounded border px-1.5 text-[11px] leading-none ${style}`}>{children}</span>;
}

export const timeAgo = (value: number) => {
    const minutes = Math.floor((Date.now() - value) / 60_000);
    if (minutes < 1) return "刚刚";
    if (minutes < 60) return `${minutes} 分钟前`;
    if (minutes < 1440) return `${Math.floor(minutes / 60)} 小时前`;
    return new Date(value).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
};
