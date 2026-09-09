import type { DramaWorkflowArtifact } from "@/lib/drama-workflow-contract";
import { renderDramaWorkflowScript } from "@/lib/drama-workflow";

export function DramaWorkflowResult({ artifact }: { artifact: DramaWorkflowArtifact }) {
    if (artifact.stage === "story") {
        const story = artifact.data;
        return (
            <div className="space-y-4" data-drama-analysis-result="story">
                <p className="whitespace-pre-wrap text-base leading-8">{story.logline}</p>
                <ResultFields values={[["核心冲突", story.coreConflict], ["类型与主题", story.genre], ["目标受众", story.audience], ["世界观与规则", story.worldRules], ["原稿关键事实", story.lockedFacts]]} />
                <p className="text-sm text-muted-foreground">{story.episodeCount} 集 · {story.targetDuration == null ? "原稿未标注单集时长" : `单集约 ${story.targetDuration} 秒`}</p>
            </div>
        );
    }
    if (artifact.stage === "characters") {
        return (
            <div className="space-y-4" data-drama-analysis-result="characters">
                {!artifact.data.characters.length ? <p className="text-sm text-muted-foreground">原稿中未识别到具名人物。</p> : null}
                {artifact.data.characters.map((character) => (
                    <article key={character.id} className="rounded-md border border-border p-4">
                        <h3 className="text-base font-semibold">{character.name}<span className="ml-3 text-sm font-normal text-muted-foreground">{character.role}</span></h3>
                        {character.aliases.length ? <p className="mt-1 text-sm text-muted-foreground">别名：{character.aliases.join("、")}</p> : null}
                        <div className="mt-3">
                            <ResultFields values={[["动机与目标", character.motivation], ["背景", character.background], ["性格与弱点", character.personality], ["人物关系", character.relationships], ["成长弧线", character.arc], ["外貌特征", character.visualIdentity], ["声音与说话方式", character.voiceStyle], ["标志动作", character.signatureAction]]} />
                        </div>
                    </article>
                ))}
            </div>
        );
    }
    if (artifact.stage === "beats") {
        return (
            <div className="space-y-4" data-drama-analysis-result="beats">
                <p className="whitespace-pre-wrap text-sm leading-7">{artifact.data.outline}</p>
                <ol className="space-y-3">
                    {artifact.data.beats.map((beat, index) => (
                        <li key={beat.id} className="border-l-2 border-border pl-4">
                            <div className="flex flex-wrap items-baseline justify-between gap-2">
                                <h3 className="text-sm font-semibold">{index + 1}. {beat.title}</h3>
                                <span className="text-xs text-muted-foreground">{beat.duration == null ? "原稿未标注时长" : `约 ${beat.duration} 秒`}</span>
                            </div>
                            <p className="mt-2 whitespace-pre-wrap text-sm leading-7">{beat.description}</p>
                            <ResultFields values={[["情绪变化", beat.emotion], ["伏笔与回收", beat.payoff]]} />
                        </li>
                    ))}
                </ol>
                <ResultFields values={[["结尾钩子", artifact.data.hook], ["下集承接", artifact.data.nextPreview]]} />
            </div>
        );
    }
    return <p className="whitespace-pre-wrap text-sm leading-7" data-drama-analysis-result="script">{renderDramaWorkflowScript(artifact.data)}</p>;
}

function ResultFields({ values }: { values: Array<[string, string]> }) {
    const present = values.filter(([, value]) => value.trim());
    return present.length ? (
        <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
            {present.map(([label, value]) => (
                <div key={label}>
                    <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
                    <dd className="mt-1 whitespace-pre-wrap text-sm leading-7">{value}</dd>
                </div>
            ))}
        </dl>
    ) : null;
}
