"use client";

import { Select } from "antd";
import { modelOptionLabel, selectableModelsByCapability, type AiConfig } from "@/stores/use-config-store";

export function DramaTextModelControl({ config, value, disabled, onChange }: { config: AiConfig; value: string; disabled: boolean; onChange: (model: string) => void }) {
    const models = selectableModelsByCapability(config, "text");
    const unavailable = Boolean(value) && !models.includes(value);
    const options = models.map((model) => ({ value: model, label: modelOptionLabel(config, model), disabled: false }));
    if (unavailable) options.unshift({ value, label: `${modelOptionLabel(config, value)}（不可用）`, disabled: true });

    return (
        <div className="mb-3 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-border bg-card px-3 py-2.5" data-drama-text-model>
            <label htmlFor="drama-text-model" className="shrink-0 text-sm font-medium">
                文本模型
            </label>
            <Select
                id="drama-text-model"
                aria-label="短剧文本模型"
                className="w-full min-w-0 sm:!w-60"
                value={value || undefined}
                options={options}
                showSearch
                optionFilterProp="label"
                placeholder="选择文本模型"
                notFoundContent="暂无可用文本模型"
                disabled={disabled || !models.length}
                onChange={onChange}
            />
            <p className={`min-w-0 text-xs leading-5 ${unavailable || !models.length ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground"}`}>
                {!models.length ? "暂无可用文本模型，请联系管理员配置。" : unavailable ? "之前选择的模型已不可用，请重新选择。" : "用于剧本分析、拆镜和提示词。切换后新发起的分析使用此模型。"}
            </p>
        </div>
    );
}
