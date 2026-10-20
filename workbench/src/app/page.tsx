"use client";

import { App, Button, Drawer, Tooltip } from "antd";
import { Menu, PanelRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Mode } from "@/lib/types";
import { useWorkbench, workbench } from "@/stores/workbench";
import { AssetPanel, useConversationAssets } from "./components/asset-panel";
import { Composer, modes } from "./components/composer";
import { MessageItem } from "./components/message-item";
import { SettingsModal } from "./components/settings-modal";
import { Sidebar } from "./components/sidebar";

const suggestions: { mode: Mode; text: string }[] = [
    { mode: "image", text: "清晨薄雾中的江南古镇，水墨风格，留白构图" },
    { mode: "image", text: "极简风格的精品咖啡海报，暖色调，产品居中" },
    { mode: "video", text: "海浪拍打礁石的慢镜头，夕阳逆光，镜头缓慢推进" },
    { mode: "video", text: "一只橘猫在窗台上伸懒腰，温暖的午后阳光" },
    { mode: "chat", text: "帮我写一段新品发布的社交媒体文案" },
    { mode: "chat", text: "给我 5 个适合做成短视频的创意选题" },
];

const wide = () => window.matchMedia("(min-width: 1280px)").matches;

export default function Page() {
    const { message } = App.useApp();
    const conversation = useWorkbench((s) => s.conversation);
    const notice = useWorkbench((s) => s.notice);
    const menuOpen = useWorkbench((s) => s.menuOpen);
    const assetsOpen = useWorkbench((s) => s.assetsOpen);
    const streamLength = useWorkbench((s) => Object.values(s.stream).join("").length);
    const assets = useConversationAssets();
    const [assetsDrawer, setAssetsDrawer] = useState(false);
    const scroller = useRef<HTMLDivElement>(null);
    const lastId = useRef<string | undefined>(undefined);
    const messages = conversation?.messages || [];
    const empty = !messages.length;

    useEffect(() => {
        void workbench.loadSettings();
        void workbench.refreshList();
    }, []);

    useEffect(() => {
        if (notice) void message.open({ type: notice.type, content: notice.text });
    }, [notice, message]);

    // 图片和视频在服务端后台生成，存在生成中的结果时定期刷新当前会话
    const pendingMedia = messages.some((m) => m.status === "pending" && m.mode !== "chat");
    useEffect(() => {
        if (!pendingMedia || !conversation) return;
        const timer = setTimeout(() => void workbench.open(conversation.id).then(workbench.refreshList), 3000);
        return () => clearTimeout(timer);
    }, [conversation, pendingMedia]);

    // 切换会话时直接定位到最新消息，同一会话内有新内容时平滑滚动
    useEffect(() => {
        const switched = lastId.current !== conversation?.id;
        lastId.current = conversation?.id;
        scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: switched ? "instant" : "smooth" });
    }, [messages.length, streamLength, conversation?.id]);

    const toggleAssets = () => (wide() ? workbench.toggle("assetsOpen") : setAssetsDrawer(true));

    return (
        <div className="flex h-full">
            <aside className="hidden w-[264px] shrink-0 border-r md:block" style={{ borderColor: "var(--line)" }}>
                <Sidebar />
            </aside>
            <Drawer open={menuOpen} onClose={() => workbench.toggle("menuOpen", false)} placement="left" size="min(300px, 86vw)" closable={false} styles={{ body: { padding: 0 } }}>
                <Sidebar />
            </Drawer>
            <main className="flex min-w-0 flex-1 flex-col">
                <header className="flex h-12 shrink-0 items-center gap-2 px-3">
                    <Button type="text" icon={<Menu size={18} />} onClick={() => workbench.toggle("menuOpen", true)} className="md:!hidden" aria-label="打开菜单" />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{empty ? "" : conversation?.title}</span>
                    {!empty && (
                        <Tooltip title="当前对话素材">
                            <Button type="text" icon={<PanelRight size={18} />} onClick={toggleAssets} aria-label="当前对话素材" className={assetsOpen ? "xl:!text-[var(--accent)]" : ""}>
                                <span className="hidden sm:inline">素材 {assets.length}</span>
                            </Button>
                        </Tooltip>
                    )}
                </header>
                {empty ? (
                    <div className="min-h-0 flex-1 overflow-y-auto">
                        <div className="mx-auto flex max-w-3xl flex-col items-center gap-5 px-4 pb-10 pt-[8vh] sm:pt-[14vh]">
                            <img src="/logo.svg" alt="VOZEB" className="h-12 w-12" />
                            <div className="text-center">
                                <h1 className="text-2xl font-semibold sm:text-[28px]">今天想创作什么？</h1>
                                <p className="mt-2 text-sm text-[var(--text-2)]">对话、图片、视频都在一个输入框里完成，结果保存在你的电脑上。</p>
                            </div>
                            <div className="w-full">
                                <Composer placement="bottom" />
                            </div>
                            <div className="grid w-full gap-2 sm:grid-cols-2">
                                {suggestions.map((item) => {
                                    const mode = modes.find((m) => m.value === item.mode)!;
                                    return (
                                        <button
                                            key={item.text}
                                            type="button"
                                            onClick={() => {
                                                workbench.setMode(item.mode);
                                                workbench.setPrompt(item.text);
                                            }}
                                            className="flex min-w-0 items-center gap-2.5 rounded-2xl border bg-[var(--panel)] px-3 py-2.5 text-left text-sm transition-colors hover:border-[var(--accent)]"
                                            style={{ borderColor: "var(--line)" }}
                                        >
                                            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[var(--hover)] text-[var(--text-2)]">{mode.icon}</span>
                                            <span className="min-w-0 flex-1 truncate">{item.text}</span>
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    </div>
                ) : (
                    <>
                        <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
                            <div className="mx-auto flex max-w-3xl flex-col gap-8 px-4 py-4">
                                {messages.map((item, index) => (
                                    <MessageItem key={item.id} item={item} request={item.role === "assistant" ? messages[index - 1] : undefined} />
                                ))}
                            </div>
                        </div>
                        <div className="mx-auto w-full max-w-3xl px-3 pb-3 sm:px-4 sm:pb-4">
                            <Composer placement="top" />
                        </div>
                    </>
                )}
            </main>
            {!empty && assetsOpen && (
                <aside className="hidden w-[320px] shrink-0 border-l xl:block" style={{ borderColor: "var(--line)" }}>
                    <AssetPanel onClose={() => workbench.toggle("assetsOpen", false)} />
                </aside>
            )}
            <Drawer open={assetsDrawer} onClose={() => setAssetsDrawer(false)} placement="right" size="min(360px, 92vw)" closable={false} styles={{ body: { padding: 0 } }}>
                <AssetPanel onClose={() => setAssetsDrawer(false)} />
            </Drawer>
            <SettingsModal />
        </div>
    );
}
