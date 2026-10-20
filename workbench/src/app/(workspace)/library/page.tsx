"use client";

import { Image, Input, Modal, Select, Tooltip } from "antd";
import { Download, MessagesSquare, Paperclip, Play, Search } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { Asset } from "@/lib/types";
import { useWorkbench, workbench } from "@/stores/workbench";
import { Pill, Tag, card, timeAgo } from "../../components/ui";

const filters: { key: string; label: string; test: (a: Asset) => boolean }[] = [
    { key: "all", label: "全部", test: () => true },
    { key: "image", label: "图片", test: (a) => a.source === "result" && a.kind === "image" },
    { key: "video", label: "视频", test: (a) => a.source === "result" && a.kind === "video" },
    { key: "reference", label: "参考图", test: (a) => a.source === "reference" },
];

const iconButton = "flex h-7 w-7 items-center justify-center rounded-lg text-[var(--text-2)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--accent)]";

export default function LibraryPage() {
    const router = useRouter();
    const assets = useWorkbench((s) => s.workspace?.assets);
    const [filter, setFilter] = useState("all");
    const [keyword, setKeyword] = useState("");
    const [order, setOrder] = useState("new");
    const [video, setVideo] = useState<Asset | null>(null);
    const all = assets || [];
    const q = keyword.trim().toLowerCase();
    const shown = all
        .filter(filters.find((f) => f.key === filter)!.test)
        .filter((a) => !q || `${a.prompt} ${a.conversationTitle} ${a.model || ""}`.toLowerCase().includes(q))
        .sort((a, b) => (order === "new" ? b.createdAt - a.createdAt : a.createdAt - b.createdAt));

    const reuse = (asset: Asset) => {
        workbench.startNew("image", asset);
        router.push("/studio");
    };

    return (
        <div className={`${card} flex h-full flex-col overflow-hidden`}>
            <div className="flex flex-col gap-3 border-b border-[var(--line)] p-4">
                <div className="flex flex-wrap items-center gap-3">
                    <div className="mr-auto">
                        <div className="text-xs text-[var(--accent)]">本地作品</div>
                        <h1 className="flex items-baseline gap-2 text-lg font-semibold">
                            素材库 <span className="text-sm font-normal text-[var(--accent)]">{all.length}</span>
                        </h1>
                    </div>
                    <div className="flex w-full gap-2 sm:w-auto">
                        <Input allowClear prefix={<Search size={15} className="opacity-50" />} placeholder="搜索提示词、对话或模型" value={keyword} onChange={(event) => setKeyword(event.target.value)} className="min-w-0 flex-1 sm:!w-64" aria-label="搜索素材" />
                        <Select value={order} onChange={setOrder} options={[{ value: "new", label: "最新优先" }, { value: "old", label: "最早优先" }]} className="w-28 shrink-0" aria-label="排序" />
                    </div>
                </div>
                <div className="flex gap-1 overflow-x-auto">
                    {filters.map((f) => (
                        <Pill key={f.key} active={filter === f.key} onClick={() => setFilter(f.key)} count={all.filter(f.test).length}>
                            {f.label}
                        </Pill>
                    ))}
                </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
                {!assets && <p className="py-16 text-center text-sm text-[var(--text-3)]">加载中…</p>}
                {assets && !shown.length && (
                    <div className="flex flex-col items-center gap-2 py-16 text-center">
                        <p className="text-sm text-[var(--text-2)]">{all.length ? "没有符合条件的素材" : "还没有素材"}</p>
                        {!all.length && (
                            <Link href="/studio" className="text-[13px] text-[var(--accent)]">
                                去 AI 创作生成第一张图
                            </Link>
                        )}
                    </div>
                )}
                <Image.PreviewGroup>
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5 2xl:grid-cols-6">
                        {shown.map((asset) => (
                            <article key={`${asset.messageId}-${asset.id}`} className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--panel)] transition-shadow hover:shadow-[var(--shadow)]" data-asset={asset.id}>
                                <div className="relative aspect-square overflow-hidden bg-[var(--panel-2)]">
                                    {asset.kind === "video" ? (
                                        <button type="button" onClick={() => setVideo(asset)} aria-label="播放视频" className="h-full w-full">
                                            <video src={asset.url} muted preload="metadata" className="h-full w-full object-cover" />
                                            <span className="absolute inset-0 m-auto flex h-10 w-10 items-center justify-center rounded-full bg-black/45 text-white">
                                                <Play size={18} fill="white" />
                                            </span>
                                        </button>
                                    ) : (
                                        <Image src={asset.url} alt={asset.prompt} width="100%" height="100%" rootClassName="!block h-full w-full" style={{ objectFit: "cover" }} />
                                    )}
                                    <span className="absolute right-2 top-2">
                                        <Tag tone={asset.source === "result" ? "accent" : "coral"}>{asset.source === "result" ? (asset.kind === "video" ? "视频" : "生成") : "参考图"}</Tag>
                                    </span>
                                </div>
                                <div className="flex flex-1 flex-col gap-1.5 p-2.5">
                                    <p className="line-clamp-2 min-h-[2.6em] text-[13px] leading-[1.3]">{asset.prompt || "（无提示词）"}</p>
                                    <div className="flex items-center gap-1 text-[11px] text-[var(--text-3)]">
                                        <span className="min-w-0 flex-1 truncate">{asset.model || asset.conversationTitle}</span>
                                        <span className="shrink-0">{timeAgo(asset.createdAt)}</span>
                                    </div>
                                    <div className="-mx-1 flex items-center gap-0.5 border-t border-[var(--line)] pt-1.5">
                                        {asset.kind === "image" && (
                                            <Tooltip title="用作参考图新建创作">
                                                <button type="button" aria-label="用作参考" onClick={() => reuse(asset)} className={iconButton}>
                                                    <Paperclip size={14} />
                                                </button>
                                            </Tooltip>
                                        )}
                                        <Tooltip title="下载">
                                            <a href={asset.url} download={asset.id} aria-label="下载" className={iconButton}>
                                                <Download size={14} />
                                            </a>
                                        </Tooltip>
                                        <Tooltip title="打开所在对话">
                                            <Link href={`/studio?c=${asset.conversationId}`} aria-label="打开所在对话" className={iconButton}>
                                                <MessagesSquare size={14} />
                                            </Link>
                                        </Tooltip>
                                    </div>
                                </div>
                            </article>
                        ))}
                    </div>
                </Image.PreviewGroup>
            </div>
            <Modal open={!!video} onCancel={() => setVideo(null)} footer={null} width="fit-content" centered destroyOnHidden title={null}>
                {video && <video src={video.url} controls autoPlay playsInline className="block max-h-[80vh] max-w-[calc(100vw-48px)] rounded-lg" />}
            </Modal>
        </div>
    );
}
