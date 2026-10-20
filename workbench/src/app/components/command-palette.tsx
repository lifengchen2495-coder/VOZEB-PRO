"use client";

import { Modal } from "antd";
import { Clapperboard, CornerDownLeft, Image as ImageIcon, Images, ListTodo, MessageCircle, MessagesSquare, Search, SlidersHorizontal } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import type { Mode } from "@/lib/types";
import { useWorkbench, workbench } from "@/stores/workbench";

type Item = { key: string; group: string; label: string; hint?: string; icon: ReactNode; thumb?: string; run: () => void };

export function CommandPalette() {
    const router = useRouter();
    const open = useWorkbench((s) => s.paletteOpen);
    const list = useWorkbench((s) => s.list);
    const workspace = useWorkbench((s) => s.workspace);
    const assets = workspace?.assets || [];
    const [query, setQuery] = useState("");
    const [cursor, setCursor] = useState(0);

    const close = () => {
        workbench.toggle("paletteOpen", false);
        setQuery("");
        setCursor(0);
    };
    const go = (href: string, before?: () => void) => () => {
        before?.();
        router.push(href);
        close();
    };
    const create = (mode: Mode) => go("/studio", () => workbench.startNew(mode));

    const q = query.trim().toLowerCase();
    const match = (text: string) => !q || text.toLowerCase().includes(q);
    const actions: Item[] = [
        { key: "chat", group: "快捷操作", label: "新建 AI 对话", icon: <MessageCircle size={16} />, run: create("chat") },
        { key: "image", group: "快捷操作", label: "生成图片", icon: <ImageIcon size={16} />, run: create("image") },
        { key: "video", group: "快捷操作", label: "生成视频", icon: <Clapperboard size={16} />, run: create("video") },
        { key: "library", group: "快捷操作", label: "打开素材库", icon: <Images size={16} />, run: go("/library") },
        { key: "tasks", group: "快捷操作", label: "查看生成任务", icon: <ListTodo size={16} />, run: go("/tasks") },
        { key: "settings", group: "快捷操作", label: "API Key 与模型设置", icon: <SlidersHorizontal size={16} />, run: go("/settings") },
    ].filter((item) => match(item.label));
    const conversations: Item[] = list
        .filter((c) => match(c.title))
        .slice(0, 6)
        .map((c) => ({ key: c.id, group: "对话", label: c.title, icon: <MessagesSquare size={16} />, run: go(`/studio?c=${c.id}`) }));
    const media: Item[] = q
        ? assets
              .filter((a) => a.source === "result" && match(a.prompt))
              .slice(0, 6)
              .map((a) => ({ key: a.id, group: "素材", label: a.prompt, hint: a.conversationTitle, icon: <ImageIcon size={16} />, thumb: a.kind === "image" ? a.url : undefined, run: go(`/studio?c=${a.conversationId}`) }))
        : [];
    const items = [...actions, ...conversations, ...media];
    const active = Math.min(cursor, items.length - 1);

    return (
        <Modal open={open} onCancel={close} footer={null} closable={false} width="min(600px, calc(100vw - 24px))" style={{ top: 72 }} styles={{ container: { padding: 0, overflow: "hidden" } }} destroyOnHidden>
            <div className="flex items-center gap-3 border-b border-[var(--line)] px-4">
                <Search size={18} className="text-[var(--text-3)]" />
                <input
                    autoFocus
                    value={query}
                    onChange={(event) => {
                        setQuery(event.target.value);
                        setCursor(0);
                    }}
                    onKeyDown={(event) => {
                        if (event.key === "ArrowDown") setCursor((c) => Math.min(c + 1, items.length - 1));
                        else if (event.key === "ArrowUp") setCursor((c) => Math.max(c - 1, 0));
                        else if (event.key === "Enter" && !event.nativeEvent.isComposing) items[active]?.run();
                        else return;
                        event.preventDefault();
                    }}
                    placeholder="搜索对话、素材，或输入操作…"
                    aria-label="搜索内容"
                    className="h-14 flex-1 bg-transparent text-[15px] outline-none placeholder:text-[var(--text-3)]"
                />
                <kbd className="rounded-md border border-[var(--line)] px-1.5 text-[11px] text-[var(--text-3)]">Esc</kbd>
            </div>
            <div className="max-h-[min(420px,60vh)] overflow-y-auto p-2">
                {!items.length && <p className="py-10 text-center text-sm text-[var(--text-3)]">没有找到相关内容</p>}
                {items.map((item, index) => (
                    <div key={item.key}>
                        {item.group !== items[index - 1]?.group && <div className="px-3 pb-1 pt-2 text-xs text-[var(--text-3)]">{item.group}</div>}
                        <button
                            type="button"
                            onMouseEnter={() => setCursor(index)}
                            onClick={item.run}
                            className={`flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm ${index === active ? "bg-[var(--accent-soft)]" : ""}`}
                        >
                            {item.thumb ? <img src={item.thumb} alt="" className="h-8 w-8 rounded-lg object-cover" /> : <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--panel-2)] text-[var(--text-2)]">{item.icon}</span>}
                            <span className="min-w-0 flex-1">
                                <span className="block truncate">{item.label}</span>
                                {item.hint && <span className="block truncate text-xs text-[var(--text-3)]">{item.hint}</span>}
                            </span>
                            {index === active && <CornerDownLeft size={14} className="text-[var(--text-3)]" />}
                        </button>
                    </div>
                ))}
            </div>
        </Modal>
    );
}
