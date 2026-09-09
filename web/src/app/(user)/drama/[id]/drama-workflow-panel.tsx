"use client";

import { useEffect, useRef, useState } from "react";
import { Alert, App, Button, Form, Input, InputNumber, Select, Tag } from "antd";
import { ArrowRight, Plus, Sparkles, Trash2 } from "lucide-react";
import { nanoid } from "nanoid";

import type { DramaEpisode, DramaProject } from "@/lib/drama-project-contract";
import { adoptDramaWorkflowArtifact, appendDramaWorkflowArtifact, dramaWorkflowArtifactIsStale, dramaWorkflowFingerprint, latestDramaWorkflowArtifact } from "@/lib/drama-workflow";
import type { DramaWorkflowArtifact, DramaWorkflowStage } from "@/lib/drama-workflow-contract";
import { requestDramaWorkflow } from "@/services/api/drama-projects";
import { useUserStore } from "@/stores/use-user-store";
import { useDramaStore } from "../stores/use-drama-store";
import type { DramaProjectStage } from "./drama-project-sections";

const labels: Record<DramaWorkflowStage, string> = { story: "故事设定", characters: "人物小传", beats: "分集节奏", script: "剧本创作" };
const nextStages: Record<DramaWorkflowStage, DramaProjectStage> = { story: "characters", characters: "beats", beats: "script", script: "review" };
const descriptions: Record<DramaWorkflowStage, string> = {
    story: "确定故事方向、改编方式与不可改动的事实，供全剧共用。",
    characters: "完善人物动机、关系和成长，采用后同步到项目角色。",
    beats: "为当前集安排铺垫、冲突、转折和钩子，再展开详细剧本。",
    script: "按场次编辑动作、对白和旁白，采用后同步到下方剧本正文。",
};
// 保留页面内切换阶段或剧集时尚未保存的编辑，按用户隔离。
const draftCache = new Map<string, { data: unknown; selectedId: string; instructions: string }>();

export function DramaWorkflowPanel({
    project,
    episode,
    stage,
    onStageChange,
    onAdoptingChange,
}: {
    project: DramaProject;
    episode: DramaEpisode;
    stage: DramaWorkflowStage;
    onStageChange: (stage: DramaProjectStage) => void;
    onAdoptingChange: (busy: boolean) => void;
}) {
    const { message } = App.useApp();
    const [form] = Form.useForm();
    const scope = stage === "beats" || stage === "script" ? episode.id : undefined;
    const userId = useUserStore((state) => state.user?.id);
    const cacheKey = `${userId}:${project.id}:${stage}:${scope || "project"}`;
    const cached = useRef(draftCache.get(cacheKey));
    const artifacts = (project.workflow?.artifacts || []).filter((item) => item.stage === stage && item.episodeId === scope).toSorted((a, b) => b.version - a.version);
    const [selectedId, setSelectedId] = useState(cached.current?.selectedId || artifacts[0]?.id || "");
    const selected = artifacts.find((item) => item.id === selectedId);
    const adopted = latestDramaWorkflowArtifact(project, stage, scope, "adopted");
    const [instructions, setInstructions] = useState(cached.current?.instructions || "");
    const [busy, setBusy] = useState<"generate" | "save" | "adopt" | null>(null);
    const [dirty, setDirty] = useState(Boolean(cached.current));
    const edits = useRef(0);
    const active = useRef(true);
    const initialValues = useRef(cached.current?.data || selected?.data || defaultValues(project, episode, stage));
    const isStale = selected && dramaWorkflowArtifactIsStale(project, selected);
    const adoptedIsStale = adopted && dramaWorkflowArtifactIsStale(project, adopted);
    useEffect(() => {
        active.current = true;
        return () => {
            active.current = false;
        };
    }, []);
    useEffect(() => {
        if (!dirty) return;
        const warn = (event: BeforeUnloadEvent) => {
            event.preventDefault();
            event.returnValue = "";
        };
        window.addEventListener("beforeunload", warn);
        return () => window.removeEventListener("beforeunload", warn);
    }, [dirty]);

    const markDirty = (value: boolean) => {
        setDirty(value);
        if (!value) draftCache.delete(cacheKey);
    };
    const showArtifact = (artifact: DramaWorkflowArtifact) => {
        form.resetFields();
        form.setFieldsValue(artifact.data);
        setSelectedId(artifact.id);
        markDirty(false);
    };
    const run = async (action: "generate" | "save" | "adopt") => {
        setBusy(action);
        if (action === "adopt") onAdoptingChange(true);
        const editRevision = edits.current;
        const data = form.getFieldsValue(true);
        try {
            const store = useDramaStore.getState();
            const snapshot = await store.flushProject(project.id);
            const result = await requestDramaWorkflow(
                project.id,
                action === "adopt"
                    ? { action, artifactId: selectedId, expectedInput: dramaWorkflowFingerprint(snapshot, stage, scope) }
                    : { action, stage, episodeId: scope, data, instructions, expectedInput: dramaWorkflowFingerprint(snapshot, stage, scope), requestId: nanoid() },
            );
            if (useUserStore.getState().user?.id !== userId) return;
            // 候选只追加产物；采用在最新本地项目上执行，保留异步完成的媒体结果。
            store.mutateWorkflowProject(project.id, (current) => {
                if (action === "adopt") return adoptDramaWorkflowArtifact(current, result.artifact.id);
                if (current.workflow?.artifacts.some((item) => item.id === result.artifact.id)) return current;
                return appendDramaWorkflowArtifact(current, { ...result.artifact, status: "candidate", adoptedFingerprint: undefined });
            });
            await store.flushProject(project.id);
            if (active.current) {
                if (editRevision === edits.current) showArtifact(result.artifact);
                message.success(action === "adopt" ? "已采用，并更新相关创作内容" : editRevision === edits.current ? "候选稿已保存，请检查后采用" : "新候选已保存到版本列表，当前编辑内容已保留");
            }
        } catch (error) {
            message.error(error instanceof Error ? error.message : "创作操作失败");
        } finally {
            if (active.current) setBusy(null);
            if (action === "adopt") onAdoptingChange(false);
        }
    };

    return (
        <div className="mb-4 space-y-4 rounded-lg border border-border bg-card p-4 sm:p-5" data-drama-workflow={stage}>
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                    <h2 className="text-base font-semibold">{labels[stage]}</h2>
                    <p className="mt-1 text-sm text-muted-foreground">{descriptions[stage]}</p>
                </div>
                <Tag color={adopted ? (adoptedIsStale ? "orange" : "green") : "default"}>{adopted ? (adoptedIsStale ? `已采用 v${adopted.version} · 待复核` : `已采用 v${adopted.version}`) : "尚未采用"}</Tag>
            </div>
            {stage === "story" || stage === "characters" ? <p className="text-xs text-muted-foreground">全剧共用 · 采用修改会提醒各集复核下游内容。</p> : <p className="text-xs text-muted-foreground">当前集：{episode.title}</p>}
            {isStale ? <Alert type="warning" showIcon title="本稿所依据的内容已改变" description="请核对当前故事、人物和本集内容。修订后保存为新候选，再决定是否采用；已有镜头和媒体保留。" /> : null}
            <div className="flex flex-wrap items-center gap-2">
                <Select
                    className="min-w-52 flex-1"
                    aria-label="创作版本"
                    placeholder="暂无候选稿"
                    value={selectedId || undefined}
                    disabled={Boolean(busy)}
                    options={artifacts.map((item) => ({
                        value: item.id,
                        label: `v${item.version} · ${item.source === "ai" ? "AI" : "手动"} · ${item.status === "adopted" ? "已采用" : "候选"}${dramaWorkflowArtifactIsStale(project, item) ? " · 待复核" : ""}`,
                    }))}
                    onChange={(id) => {
                        if (dirty && !window.confirm("当前编辑尚未保存，确定切换候选稿？")) return;
                        const artifact = artifacts.find((item) => item.id === id);
                        if (artifact) showArtifact(artifact);
                    }}
                />
                {dirty ? <Tag color="blue">编辑尚未保存</Tag> : null}
                <Button loading={busy === "save"} disabled={Boolean(busy)} onClick={() => void run("save")}>
                    保存为新候选
                </Button>
                <Button type="primary" loading={busy === "adopt"} disabled={Boolean(busy) || !selected || selected.status === "adopted" || Boolean(isStale) || dirty} onClick={() => void run("adopt")}>
                    采用此稿
                </Button>
            </div>
            <Form
                form={form}
                layout="vertical"
                initialValues={initialValues.current}
                disabled={busy === "adopt" || busy === "save"}
                onValuesChange={() => {
                    edits.current++;
                    markDirty(true);
                    draftCache.set(cacheKey, { data: form.getFieldsValue(true), selectedId, instructions });
                }}
            >
                <WorkflowFields stage={stage} />
            </Form>
            <div className="border-t border-border pt-4">
                <label className="mb-2 block text-sm font-medium" htmlFor={`drama-instructions-${stage}`}>
                    补充要求 / 改写范围
                </label>
                <Input.TextArea
                    id={`drama-instructions-${stage}`}
                    value={instructions}
                    maxLength={10000}
                    autoSize={{ minRows: 2, maxRows: 6 }}
                    onChange={(event) => {
                        setInstructions(event.target.value);
                        const draft = draftCache.get(cacheKey);
                        if (draft) draftCache.set(cacheKey, { ...draft, instructions: event.target.value });
                    }}
                    placeholder="例如：本集控制在 90 秒；保留结尾，只加强第二场冲突。"
                />
                <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                    <Button icon={<Sparkles className="size-4" />} loading={busy === "generate"} disabled={Boolean(busy)} onClick={() => void run("generate")}>
                        AI 生成候选稿
                    </Button>
                    {stage !== "script" ? (
                        <Button icon={<ArrowRight className="size-4" />} disabled={Boolean(busy) || dirty} onClick={() => onStageChange(nextStages[stage])}>
                            继续：{labels[nextStages[stage] as DramaWorkflowStage]}
                        </Button>
                    ) : (
                        <span className="text-xs text-muted-foreground">采用后，可在正文继续编辑并提取分镜内容。</span>
                    )}
                </div>
                <p className="mt-2 text-xs text-muted-foreground">AI 使用默认文本模型并按系统规则计费；生成结果保存为候选，采用后才更新正文和资产。</p>
            </div>
        </div>
    );
}

const textFields = (fields: Array<[string, string]>, path: (string | number)[] = []) =>
    fields.map(([name, label]) => (
        <Form.Item key={name} name={[...path, name]} label={label}>
            <Input.TextArea aria-label={label} autoSize={{ minRows: 2, maxRows: 8 }} />
        </Form.Item>
    ));
const idField = (path: (string | number)[]) => (
    <Form.Item name={[...path, "id"]} hidden>
        <Input />
    </Form.Item>
);

function WorkflowFields({ stage }: { stage: DramaWorkflowStage }) {
    if (stage === "story")
        return (
            <>
                {textFields([
                    ["logline", "故事梗概"],
                    ["coreConflict", "核心冲突"],
                ])}
                <div className="grid gap-x-4 sm:grid-cols-2">
                    {textFields([
                        ["genre", "类型与主题"],
                        ["audience", "目标受众"],
                    ])}
                </div>
                {textFields([
                    ["worldRules", "世界观与规则"],
                    ["lockedFacts", "锁定事实（改编时必须遵守）"],
                ])}
                <div className="grid gap-x-4 sm:grid-cols-3">
                    <Form.Item name="adaptationMode" label="创作方式">
                        <Select
                            aria-label="创作方式"
                            options={[
                                { value: "original", label: "原创" },
                                { value: "faithful", label: "忠实改编" },
                                { value: "free", label: "自由改编" },
                            ]}
                        />
                    </Form.Item>
                    <Form.Item name="targetDuration" label="单集目标时长（秒）">
                        <InputNumber aria-label="单集目标时长（秒）" min={1} className="!w-full" />
                    </Form.Item>
                    <Form.Item name="episodeCount" label="计划集数">
                        <InputNumber aria-label="计划集数" min={1} precision={0} className="!w-full" />
                    </Form.Item>
                </div>
                <p className="mb-4 text-xs text-muted-foreground">目标时长与计划集数用于创作规划。剧集可在左侧按需添加。</p>
            </>
        );
    if (stage === "characters")
        return (
            <Form.List name="characters">
                {(fields, { add, remove }) => (
                    <>
                        {fields.map((field, index) => (
                            <div key={field.key} className="mb-4 rounded-md border border-border p-3">
                                <div className="mb-3 flex items-center justify-between">
                                    <span className="text-sm font-medium">人物 {index + 1}</span>
                                    <Button type="text" aria-label={`移除人物 ${index + 1}`} icon={<Trash2 className="size-4" />} onClick={() => remove(field.name)} />
                                </div>
                                {idField([field.name])}
                                <div className="grid gap-x-4 sm:grid-cols-2">
                                    <Form.Item name={[field.name, "name"]} label="姓名">
                                        <Input aria-label="姓名" />
                                    </Form.Item>
                                    <Form.Item name={[field.name, "aliases"]} label="别名">
                                        <Select mode="tags" aria-label="别名" tokenSeparators={[",", "，"]} />
                                    </Form.Item>
                                    {textFields(
                                        [
                                            ["role", "身份 / 角色定位"],
                                            ["background", "背景"],
                                            ["motivation", "动机与目标"],
                                            ["personality", "性格与弱点"],
                                            ["relationships", "人物关系"],
                                            ["arc", "成长弧线"],
                                            ["visualIdentity", "稳定外貌"],
                                            ["voiceStyle", "声音与说话方式"],
                                            ["signatureAction", "标志动作"],
                                        ],
                                        [field.name],
                                    )}
                                </div>
                            </div>
                        ))}
                        <Button block type="dashed" icon={<Plus className="size-4" />} onClick={() => add({ id: `character-${nanoid()}`, aliases: [] })}>
                            添加人物
                        </Button>
                    </>
                )}
            </Form.List>
        );
    if (stage === "beats")
        return (
            <>
                {textFields([
                    ["outline", "本集大纲"],
                    ["hook", "结尾钩子"],
                    ["nextPreview", "下集承接"],
                ])}
                <Form.List name="beats">
                    {(fields, { add, remove, move }) => (
                        <>
                            {fields.map((field, index) => (
                                <div key={field.key} className="mb-4 rounded-md border border-border p-3">
                                    <div className="mb-3 flex items-center justify-between">
                                        <span className="text-sm font-medium">节拍 {index + 1}</span>
                                        <div className="flex gap-1">
                                            <Button size="small" disabled={!index} onClick={() => move(index, index - 1)}>
                                                上移
                                            </Button>
                                            <Button size="small" onClick={() => remove(field.name)}>
                                                移除
                                            </Button>
                                        </div>
                                    </div>
                                    {idField([field.name])}
                                    <div className="grid gap-x-4 sm:grid-cols-2">
                                        <Form.Item name={[field.name, "title"]} label="节拍标题">
                                            <Input aria-label="节拍标题" />
                                        </Form.Item>
                                        <Form.Item name={[field.name, "duration"]} label="预计时长（秒）">
                                            <InputNumber aria-label="预计时长（秒）" min={1} />
                                        </Form.Item>
                                    </div>
                                    {textFields(
                                        [
                                            ["description", "剧情事件"],
                                            ["emotion", "情绪变化"],
                                            ["payoff", "伏笔 / 爽点 / 回收"],
                                        ],
                                        [field.name],
                                    )}
                                </div>
                            ))}
                            <Button block type="dashed" icon={<Plus className="size-4" />} onClick={() => add({ id: `beat-${nanoid()}`, duration: 15 })}>
                                添加节拍
                            </Button>
                        </>
                    )}
                </Form.List>
            </>
        );
    return (
        <Form.List name="scenes">
            {(fields, { add, remove, move }) => (
                <>
                    {fields.map((field, index) => (
                        <div key={field.key} className="mb-4 rounded-md border border-border p-3">
                            <div className="mb-3 flex items-center justify-between">
                                <span className="text-sm font-medium">第 {index + 1} 场</span>
                                <div className="flex gap-1">
                                    <Button size="small" disabled={!index} onClick={() => move(index, index - 1)}>
                                        上移
                                    </Button>
                                    <Button size="small" onClick={() => remove(field.name)}>
                                        移除场次
                                    </Button>
                                </div>
                            </div>
                            {idField([field.name])}
                            <div className="grid gap-x-4 sm:grid-cols-2">
                                {[
                                    ["title", "场次标题"],
                                    ["location", "地点 / 内外景"],
                                    ["time", "时间"],
                                    ["lighting", "光线"],
                                ].map(([name, label]) => (
                                    <Form.Item key={name} name={[field.name, name]} label={label}>
                                        <Input aria-label={label} />
                                    </Form.Item>
                                ))}
                            </div>
                            <Form.List name={[field.name, "blocks"]}>
                                {(blocks, operations) => (
                                    <>
                                        {blocks.map((block, blockIndex) => (
                                            <div key={block.key} className="mb-3 border-l-2 border-border pl-3">
                                                {idField([block.name])}
                                                <div className="flex flex-wrap gap-x-3">
                                                    <Form.Item name={[block.name, "type"]} label="段落类型">
                                                        <Select
                                                            className="!w-28"
                                                            aria-label="段落类型"
                                                            options={[
                                                                { value: "action", label: "动作" },
                                                                { value: "dialogue", label: "对白" },
                                                                { value: "narration", label: "旁白" },
                                                            ]}
                                                        />
                                                    </Form.Item>
                                                    <Form.Item name={[block.name, "speaker"]} label="说话人（对白必填）">
                                                        <Input aria-label="说话人" />
                                                    </Form.Item>
                                                </div>
                                                <Form.Item name={[block.name, "text"]} label={`第 ${blockIndex + 1} 段内容`}>
                                                    <Input.TextArea aria-label={`第 ${blockIndex + 1} 段内容`} autoSize={{ minRows: 2, maxRows: 10 }} />
                                                </Form.Item>
                                                <div className="flex gap-2">
                                                    <Button size="small" disabled={!blockIndex} onClick={() => operations.move(blockIndex, blockIndex - 1)}>
                                                        上移段落
                                                    </Button>
                                                    <Button size="small" onClick={() => operations.remove(block.name)}>
                                                        移除段落
                                                    </Button>
                                                </div>
                                            </div>
                                        ))}
                                        <Button type="dashed" onClick={() => operations.add({ id: `block-${nanoid()}`, type: "action", speaker: "", text: "" })}>
                                            添加动作 / 对白 / 旁白
                                        </Button>
                                    </>
                                )}
                            </Form.List>
                        </div>
                    ))}
                    <Button block type="dashed" icon={<Plus className="size-4" />} onClick={() => add({ id: `scene-${nanoid()}`, blocks: [{ id: `block-${nanoid()}`, type: "action", speaker: "", text: "" }] })}>
                        添加场次
                    </Button>
                </>
            )}
        </Form.List>
    );
}

function defaultValues(project: DramaProject, episode: DramaEpisode, stage: DramaWorkflowStage) {
    if (stage === "story") return { logline: project.summary, genre: "", audience: "", coreConflict: "", worldRules: "", lockedFacts: "", adaptationMode: "original", targetDuration: 90, episodeCount: project.episodes.length || 1 };
    if (stage === "characters")
        return {
            characters: project.characters.length
                ? project.characters.map((character) => ({ id: character.id, name: character.name, aliases: [], background: character.description, visualIdentity: character.profile?.visualIdentity || "" }))
                : [{ name: "", aliases: [] }],
        };
    if (stage === "beats") return { outline: episode.outline || "", hook: episode.hook || "", nextPreview: episode.nextPreview || "", beats: [{ id: `beat-${nanoid()}`, title: "", duration: 15, description: "", emotion: "", payoff: "" }] };
    return { scenes: [{ id: `scene-${nanoid()}`, title: episode.title, location: "", time: "", lighting: "", blocks: [{ id: `block-${nanoid()}`, type: "action", speaker: "", text: episode.script }] }] };
}
