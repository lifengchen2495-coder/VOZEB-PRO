"use client";

import { InputNumber, Segmented } from "antd";

import { LabeledControl } from "./admin-settings-controls";
import { MAX_MODEL_BILLING_POINTS } from "@/lib/model-billing-config";
import type { ModelBillingRule, TokenBillingRule } from "@/lib/model-billing";

export function ModelBillingEditor({
    model,
    rule,
    requestPoints,
    onRuleChange,
    onRequestPointsChange,
}: {
    model: string;
    rule: ModelBillingRule;
    requestPoints: number;
    onRuleChange: (rule: ModelBillingRule) => void;
    onRequestPointsChange: (value: number | null) => void;
}) {
    const updateTokenPrice = (key: keyof Omit<TokenBillingRule, "mode">, value: number | null) => {
        if (rule.mode !== "token") return;
        if (key === "cachedInputPointsPerMillion" && value === null) {
            const next = { ...rule };
            delete next.cachedInputPointsPerMillion;
            onRuleChange(next);
            return;
        }
        onRuleChange({ ...rule, [key]: value ?? (key === "reservePoints" ? 0.01 : 0) });
    };
    return (
        <div className="mt-3 space-y-3">
            <Segmented
                block
                aria-label={`${model} 计费方式`}
                value={rule.mode}
                options={[
                    { label: "按次", value: "request" },
                    { label: "按 Token", value: "token" },
                ]}
                onChange={(mode) => onRuleChange(mode === "token" ? { mode: "token", inputPointsPerMillion: 0, outputPointsPerMillion: 0, reservePoints: Math.max(0.01, requestPoints) } : { mode: "request" })}
            />
            {rule.mode === "request" ? (
                <LabeledControl label="每次扣除积分">
                    <InputNumber className="w-full" aria-label={`${model} 每次扣除积分`} min={0} max={MAX_MODEL_BILLING_POINTS} precision={2} value={requestPoints} onChange={onRequestPointsChange} />
                </LabeledControl>
            ) : (
                <>
                    <div className="grid grid-cols-2 gap-3">
                        <LabeledControl label="输入单价（积分 / 百万 Token）">
                            <InputNumber className="w-full" aria-label={`${model} 输入单价`} min={0} max={MAX_MODEL_BILLING_POINTS} precision={6} value={rule.inputPointsPerMillion} onChange={(value) => updateTokenPrice("inputPointsPerMillion", value)} />
                        </LabeledControl>
                        <LabeledControl label="输出单价（积分 / 百万 Token）">
                            <InputNumber
                                className="w-full"
                                aria-label={`${model} 输出单价`}
                                min={0}
                                max={MAX_MODEL_BILLING_POINTS}
                                precision={6}
                                value={rule.outputPointsPerMillion}
                                onChange={(value) => updateTokenPrice("outputPointsPerMillion", value)}
                            />
                        </LabeledControl>
                        <LabeledControl label="缓存输入单价（积分 / 百万 Token）">
                            <InputNumber
                                className="w-full"
                                aria-label={`${model} 缓存输入单价`}
                                placeholder="留空同输入单价"
                                min={0}
                                max={MAX_MODEL_BILLING_POINTS}
                                precision={6}
                                value={rule.cachedInputPointsPerMillion}
                                onChange={(value) => updateTokenPrice("cachedInputPointsPerMillion", value)}
                            />
                        </LabeledControl>
                        <LabeledControl label="每次预扣积分">
                            <InputNumber className="w-full" aria-label={`${model} 每次预扣积分`} min={0.01} max={MAX_MODEL_BILLING_POINTS} precision={2} value={rule.reservePoints} onChange={(value) => updateTokenPrice("reservePoints", value)} />
                        </LabeledControl>
                    </div>
                    <p className="text-xs leading-5 text-stone-500">预扣金额不是消费上限，建议覆盖常见最大用量。结束后按实际 Token 多退少补，余额不足时永久积分可能欠费；上游缺少用量时保留预扣并标记待核对。费用向上取到 0.01 积分。</p>
                    {rule.inputPointsPerMillion === 0 && rule.outputPointsPerMillion === 0 && !rule.cachedInputPointsPerMillion && (
                        <p className="text-xs text-amber-700 dark:text-amber-400">当前 Token 单价均为 0，将按免费调用结算。请填写计划使用的积分售价。</p>
                    )}
                </>
            )}
        </div>
    );
}
