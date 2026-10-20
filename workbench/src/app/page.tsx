"use client";

import { App, Button, Drawer, Dropdown, Empty, Input, Modal } from "antd";
import { Menu, MoreHorizontal, Plus, Settings as SettingsIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Conversation, ConversationSummary, SendBody } from "@/lib/types";
import { api, retryMessage, sendMessage } from "@/services/api";
import { Composer } from "./components/composer";
import { MessageItem } from "./components/message-item";
import { SettingsModal } from "./components/settings-modal";

export default function Page() {
    const { message, modal } = App.useApp();
    const [list, setList] = useState<ConversationSummary[]>([]);
    const [conversation, setConversation] = useState<Conversation | null>(null);
    const [stream, setStream] = useState<Record<string, string>>({});
    const [busy, setBusy] = useState(false);
    const [drawer, setDrawer] = useState(false);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
    const activeId = useRef<string | null>(null);
    const scroller = useRef<HTMLDivElement>(null);

    const refreshList = useCallback(() => api.conversations().then(setList).catch((error) => message.error(error.message)), [message]);

    const open = useCallback(
        async (id: string | null) => {
            activeId.current = id;
            setDrawer(false);
            if (!id) return setConversation(null);
            try {
                const data = await api.conversation(id);
                if (activeId.current === id) setConversation(data);
            } catch (error) {
                message.error(error instanceof Error ? error.message : "读取会话失败");
            }
        },
        [message],
    );

    useEffect(() => {
        void refreshList();
        api.settings()
            .then((settings) => !settings.hasApiKey && setSettingsOpen(true))
            .catch(() => undefined);
    }, [refreshList]);

    // 媒体任务在服务端后台执行，存在 pending 结果时定期刷新当前会话
    const hasPendingMedia = conversation?.messages.some((m) => m.status === "pending" && m.mode !== "chat");
    useEffect(() => {
        if (!hasPendingMedia || !conversation) return;
        const timer = setTimeout(() => void open(conversation.id).then(refreshList), 3000);
        return () => clearTimeout(timer);
    }, [conversation, hasPendingMedia, open, refreshList]);

    // 切换会话时直接定位到最新消息，同一会话内有新内容时平滑滚动
    const messageCount = conversation?.messages.length || 0;
    const streamLength = Object.values(stream).join("").length;
    const lastId = useRef<string | undefined>(undefined);
    useEffect(() => {
        const switched = lastId.current !== conversation?.id;
        lastId.current = conversation?.id;
        scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: switched ? "instant" : "smooth" });
    }, [messageCount, streamLength, conversation?.id]);

    const run = async (conversationId: string, action: typeof sendMessage | typeof retryMessage, arg: SendBody | string) => {
        setBusy(true);
        try {
            await action(conversationId, arg as never, (assistantId, text) => {
                if (!text) return void open(conversationId);
                setStream((current) => ({ ...current, [assistantId]: (current[assistantId] || "") + text }));
            });
            return true;
        } catch (error) {
            message.error(error instanceof Error ? error.message : "发送失败");
            return false;
        } finally {
            await open(activeId.current === conversationId ? conversationId : activeId.current);
            setStream({});
            setBusy(false);
            void refreshList();
        }
    };

    const send = async (body: SendBody) => {
        let id = conversation?.id;
        if (!id) {
            const created = await api.createConversation().catch((error) => void message.error(error.message));
            if (!created) return false;
            id = created.id;
            activeId.current = id;
            setConversation(created);
        }
        return run(id, sendMessage, body);
    };

    const remove = (item: ConversationSummary) =>
        modal.confirm({
            title: "删除对话",
            content: `确定删除「${item.title}」吗？对话中的图片和视频文件也会一并删除。`,
            okText: "删除",
            okButtonProps: { danger: true },
            cancelText: "取消",
            onOk: async () => {
                await api.deleteConversation(item.id);
                if (conversation?.id === item.id) void open(null);
                await refreshList();
            },
        });

    const rename = async () => {
        if (!renaming?.title.trim()) return;
        try {
            await api.renameConversation(renaming.id, renaming.title);
            if (conversation?.id === renaming.id) setConversation({ ...conversation, title: renaming.title.trim() });
            setRenaming(null);
            await refreshList();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "重命名失败");
        }
    };

    const sidebar = (
        <div className="flex h-full flex-col gap-3 p-3">
            <div className="flex items-center gap-2 px-1 py-1">
                <img src="/logo.svg" alt="VOZEB" className="h-7 w-7" />
                <span className="font-semibold">VOZEB 本地工作台</span>
            </div>
            <Button icon={<Plus size={16} />} onClick={() => open(null)} block>
                新建对话
            </Button>
            <div className="min-h-0 flex-1 overflow-y-auto">
                {list.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有对话" />}
                {list.map((item) => (
                    <div
                        key={item.id}
                        onClick={() => open(item.id)}
                        className={`group mb-1 flex cursor-pointer items-center gap-1 rounded-lg px-3 py-2 text-sm hover:bg-black/5 dark:hover:bg-white/10 ${conversation?.id === item.id ? "bg-black/5 font-medium dark:bg-white/10" : ""}`}
                    >
                        <span className="min-w-0 flex-1 truncate">{item.title}</span>
                        {item.pending && <span className="h-2 w-2 shrink-0 rounded-full bg-violet-500" title="生成中" />}
                        <Dropdown
                            trigger={["click"]}
                            menu={{
                                items: [
                                    { key: "rename", label: "重命名" },
                                    { key: "delete", label: "删除", danger: true },
                                ],
                                onClick: ({ key, domEvent }) => {
                                    domEvent.stopPropagation();
                                    if (key === "rename") setRenaming({ id: item.id, title: item.title });
                                    else remove(item);
                                },
                            }}
                        >
                            <Button type="text" size="small" icon={<MoreHorizontal size={14} />} onClick={(event) => event.stopPropagation()} aria-label="管理对话" className="md:opacity-0 md:group-hover:opacity-100" />
                        </Dropdown>
                    </div>
                ))}
            </div>
            <Button type="text" icon={<SettingsIcon size={16} />} onClick={() => setSettingsOpen(true)} className="!justify-start">
                设置
            </Button>
        </div>
    );

    return (
        <div className="flex h-full">
            <aside className="hidden w-64 shrink-0 border-r md:block" style={{ background: "var(--panel)", borderColor: "var(--line)" }}>
                {sidebar}
            </aside>
            <Drawer open={drawer} onClose={() => setDrawer(false)} placement="left" size="min(280px, 85vw)" closable={false} styles={{ body: { padding: 0 } }}>
                {sidebar}
            </Drawer>
            <main className="flex min-w-0 flex-1 flex-col">
                <header className="flex h-12 shrink-0 items-center gap-2 px-3">
                    <Button type="text" icon={<Menu size={18} />} onClick={() => setDrawer(true)} className="md:!hidden" aria-label="打开菜单" />
                    <span className="truncate text-sm font-medium">{conversation?.title || "新对话"}</span>
                </header>
                <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
                    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-4">
                        {!conversation?.messages.length && (
                            <div className="flex flex-col items-center gap-3 pt-[15vh] text-center">
                                <img src="/logo.svg" alt="VOZEB" className="h-14 w-14" />
                                <h1 className="text-2xl font-semibold">今天想创作什么？</h1>
                                <p style={{ color: "var(--muted)" }}>在下方选择对话、图片或视频，直接开始。</p>
                            </div>
                        )}
                        {conversation?.messages.map((item) => (
                            <MessageItem key={item.id} item={item} streamText={stream[item.id]} onRetry={(id) => run(conversation.id, retryMessage, id)} />
                        ))}
                    </div>
                </div>
                <div className="mx-auto w-full max-w-3xl px-4 pb-4">
                    <Composer busy={busy} onSend={send} />
                </div>
            </main>
            <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
            <Modal title="重命名对话" open={!!renaming} onCancel={() => setRenaming(null)} onOk={rename} okText="保存" cancelText="取消" destroyOnHidden>
                <Input value={renaming?.title} onChange={(event) => setRenaming((current) => current && { ...current, title: event.target.value })} onPressEnter={rename} maxLength={60} autoFocus />
            </Modal>
        </div>
    );
}
