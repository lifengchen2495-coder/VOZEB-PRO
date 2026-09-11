"use client";

import { useEffect, useRef, useState } from "react";
import { Alert, App, Button, Form, Input, InputNumber, Select, Tag } from "antd";
import { ArrowRight, Pencil, Plus, Sparkles, Trash2 } from "lucide-react";
import { nanoid } from "nanoid";

import type { DramaEpisode, DramaProject } from "@/lib/drama-project-contract";
import { dramaWorkflowArtifactIsStale, dramaWorkflowFingerprint, latestDramaWorkflowArtifact } from "@/lib/drama-workflow";
import { DramaWorkflowMergeConflict, mergeDramaWorkflowArtifactResult } from "@/lib/drama-workflow-response";
import type { DramaWorkflowArtifact, DramaWorkflowStage } from "@/lib/drama-workflow-contract";
import type { DramaWorkflowRequest } from "@/lib/drama-workflow-request";
import { requestDramaWorkflow } from "@/services/api/drama-projects";
import { useUserStore } from "@/stores/use-user-store";
import { useDramaStore } from "../stores/use-drama-store";
import type { DramaProjectStage } from "./drama-project-sections";
import { DramaWorkflowResult } from "./drama-workflow-result";

const labels: Record<DramaWorkflowStage, string> = { story: "故事理解", characters: "人物小传", beats: "节奏设计", script: "详细改编剧本" };
const descriptions: Record<DramaWorkflowStage, string> = {
    story: "从剧本中提取故事梗概、核心冲突、世界观和关键事实。",
    characters: "按人物小传 Skill 完整创作人物背景、动机、关系和成长弧线，展示改编补充与检查结果。",
    beats: "按爽点与节奏设计 Skill 编排本集冲突、情绪递进、反转和钩子。",
    script: "按详细写作 Skill 将原稿、人物小传和节奏方案改编成可拍摄剧本。采用后用于拆镜，原稿独立保留。",
};
// 保留页面内切换阶段或剧集时尚未保存的编辑，按用户隔离。
const draftCache = new Map<string, { data: unknown; selectedId: string; instructions: string }>();

type WorkflowAction = "analyze" | "generate" | "save" | "adopt";

export function DramaWorkflowPanel({
    project,
    episode,
    stage,
    busy: pipelineBusy = false,
    textModel,
    textModelReady = true,
    onAnalysisBusyChange,
    onStageChange,
    onAdoptingChange,
    onContinue,
}: {
    project: DramaProject;
    episode: DramaEpisode;
    stage: DramaWorkflowStage;
    busy?: boolean;
    textModel?: string;
    textModelReady?: boolean;
    onAnalysisBusyChange?: (busy: boolean) => void;
    onStageChange: (stage: DramaProjectStage) => void;
    onAdoptingChange: (busy: boolean) => void;
    onContinue?: () => void;
}) {
    const { message } = App.useApp();
    const [form] = Form.useForm();
    const scope = stage === "beats" || stage === "script" ? episode.id : undefined;
    const analysisStage = stage === "story";
    const targetIntent = analysisStage ? "analysis" : "creation";
    const userId = useUserStore((state) => state.user?.id);
    const cacheKey = `${userId}:${project.id}:${stage}:${targetIntent}:${scope || "project"}`;
    const cached = useRef(draftCache.get(cacheKey));
    const artifacts = (project.workflow?.artifacts || []).filter((item) => item.stage === stage && item.episodeId === scope).toSorted((a, b) => b.version - a.version);
    const defaultArtifact = artifacts.find((item) => (item.intent || "creation") === targetIntent) || artifacts[0];
    const [selectedId, setSelectedId] = useState(cached.current?.selectedId || defaultArtifact?.id || "");
    const selected = artifacts.find((item) => item.id === selectedId) || defaultArtifact;
    const selectedSkill = selected && "skill" in selected.data ? selected.data.skill : undefined;
    const adopted = latestDramaWorkflowArtifact(project, stage, scope, "adopted", targetIntent);
    const [instructions, setInstructions] = useState(cached.current?.instructions || "");
    const [busy, setBusy] = useState<WorkflowAction | null>(null);
    const actionDisabled = Boolean(busy) || pipelineBusy;
    const [dirty, setDirty] = useState(Boolean(cached.current));
    const [editing, setEditing] = useState(Boolean(cached.current));
    const edits = useRef(0);
    const active = useRef(true);
    const running = useRef(false);
    const initialValues = useRef(cached.current?.data || selected?.data || defaultValues(project, episode, stage));
    const isStale = selected && dramaWorkflowArtifactIsStale(project, selected);
    const adoptedIsStale = adopted && dramaWorkflowArtifactIsStale(project, adopted);
    const hasScript = scope ? Boolean(episode.script.trim()) : project.episodes.some((item) => item.script.trim());
    useEffect(() => {
        active.current = true;
        return () => { active.current = false; };
    }, []);
    useEffect(() => {
        if (!dirty) return;
        const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
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
        setEditing(false);
    };
    const run = async (action: WorkflowAction) => {
        if (actionDisabled || running.current) return;
        const generates = action === "analyze" || action === "generate";
        if (generates && !textModelReady) return message.warning("请先选择可用的文本模型");
        running.current = true;
        setBusy(action);
        if (generates) onAnalysisBusyChange?.(true);
        if (action === "adopt") onAdoptingChange(true);
        const editRevision = edits.current;
        const hadEdits = dirty;
        const intent = action === "analyze" ? "analysis" : action === "generate" ? targetIntent : selected?.intent || targetIntent;
        const formData = form.getFieldsValue(true);
        const data = action === "save" || (action === "generate" && dirty) ? { ...selected?.data, ...formData, ...(selectedSkill ? { skill: { ...selectedSkill, ...formData.skill } } : {}) } : undefined;
        try {
            const store = useDramaStore.getState();
            const snapshot = await store.flushProject(project.id);
            const expectedInput = dramaWorkflowFingerprint(snapshot, stage, scope, intent);
            let request: DramaWorkflowRequest;
            if (action === "adopt") request = { action, artifactId: selected!.id, expectedInput };
            else if (action === "analyze") {
                if (stage === "script") throw new Error("请在剧本入口开始原稿分析");
                request = { action, stage, episodeId: scope, expectedInput, requestId: nanoid(), instructions, textModel };
            } else request = { action, stage, episodeId: scope, data, instructions, intent, expectedInput, requestId: nanoid() };
            if (request.action === "generate") request.textModel = textModel;
            const result = await requestDramaWorkflow(project.id, request);
            if (useUserStore.getState().user?.id !== userId) return;
            let mergeConflict: DramaWorkflowMergeConflict | undefined;
            store.mutateWorkflowProject(project.id, (current) => {
                try {
                    return mergeDramaWorkflowArtifactResult(current, result.artifact);
                } catch (error) {
                    if (!(error instanceof DramaWorkflowMergeConflict)) throw error;
                    mergeConflict = error;
                    return error.project;
                }
            });
            await store.flushProject(project.id);
            if (mergeConflict) throw mergeConflict;
            if (active.current) {
                const keepEdits = editRevision !== edits.current || (hadEdits && (action === "analyze" || action === "generate"));
                if (!keepEdits) showArtifact(result.artifact);
                message.success(keepEdits ? "新结果已保存到历史列表，当前编辑内容已保留" : result.artifact.status === "adopted" ? "结果已保存并应用" : result.artifact.intent === "analysis" ? "分析结果已保存，原稿有变化，请复核后再应用" : "完整候选稿已保存，请检查后采用");
            }
        } catch (error) {
            message.error(error instanceof Error ? error.message : "分析操作失败");
        } finally {
            running.current = false;
            if (active.current) setBusy(null);
            if (generates) onAnalysisBusyChange?.(false);
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
                <div className="flex flex-wrap items-center gap-2">
                    <Tag color={adopted ? (adoptedIsStale ? "orange" : "green") : "default"}>{adopted ? (adoptedIsStale ? `已应用 v${adopted.version} · 待复核` : `已应用 v${adopted.version}`) : "尚无采用稿"}</Tag>
                    <Button icon={<Sparkles className="size-4" />} loading={busy === "analyze" || busy === "generate"} disabled={actionDisabled || !textModelReady || !hasScript} onClick={() => void run(analysisStage ? "analyze" : "generate")}>
                        {analysisStage ? selected ? "AI 重新分析" : "AI 分析这一阶段" : "按 Skill 生成完整候选稿"}
                    </Button>
                </div>
            </div>
            <p className="text-xs text-muted-foreground">{scope ? `当前集：${episode.title}` : "基于全剧原稿"}</p>
            {isStale ? <Alert type="warning" showIcon title="原稿或上游分析已有变化" description="本版本保留供对照，请重新分析或修订后保存；已有镜头和媒体仍然保留。" /> : null}
            {selected ? (
                <>
                    <div className="flex flex-wrap items-center gap-2">
                        <Select
                            className="min-w-52 flex-1"
                            aria-label="创作与分析历史"
                            value={selected.id}
                            disabled={Boolean(busy)}
                            options={artifacts.map((item) => ({ value: item.id, label: `v${item.version} · ${item.intent === "analysis" ? "原稿分析" : "skill" in item.data && item.data.skill ? "Skill 创作" : "旧创作稿"} · ${item.source === "ai" ? "AI" : "手动修订"} · ${item.status === "adopted" ? "已应用" : "待确认"}${dramaWorkflowArtifactIsStale(project, item) ? " · 待复核" : ""}` }))}
                            onChange={(id) => {
                                if (dirty && !window.confirm("当前编辑尚未保存，确定切换分析结果？")) return;
                                const artifact = artifacts.find((item) => item.id === id);
                                if (artifact) showArtifact(artifact);
                            }}
                        />
                        {dirty ? <Tag color="blue">编辑尚未保存</Tag> : null}
                        {!editing ? <Button icon={<Pencil className="size-4" />} disabled={actionDisabled} onClick={() => { form.resetFields(); form.setFieldsValue(selected.data); setEditing(true); }}>高级修订</Button> : null}
                        {selected.status !== "adopted" && (selected.intent || "creation") === targetIntent ? <Button type="primary" loading={busy === "adopt"} disabled={actionDisabled || Boolean(isStale) || dirty} onClick={() => void run("adopt")}>采用此结果</Button> : null}
                    </div>
                    {!analysisStage && (selected.intent === "analysis" || !selectedSkill) ? <Alert type="info" showIcon title="这是旧版结果" description="可保留对照；点击按 Skill 生成完整候选稿，获取完整创作报告。" /> : null}
                    {!editing ? <DramaWorkflowResult artifact={selected} /> : null}
                </>
            ) : (
                <div className="rounded-md bg-muted/30 px-4 py-8 text-center" data-drama-analysis-empty>
                    <p className="text-sm font-medium">完成后，这里会展示{labels[stage]}完整结果</p>
                    <p className="mt-2 text-sm text-muted-foreground">提供原稿后即可让 AI 执行，无需逐项填写。每一步可审阅、修订和采用。</p>
                    <Button className="mt-4" icon={<ArrowRight className="size-4" />} onClick={() => onStageChange("script")}>返回原稿</Button>
                </div>
            )}
            <div hidden={!editing}>
                <Form
                    form={form}
                    layout="vertical"
                    initialValues={initialValues.current}
                    disabled={busy === "adopt" || busy === "save"}
                    onValuesChange={() => {
                        edits.current++;
                        markDirty(true);
                        draftCache.set(cacheKey, { data: form.getFieldsValue(true), selectedId: selected?.id || "", instructions });
                    }}
                >
                    {selectedSkill ? <Form.Item name={["skill", "document"]} label="完整 Skill 报告"><Input.TextArea aria-label="完整 Skill 报告" autoSize={{ minRows: 12, maxRows: 30 }} /></Form.Item> : null}
                    {stage === "script" && selected?.stage === "script" && selected.data.screenplay ? <Form.Item name="screenplay" label="改编剧本正文"><Input.TextArea aria-label="改编剧本正文" autoSize={{ minRows: 12, maxRows: 30 }} /></Form.Item> : null}
                    <details><summary className="mb-3 cursor-pointer text-sm">高级结构字段（可选）</summary><WorkflowFields stage={stage} analysis={selected?.intent === "analysis"} /></details>
                </Form>
                <div className="mt-3 flex flex-wrap gap-2">
                    <Button type="primary" loading={busy === "save"} disabled={actionDisabled} onClick={() => void run("save")}>{selected?.intent === "analysis" ? "保存修订" : "保存为新候选"}</Button>
                    <Button disabled={actionDisabled} onClick={() => { if (dirty && !window.confirm("当前修订尚未保存，确定放弃修订？")) return; if (selected) showArtifact(selected); else { markDirty(false); setEditing(false); } }}>取消编辑</Button>
                </div>
            </div>
            <details className="border-t border-border pt-3">
                <summary className="cursor-pointer text-xs text-muted-foreground">{analysisStage ? "补充分析要求（可选）" : "补充要求 / 改写范围"}</summary>
                <Input.TextArea
                    className="mt-3"
                    aria-label="补充分析要求"
                    value={instructions}
                    maxLength={10000}
                    autoSize={{ minRows: 2, maxRows: 6 }}
                    onChange={(event) => {
                        setInstructions(event.target.value);
                        const draft = draftCache.get(cacheKey);
                        if (draft) draftCache.set(cacheKey, { ...draft, instructions: event.target.value });
                    }}
                    placeholder={analysisStage ? "例如：重点梳理人物之间的利益关系，原稿没有明确的信息请标注。" : "例如：保留结尾，只加强第二场冲突。"}
                />
            </details>
            {selected && !editing ? <div className="flex flex-wrap gap-2"><Button type="text" disabled={actionDisabled} onClick={() => onStageChange("script")}>返回原稿</Button>{adopted && !adoptedIsStale ? <Button icon={<ArrowRight className="size-4" />} disabled={actionDisabled} onClick={() => stage === "script" && onContinue ? onContinue() : onStageChange(stage === "story" ? "characters" : stage === "characters" ? "beats" : stage === "beats" ? "adapted-script" : "storyboard")}>{stage === "script" ? "继续生成分镜与提示词" : "查看下一阶段"}</Button> : null}</div> : null}
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

function WorkflowFields({ stage, analysis }: { stage: DramaWorkflowStage; analysis?: boolean }) {
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
                    <Form.Item name="adaptationMode" label="创作方式" hidden={analysis}>
                        <Select
                            aria-label="创作方式"
                            options={[
                                { value: "original", label: "原创" },
                                { value: "faithful", label: "忠实改编" },
                                { value: "free", label: "自由改编" },
                            ]}
                        />
                    </Form.Item>
                    <Form.Item name="targetDuration" label={analysis ? "单集时长（秒，未标注可留空）" : "单集目标时长（秒）"}>
                        <InputNumber aria-label={analysis ? "单集时长（秒，未标注可留空）" : "单集目标时长（秒）"} min={1} className="!w-full" />
                    </Form.Item>
                    <Form.Item name="episodeCount" label={analysis ? "当前剧集数" : "计划集数"}>
                        <InputNumber aria-label={analysis ? "当前剧集数" : "计划集数"} disabled={analysis} min={1} precision={0} className="!w-full" />
                    </Form.Item>
                </div>
                {!analysis ? <p className="mb-4 text-xs text-muted-foreground">目标时长与计划集数用于创作规划。剧集可在左侧按需添加。</p> : null}
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
                                        <Form.Item name={[field.name, "duration"]} label={analysis ? "时长（秒，未标注可留空）" : "预计时长（秒）"}>
                                            <InputNumber aria-label={analysis ? "时长（秒，未标注可留空）" : "预计时长（秒）"} min={1} />
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
