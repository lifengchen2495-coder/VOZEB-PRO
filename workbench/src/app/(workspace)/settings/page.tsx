"use client";

import { App, Button, Form, Input, Select } from "antd";
import { CheckCircle2, CircleAlert, FolderOpen, PlugZap } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { brand } from "@/lib/brand";
import type { Mode, Settings } from "@/lib/types";
import { api } from "@/services/api";
import { useWorkbench } from "@/stores/workbench";
import { card } from "../../components/ui";

const modelFields: { mode: Mode; label: string; hint: string }[] = [
    { mode: "chat", label: "对话模型", hint: "也用于优化提示词" },
    { mode: "image", label: "图片模型", hint: "文生图和参考图编辑" },
    { mode: "video", label: "视频模型", hint: "OpenAI /videos 接口" },
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
    const [form] = Form.useForm<Settings>();
    const [catalog, setCatalog] = useState<string[]>([]);
    const [saving, setSaving] = useState(false);
    const [reading, setReading] = useState(false);

    useEffect(() => {
        if (current) form.setFieldsValue({ ...current, apiKey: "" });
    }, [current, form]);

    const save = async () => {
        setSaving(true);
        try {
            const settings = await api.saveSettings(await form.validateFields());
            useWorkbench.setState({ settings });
            message.success("设置已保存");
        } catch (error) {
            if (error instanceof Error) message.error(error.message);
        } finally {
            setSaving(false);
        }
    };

    const loadCatalog = async () => {
        setReading(true);
        try {
            // 先保存当前填写的地址和密钥，模型目录按保存后的配置读取
            const { baseUrl, apiKey } = await form.validateFields(["baseUrl", "apiKey"]);
            useWorkbench.setState({ settings: await api.saveSettings({ baseUrl, apiKey }) });
            form.setFieldValue("apiKey", "");
            const ids = await api.models();
            setCatalog(ids);
            message.success(`连接成功，读取到 ${ids.length} 个模型`);
        } catch (error) {
            if (error instanceof Error) message.error(error.message);
        } finally {
            setReading(false);
        }
    };

    return (
        <div className="h-full overflow-y-auto">
            <div className="mx-auto grid max-w-[1120px] gap-3 lg:grid-cols-[minmax(0,1fr)_320px]">
                <Form form={form} layout="vertical" requiredMark={false} className={`${card} min-w-0`}>
                    <div className="flex items-center gap-3 border-b border-[var(--line)] px-5 py-4">
                        <div className="min-w-0 flex-1">
                            <div className="text-xs text-[var(--accent)]">接口与模型</div>
                            <h1 className="text-lg font-semibold">模型设置</h1>
                        </div>
                        <Button type="primary" onClick={save} loading={saving}>
                            保存设置
                        </Button>
                    </div>
                    <Block title="接口连接" desc="支持任意 OpenAI 兼容接口，例如官方地址或你的中转服务。">
                        <div className="grid gap-x-4 sm:grid-cols-2">
                            <Form.Item name="baseUrl" label="接口地址" rules={[{ required: true, type: "url", message: "请填写有效的接口地址" }]}>
                                <Input placeholder="https://api.openai.com/v1" />
                            </Form.Item>
                            <Form.Item name="apiKey" label="API Key" extra={current?.hasApiKey ? "已保存，留空表示不修改" : "尚未配置密钥"}>
                                <Input.Password placeholder={current?.hasApiKey ? "••••••••" : "sk-..."} autoComplete="off" />
                            </Form.Item>
                        </div>
                        <Button icon={<PlugZap size={15} />} onClick={loadCatalog} loading={reading}>
                            测试连接并读取模型
                        </Button>
                    </Block>
                    <Block title="模型" desc="每类可以填多个模型，第一个作为默认；创作时在输入框的「模型」入口切换。输入后回车即可添加。">
                        <div className="grid gap-x-4 md:grid-cols-3">
                            {modelFields.map(({ mode, label, hint }) => (
                                <Form.Item key={mode} name={["models", mode]} label={label} extra={hint} rules={[{ required: true, type: "array", min: 1, message: `请至少填写一个${label}` }]}>
                                    <Select mode="tags" tokenSeparators={[",", " "]} options={catalog.map((value) => ({ value }))} placeholder="输入或选择模型 ID" aria-label={label} />
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
                            {current?.hasApiKey ? <CheckCircle2 size={16} className="text-[var(--accent)]" /> : <CircleAlert size={16} className="text-[var(--coral)]" />}
                            {current?.hasApiKey ? "接口已配置" : "还没有配置接口"}
                        </div>
                        <p className="mt-2 text-xs leading-5 text-[var(--text-2)]">API Key 只保存在本机，不会返回给浏览器。{brand.name}只监听 127.0.0.1，局域网里的其他设备无法访问。</p>
                    </div>
                    <div className={`${card} p-4`}>
                        <div className="flex items-center gap-2 text-sm font-semibold">
                            <FolderOpen size={16} className="text-[var(--text-2)]" />
                            本地数据
                        </div>
                        <p className="mt-2 text-xs leading-5 text-[var(--text-2)]">对话、设置、参考图和生成的图片视频都保存在：</p>
                        <code className="mt-1.5 block break-all rounded-lg bg-[var(--panel-2)] px-2 py-1.5 text-[11px] text-[var(--text-2)]">{current?.dataDir || "…"}</code>
                    </div>
                    <div className={`${card} p-4`}>
                        <div className="text-sm font-semibold">没有 Key 想先体验？</div>
                        <p className="mt-2 text-xs leading-5 text-[var(--text-2)]">
                            在项目目录运行 <code className="rounded bg-[var(--panel-2)] px-1">npm run mock</code>，把接口地址填成 <code className="rounded bg-[var(--panel-2)] px-1">http://127.0.0.1:3199/v1</code>，API Key 随便填。
                        </p>
                    </div>
                </aside>
            </div>
        </div>
    );
}
