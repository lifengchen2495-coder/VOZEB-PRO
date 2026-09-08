"use client";

import { Button } from "antd";
import { Save } from "lucide-react";

import { Panel, PanelHeader } from "@/components/admin/admin-panel";
import { QuotaRuleTable } from "@/components/admin/admin-quota-rules";

import type { AdminDashboardController } from "./use-admin-dashboard-controller";

export function AdminPointsSection({ controller }: { controller: AdminDashboardController }) {
    const {
        activeSection,
        settings,
        setSettings,
        settingsLoading,
        customPointModel,
        setCustomPointModel,
        saveSettings,
        updateFreeDailyPoints,
        updateModelPointCost,
        updateGenerationPointMultiplier,
        deleteGenerationPointMultiplier,
        addCustomPointModel,
        deleteModelPointCost,
    } = controller;
    if (activeSection !== "points") return null;

    return (
        <Panel>
            <PanelHeader
                title="积分规则"
                description="配置每日额度、模型按次或按 Token 计费，以及图片、视频参数倍率。"
                actions={
                    <Button
                        type="primary"
                        loading={settingsLoading}
                        icon={<Save className="size-4" />}
                        aria-label="保存积分规则"
                        title="保存积分规则"
                        onClick={() =>
                            saveSettings(
                                (current) => ({
                                    freeDailyPointsEnabled: current.freeDailyPointsEnabled,
                                    freeDailyPoints: current.freeDailyPoints,
                                    modelPointCosts: current.modelPointCosts,
                                    modelBillingRules: current.modelBillingRules || {},
                                    generationPointMultipliers: current.generationPointMultipliers,
                                }),
                                "积分规则已保存",
                            )
                        }
                    >
                        <span className="sm:hidden">保存</span>
                        <span className="hidden sm:inline">保存积分规则</span>
                    </Button>
                }
            />
            <div className="min-w-0 p-3 sm:p-5">
                <QuotaRuleTable
                    settings={settings}
                    customModel={customPointModel}
                    onCustomModelChange={setCustomPointModel}
                    onAddCustomModel={addCustomPointModel}
                    onFreeDailyPointsEnabledChange={(freeDailyPointsEnabled) => setSettings((current) => ({ ...current, freeDailyPointsEnabled }))}
                    onFreeDailyPointsChange={updateFreeDailyPoints}
                    onModelPointCostChange={updateModelPointCost}
                    onModelBillingRuleChange={(model, rule) =>
                        setSettings((current) => {
                            const modelBillingRules = { ...current.modelBillingRules };
                            Object.keys(modelBillingRules)
                                .filter((key) => key.toLowerCase() === model.toLowerCase())
                                .forEach((key) => delete modelBillingRules[key]);
                            if (rule) modelBillingRules[model] = rule;
                            return { ...current, modelBillingRules };
                        })
                    }
                    onModelPointCostDelete={deleteModelPointCost}
                    onGenerationPointMultiplierChange={updateGenerationPointMultiplier}
                    onGenerationPointMultiplierDelete={deleteGenerationPointMultiplier}
                />
            </div>
        </Panel>
    );
}
