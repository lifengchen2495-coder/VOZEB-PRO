"use client";

import { App, Button, Checkbox, Input, Tooltip } from "antd";
import { Check, ListChecks, Pencil, Plus, Search, Trash2, X } from "lucide-react";
import { useMemo, useState } from "react";
import type { ConversationSummary } from "@/lib/types";
import { useWorkbench, workbench } from "@/stores/workbench";

const dayMs = 86_400_000;
function groupOf(updatedAt: number) {
    const today = new Date().setHours(0, 0, 0, 0);
    if (updatedAt >= today) return "今天";
    if (updatedAt >= today - 6 * dayMs) return "最近 7 天";
    return "更早";
}

export function ConversationList({ onOpen }: { onOpen: (id: string | null) => void }) {
    const { modal } = App.useApp();
    const list = useWorkbench((s) => s.list);
    const activeId = useWorkbench((s) => s.conversation?.id);
    const [keyword, setKeyword] = useState("");
    const [editing, setEditing] = useState<{ id: string; title: string } | null>(null);
    const [managing, setManaging] = useState(false);
    const [selected, setSelected] = useState<string[]>([]);

    const filtered = list.filter((item) => item.title.toLowerCase().includes(keyword.trim().toLowerCase()));
    const groups = useMemo(() => {
        const map = new Map<string, ConversationSummary[]>();
        for (const item of filtered) map.set(groupOf(item.updatedAt), [...(map.get(groupOf(item.updatedAt)) || []), item]);
        return [...map];
    }, [filtered]);

    const confirmDelete = (ids: string[], name: string) =>
        modal.confirm({
            title: "删除对话",
            content: `确定删除${name}吗？对话里生成和上传的图片、视频也会一起删除，无法恢复。`,
            okText: "删除",
            okButtonProps: { danger: true },
            cancelText: "取消",
            onOk: async () => {
                await workbench.remove(ids);
                setSelected([]);
                setManaging(false);
            },
        });

    const saveTitle = async () => {
        if (editing?.title.trim()) await workbench.rename(editing.id, editing.title);
        setEditing(null);
    };

    return (
        <div className="flex h-full flex-col">
            <div className="flex flex-col gap-3 p-3 pb-2">
                <div className="flex items-center gap-2 pl-1">
                    <span className="flex-1 text-sm font-semibold">创作对话</span>
                    <span className="text-xs text-[var(--text-3)]">{list.length}</span>
                    <Tooltip title="新建对话">
                        <Button size="small" type="text" icon={<Plus size={16} />} onClick={() => onOpen(null)} aria-label="新建对话" />
                    </Tooltip>
                </div>
                <div className="flex items-center gap-1">
                    <Input allowClear size="small" prefix={<Search size={14} className="opacity-50" />} placeholder="搜索对话" value={keyword} onChange={(event) => setKeyword(event.target.value)} variant="filled" />
                    <Tooltip title={managing ? "退出管理" : "批量管理"}>
                        <Button
                            size="small"
                            type="text"
                            aria-label={managing ? "退出管理" : "批量管理"}
                            icon={managing ? <X size={15} /> : <ListChecks size={15} />}
                            onClick={() => {
                                setManaging(!managing);
                                setSelected([]);
                            }}
                        />
                    </Tooltip>
                </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-3">
                {!filtered.length && <p className="px-2 py-6 text-center text-xs text-[var(--text-2)]">{keyword ? "没有匹配的对话" : "还没有对话，开始第一次创作吧"}</p>}
                {groups.map(([label, items]) => (
                    <div key={label} className="mb-3">
                        <div className="px-2 pb-1 text-xs text-[var(--text-2)]">{label}</div>
                        {items.map((item) =>
                            editing?.id === item.id ? (
                                <Input
                                    key={item.id}
                                    size="small"
                                    autoFocus
                                    maxLength={60}
                                    value={editing.title}
                                    onChange={(event) => setEditing({ ...editing, title: event.target.value })}
                                    onPressEnter={saveTitle}
                                    onBlur={saveTitle}
                                    onKeyDown={(event) => event.key === "Escape" && setEditing(null)}
                                    aria-label="对话标题"
                                    className="!mb-1"
                                    suffix={<Check size={14} className="opacity-60" />}
                                />
                            ) : (
                                <div
                                    key={item.id}
                                    role="button"
                                    tabIndex={0}
                                    data-conversation={item.id}
                                    onClick={() => (managing ? setSelected((s) => (s.includes(item.id) ? s.filter((id) => id !== item.id) : [...s, item.id])) : onOpen(item.id))}
                                    onKeyDown={(event) => event.key === "Enter" && event.currentTarget.click()}
                                    className={`group/row mb-0.5 flex h-9 cursor-pointer items-center gap-2 rounded-lg px-2 text-sm transition-colors hover:bg-[var(--hover)] ${activeId === item.id && !managing ? "bg-[var(--accent-soft)] font-medium text-[var(--accent)]" : ""}`}
                                >
                                    {managing && <Checkbox checked={selected.includes(item.id)} aria-label={`选择 ${item.title}`} />}
                                    <span className="min-w-0 flex-1 truncate">{item.title}</span>
                                    {item.pending && <span className="h-2 w-2 shrink-0 rounded-full bg-[var(--accent)]" title="生成中" />}
                                    {!managing && (
                                        <span className="flex shrink-0 gap-0.5 md:hidden md:group-hover/row:flex md:group-focus-within/row:flex">
                                            <Button
                                                size="small"
                                                type="text"
                                                aria-label="重命名"
                                                icon={<Pencil size={13} />}
                                                onClick={(event) => {
                                                    event.stopPropagation();
                                                    setEditing({ id: item.id, title: item.title });
                                                }}
                                            />
                                            <Button
                                                size="small"
                                                type="text"
                                                aria-label="删除"
                                                icon={<Trash2 size={13} />}
                                                onClick={(event) => {
                                                    event.stopPropagation();
                                                    confirmDelete([item.id], `「${item.title}」`);
                                                }}
                                            />
                                        </span>
                                    )}
                                </div>
                            ),
                        )}
                    </div>
                ))}
            </div>
            {managing && (
                <div className="flex items-center gap-2 border-t border-[var(--line)] p-3">
                    <Checkbox
                        checked={!!filtered.length && selected.length === filtered.length}
                        indeterminate={selected.length > 0 && selected.length < filtered.length}
                        onChange={(event) => setSelected(event.target.checked ? filtered.map((item) => item.id) : [])}
                    >
                        全选
                    </Checkbox>
                    <Button danger size="small" className="ml-auto" disabled={!selected.length} onClick={() => confirmDelete(selected, `选中的 ${selected.length} 个对话`)}>
                        删除所选
                    </Button>
                </div>
            )}
        </div>
    );
}
