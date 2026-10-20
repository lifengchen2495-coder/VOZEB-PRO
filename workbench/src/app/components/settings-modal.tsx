"use client";

import { App, AutoComplete, Button, Form, Input, Modal } from "antd";
import { useEffect, useState } from "react";
import type { PublicSettings, Settings } from "@/lib/types";
import { api } from "@/services/api";

export function SettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
    const { message } = App.useApp();
    const [form] = Form.useForm<Settings>();
    const [current, setCurrent] = useState<PublicSettings>();
    const [models, setModels] = useState<string[]>([]);
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        if (!open) return;
        api.settings()
            .then((settings) => {
                setCurrent(settings);
                form.setFieldsValue({ ...settings, apiKey: "" });
            })
            .catch((error) => message.error(error.message));
    }, [open, form, message]);

    const save = async () => {
        setLoading(true);
        try {
            setCurrent(await api.saveSettings(await form.validateFields()));
            message.success("设置已保存");
            onClose();
        } catch (error) {
            if (error instanceof Error) message.error(error.message);
        } finally {
            setLoading(false);
        }
    };

    const loadModels = async () => {
        try {
            // 先保存当前填写的地址和密钥，模型列表按保存后的配置读取
            await api.saveSettings(form.getFieldsValue());
            const ids = await api.models();
            setModels(ids);
            message.success(`读取到 ${ids.length} 个模型`);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "读取模型失败");
        }
    };

    const options = models.map((value) => ({ value }));
    const modelField = (name: keyof Settings, label: string) => (
        <Form.Item name={name} label={label} rules={[{ required: true, message: `请填写${label}` }]}>
            <AutoComplete options={options} placeholder="模型 ID" filterOption={(input, option) => String(option?.value).toLowerCase().includes(input.toLowerCase())} />
        </Form.Item>
    );

    return (
        <Modal title="设置" open={open} onCancel={onClose} onOk={save} okText="保存" cancelText="取消" confirmLoading={loading} width="min(560px, calc(100vw - 32px))" destroyOnHidden>
            <p className="mb-4 text-sm" style={{ color: "var(--muted)" }}>
                填写任意 OpenAI 兼容接口。密钥只保存在本机 <code>.data/settings.json</code>，不会发送到浏览器。
            </p>
            <Form form={form} layout="vertical" requiredMark={false}>
                <Form.Item name="baseUrl" label="接口地址" rules={[{ required: true, type: "url", message: "请填写有效的接口地址" }]}>
                    <Input placeholder="https://api.openai.com/v1" />
                </Form.Item>
                <Form.Item name="apiKey" label="API Key" extra={current?.hasApiKey ? "已保存密钥，留空表示不修改" : "尚未配置密钥"}>
                    <Input.Password placeholder={current?.hasApiKey ? "••••••••" : "sk-..."} autoComplete="off" />
                </Form.Item>
                <div className="grid gap-x-3 sm:grid-cols-3">
                    {modelField("textModel", "对话模型")}
                    {modelField("imageModel", "图片模型")}
                    {modelField("videoModel", "视频模型")}
                </div>
                <Button size="small" onClick={loadModels} className="mb-4">
                    从接口读取模型列表
                </Button>
                <Form.Item name="systemPrompt" label="对话系统提示词">
                    <Input.TextArea autoSize={{ minRows: 2, maxRows: 6 }} placeholder="可选，例如：你是一名专业的创意助手" />
                </Form.Item>
            </Form>
        </Modal>
    );
}
