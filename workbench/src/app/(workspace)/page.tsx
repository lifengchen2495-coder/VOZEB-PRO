"use client";

import { ArrowRight, ArrowUpRight, Clapperboard, Image as ImageIcon, MessageCircle, Play } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { brand } from "@/lib/brand";
import type { Mode } from "@/lib/types";
import { useWorkbench, workbench } from "@/stores/workbench";
import { StatusTag, card, timeAgo } from "../components/ui";

const quick: { mode: Mode; title: string; desc: string; icon: typeof MessageCircle; tone: string }[] = [
    { mode: "chat", title: "AI 对话", desc: "写文案、想选题、看图问答", icon: MessageCircle, tone: "bg-[var(--accent-soft)] text-[var(--accent)]" },
    { mode: "image", title: "图片生成", desc: "文字出图，附参考图可修改", icon: ImageIcon, tone: "bg-[var(--coral-soft)] text-[var(--coral)]" },
    { mode: "video", title: "视频生成", desc: "文字生成视频，可指定首帧", icon: Clapperboard, tone: "bg-[var(--blue-soft)] text-[var(--blue)]" },
];

function greeting() {
    const hour = new Date().getHours();
    return hour < 6 ? "夜深了" : hour < 12 ? "早上好" : hour < 14 ? "中午好" : hour < 18 ? "下午好" : "晚上好";
}

function Section({ title, href, children }: { title: string; href: string; children: React.ReactNode }) {
    return (
        <section className={`${card} flex min-w-0 flex-col p-4`}>
            <div className="mb-3 flex items-center">
                <h2 className="flex-1 text-[15px] font-semibold">{title}</h2>
                <Link href={href} className="flex items-center gap-0.5 text-xs text-[var(--text-2)] hover:text-[var(--accent)]">
                    查看全部 <ArrowRight size={13} />
                </Link>
            </div>
            {children}
        </section>
    );
}

export default function OverviewPage() {
    const router = useRouter();
    const settings = useWorkbench((s) => s.settings);
    const workspace = useWorkbench((s) => s.workspace);
    const list = useWorkbench((s) => s.list);
    const stats = workspace?.stats;
    const works = (workspace?.assets || []).filter((a) => a.source === "result").slice(0, 12);
    const tasks = (workspace?.tasks || []).slice(0, 5);
    const models = settings?.catalog.length || 0;

    const start = (mode: Mode) => {
        workbench.startNew(mode);
        router.push("/studio");
    };

    return (
        <div className="h-full overflow-y-auto">
            <div className="flex flex-col gap-3">
                <section className={`${card} flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:gap-4 sm:p-5`}>
                    <div className="min-w-0 flex-1">
                        <h1 className="text-lg font-semibold sm:text-xl">{greeting()}，欢迎回到{brand.name}</h1>
                        <p className="mt-1 text-[13px] text-[var(--text-2)]">{brand.slogan}。所有对话和作品都保存在你的电脑上。</p>
                    </div>
                    {settings && (
                        <Link href="/settings" className="flex shrink-0 items-center gap-2 self-start rounded-xl border border-[var(--line)] bg-[var(--panel-2)] px-3 py-2 text-xs text-[var(--text-2)] hover:border-[var(--line-strong)] sm:self-auto">
                            <span className={`h-2 w-2 rounded-full ${models ? "bg-[var(--accent)]" : "bg-[var(--coral)]"}`} />
                            {models ? `已连接 · ${models} 个模型` : "还没有获取模型"}
                            <ArrowUpRight size={13} />
                        </Link>
                    )}
                </section>

                <div className="grid grid-cols-3 gap-2 sm:gap-3">
                    {quick.map(({ mode, title, desc, icon: Icon, tone }) => (
                        <button key={mode} type="button" onClick={() => start(mode)} className={`${card} group flex flex-col items-center gap-2 p-3 text-center transition-shadow hover:shadow-[var(--shadow)] md:flex-row md:gap-3 md:p-4 md:text-left`}>
                            <span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${tone}`}>
                                <Icon size={20} />
                            </span>
                            <span className="min-w-0 flex-1">
                                <span className="block text-[13px] font-semibold md:text-[15px]">{title}</span>
                                <span className="hidden truncate text-xs text-[var(--text-2)] md:block">{desc}</span>
                            </span>
                            <ArrowRight size={16} className="hidden text-[var(--text-3)] transition-transform md:block group-hover:translate-x-0.5 group-hover:text-[var(--accent)]" />
                        </button>
                    ))}
                </div>

                <div className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
                    {[
                        { label: "创作对话", value: stats?.conversations, hint: "全部对话" },
                        { label: "生成图片", value: stats?.images, hint: "已保存到本地" },
                        { label: "生成视频", value: stats?.videos, hint: "已保存到本地" },
                        { label: "进行中任务", value: stats?.running, hint: stats?.failed ? `${stats.failed} 个失败待重试` : "暂无失败任务" },
                    ].map((item) => (
                        <div key={item.label} className={`${card} p-3 sm:p-4`}>
                            <div className="text-xs text-[var(--text-2)]">{item.label}</div>
                            <div className="mt-1.5 text-[22px] font-semibold leading-none tabular-nums sm:text-[26px]">{item.value ?? "–"}</div>
                            <div className="mt-1.5 truncate text-xs text-[var(--text-3)] sm:mt-2">{item.hint}</div>
                        </div>
                    ))}
                </div>

                <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_380px]">
                    <Section title="最近作品" href="/library">
                        {works.length ? (
                            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 xl:grid-cols-6">
                                {works.map((asset) => (
                                    <Link key={asset.id} href={`/studio?c=${asset.conversationId}`} className="group relative aspect-square overflow-hidden rounded-xl bg-[var(--panel-2)]" title={asset.prompt}>
                                        {asset.kind === "video" ? <video src={asset.url} muted preload="metadata" className="h-full w-full object-cover" /> : <img src={asset.url} alt={asset.prompt} className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105" />}
                                        {asset.kind === "video" && <Play size={18} fill="white" className="absolute left-2 top-2 text-white drop-shadow" />}
                                        <span className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/60 to-transparent px-2 pb-1.5 pt-5 text-[11px] text-white">{asset.prompt}</span>
                                    </Link>
                                ))}
                            </div>
                        ) : (
                            <p className="py-10 text-center text-[13px] text-[var(--text-3)]">还没有作品，从上面选一种方式开始创作吧</p>
                        )}
                    </Section>
                    <div className="flex min-w-0 flex-col gap-3">
                        <Section title="最近对话" href="/studio">
                            {list.length ? (
                                <div className="-mx-2 flex flex-col">
                                    {list.slice(0, 5).map((c) => (
                                        <Link key={c.id} href={`/studio?c=${c.id}`} className="flex items-center gap-2 rounded-lg px-2 py-2 text-[13px] hover:bg-[var(--hover)]">
                                            <span className="min-w-0 flex-1 truncate">{c.title}</span>
                                            {c.pending && <span className="h-1.5 w-1.5 rounded-full bg-[var(--blue)]" />}
                                            <span className="shrink-0 text-xs text-[var(--text-3)]">{timeAgo(c.updatedAt)}</span>
                                        </Link>
                                    ))}
                                </div>
                            ) : (
                                <p className="py-6 text-center text-[13px] text-[var(--text-3)]">暂无对话</p>
                            )}
                        </Section>
                        <Section title="任务动态" href="/tasks">
                            {tasks.length ? (
                                <div className="flex flex-col gap-2.5">
                                    {tasks.map((task) => (
                                        <div key={task.id} className="flex items-center gap-2 text-[13px]">
                                            <span className="min-w-0 flex-1 truncate">{task.prompt}</span>
                                            <StatusTag status={task.status} />
                                        </div>
                                    ))}
                                </div>
                            ) : (
                                <p className="py-6 text-center text-[13px] text-[var(--text-3)]">图片和视频任务会显示在这里</p>
                            )}
                        </Section>
                    </div>
                </div>
            </div>
        </div>
    );
}
