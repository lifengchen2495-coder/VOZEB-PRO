import { AgentMarkdown } from "@/components/agent/agent-markdown";
import type { DramaSkillReport } from "@/lib/drama-skill-contract";

export function DramaSkillReportView({ report, title }: { report: DramaSkillReport; title?: string }) {
    return (
        <article className="space-y-4" data-drama-skill-report={report.skillId}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
                {title ? <h3 className="text-base font-semibold">{title}</h3> : null}
                <p className="text-xs text-muted-foreground">
                    Skill：{report.skillId} · 版本：{report.version}
                </p>
            </div>
            <AgentMarkdown className="text-sm leading-7">{report.document}</AgentMarkdown>
            {report.assumptions.length ? <ReportList title="补充设定与假设" values={report.assumptions} /> : null}
            {report.changes.length ? <ReportList title="相对原稿的改编" values={report.changes} /> : null}
            {report.checks.length ? (
                <section className="rounded-md border border-border p-3" aria-label="Skill AI 自查结果">
                    <h4 className="text-sm font-medium">AI 自查结果</h4>
                    <p className="mt-1 text-xs text-muted-foreground">以下为模型对 Skill 要求的自查声明，供审阅时核对。</p>
                    <ul className="mt-2 space-y-2 text-sm">
                        {report.checks.map((check) => (
                            <li key={check.id}>
                                <span className={check.passed ? "text-emerald-700 dark:text-emerald-400" : "text-amber-700 dark:text-amber-400"}>{check.passed ? "模型标记通过" : "待修订"}</span> · {check.title}
                                {check.detail ? <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{check.detail}</p> : null}
                            </li>
                        ))}
                    </ul>
                </section>
            ) : null}
        </article>
    );
}

function ReportList({ title, values }: { title: string; values: string[] }) {
    return (
        <section>
            <h4 className="text-sm font-medium">{title}</h4>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm leading-7">
                {values.map((value, index) => (
                    <li key={index} className="whitespace-pre-wrap">
                        {value}
                    </li>
                ))}
            </ul>
        </section>
    );
}
