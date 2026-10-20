"use client";

import { App, Button, Form, Input, Select } from "antd";
import { CheckCircle2, CircleAlert, ExternalLink, FolderOpen, Lock, RefreshCw } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { brand } from "@/lib/brand";
import type { Mode, SettingsPatch } from "@/lib/types";
import { api } from "@/services/api";
import { useWorkbench } from "@/stores/workbench";
import { card } from "../../components/ui";

const modelFields: { mode: Mode; label: string; hint: string }[] = [
    { mode: "chat", label: "文本模型", hint: "AI 对话和优化提示词" },
    { mode: "image", label: "图片模型", hint: "文生图和参考图编辑" },
    { mode: "video", label: "视频模型", hint: "文字或首帧生成视频" },
];

function Block({ title, desc, children }: { title: string; desc: string; children: ReactNode }) {
    return (
        <section className="border-b border-[var(--line)] px-5 py-5 last:border-b-0">
            <h2 className="text-[15px] font-semibold">{title}</h2>
            <p className="mb-4 mt-0.5 text-xs text-[var(--text-2)]">{desc}</p>
            {children}
        </section>
    );
}

export default function SettingsPage() {
    const { message } = App.useApp();
    const current = useWorkbench((s) => s.settings);
    const [form] = Form.useForm<SettingsPatch>();
    const [saving, setSaving] = useState(false);
    const [fetching, setFetching] = useState(false);
    const catalog = current?.catalog || [];
    const origin = current ? new URL(current.baseUrl).origin : "";

    useEffect(() => {
        if (current) form.setFieldsValue({ apiKey: "", systemPrompt: current.systemPrompt, models: current.models });
    }, [current, form]);

    const run = async (action: () => Promise<string>, setBusy: (busy: boolean) => void) => {
        setBusy(true);
        try {
            message.success(await action());
        } catch (error) {
            if (error instanceof Error) message.error(error.message);
        } finally {
            setBusy(false);
        }
    };

    const save = () =>
        run(async () => {
            useWorkbench.setState({ settings: await api.saveSettings(await form.validateFields()) });
            return "设置已保存";
        }, setSaving);

    // 获取成功后服务端保存密钥，并把新模型按类型归类
    const fetchModels = () =>
        run(async () => {
            const settings = await api.fetchModels(form.getFieldValue("apiKey") || "");
            useWorkbench.setState({ settings });
            return `获取到 ${settings.catalog.length} 个模型`;
        }, setFetching);

    return (
        <div className="h-full overflow-y-auto">
            <div className="mx-auto grid max-w-[1120px] gap-3 lg:grid-cols-[minmax(0,1fr)_320px]">
                <Form form={form} layout="vertical" requiredMark={false} className={`${card} min-w-0`}>
                    <div className="flex items-center gap-3 border-b border-[var(--line)] px-5 py-4">
                        <div className="min-w-0 flex-1">
                            <div className="text-xs text-[var(--accent)]">密钥与模型</div>
                            <h1 className="text-lg font-semibold">模型设置</h1>
                        </div>
                        <Button type="primary" onClick={save} loading={saving}>
                            保存设置
                        </Button>
                    </div>
                    <Block title="模型服务" desc="接口地址已内置，不能修改。填写你的 API Key 后点「获取模型」即可开始使用。">
                        <div className="grid gap-x-4 sm:grid-cols-2">
                            <div className="mb-6">
                                <div className="pb-2 text-sm">接口地址</div>
                                <div className="flex h-8 items-center gap-2 rounded-[10px] bg-[var(--panel-2)] px-3 text-sm text-[var(--text-2)]">
                                    <Lock size={14} className="shrink-0" />
                                    <span className="min-w-0 flex-1 truncate">{origin}</span>
                                    <span className="shrink-0 text-xs text-[var(--text-3)]">内置</span>
                                </div>
                            </div>
                            <Form.Item name="apiKey" label="API Key" extra={current?.hasApiKey ? "已保存，留空表示不修改" : "尚未填写密钥"}>
                                <Input.Password placeholder={current?.hasApiKey ? "••••••••" : "sk-..."} autoComplete="off" />
                            </Form.Item>
                        </div>
                        <Button icon={<RefreshCw size={15} />} onClick={fetchModels} loading={fetching}>
                            获取模型
                        </Button>
                    </Block>
                    <Block title="模型" desc="获取到的模型已按类型自动归类，每类第一个是默认模型；可以在这里增删，创作时在输入框的「模型」入口选择。">
                        <div className="grid gap-x-4 md:grid-cols-3">
                            {modelFields.map(({ mode, label, hint }) => (
                                <Form.Item key={mode} name={["models", mode]} label={label} extra={hint}>
                                    <Select mode="multiple" disabled={!catalog.length} options={catalog.map((value) => ({ value }))} placeholder={catalog.length ? "选择模型" : "先获取模型"} aria-label={label} />
                                </Form.Item>
                            ))}
                        </div>
                    </Block>
                    <Block title="对话" desc="每次 AI 对话都会带上这段系统提示词。">
                        <Form.Item name="systemPrompt" className="!mb-0">
                            <Input.TextArea autoSize={{ minRows: 3, maxRows: 8 }} placeholder="可选，例如：你是一名专业的电商内容策划" aria-label="对话系统提示词" />
                        </Form.Item>
                    </Block>
                </Form>
                <aside className="flex flex-col gap-3">
                    <div className={`${card} p-4`}>
                        <div className="flex items-center gap-2 text-sm font-semibold">
                            {catalog.length ? <CheckCircle2 size={16} className="text-[var(--accent)]" /> : <CircleAlert size={16} className="text-[var(--coral)]" />}
                            {catalog.length ? `已获取 ${catalog.length} 个模型` : current?.hasApiKey ? "还没有获取模型" : "还没有填写 API Key"}
                        </div>
                        <p className="mt-2 text-xs leading-5 text-[var(--text-2)]">API Key 只保存在本机，不会返回给浏览器。{brand.name}只监听 127.0.0.1，局域网里的其他设备无法访问。</p>
                        {origin && (
                            <a href={origin} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-xs text-[var(--accent)] hover:underline">
                                前往 {new URL(origin).host} 获取 Key <ExternalLink size={12} />
                            </a>
                        )}
                    </div>
                    <div className={`${card} p-4`}>
                        <div className="flex items-center gap-2 text-sm font-semibold">
                            <FolderOpen size={16} className="text-[var(--text-2)]" />
                            本地数据
                        </div>
                        <p className="mt-2 text-xs leading-5 text-[var(--text-2)]">对话、设置、参考图和生成的图片视频都保存在：</p>
                        <code className="mt-1.5 block break-all rounded-lg bg-[var(--panel-2)] px-2 py-1.5 text-[11px] text-[var(--text-2)]">{current?.dataDir || "…"}</code>
                    </div>
                </aside>
            </div>
        </div>
    );
}
