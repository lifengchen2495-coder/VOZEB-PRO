"use client";
import Link from "next/link";
import { FrameRemakeWorkflow } from "./workflow";
import { recoveredFrameRemakeWorkflowStage } from "@/lib/frame-remake-steps";
import { useCallback, useEffect, useRef, useState } from "react";
import {
    frameRemakeBusy,
    frameRemakeAnalysisResult,
    type FrameRemakeWorkflowStage,
    type FrameRemakeAnalysisStage,
    type FrameRemakeOperationKind,
    type FrameRemakeGenerationKind,
    type FrameRemakePatch,
    type FrameRemakeProject,
} from "@/lib/frame-remake-contract";
import { frameRemakeProjectPath, frameRemakeRequest, uploadFrameRemakeMedia } from "../api";
import { Button } from "../../bangbang/controls";

const roles = { product: "产品", character: "人物", background: "背景" } as const;
export function FrameRemakeWorkspace({ id }: { id: string }) {
    const [project, setProject] = useState<FrameRemakeProject>();
    const [draft, setDraft] = useState<FrameRemakePatch>({});
    const [selected, setSelected] = useState("G1");
    const [working, setWorking] = useState(false);
    const [stage, setStage] = useState<FrameRemakeWorkflowStage>();
    const [error, setError] = useState("");
    const current = useRef<FrameRemakeProject>(undefined);
    const lock = useRef(false);
    const mounted = useRef(true);
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
    useEffect(() => {
        mounted.current = true;
        let stopped = false;
        let timer: ReturnType<typeof setTimeout>;
        const poll = async () => {
            try {
                if (!lock.current) await refresh();
            } catch (error) {
                if (!stopped) setError((error as Error).message);
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
    const dirty = Object.keys(draft).length > 0;
    useEffect(() => {
        if (!dirty) return;
        const warn = (event: BeforeUnloadEvent) => event.preventDefault();
        window.addEventListener("beforeunload", warn);
        return () => window.removeEventListener("beforeunload", warn);
    }, [dirty]);
    const action = async (fn: () => Promise<unknown>) => {
        if (lock.current) return;
        lock.current = true;
        setWorking(true);
        setError("");
        try {
            await fn();
        } catch (error) {
            if (mounted.current) setError((error as Error).message);
            await refresh().catch(() => undefined);
        } finally {
            lock.current = false;
            if (mounted.current) setWorking(false);
        }
    };
    const save = () =>
        action(async () => {
            accept(await frameRemakeRequest<FrameRemakeProject>(path, { ...draft, revision: current.current!.revision }, "PATCH"));
            setDraft({});
        });
    const operation = (kind: FrameRemakeOperationKind, groupId?: string, analysisStage?: FrameRemakeAnalysisStage) =>
        action(async () => accept(await frameRemakeRequest<FrameRemakeProject>(`${path}/operations`, { revision: current.current!.revision, kind, groupId, analysisStage })));
    const control = (mode: "start" | "step" | "pause", stageScope: FrameRemakeWorkflowStage) =>
        action(async () => {
            setStage(stageScope);
            const latest = await refresh();
            accept(await frameRemakeRequest<FrameRemakeProject>(`${path}/run`, { revision: latest.revision, action: mode, stageScope }));
        });
    const generate = (groupId: string, kind: FrameRemakeGenerationKind) => action(async () => accept(await frameRemakeRequest<FrameRemakeProject>(`${path}/groups/${groupId}/${kind}`, { revision: current.current!.revision })));
    const abandon = (groupId: string, kind: FrameRemakeGenerationKind) => action(async () => accept(await frameRemakeRequest<FrameRemakeProject>(`${path}/groups/${groupId}/${kind}`, undefined, "DELETE")));
    const upload = (file: File, role: keyof typeof roles | "video") =>
        action(async () => {
            const media = await uploadFrameRemakeMedia(id, file);
            const latest = await refresh();
            const patch = role === "video" ? { sourceVideo: media } : { references: { ...latest.references, [role]: [...latest.references[role], media] } };
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
    const busy = frameRemakeBusy(project);
    const editingDisabled = working || busy || project.automation?.status === "running";
    const display = { ...project, ...draft } as FrameRemakeProject;
    const selectedGroup = project.groups.find((group) => group.id === selected) || project.groups[0];
    const group = selectedGroup && draft.group?.id === selectedGroup.id ? { ...selectedGroup, ...draft.group } : selectedGroup;
    const activeStage = stage ?? recoveredFrameRemakeWorkflowStage(project);
    const change = (patch: FrameRemakePatch) => setDraft((current) => ({ ...current, ...patch }));
    const editGroup = (key: FrameRemakeAnalysisStage, value: string) =>
        group && change({ group: { id: group.id, analysis: group.analysis, productScript: frameRemakeAnalysisResult(group, "productScript"), imagePrompt: group.imagePrompt, videoPrompt: group.videoPrompt, [key]: value } });
    return (
        <FrameRemakeWorkflow
            project={project}
            display={display}
            group={group}
            stage={activeStage}
            dirty={dirty}
            working={working}
            editingDisabled={editingDisabled}
            disabled={editingDisabled || dirty}
            error={error}
            onStage={setStage}
            onGroup={(id) => {
                if (!draft.group) setSelected(id);
            }}
            groupLocked={Boolean(draft.group)}
            onChange={change}
            onEditGroup={editGroup}
            onSave={save}
            onDiscard={() => setDraft({})}
            onRefresh={() => action(refresh)}
            onControl={(mode) => control(mode, activeStage)}
            onOperation={operation}
            onGenerate={generate}
            onAbandon={abandon}
            onUpload={upload}
        />
    );
}
