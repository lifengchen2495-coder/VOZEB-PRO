"use client";

import { Alert, App, Button, Checkbox, Input, Select } from "antd";
import { ArrowLeft, Clapperboard, ListTree, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { normalizeCommerceVideoWorkflowInput, type CommerceVideoMaterial, type CommerceVideoWorkflowInput } from "@/lib/commerce-video-workflow";
import { listAgentSkills, type AgentSkillSummary } from "@/services/api/agent-skills";
import { generateCommerceVideoWorkflow, type CommerceVideoWorkflowResult } from "@/services/api/commerce-video-workflow";
import { modelOptionLabel, selectableModelsByCapability, useConfigStore } from "@/stores/use-config-store";
import { WorkflowResult } from "./workflow-result";

type WorkflowForm = Omit<CommerceVideoWorkflowInput, "requestId">;
const INITIAL_FORM: WorkflowForm = { brief: "", platform: "general", durationSeconds: 15, people: "none", language: "zh", materials: [], skillId: "" };
const MATERIAL_OPTIONS: { value: CommerceVideoMaterial; label: string }[] = [
    { value: "product-images", label: "产品参考图" },
    { value: "reference-video", label: "对标视频" },
    { value: "storyboard", label: "分镜 / 九宫格图" },
    { value: "character-images", label: "人物参考图" },
    { value: "voiceover", label: "旁白文案 / 音频" },
];
const FIELD_LABEL = "mb-1.5 block text-xs font-medium";

function formFingerprint(form: WorkflowForm) {
    return JSON.stringify({ brief: form.brief.trim(), platform: form.platform, durationSeconds: form.durationSeconds, people: form.people, language: form.language, materials: [...form.materials].sort(), skillId: form.skillId, modelId: form.modelId || "" });
}

export function CommerceVideoWorkspace() {
    const { message } = App.useApp();
    const [form, setForm] = useState<WorkflowForm>(INITIAL_FORM);
    const [skills, setSkills] = useState<AgentSkillSummary[]>([]);
    const [skillsLoading, setSkillsLoading] = useState(true);
    const [skillError, setSkillError] = useState("");
    const [skillReload, setSkillReload] = useState(0);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [result, setResult] = useState<CommerceVideoWorkflowResult | null>(null);
    const [resultInput, setResultInput] = useState<CommerceVideoWorkflowInput | null>(null);
    const pendingRef = useRef<{ fingerprint: string; requestId: string } | null>(null);
    const controllerRef = useRef<AbortController | null>(null);
    const resultRef = useRef<HTMLElement>(null);
    const config = useConfigStore((state) => state.config);
    const textModels = selectableModelsByCapability(config, "text");
    const selectedSkill = skills.find((skill) => skill.id === form.skillId);
    const stale = resultInput && formFingerprint(resultInput) !== formFingerprint(form);
    const update = (patch: Partial<WorkflowForm>) => setForm((current) => ({ ...current, ...patch }));

    useEffect(() => {
        let active = true;
        setSkillsLoading(true);
        setSkillError("");
        void listAgentSkills("video").then((items) => {
            if (!active) return;
            setSkills(items);
            setForm((current) => {
                if (items.some((skill) => skill.id === current.skillId)) return current;
                const preferred = items.find((skill) => /电商.*视频|ecommerce.*video|视频.*流程/i.test(`${skill.name} ${skill.description}`));
                return { ...current, skillId: preferred?.id || items[0]?.id || "" };
            });
        }).catch((cause) => {
            if (active) setSkillError(cause instanceof Error ? cause.message : "获取视频 Skill 失败");
        }).finally(() => {
            if (active) setSkillsLoading(false);
        });
        return () => { active = false; };
    }, [skillReload]);

    useEffect(() => () => controllerRef.current?.abort(), []);

    const generate = async () => {
        if (controllerRef.current) return;
        let input: CommerceVideoWorkflowInput;
        try {
            const fingerprint = formFingerprint(form);
            if (pendingRef.current?.fingerprint !== fingerprint) pendingRef.current = { fingerprint, requestId: `video-workflow-${crypto.randomUUID()}` };
            input = normalizeCommerceVideoWorkflowInput({ ...form, requestId: pendingRef.current.requestId });
        } catch (cause) {
            message.warning(cause instanceof Error ? cause.message : "请补充视频需求");
            return;
        }
        const controller = new AbortController();
        controllerRef.current = controller;
        setBusy(true);
        setError("");
        try {
            const generated = await generateCommerceVideoWorkflow(input, controller.signal);
            if (controller.signal.aborted) return;
            setResult(generated);
            setResultInput(input);
            pendingRef.current = null;
            window.requestAnimationFrame(() => resultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
        } catch (cause) {
            if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "视频流程生成失败，请重试");
        } finally {
            if (controllerRef.current === controller) {
                controllerRef.current = null;
                setBusy(false);
            }
        }
    };

    return (
        <main className="h-full overflow-y-auto bg-background text-foreground" data-testid="commerce-video-workspace" data-ready={!skillsLoading}>
            <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-7 sm:py-8">
                <header className="mb-7 border-b border-border pb-5">
                    <Link href="/commerce" className="mb-4 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"><ArrowLeft className="size-3.5" />电商创作</Link>
                    <h1 className="flex items-center gap-2.5 text-xl font-semibold"><Clapperboard className="size-5" />视频流程生成</h1>
                    <p className="mt-2 text-sm leading-6 text-muted-foreground">描述产品和目标，让 Skill 安排脚本、分镜、素材准备与视频制作步骤。</p>
                </header>

                <div className="grid min-w-0 gap-7 lg:grid-cols-[minmax(300px,360px)_minmax(0,1fr)] lg:gap-8">
                    <form className="min-w-0 space-y-4" aria-label="视频流程需求" onSubmit={(event) => { event.preventDefault(); void generate(); }}>
                        <div>
                            <label htmlFor="video-workflow-brief" className={FIELD_LABEL}>产品与视频目标 <span className="text-muted-foreground">（必填）</span></label>
                            <Input.TextArea id="video-workflow-brief" placeholder="例如：为便携榨汁杯设计一条 TikTok 产品演示视频，突出便携和清洗方便。希望先展示使用场景，再演示操作，最后给出购买引导。" value={form.brief} maxLength={6000} showCount autoSize={{ minRows: 5, maxRows: 12 }} disabled={busy} onChange={(event) => update({ brief: event.target.value })} />
                        </div>
                        <div className="grid grid-cols-2 gap-3 pt-2">
                            <div className="min-w-0"><label htmlFor="video-workflow-duration" className={FIELD_LABEL}>目标时长</label><Select id="video-workflow-duration" className="w-full" value={form.durationSeconds} options={[15, 30, 60].map((value) => ({ value, label: `${value} 秒` }))} disabled={busy} onChange={(durationSeconds) => update({ durationSeconds })} /></div>
                            <div className="min-w-0"><label htmlFor="video-workflow-platform" className={FIELD_LABEL}>目标平台</label><Select id="video-workflow-platform" className="w-full" value={form.platform} options={[{ value: "general", label: "通用电商" }, { value: "douyin", label: "抖音" }, { value: "tiktok", label: "TikTok" }]} disabled={busy} onChange={(platform) => update({ platform })} /></div>
                            <div className="min-w-0"><label htmlFor="video-workflow-people" className={FIELD_LABEL}>人物安排</label><Select id="video-workflow-people" className="w-full" value={form.people} options={[{ value: "none", label: "无人展示" }, { value: "single", label: "单人" }, { value: "multiple", label: "多人 / 对话" }]} disabled={busy} onChange={(people) => update({ people })} /></div>
                            <div className="min-w-0"><label htmlFor="video-workflow-language" className={FIELD_LABEL}>视频文案语言</label><Select id="video-workflow-language" className="w-full" value={form.language} options={[{ value: "zh", label: "中文" }, { value: "en", label: "英文" }]} disabled={busy} onChange={(language) => update({ language })} /></div>
                        </div>
                        <fieldset className="min-w-0 border-y border-border py-4">
                            <legend className="!mb-2 !w-auto !border-0 !p-0 !text-xs !font-medium">已有素材</legend>
                            <Checkbox.Group className="!grid gap-y-2" options={MATERIAL_OPTIONS} value={form.materials} disabled={busy} onChange={(materials) => update({ materials: materials as CommerceVideoMaterial[] })} />
                            <p className="mt-3 text-xs leading-5 text-muted-foreground">按已有资料勾选即可；缺少的素材会列入流程，执行对应步骤时再上传。</p>
                        </fieldset>
                        <div>
                            <div className="mb-1.5 flex items-center justify-between gap-2"><label htmlFor="video-workflow-skill" className="text-xs font-medium">流程 Skill</label><Button type="text" size="small" aria-label="刷新视频 Skill" disabled={skillsLoading || busy} icon={<RefreshCw className="size-3" />} onClick={() => setSkillReload((value) => value + 1)} /></div>
                            <Select id="video-workflow-skill" className="w-full" placeholder="选择已启用的视频 Skill" value={form.skillId || undefined} options={skills.map((skill) => ({ value: skill.id, label: skill.name }))} loading={skillsLoading} disabled={busy || skillsLoading} onChange={(skillId) => update({ skillId })} />
                            {selectedSkill ? <p className="mt-2 text-xs leading-5 text-muted-foreground">{selectedSkill.description}</p> : null}
                            {skillError ? <p role="alert" className="mt-2 text-xs text-destructive">{skillError}，可点击刷新重试。</p> : !skillsLoading && !skills.length ? <p role="status" className="mt-2 text-xs leading-5 text-amber-700 dark:text-amber-300">暂无可用的视频 Skill。请先在系统技能库导入并启用，使用范围选择“视频”，然后刷新。</p> : null}
                        </div>
                        <div>
                            <label htmlFor="video-workflow-model" className={FIELD_LABEL}>规划模型</label>
                            <Select id="video-workflow-model" className="w-full" placeholder="使用系统默认文本模型" allowClear value={form.modelId} options={textModels.map((id) => ({ value: id, label: modelOptionLabel(config, id) }))} disabled={busy} onChange={(modelId) => update({ modelId })} />
                        </div>
                        <Button htmlType="submit" type="primary" block size="large" loading={busy} disabled={!form.brief.trim() || !form.skillId || skillsLoading || Boolean(skillError)} icon={<ListTree className="size-4" />}>{busy ? "正在规划…" : result ? "重新生成流程" : "生成视频流程"}</Button>
                        <p className="text-xs leading-5 text-muted-foreground">本次生成流程和提示词。图片、视频及剪辑按后续步骤分别执行。</p>
                        {error ? <Alert type="error" showIcon title="流程未生成" description={error} /> : null}
                    </form>

                    <section ref={resultRef} aria-label="流程输出" className="min-w-0 scroll-mt-4 border-t border-border pt-6 lg:border-l lg:border-t-0 lg:pl-8 lg:pt-0">
                        {result && resultInput ? <>
                            {stale ? <Alert type="info" showIcon className="mb-4" title="需求已修改" description="下方仍是上次生成的流程；重新生成后会应用当前需求。" /> : null}
                            <WorkflowResult result={result} input={resultInput} onChange={(workflow) => setResult((current) => current ? { ...current, workflow } : current)} />
                        </> : (
                            <div className="py-4 lg:py-8">
                                <ListTree className="mb-4 size-8 text-muted-foreground" />
                                <h2 className="text-base font-semibold">先排清流程，再逐步制作</h2>
                                <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">原创产品展示、对标拆解换品、九宫格转视频都可以从这里开始。Skill 会根据你的目标和素材组织适用步骤。</p>
                                <ol className="mt-6 divide-y divide-border text-sm">
                                    {[
                                        ["路线与素材", "确定制作方式，列出已备材料和缺口。"],
                                        ["阶段与提示词", "安排先后顺序，标明每步输入和产物。"],
                                        ["分段与衔接", "分配视频时长，保持商品、人物和场景连贯。"],
                                        ["执行与检查", "复制提示词、打开对应创作入口，或下载完整流程。"],
                                    ].map(([title, description], index) => <li key={title} className="flex gap-4 py-4"><span className="text-xs tabular-nums text-muted-foreground">0{index + 1}</span><div><p className="font-medium">{title}</p><p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p></div></li>)}
                                </ol>
                            </div>
                        )}
                    </section>
                </div>
            </div>
        </main>
    );
}
