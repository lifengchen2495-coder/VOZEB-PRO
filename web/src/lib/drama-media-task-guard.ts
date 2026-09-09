import type { DramaShot } from "@/lib/drama-project-contract";

export type DramaMediaTaskKind = "storyboard" | "storyboardEnd" | "generation" | "audio";

export function dramaMediaTaskIsCurrent(latest: DramaShot | undefined, expected: DramaShot, kind: DramaMediaTaskKind, phase: "creating" | "running") {
    if (!latest || latest.id !== expected.id || latest[`${kind}Attempt`] !== expected[`${kind}Attempt`]) return false;
    if (phase === "running") return Boolean(expected[`${kind}TaskId`]) && latest[`${kind}TaskId`] === expected[`${kind}TaskId`] && latest[`${kind}Status`] === "running";
    // 请求已提交后可能发生改稿；仍需接回该次任务，产物保留为待更新状态。
    return !latest[`${kind}TaskId`] && (latest[`${kind}Status`] === "queued" || (latest[`${kind}Status`] === "idle" && latest.productionStale));
}

export function clearDramaMediaTaskRef(ref: { current: string }, expectedKey: string) {
    if (ref.current === expectedKey) ref.current = "";
}
