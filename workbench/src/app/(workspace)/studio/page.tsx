"use client";

import { Button } from "antd";
import { PanelRight } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef } from "react";
import { brand } from "@/lib/brand";
import type { Mode } from "@/lib/types";
import { useWorkbench, workbench } from "@/stores/workbench";
import { AssetPanel, useConversationAssets } from "../../components/asset-panel";
import { Composer, modes } from "../../components/composer";
import { ConversationList } from "../../components/conversation-list";
import { MessageItem } from "../../components/message-item";
import { card } from "../../components/ui";

const suggestions: { mode: Mode; text: string }[] = [
    { mode: "image", text: "清晨薄雾中的江南古镇，水墨风格，留白构图" },
    { mode: "image", text: "极简风格的精品咖啡海报，暖色调，产品居中" },
    { mode: "video", text: "海浪拍打礁石的慢镜头，夕阳逆光，镜头缓慢推进" },
    { mode: "video", text: "一只橘猫在窗台上伸懒腰，温暖的午后阳光" },
    { mode: "chat", text: "帮我写一段新品发布的社交媒体文案" },
    { mode: "chat", text: "给我 5 个适合做成短视频的创意选题" },
];

function Studio() {
    const router = useRouter();
    const target = useSearchParams().get("c");
    const conversation = useWorkbench((s) => s.conversation);
    const assetsOpen = useWorkbench((s) => s.assetsOpen);
    const streamLength = useWorkbench((s) => Object.values(s.stream).join("").length);
    const assets = useConversationAssets();
    const scroller = useRef<HTMLDivElement>(null);
    const lastId = useRef<string | undefined>(undefined);
    const messages = conversation?.messages || [];
    const empty = !messages.length;

    // 地址栏中的对话 ID 决定当前打开的对话，刷新或从其他页面跳转都能回到原对话
    useEffect(() => {
        if (target && target !== useWorkbench.getState().conversation?.id) void workbench.open(target);
    }, [target]);

    useEffect(() => {
        if (conversation?.id && conversation.id !== target && messages.length) router.replace(`/studio?c=${conversation.id}`);
    }, [conversation?.id, messages.length, target, router]);

    // 图片和视频在服务端后台生成，存在生成中的结果时定期刷新当前对话
    const pendingMedia = messages.some((m) => m.status === "pending" && m.mode !== "chat");
    useEffect(() => {
        if (!pendingMedia || !conversation) return;
        const timer = setTimeout(() => void workbench.open(conversation.id).then(workbench.refreshList), 3000);
        return () => clearTimeout(timer);
    }, [conversation, pendingMedia]);

    // 切换对话时直接定位到最新消息，同一对话内有新内容时平滑滚动
    useEffect(() => {
        const switched = lastId.current !== conversation?.id;
        lastId.current = conversation?.id;
        scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: switched ? "instant" : "smooth" });
    }, [messages.length, streamLength, conversation?.id]);

    const openConversation = (id: string | null) => {
        void workbench.open(id);
        router.replace(id ? `/studio?c=${id}` : "/studio");
    };

    return (
        <div className="flex h-full gap-3">
            <aside className={`${card} w-[260px] shrink-0 overflow-hidden`}>
                <ConversationList onOpen={openConversation} />
            </aside>
            <section className={`${card} flex min-w-0 flex-1 flex-col overflow-hidden`}>
                <header className="flex h-12 shrink-0 items-center gap-2 border-b border-[var(--line)] px-3">
                    <span className="min-w-0 flex-1 truncate pl-1 text-sm font-medium">{empty ? "新对话" : conversation?.title}</span>
                    {!empty && (
                        <Button type="text" size="small" icon={<PanelRight size={16} />} onClick={() => workbench.toggle("assetsOpen")} aria-label="当前对话素材" className={assetsOpen ? "!text-[var(--accent)]" : ""}>
                            素材 {assets.length}
                        </Button>
                    )}
                </header>
                {empty ? (
                    <div className="min-h-0 flex-1 overflow-y-auto">
                        <div className="mx-auto flex max-w-[760px] flex-col items-center gap-5 px-4 pb-10 pt-[10vh]">
                            <img src="/logo.svg" alt="" className="h-12 w-12" />
                            <div className="text-center">
                                <h1 className="text-[26px] font-semibold">今天想创作点什么？</h1>
                                <p className="mt-2 text-sm text-[var(--text-2)]">{brand.slogan}</p>
                            </div>
                            <div className="w-full">
                                <Composer placement="bottom" />
                            </div>
                            <div className="grid w-full grid-cols-2 gap-2">
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
                                            className="flex min-w-0 items-center gap-2.5 rounded-xl border border-[var(--line)] bg-[var(--panel)] px-3 py-2.5 text-left text-[13px] transition-colors hover:border-[var(--accent)] hover:bg-[var(--accent-soft)]"
                                        >
                                            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[var(--panel-2)] text-[var(--text-2)]">{mode.icon}</span>
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
                            <div className="mx-auto flex max-w-[820px] flex-col gap-8 px-4 py-5">
                                {messages.map((item, index) => (
                                    <MessageItem key={item.id} item={item} request={item.role === "assistant" ? messages[index - 1] : undefined} />
                                ))}
                            </div>
                        </div>
                        <div className="mx-auto w-full max-w-[820px] px-4 pb-3">
                            <Composer placement="top" />
                        </div>
                    </>
                )}
            </section>
            {!empty && assetsOpen && (
                <aside className={`${card} w-[300px] shrink-0 overflow-hidden`}>
                    <AssetPanel onClose={() => workbench.toggle("assetsOpen", false)} />
                </aside>
            )}
        </div>
    );
}

export default function StudioPage() {
    return (
        <Suspense>
            <Studio />
        </Suspense>
    );
}
