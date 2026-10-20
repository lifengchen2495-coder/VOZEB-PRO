"use client";

import { Button, Image, Modal } from "antd";
import { Play, X } from "lucide-react";
import { useState } from "react";
import type { Media } from "@/lib/types";
import { useWorkbench, workbench } from "@/stores/workbench";

// 当前对话中上传和生成的全部素材，新的在前
export function useConversationAssets() {
    const conversation = useWorkbench((s) => s.conversation);
    const seen = new Set<string>();
    const assets: Media[] = [];
    for (const message of [...(conversation?.messages || [])].reverse()) {
        for (const media of [...(message.results || []), ...(message.attachments || [])]) {
            if (seen.has(media.id)) continue;
            seen.add(media.id);
            assets.push(media);
        }
    }
    return assets;
}

export function AssetPanel({ onClose }: { onClose: () => void }) {
    const assets = useConversationAssets();
    const attachments = useWorkbench((s) => s.attachments);
    const [video, setVideo] = useState<Media | null>(null);

    return (
        <div className="flex h-full flex-col bg-[var(--panel)]">
            <div className="flex h-12 shrink-0 items-center gap-2 border-b border-[var(--line)] px-4">
                <span className="text-sm font-medium">当前对话素材</span>
                <span className="text-xs text-[var(--text-2)]">{assets.length}</span>
                <Button type="text" size="small" icon={<X size={16} />} onClick={onClose} aria-label="关闭素材面板" className="ml-auto" />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
                {!assets.length && <p className="pt-10 text-center text-xs leading-6 text-[var(--text-2)]">这里会显示本次对话上传的参考图和生成的图片、视频，点击「引用」可以继续创作。</p>}
                <Image.PreviewGroup>
                    <div className="grid grid-cols-4 gap-x-2 gap-y-3">
                        {assets.map((media) => {
                            const referenced = attachments.some((item) => item.media?.id === media.id);
                            return (
                                <div key={media.id} className="flex min-w-0 flex-col items-center gap-1">
                                    <div className={`aspect-square w-full overflow-hidden rounded-lg border-2 ${referenced ? "border-[var(--accent)]" : "border-transparent"}`}>
                                        {media.kind === "video" ? (
                                            <button type="button" aria-label="播放视频" onClick={() => setVideo(media)} className="relative h-full w-full bg-black">
                                                <video src={media.url} muted preload="metadata" className="h-full w-full object-cover" />
                                                <Play size={16} className="absolute inset-0 m-auto text-white" fill="white" />
                                            </button>
                                        ) : (
                                            <Image src={media.url} alt={media.name || "素材"} width="100%" height="100%" rootClassName="!block h-full w-full" style={{ objectFit: "cover" }} />
                                        )}
                                    </div>
                                    {media.kind === "image" ? (
                                        <button type="button" onClick={() => workbench.reference(media)} className={`text-xs transition-colors ${referenced ? "text-[var(--accent)]" : "text-[var(--text-2)] hover:text-[var(--accent)]"}`}>
                                            {referenced ? "已引用" : "引用"}
                                        </button>
                                    ) : (
                                        <span className="text-xs text-[var(--text-2)]">视频</span>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                </Image.PreviewGroup>
            </div>
            <Modal open={!!video} onCancel={() => setVideo(null)} footer={null} width="fit-content" centered destroyOnHidden styles={{ body: { padding: 0 } }} title={null} closable>
                {video && <video src={video.url} controls autoPlay playsInline className="block max-h-[80vh] max-w-[calc(100vw-48px)] rounded-lg" />}
            </Modal>
        </div>
    );
}
