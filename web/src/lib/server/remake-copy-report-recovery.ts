import type { RemakeProductionCopyReportInput } from "./remake-production-prompt";

type CopyReportProject = {
    sourceCopy: string;
    copyBlocks: RemakeProductionCopyReportInput["blocks"];
    copy: Omit<RemakeProductionCopyReportInput, "sourceCopy" | "blocks"> & { status: string; rawReport: string };
};

export function restoreRemakeCopyReport<T extends CopyReportProject>(project: T, render: (input: RemakeProductionCopyReportInput) => string): T {
    const { copy, copyBlocks } = project;
    if (copy.rawReport.trim() || copy.status !== "completed" || !copy.checks.sequential || !copy.checks.noDuplicates || !copy.checks.noSkips) return project;
    const counts = [copy.stats.unchangedBlocks, copy.stats.completedBlocks, copy.stats.correctedBlocks, copy.stats.emptyBlocks];
    if (counts.some((count) => !Number.isInteger(count) || count < 0) || counts.reduce((sum, count) => sum + count, 0) !== copyBlocks.length || copy.stats.emptyBlocks !== copyBlocks.filter((block) => !block.text.trim()).length) return project;
    try {
        // 旧版本切换配音误删报告时，仅用通过完整覆盖校验的现存文案重建展示。
        const rawReport = render({ ...copy, sourceCopy: project.sourceCopy, blocks: copyBlocks });
        return { ...project, copy: { ...copy, rawReport } };
    } catch {
        // 缺段、重复或原文不一致的历史数据不具备恢复条件，保持原状态。
        return project;
    }
}
