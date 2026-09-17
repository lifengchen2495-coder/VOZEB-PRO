"use client";
import Link from "next/link";
import { FrameRemakeWorkflow } from "./workflow";
import { recoveredFrameRemakeWorkflowStage } from "@/lib/frame-remake-steps";
import { useCallback, useEffect, useRef, useState } from "react";
import {
    frameRemakeBusy,
    type FrameRemakeWorkflowStage,
    type FrameRemakeAnalysisStage,
    type FrameRemakeOperationKind,
    type FrameRemakeGenerationKind,
    type FrameRemakePatch,
    type FrameRemakeProject,
    type FrameRemakeRunOptions,
} from "@/lib/frame-remake-contract";
import { frameRemakeProjectPath, frameRemakeRequest, uploadFrameRemakeMedia } from "../api";
import { Button } from "../../bangbang/controls";

function applyDraft(project: FrameRemakeProject, draft: FrameRemakePatch): FrameRemakeProject {
    return {
        ...project,
        ...draft,
        sourceVideo: draft.sourceVideo === null ? undefined : (draft.sourceVideo ?? project.sourceVideo),
        groups: project.groups.map((group) => ({
            ...group,
            ...(draft.group?.id === group.id ? draft.group : {}),
            frames: group.frames.map((f) => (draft.frame?.groupId === group.id && draft.frame.number === f.number ? { ...f, detail: draft.frame.detail } : f)),
            copyBlocks: group.copyBlocks?.map((b) => (draft.copyBlock?.groupId === group.id && draft.copyBlock.number === b.number ? { ...b, text: draft.copyBlock.text } : b)),
        })),
    };
}
function patchScope(patch: FrameRemakePatch) {
    if (patch.group) return `group:${patch.group.id}`;
    if (patch.frame) return `frame:${patch.frame.groupId}:${patch.frame.number}`;
    if (patch.copyBlock) return `copy:${patch.copyBlock.groupId}:${patch.copyBlock.number}`;
    return "project";
}
export function FrameRemakeWorkspace({ id }: { id: string }) {
    const [project, setProject] = useState<FrameRemakeProject>();
    const [drafts, setDrafts] = useState<FrameRemakePatch[]>([]);
    const [selected, setSelected] = useState("G1");
    const [working, setWorking] = useState(false),
        [saving, setSaving] = useState(false);
    const [controlling, setControlling] = useState(false);
    const [stage, setStage] = useState<FrameRemakeWorkflowStage>();
    const [error, setError] = useState("");
    const current = useRef<FrameRemakeProject>(undefined),
        queue = useRef<FrameRemakePatch[]>([]);
    const savingPromise = useRef<Promise<void> | undefined>(undefined),
        inFlight = useRef<FrameRemakePatch | undefined>(undefined);
    const lock = useRef(false),
        mounted = useRef(true);
    const controlLock = useRef(false),
        controlEpoch = useRef(0),
        actionEpoch = useRef(0);
    const path = frameRemakeProjectPath(id);
    const accept = useCallback(
        (value: FrameRemakeProject) => {
            if (mounted.current && value.id === id && (!current.current || value.revision >= current.current.revision)) {
                current.current = value;
                setProject(value);
            }
            return value;
        },
        [id],
    );
    const refresh = useCallback(async () => accept(await frameRemakeRequest<FrameRemakeProject>(frameRemakeProjectPath(id))), [accept, id]);
    const flush = useCallback((): Promise<void> => {
        if (savingPromise.current) return savingPromise.current;
        const epoch = controlEpoch.current;
        const pending = (async () => {
            setSaving(true);
            try {
                while (queue.current.length && mounted.current && !controlLock.current && epoch === controlEpoch.current) {
                    const patch = queue.current[0];
                    inFlight.current = patch;
                    accept(await frameRemakeRequest<FrameRemakeProject>(path, { ...patch, revision: current.current!.revision }, "PATCH"));
                    queue.current = queue.current.filter((p) => p !== patch);
                    setDrafts([...queue.current]);
                }
                if (epoch === controlEpoch.current) setError("");
            } finally {
                inFlight.current = undefined;
                setSaving(false);
            }
        })();
        savingPromise.current = pending;
        void pending
            .finally(() => {
                savingPromise.current = undefined;
            })
            .catch(() => undefined);
        return pending;
    }, [accept, path]);
    const change = (patch: FrameRemakePatch) => {
        const last = queue.current.at(-1);
        if (last && last !== inFlight.current && patchScope(last) === patchScope(patch)) {
            queue.current = [...queue.current.slice(0, -1), { ...last, ...patch, ...(patch.group ? { group: { ...last.group, ...patch.group } } : {}) }];
        } else queue.current = [...queue.current, patch];
        setDrafts([...queue.current]);
    };
    useEffect(() => {
        if (!drafts.length || working || controlling || (project && (frameRemakeBusy(project) || project.automation?.status === "running"))) return;
        const timer = setTimeout(() => {
            void flush().catch((e) => setError(`自动保存失败：${e.message}`));
        }, 700);
        return () => clearTimeout(timer);
    }, [drafts, working, controlling, project, flush]);
    useEffect(() => {
        mounted.current = true;
        let stopped = false;
        let timer: ReturnType<typeof setTimeout>;
        const poll = async () => {
            try {
                if (!lock.current && !controlLock.current) await refresh();
            } catch (e) {
                if (!stopped) setError((e as Error).message);
            }
            if (!stopped) timer = setTimeout(poll, current.current && (frameRemakeBusy(current.current) || current.current.automation?.status === "running") ? 4000 : 20000);
        };
        void poll();
        return () => {
            stopped = true;
            mounted.current = false;
            clearTimeout(timer);
        };
    }, [refresh]);
    useEffect(() => {
        if (!drafts.length) return;
        const warn = (event: BeforeUnloadEvent) => event.preventDefault();
        window.addEventListener("beforeunload", warn);
        return () => window.removeEventListener("beforeunload", warn);
    }, [drafts.length]);
    const action = async (fn: (canContinue: () => boolean) => Promise<unknown>) => {
        if (lock.current || controlLock.current) return;
        const epoch = ++actionEpoch.current;
        const canContinue = () => epoch === actionEpoch.current && mounted.current;
        lock.current = true;
        setWorking(true);
        setError("");
        try {
            await flush();
            if (canContinue()) await fn(canContinue);
        } catch (e) {
            if (canContinue()) {
                setError((e as Error).message);
                await refresh().catch(() => undefined);
            }
        } finally {
            if (epoch === actionEpoch.current) {
                lock.current = false;
                if (mounted.current) setWorking(false);
            }
        }
    };
    // 暂停和取消不能等待草稿保存；同时阻止旧的开始请求在等待保存后继续提交。
    const priorityControl = async (fn: () => Promise<FrameRemakeProject>) => {
        if (controlLock.current) return;
        controlLock.current = true;
        controlEpoch.current++;
        actionEpoch.current++;
        lock.current = false;
        setWorking(false);
        setControlling(true);
        setError("");
        try {
            accept(await fn());
        } catch (e) {
            if (mounted.current) setError((e as Error).message);
            await refresh().catch(() => undefined);
        } finally {
            controlLock.current = false;
            if (mounted.current) setControlling(false);
        }
    };
    const operation = (kind: FrameRemakeOperationKind, groupId?: string, analysisStage?: FrameRemakeAnalysisStage) =>
        action(async () => accept(await frameRemakeRequest<FrameRemakeProject>(`${path}/operations`, { revision: current.current!.revision, kind, groupId, analysisStage })));
    const control = (mode: "start" | "step" | "pause", stageScope: FrameRemakeWorkflowStage, stopAfterPrompts = false, options?: FrameRemakeRunOptions) => {
        if (mode === "pause") return priorityControl(() => frameRemakeRequest<FrameRemakeProject>(`${path}/run`, { revision: current.current!.revision, action: "pause" }));
        return action(async (canContinue) => {
            setStage(stageScope);
            const latest = await refresh();
            if (!canContinue()) return;
            accept(await frameRemakeRequest<FrameRemakeProject>(`${path}/run`, { revision: latest.revision, action: mode, stageScope, stopAfterPrompts, options }));
        });
    };
    const generate = (groupId: string, kind: FrameRemakeGenerationKind) => action(async () => accept(await frameRemakeRequest<FrameRemakeProject>(`${path}/groups/${groupId}/${kind}`, { revision: current.current!.revision })));
    const abandon = (groupId: string, kind: FrameRemakeGenerationKind) => priorityControl(() => frameRemakeRequest<FrameRemakeProject>(`${path}/groups/${groupId}/${kind}`, undefined, "DELETE"));
    const upload = (file: File, role: "product" | "character" | "background" | "video") =>
        action(async (canContinue) => {
            const media = await uploadFrameRemakeMedia(id, file),
                latest = await refresh();
            if (!canContinue()) return;
            const patch = role === "video" ? { sourceVideo: media } : { references: { ...latest.references, [role]: [media] } };
            accept(await frameRemakeRequest<FrameRemakeProject>(path, { ...patch, revision: latest.revision }, "PATCH"));
        });
    if (!project)
        return (
            <main className="grid h-full place-items-center p-6">
                <div className="space-y-4 text-center">
                    <p role={error ? "alert" : undefined}>{error || "正在读取复刻项目…"}</p>
                    <Button variant="outline" onClick={() => void action(refresh)}>
                        重新读取
                    </Button>
                    <Link href="/frame-remake" className="block text-sm underline">
                        返回复刻项目
                    </Link>
                </div>
            </main>
        );
    const editingDisabled = working || controlling || frameRemakeBusy(project) || project.automation?.status === "running";
    const display = drafts.reduce(applyDraft, project);
    const activeStage = stage ?? recoveredFrameRemakeWorkflowStage(project);
    return (
        <FrameRemakeWorkflow
            project={project}
            display={display}
            group={display.groups.find((g) => g.id === selected) || display.groups[0]}
            stage={activeStage}
            dirty={drafts.length > 0}
            saving={saving}
            working={working}
            controlling={controlling}
            editingDisabled={editingDisabled}
            disabled={editingDisabled}
            error={error}
            groupLocked={false}
            onStage={setStage}
            onGroup={setSelected}
            onChange={change}
            onEditGroup={(key, value, groupId) => {
                if (groupId) change({ group: { id: groupId, [key]: value } });
            }}
            onSave={async () => {
                try {
                    await flush();
                } catch (e) {
                    setError((e as Error).message);
                    throw e;
                }
            }}
            onDiscard={() => {
                queue.current = queue.current.filter((p) => p === inFlight.current);
                setDrafts([...queue.current]);
            }}
            onRefresh={async () => {
                try {
                    await refresh();
                } catch (e) {
                    if (mounted.current) setError((e as Error).message);
                }
            }}
            onControl={(mode, stop, options) => control(mode, activeStage, stop, options)}
            onOperation={operation}
            onGenerate={generate}
            onAbandon={abandon}
            onUpload={upload}
        />
    );
}
