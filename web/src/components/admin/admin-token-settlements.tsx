"use client";

import { useState } from "react";
import { Alert, Button, Form, Input, InputNumber, Modal, Typography } from "antd";

import type { PublicPointRecord } from "@/lib/auth/store-types";
import { tokenUsagePoints, type TokenUsage } from "@/lib/model-billing";
import { formatCreditAmount } from "@/constant/credits";
import { Panel, PanelHeader } from "./admin-panel";

type SettlementForm = TokenUsage & { reason: string };
const SETTLEMENT_ENDPOINT = "/api/admin/points/token-settlements";

export function AdminTokenSettlements({ onSettled }: { onSettled?: () => void }) {
    const [records, setRecords] = useState<PublicPointRecord[] | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    const [selectedRecord, setSelectedRecord] = useState<PublicPointRecord | null>(null);

    const loadRecords = async () => {
        setLoading(true);
        setError("");
        try {
            const response = await fetch(SETTLEMENT_ENDPOINT, { cache: "no-store" });
            const payload = (await response.json()) as { records?: PublicPointRecord[]; error?: string };
            if (!response.ok || !Array.isArray(payload.records)) throw new Error(payload.error || "加载待核对 Token 消费失败");
            setRecords(payload.records);
        } catch (error) {
            setError(error instanceof Error ? error.message : "加载待核对 Token 消费失败");
        } finally {
            setLoading(false);
        }
    };

    return (
        <Panel>
            <PanelHeader
                title="Token 消费待核对"
                description="展示缺少用量或超过 1 小时未结算的预扣。核对上游账单后补录 Token，按调用时的价格结算；每次最多展示 50 条。"
                actions={
                    <Button loading={loading} onClick={() => void loadRecords()}>
                        {records === null ? "加载待核对" : "刷新待核对"}
                    </Button>
                }
            />
            <div className="space-y-3 p-3 sm:p-5">
                {error ? <Alert type="error" showIcon title={error} /> : null}
                {notice ? <Alert type="success" showIcon title={notice} closable onClose={() => setNotice("")} /> : null}
                <TokenSettlementList records={records} onSelect={setSelectedRecord} />
            </div>
            {selectedRecord ? (
                <TokenSettlementModal
                    key={selectedRecord.id}
                    record={selectedRecord}
                    onCancel={() => setSelectedRecord(null)}
                    onSaved={(record, applied) => {
                        setRecords((current) => current?.filter((item) => item.id !== record.id) || []);
                        setSelectedRecord(null);
                        setNotice(applied ? `消费 ${record.id} 已完成核对结算` : `消费 ${record.id} 已结算，本次未重复扣款`);
                        onSettled?.();
                    }}
                />
            ) : null}
        </Panel>
    );
}

export function TokenSettlementList({ records, onSelect }: { records: PublicPointRecord[] | null; onSelect: (record: PublicPointRecord) => void }) {
    if (records === null) return <p className="text-sm text-stone-500">点击“加载待核对”查询尚未取得用量的 Token 消费。</p>;
    if (!records.length) return <p className="py-3 text-sm text-stone-500">当前没有待核对的 Token 消费。</p>;
    return (
        <div className="divide-y divide-stone-200 dark:divide-stone-800">
            {records.map((record) => (
                <div key={record.id} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0">
                    <div className="min-w-0 space-y-1 text-xs text-stone-500">
                        <div className="break-all text-sm font-medium text-stone-800 dark:text-stone-100">{record.model || "未记录模型"}</div>
                        <div className="break-all">用户 ID：{record.userId}</div>
                        <div className="break-all">
                            消费 ID：
                            <Typography.Text copyable={{ text: record.id }} className="!text-xs">
                                {record.id}
                            </Typography.Text>
                        </div>
                        <div>
                            预扣 {formatCreditAmount(record.tokenBilling?.reservedPoints || 0)} 积分 · {new Date(record.createdAt).toLocaleString("zh-CN", { hour12: false })}
                        </div>
                    </div>
                    <Button onClick={() => onSelect(record)}>补录用量</Button>
                </div>
            ))}
        </div>
    );
}

function TokenSettlementModal({ record, onCancel, onSaved }: { record: PublicPointRecord; onCancel: () => void; onSaved: (record: PublicPointRecord, applied: boolean) => void }) {
    const [form] = Form.useForm<SettlementForm>();
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const values = Form.useWatch([], form) as Partial<SettlementForm> | undefined;
    const preview = previewTokenSettlement(record, values || {});
    const rule = record.tokenBilling?.rule;

    const submit = async (values: SettlementForm) => {
        const checked = previewTokenSettlement(record, values);
        if (checked.error) {
            setError(checked.error);
            return;
        }
        setSaving(true);
        setError("");
        try {
            const response = await fetch(SETTLEMENT_ENDPOINT, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ recordId: record.id, inputTokens: values.inputTokens, outputTokens: values.outputTokens, cachedInputTokens: values.cachedInputTokens, reason: values.reason.trim() }),
            });
            const payload = (await response.json()) as { record?: PublicPointRecord; applied?: boolean; error?: string };
            if (!response.ok || !payload.record) throw new Error(payload.error || "Token 消费结算失败");
            onSaved(payload.record, payload.applied === true);
        } catch (error) {
            setError(error instanceof Error ? error.message : "Token 消费结算失败");
        } finally {
            setSaving(false);
        }
    };

    return (
        <Modal
            title="核对 Token 用量并结算"
            open
            onCancel={onCancel}
            onOk={() => form.submit()}
            okText="确认结算"
            cancelText="取消"
            confirmLoading={saving}
            cancelButtonProps={{ disabled: saving }}
            closable={!saving}
            keyboard={!saving}
            maskClosable={false}
            width={640}
        >
            <div className="mb-4 space-y-1 break-all text-xs leading-5 text-stone-500">
                <div>
                    模型：{record.model} · 用户 ID：{record.userId}
                </div>
                <div>消费 ID：{record.id}</div>
                <div>
                    调用时单价（积分 / 百万 Token）：输入 {rule?.inputPointsPerMillion}，输出 {rule?.outputPointsPerMillion}，缓存输入 {rule?.cachedInputPointsPerMillion ?? rule?.inputPointsPerMillion}。
                </div>
            </div>
            <Form form={form} layout="vertical" initialValues={{ cachedInputTokens: 0 }} onFinish={(values) => void submit(values)} disabled={saving}>
                <div className="grid grid-cols-2 gap-x-3">
                    <Form.Item name="inputTokens" label="输入 Token（含缓存）" rules={[{ required: true, message: "请填写输入 Token" }]}>
                        <InputNumber className="!w-full" min={0} max={Number.MAX_SAFE_INTEGER} precision={0} />
                    </Form.Item>
                    <Form.Item name="outputTokens" label="输出 Token" rules={[{ required: true, message: "请填写输出 Token" }]}>
                        <InputNumber className="!w-full" min={0} max={Number.MAX_SAFE_INTEGER} precision={0} />
                    </Form.Item>
                </div>
                <Form.Item name="cachedInputTokens" label="其中缓存输入 Token" rules={[{ required: true, message: "请填写缓存输入 Token，没有则填 0" }]}>
                    <InputNumber className="!w-full" min={0} max={Number.MAX_SAFE_INTEGER} precision={0} />
                </Form.Item>
                <Form.Item
                    name="reason"
                    label="核对依据"
                    rules={[
                        { required: true, whitespace: true, message: "请填写上游账单编号、请求 ID 或其他核对依据" },
                        { max: 1000, message: "核对依据最多 1000 字" },
                    ]}
                >
                    <Input.TextArea rows={3} maxLength={1000} placeholder="填写上游账单编号、请求 ID 及核对说明" />
                </Form.Item>
            </Form>
            {preview.error !== undefined ? (
                <p className="mb-3 text-xs text-stone-500">{preview.error}</p>
            ) : (
                <div className="mb-3 rounded-md bg-stone-50 p-3 text-sm dark:bg-stone-900">
                    最终消费 {formatCreditAmount(preview.actualPoints)} 积分；已预扣 {formatCreditAmount(record.tokenBilling?.reservedPoints || 0)} 积分；
                    {preview.adjustmentPoints > 0 ? `需补扣 ${formatCreditAmount(preview.adjustmentPoints)}` : preview.adjustmentPoints < 0 ? `需退回 ${formatCreditAmount(-preview.adjustmentPoints)}` : "无需补退"} 积分。
                </div>
            )}
            <Alert type="info" showIcon title="确认后按实际用量多退少补；已过期的每日积分不退入余额，余额不足时永久积分可能欠费。" />
            {error ? (
                <div className="mt-3">
                    <Alert type="error" showIcon title={error} />
                </div>
            ) : null}
        </Modal>
    );
}

export function previewTokenSettlement(record: PublicPointRecord, values: Partial<TokenUsage>): { actualPoints: number; adjustmentPoints: number; error?: undefined } | { error: string; actualPoints?: undefined; adjustmentPoints?: undefined } {
    if (!record.tokenBilling) return { error: "这条消费没有 Token 计费信息" };
    if (![values.inputTokens, values.outputTokens, values.cachedInputTokens].every((value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0)) return { error: "请填写有效的非负整数 Token 用量" };
    if (values.cachedInputTokens! > values.inputTokens!) return { error: "缓存输入 Token 不能大于输入 Token" };
    try {
        const actualPoints = tokenUsagePoints(record.tokenBilling.rule, values as TokenUsage);
        return { actualPoints, adjustmentPoints: Number((actualPoints - record.tokenBilling.reservedPoints).toFixed(2)) };
    } catch (error) {
        return { error: error instanceof Error ? error.message : "无法计算 Token 费用" };
    }
}
