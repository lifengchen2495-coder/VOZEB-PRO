"use client";

import { App, Button, Form, Input, Modal, Select } from "antd";
import { useEffect, useState } from "react";
import type { Mode, Settings } from "@/lib/types";
import { api } from "@/services/api";
import { useWorkbench, workbench } from "@/stores/workbench";

const modelFields: { mode: Mode; label: string }[] = [
    { mode: "chat", label: "对话模型" },
    { mode: "image", label: "图片模型" },
    { mode: "video", label: "视频模型" },
];

export function SettingsModal() {
    const { message } = App.useApp();
    const open = useWorkbench((s) => s.settingsOpen);
    const current = useWorkbench((s) => s.settings);
    const [form] = Form.useForm<Settings>();
    const [catalog, setCatalog] = useState<string[]>([]);
    const [loading, setLoading] = useState(false);
    const [reading, setReading] = useState(false);

    useEffect(() => {
        if (open && current) form.setFieldsValue({ ...current, apiKey: "" });
    }, [open, current, form]);

    const close = () => workbench.toggle("settingsOpen", false);

    const save = async () => {
        setLoading(true);
        try {
            const settings = await api.saveSettings(await form.validateFields());
            useWorkbench.setState({ settings });
            message.success("设置已保存");
            close();
        } catch (error) {
            if (error instanceof Error) message.error(error.message);
        } finally {
            setLoading(false);
        }
    };

    const loadCatalog = async () => {
        setReading(true);
        try {
            // 先保存当前填写的地址和密钥，模型目录按保存后的配置读取
            const { baseUrl, apiKey } = form.getFieldsValue();
            useWorkbench.setState({ settings: await api.saveSettings({ baseUrl, apiKey }) });
            const ids = await api.models();
            setCatalog(ids);
            message.success(`读取到 ${ids.length} 个模型，可在下方选择`);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "读取模型失败");
        } finally {
            setReading(false);
        }
    };

    return (
        <Modal title="设置" open={open} onCancel={close} onOk={save} okText="保存" cancelText="取消" confirmLoading={loading} width="min(600px, calc(100vw - 32px))" destroyOnHidden>
            <p className="mb-4 text-sm text-[var(--text-2)]">
                支持任意 OpenAI 兼容接口。密钥只保存在本机 <code>.data/settings.json</code>，不会发送到浏览器。
            </p>
            <Form form={form} layout="vertical" requiredMark={false}>
                <div className="grid gap-x-3 sm:grid-cols-2">
                    <Form.Item name="baseUrl" label="接口地址" rules={[{ required: true, type: "url", message: "请填写有效的接口地址" }]}>
                        <Input placeholder="https://api.openai.com/v1" />
                    </Form.Item>
                    <Form.Item name="apiKey" label="API Key" extra={current?.hasApiKey ? "已保存，留空表示不修改" : "尚未配置密钥"}>
                        <Input.Password placeholder={current?.hasApiKey ? "••••••••" : "sk-..."} autoComplete="off" />
                    </Form.Item>
                </div>
                <div className="mb-3 flex flex-wrap items-center gap-2">
                    <Button size="small" onClick={loadCatalog} loading={reading}>
                        从接口读取模型列表
                    </Button>
                    <span className="text-xs text-[var(--text-2)]">每类可以填多个模型，第一个作为默认，输入后回车即可添加。</span>
                </div>
                {modelFields.map(({ mode, label }) => (
                    <Form.Item key={mode} name={["models", mode]} label={label} rules={[{ required: true, type: "array", min: 1, message: `请至少填写一个${label}` }]}>
                        <Select mode="tags" tokenSeparators={[",", " "]} options={catalog.map((value) => ({ value }))} placeholder="输入或选择模型 ID" aria-label={label} />
                    </Form.Item>
                ))}
                <Form.Item name="systemPrompt" label="对话系统提示词">
                    <Input.TextArea autoSize={{ minRows: 2, maxRows: 6 }} placeholder="可选，例如：你是一名专业的创意助手" />
                </Form.Item>
            </Form>
        </Modal>
    );
}
