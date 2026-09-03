import { createHash } from "node:crypto";

const MAX_WORKER_ID_LENGTH = 144;
const HASH_LENGTH = 16;
const SAFE_WORKER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,144}$/;

export function normalizeGenerationWorkerId(value) {
    const trimmed = typeof value === "string" ? value.trim() : "";
    if (!trimmed) return "";
    if (SAFE_WORKER_ID_PATTERN.test(trimmed)) return trimmed;

    const hash = createHash("sha256").update(trimmed).digest("hex").slice(0, HASH_LENGTH);
    const maximumPrefixLength = MAX_WORKER_ID_LENGTH - hash.length - 1;
    const readable = trimmed
        .replace(/[^A-Za-z0-9._:-]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^[-._:]+|[-._:]+$/g, "");
    const prefix = readable.slice(0, maximumPrefixLength).replace(/[-._:]+$/g, "") || "worker";
    return `${prefix}-${hash}`;
}
