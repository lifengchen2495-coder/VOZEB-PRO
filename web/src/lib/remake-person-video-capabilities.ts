import { creativeModelProfileForLogicalModel } from "@/lib/creative-model-capabilities";
import { huifengVideoCapabilityProfile } from "@/lib/huifeng-media";
import { isSeedanceFastModel } from "@/lib/seedance-video";
import { modelOptionName, type AiConfig } from "@/stores/use-config-store";
import { normalizeRemakeVideoQuality, normalizeRemakeVideoSettings, remakeVideoQualityLabel, type RemakeVideoSettings } from "./remake-person-video-settings";

export function remakeVideoResolutionOptions(config: Pick<AiConfig, "logicalModels">, selectedModel: string) {
    const model = modelOptionName(selectedModel).trim().toLowerCase();
    const logical = config.logicalModels?.find((item) => item.enabled && item.id.toLowerCase() === model);
    const profile = creativeModelProfileForLogicalModel(logical && {
        ...logical,
        bindings: logical.bindings.map((binding) => ({
            ...binding,
            capabilityProfile: binding.capabilityProfile || huifengVideoCapabilityProfile(binding.upstreamModel.toLowerCase()),
        })),
    }) || huifengVideoCapabilityProfile(model);
    const fallback = isSeedanceFastModel(model) ? ["480", "720"] : ["480", "720", "1080"];
    const qualities = (profile?.resolutions?.length ? profile.resolutions : fallback).map(normalizeRemakeVideoQuality);
    return [...new Set(qualities)].filter((value): value is RemakeVideoSettings["vquality"] => value !== undefined).map((value) => ({ value, label: remakeVideoQualityLabel(value) }));
}

export function remakeVideoSettingsForModel(config: Pick<AiConfig, "logicalModels">, settings: unknown, model: string): RemakeVideoSettings {
    const normalized = normalizeRemakeVideoSettings(settings);
    const options = remakeVideoResolutionOptions(config, model);
    return options.length && !options.some((option) => option.value === normalized.vquality) ? { ...normalized, vquality: options[0].value } : normalized;
}
