"use client";

import { useEffect, useRef, useState } from "react";
import { Upload } from "lucide-react";
import { useUserStore } from "@/stores/use-user-store";
import { omniInputVersion, type OmniProject, type OmniSegment } from "@/lib/omni-remake-contract";
import { uploadOmniResult } from "../omni-api";
import { Button } from "../controls";

type PendingUpload = { url: string; uploadId: string; name: string; fingerprint: string; uploadedAt: number };

function readPendingUploads(prefix: string): PendingUpload[] {
    if (!prefix) return [];
    const items: PendingUpload[] = [];
    try {
        for (let index = 0; index < localStorage.length; index++) {
            const key = localStorage.key(index);
            if (!key?.startsWith(`${prefix}:`)) continue;
            try {
                const value = JSON.parse(localStorage.getItem(key) || "null") as Partial<PendingUpload> | null;
                if (value && typeof value.url === "string" && typeof value.uploadId === "string" && typeof value.name === "string" && typeof value.fingerprint === "string" && typeof value.uploadedAt === "number") items.push(value as PendingUpload);
            } catch { /* 跳过不完整的浏览器记录。 */ }
        }
    } catch { /* 浏览器禁用存储时仍可在本页上传。 */ }
    return items.sort((a, b) => b.uploadedAt - a.uploadedAt);
}

export function ManualVideoUpload({ project, segment, disabled, acquire, release, onImport }: {
    project: OmniProject;
    segment: OmniSegment;
    disabled: boolean;
    acquire: () => boolean;
    release: () => void;
    onImport: (url: string, uploadId: string) => Promise<void>;
}) {
    const userId = useUserStore((state) => state.user?.id);
    const storageKey = userId ? `omni-remake:manual-result:${userId}:${project.id}:${segment.id}` : "";
    const fingerprint = JSON.stringify([omniInputVersion(project), segment.sourceClip?.url, segment.start, segment.end, segment.audioStrategy, segment.prompt, segment.promptZh]);
    const [pending, setPending] = useState<PendingUpload>();
    const [readyKey, setReadyKey] = useState("");
    const [working, setWorking] = useState(false);
    const [error, setError] = useState("");
    const [storageNotice, setStorageNotice] = useState("");
    const localLock = useRef(false);
    useEffect(() => {
        setPending(readPendingUploads(storageKey)[0]);
        setReadyKey(storageKey);
        const refresh = (event: StorageEvent) => {
            if (!event.key?.startsWith(`${storageKey}:`) || localLock.current) return;
            const candidates = readPendingUploads(storageKey);
            setPending((value) => candidates.find((candidate) => candidate.uploadId === value?.uploadId) || candidates[0]);
        };
        window.addEventListener("storage", refresh);
        return () => window.removeEventListener("storage", refresh);
    }, [storageKey]);
    useEffect(() => {
        if (readyKey !== storageKey || !pending || segment.video.manualUploadId !== pending.uploadId || !segment.video.result) return;
        try { localStorage.removeItem(`${storageKey}:${pending.uploadId}`); } catch { /* 当前页的采用状态仍然有效。 */ }
        setPending(readPendingUploads(storageKey).find((value) => value.uploadId !== pending.uploadId));
    }, [pending, readyKey, storageKey, segment.video.manualUploadId, segment.video.result]);
    const remember = (value: PendingUpload) => {
        setPending(value);
        try {
            localStorage.setItem(`${storageKey}:${value.uploadId}`, JSON.stringify(value));
        } catch {
            setStorageNotice("当前浏览器无法保留待保存记录，请在关闭页面前完成保存。");
        }
    };
    const forget = (uploadId: string) => {
        try { localStorage.removeItem(`${storageKey}:${uploadId}`); } catch { /* 不影响已经采用的结果。 */ }
        setPending(readPendingUploads(storageKey).find((value) => value.uploadId !== uploadId));
    };
    const stale = Boolean(pending && pending.fingerprint !== fingerprint);
    const expired = Boolean(pending && Date.now() - pending.uploadedAt >= 24 * 60 * 60 * 1000);
    const blocked = disabled || working || !storageKey || readyKey !== storageKey;
    const run = async (file?: File) => {
        if (blocked || localLock.current || (!file && (!pending || stale || expired))) return;
        if (!acquire()) return;
        localLock.current = true;
        setWorking(true);
        setError("");
        try {
            let candidate = pending;
            if (file) {
                const asset = await uploadOmniResult(project.id, segment.id, project.revision, file);
                candidate = { url: asset.url, uploadId: asset.uploadId, name: file.name, fingerprint, uploadedAt: Date.now() };
                remember(candidate);
            }
            if (!candidate) throw new Error("请先选择生成的视频");
            await onImport(candidate.url, candidate.uploadId);
            forget(candidate.uploadId);
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : "结果保存失败，请重试");
        } finally {
            localLock.current = false;
            setWorking(false);
            release();
        }
    };
    return (
        <div className="space-y-2 rounded-lg bg-muted/40 p-3">
            <label className={`inline-flex cursor-pointer items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm ${blocked ? "pointer-events-none opacity-50" : ""}`}>
                <Upload className="size-4" />
                {working ? "正在上传并保存…" : segment.video.result ? "上传替换结果" : "上传手动生成结果"}
                <input aria-label={`${segment.id} 上传手动生成结果`} className="sr-only" type="file" accept="video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm" disabled={blocked} onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    if (file) void run(file);
                }} />
            </label>
            <p className="text-xs text-muted-foreground">将外部生成的完整视频上传到本段，画面时长至少 {segment.duration} 秒，最多 200 MB。合并时会按本段时长截取。</p>
            {pending && readyKey === storageKey && (
                <div className="space-y-2 text-xs">
                    <p>{stale ? "素材或提示词已变化，请按当前片段重新生成并上传。" : expired ? "临时上传已过期，请重新上传。" : `“${pending.name}”已上传，尚未确认保存；可在 24 小时内重试。`}</p>
                    <div className="flex gap-2">
                        <Button size="sm" variant="outline" disabled={blocked || stale || expired} onClick={() => void run()}>重试保存已上传结果</Button>
                        <Button size="sm" variant="ghost" disabled={blocked} onClick={() => { forget(pending.uploadId); setError(""); }}>清除待保存记录</Button>
                    </div>
                </div>
            )}
            {storageNotice && <p role="status" className="text-xs text-muted-foreground">{storageNotice}</p>}
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        </div>
    );
}
