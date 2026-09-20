import { describe, expect, it } from "vitest";

import type { LogicalModel, SystemModelChannel } from "@/lib/auth/store-types";
import { applyChannelProtocol } from "@/lib/channel-protocol-registry";
import { normalizeLogicalModelsConfig } from "@/lib/model-routing-config";
import { resolveLogicalModel } from "@/lib/server/logical-model-router";
import { applyPublicSystemSettings, defaultConfig } from "@/stores/use-config-store";

function savedSettings() {
    const channel = applyChannelProtocol({ id: "custom", name: "Custom", baseUrl: "https://example.com/v1", apiKey: "test", apiFormat: "openai", models: ["banana-pro", "banana-2"], enabled: true } satisfies SystemModelChannel, "custom");
    const logicalModels: LogicalModel[] = [
        { id: "banana-pro", name: "Banana Pro", capability: "image", enabled: true, bindings: [{ id: "pro", channelId: channel.id, upstreamModel: "banana-pro", enabled: true, priority: 1 }] },
        { id: "banana-2", name: "Banana 2", capability: "text", enabled: true, bindings: [{ id: "two", channelId: channel.id, upstreamModel: "banana-2", enabled: true, priority: 4 }] },
    ];
    return { channel, logicalModels };
}

describe("saved banana-2 capability migration", () => {
    it("repairs the saved text fallback so banana-2 is selectable and routable for images", () => {
        const { channel, logicalModels: savedModels } = savedSettings();
        const logicalModels = normalizeLogicalModelsConfig(savedModels, [channel]);
        expect(logicalModels[1]).toEqual({ ...savedModels[1], capability: "image" });
        expect(normalizeLogicalModelsConfig(logicalModels, [channel])).toEqual(logicalModels);

        const settings = { systemChannels: [channel], logicalModels };
        const config = applyPublicSystemSettings(defaultConfig, settings);
        expect(config.imageModels).toEqual(["banana-pro", "banana-2"]);
        expect(config.textModels).not.toContain("banana-2");
        expect(resolveLogicalModel(settings, "image", "banana-2")).toMatchObject({ channelId: "custom", upstreamModel: "banana-2" });
    });

    it("preserves an explicit per-model text configuration", () => {
        const { channel, logicalModels } = savedSettings();
        channel.advancedConfig = { ...channel.advancedConfig!, modelConfigs: { "banana-2": { capability: "text", source: "manual" } } };
        expect(normalizeLogicalModelsConfig(logicalModels, [channel])[1].capability).toBe("text");
    });

    it("preserves disabled status and binding settings while correcting the old classification", () => {
        const { channel, logicalModels } = savedSettings();
        logicalModels[1].enabled = false;
        logicalModels[1].bindings[0].enabled = false;
        const normalized = normalizeLogicalModelsConfig(logicalModels, [channel]);
        expect(normalized[1]).toEqual({ ...logicalModels[1], capability: "image" });
        expect(applyPublicSystemSettings(defaultConfig, { systemChannels: [channel], logicalModels: normalized }).imageModels).toEqual(["banana-pro"]);
    });
});
