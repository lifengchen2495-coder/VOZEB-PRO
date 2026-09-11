import type { DramaSkillReport } from "@/lib/drama-skill-contract";
import { getDramaSkillDefinition, getDramaSkillInstructions, getDramaSkillReportSchema, normalizeAndValidateDramaSkillReport } from "@/lib/server/drama-skills";
import { hasUsableDramaToolArguments } from "@/lib/server/drama-analysis";
import type { DramaShotDurationPolicy } from "@/lib/server/drama-shot-config";

type Phase = "content" | "visual" | "video-prompts";
type Tool = { name: string; description: string; parameters: Record<string, unknown> };

export function dramaSeedanceDurationPolicy(policy: DramaShotDurationPolicy): DramaShotDurationPolicy {
    const min = Math.max(4, policy.minDurationSeconds || 4);
    const max = Math.min(15, policy.maxDurationSeconds || 15);
    const durations = policy.durationSeconds?.filter((seconds) => seconds >= min && seconds <= max);
    if (min > max || (durations && !durations.length)) throw new Error("当前视频模型没有 4 至 15 秒的可用时长，无法执行 Seedance 分镜，请选择支持该时长的视频模型");
    const defaultSeconds = durations?.length ? durations.reduce((nearest, seconds) => (Math.abs(seconds - policy.defaultSeconds) < Math.abs(nearest - policy.defaultSeconds) ? seconds : nearest)) : Math.max(min, Math.min(max, policy.defaultSeconds));
    return { ...policy, defaultSeconds, minDurationSeconds: min, maxDurationSeconds: max, ...(durations ? { durationSeconds: durations } : {}) };
}

export function dramaSkillAnalysisTool(phase: Phase, base: Tool): Tool {
    return {
        ...base,
        description: phase === "content" ? "完整标准分镜作品及同稿制作结构" : "完整 Seedance 作品及逐镜生产提示词",
        parameters: {
            ...base.parameters,
            properties: { ...(base.parameters.properties as Record<string, unknown>), skill: getDramaSkillReportSchema(phase) },
            required: [...(base.parameters.required as string[]), "skill"],
        },
    };
}

export function dramaSkillAnalysisInstructions(phase: Phase): string {
    return [
        getDramaSkillInstructions(phase),
        "输入 creativeContext 是原稿和已采用的完整人物、节奏及详细剧本产物。以最新制作剧本和分镜为本阶段依据。正文和结构化镜头必须一一对应，不能写两套故事；所有调整、推断及无法验证的条件明确记录。",
        phase === "content"
            ? "本阶段将已创作完成的 script 转为标准分镜；保留制作剧本事件与台词。sourceText 逐字覆盖本次 script（它是改编稿，不是最初原稿）。完整编号分镜写入 skill.document，台词、动作、时长和资产名称同步映射 shots；音效、字幕、动态、转场与备注不得在完整分镜中省略。时长按输入视频模型的实际支持值分镜，绝不能把整集压缩成一个短片。遇到分段输入，仅交付当前片段完整分镜，不重复前后片段正文。"
            : "以输入 episode.storyboardSkill 的完整标准分镜、人物小传和当前 shots 为依据，逐镜生成完整 Seedance 提示词并同步写入 shots[].videoPrompt。每条 videoPrompt 必须独立可用，包含【风格】【主体描述】【场景环境】【时间轴】【镜头语言】【光影氛围】【声音】【参考】，时间轴从 0 连续覆盖该镜 duration，每段含景别、运镜或转场、主体动作和环境动态。另写首尾帧及连续性，禁止只在报告写完整内容、在实际 videoPrompt 中返回一句摘要。不能更改 shotId、顺序、对白或时长；时长超出 4 至 15 秒时明确提示需先重新拆镜，不能伪造匹配结果。",
        "素材处理：availableReferences / sourceAssets 仅表示项目中存在的素材，不代表视频供应商已上传或绑定。实际 videoPrompt 使用完整文字描述和参考用途，不虚构 @图片1 等上传引用。素材清单与使用提示可给出待制作素材的中英文提示词及上传后引用示例，并明确尚未绑定。未提供素材时说明无现成参考，不套用来源范例的人物或素材。",
        "外层仅输出 JSON；完整 Markdown 文档放在 skill.document 字符串中，不输出 JSON 外的解释。",
    ].join("\n\n");
}

export function validateDramaSkillAnalysisArguments(value: string, phase: Phase, toolName: string, shots?: Array<{ id: string; duration: number }>): boolean {
    if (!hasUsableDramaToolArguments(value, toolName)) return false;
    try {
        const parsed = JSON.parse(value) as { skill?: unknown; shots: Array<{ shotId?: string; videoPrompt?: string }> };
        normalizeAndValidateDramaSkillReport(phase, parsed.skill);
        if (phase !== "content") {
            for (const shot of parsed.shots) {
                const duration = shots?.find((item) => item.id === shot.shotId)?.duration;
                if (!validSeedanceProductionPrompt(shot.videoPrompt, duration)) return false;
            }
        }
        return true;
    } catch {
        return false;
    }
}

export function validSeedanceProductionPrompt(value: unknown, duration?: number): boolean {
    if (typeof value !== "string") return false;
    if (!["风格", "主体描述", "场景环境", "时间轴", "镜头语言", "光影氛围", "声音", "参考"].every((label) => value.includes(`【${label}】`))) return false;
    const rows = [...value.matchAll(/(\d+(?:\.\d+)?)\s*[-~～—至]\s*(\d+(?:\.\d+)?)\s*(?:秒|s)\s*[：:]([^\n\r]+)/giu)];
    if (!rows.length) return false;
    let end = 0;
    for (const row of rows) {
        const start = Number(row[1]);
        const next = Number(row[2]);
        if (Math.abs(start - end) > 0.01 || next <= start || next > 15) return false;
        if (!/远景|全景|中景|近景|特写|主观视角|黑场/u.test(row[3]) || !/推|拉|摇|移|跟|环绕|升|降|切|渐变|叠化|黑场|固定/u.test(row[3])) return false;
        end = next;
    }
    return end >= 4 && (duration === undefined || Math.abs(end - duration) <= 0.01);
}

/** 分批生成后保留每批完整文档和自查来源，不把局部自查合成为全局通过。 */
export function mergeDramaSkillReports(reports: Array<DramaSkillReport | undefined>): DramaSkillReport | undefined {
    const available = reports.filter((report): report is DramaSkillReport => Boolean(report));
    if (!available.length) return undefined;
    if (available.length === 1) return available[0];
    const first = available[0];
    if (available.some((report) => report.skillId !== first.skillId || report.version !== first.version)) throw new Error("分批作品的 Skill 版本不一致，请重新生成本阶段");
    let document = available.map((report, index) => `# 分段 ${index + 1}\n\n${report.document}`).join("\n\n---\n\n");
    if (first.skillId === getDramaSkillDefinition("content").id) {
        let number = 0;
        document = document.replace(/【分镜\s*\d+】/gu, () => `【分镜${String(++number).padStart(2, "0")}】`);
    }
    return {
        ...first,
        document,
        assumptions: [...new Set(available.flatMap((report) => report.assumptions)), "本作品由多个片段合并；自查说明按片段保留，不代表已完成人工或全局创作质量审核。"],
        changes: [...new Set(available.flatMap((report) => report.changes))],
        checks: first.checks.map((check) => ({
            ...check,
            passed: available.every((report) => report.checks.some((item) => item.id === check.id && item.passed)),
            detail: available.map((report, index) => `分段 ${index + 1}：${report.checks.find((item) => item.id === check.id)?.detail || "缺少本项自查"}`).join("\n"),
        })),
    };
}
