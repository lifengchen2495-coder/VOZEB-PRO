import { cleanOmniWorkflowMediaReferences } from "@/lib/server/omni-workflow-media-cleanup";
import { cleanBangbangMediaReferences } from "@/lib/server/bangbang-media-cleanup";
import type { CanvasProject } from "@/lib/canvas-project-contract";
import { readJsonDataFile, withJsonDataFileLocks, writeJsonDataFile } from "@/lib/server/data-adapter";
import { ensurePostgresSchema, getDatabaseProvider, withPostgresTransaction, type QueryExecutor } from "@/lib/server/database";
import type { RuntimeFileDatabase } from "@/lib/server/creative-runtime-repository";
import type { GenerationLogDatabase } from "@/lib/server/generation-log-types";
import type { StoredGenerationTaskRecord } from "@/lib/server/generation-task-store";
import { getLocalMediaRegistrations, type LocalMediaRegistration } from "@/lib/server/local-media-registry";
import { deleteRegisteredLocalMediaSnapshots } from "@/lib/server/local-media-storage";
import { defaultRemakePipeline, emptyRemakeCopyState, emptyRemakeRangeGroups, isRemakeNoNarrationCopy, normalizeRemakeProjectWorkflow, type RemakeMediaAsset, type RemakePipeline, type RemakeProject } from "@/lib/server/remake-project-contract";
import {
    defaultRemakePipeline as defaultRemake15Pipeline,
    emptyRemakeCopyState as emptyRemake15CopyState,
    emptyRemakeRangeGroups as emptyRemake15RangeGroups,
    isRemakeNoNarrationCopy as isRemake15NoNarrationCopy,
    normalizeRemakeProjectWorkflow as normalizeRemake15ProjectWorkflow,
    type RemakeProject as Remake15Project,
} from "@/lib/server/remake15-project-contract";
import { cleanCanvasProjectMediaReferences, cleanUserMediaReferences, containsUserMediaReference } from "@/lib/server/user-media-reference-cleanup";

import { defaultRemakePipeline as defaultRemake60Pipeline, emptyRemakeCopyState as emptyRemake60CopyState, emptyRemakeRangeGroups as emptyRemake60RangeGroups, isRemakeNoNarrationCopy as isRemake60NoNarrationCopy, normalizeRemakeProjectWorkflow as normalizeRemake60ProjectWorkflow, type RemakeProject as Remake60Project } from "@/lib/server/remake60-project-contract";

import { defaultRemakePipeline as defaultRemakeProductPipeline, emptyRemakeCopyState as emptyRemakeProductCopyState, emptyRemakeRangeGroups as emptyRemakeProductRangeGroups, isRemakeNoNarrationCopy as isRemakeProductNoNarrationCopy, normalizeRemakeProjectWorkflow as normalizeRemakeProductProjectWorkflow, type RemakeProject as RemakeProductProject } from "@/lib/server/remake-product-project-contract";

import { defaultRemakePipeline as defaultRemakePersonPipeline, emptyRemakeCopyState as emptyRemakePersonCopyState, emptyRemakeRangeGroups as emptyRemakePersonRangeGroups, isRemakeNoNarrationCopy as isRemakePersonNoNarrationCopy, normalizeRemakeProjectWorkflow as normalizeRemakePersonProjectWorkflow, type RemakeProject as RemakePersonProject } from "@/lib/server/remake-person-project-contract";

const FILES = [
    "auth.json",
    "canvas-projects.json",
    "creative-runtime.json",
    "drama-projects.json",
    "remake-projects.json",
    "remake15-projects.json",
    "remake60-projects.json",
    "remake-product-projects.json",
    "remake-person-projects.json",
    "omni-clothing-projects.json",
    "omni-remake-projects.json",
    "bangbang-projects.json",
    "generation-logs.json",
    "generation-tasks.json",
    "library-assets.json",
    "local-media-assets.json",
] as const;

type CanvasProjectFile = { version: 1; projects: Array<{ userId: string; project: CanvasProject }> };
type ProjectFile = { version: 1; projects: Array<{ userId: string; project: Record<string, unknown> }> };
type RemakeProjectFile = { version: 1; projects: Array<{ userId: string; project: RemakeProject }> };
type Remake15ProjectFile = { version: 1; projects: Array<{ userId: string; project: Remake15Project }> };
type LibraryAssetFile = { version: 1; assets: unknown[] };
type LocalMediaFile = { version: 1; assets: LocalMediaRegistration[] };

export async function deleteUserMediaAssetsCascade(userId: string, storageKeys: string[]) {
    const ownerUserId = userId.trim();
    const requestedKeys = normalizeKeys(storageKeys);
    if (!ownerUserId || !requestedKeys.length) return emptyResult();

    const cleanup = getDatabaseProvider() === "postgres" ? await cleanPostgresReferences(ownerUserId, requestedKeys) : await cleanFileReferences(ownerUserId, requestedKeys);
    if (!cleanup.registrations.length) return emptyResult();
    const deleted = await deleteRegisteredLocalMediaSnapshots(cleanup.registrations);
    return { ...deleted, removedReferences: cleanup.removedReferences };
}

async function cleanPostgresReferences(userId: string, storageKeys: string[]) {
    await ensurePostgresSchema();
    return withPostgresTransaction(async (client) => {
        const registrations = await getLocalMediaRegistrations(storageKeys, { ownerUserId: userId, executor: client, forUpdate: true });
        const keys = registrations.map((item) => item.storageKey);
        if (!keys.length) return { registrations, removedReferences: 0 };
        const removedReferences = await removePostgresReferences(client, userId, keys);
        return { registrations, removedReferences };
    });
}

async function removePostgresReferences(client: QueryExecutor, userId: string, storageKeys: string[]) {
    let removed = 0;
    const assets = await client.query<{ id: string; conversation_id: string; source_run_id?: string }>(
        `DELETE FROM creative_assets
         WHERE user_id = $1
           AND (storage_key = ANY($2::text[]) OR ${matchesJsonColumns("creative_assets", ["server_url", "remote_url", "metadata"])})
         RETURNING id, conversation_id, source_run_id`,
        [userId, storageKeys],
    );
    removed += assets.rowCount || assets.rows.length;
    const assetIds = assets.rows.map((row) => row.id).filter(Boolean);
    const conversationIds = Array.from(new Set(assets.rows.map((row) => row.conversation_id).filter(Boolean)));
    const runIds = Array.from(new Set(assets.rows.map((row) => row.source_run_id).filter((value): value is string => Boolean(value))));

    const messages = await client.query<{ id: string; content: string; metadata: unknown }>(
        `SELECT message.id, message.content, message.metadata
         FROM creative_messages message
         JOIN creative_conversations conversation ON conversation.id = message.conversation_id
         WHERE conversation.user_id = $1
           AND (
               message.conversation_id = ANY($3::text[])
               OR ${matchesJsonColumns("message", ["content", "metadata"])}
           )
         FOR UPDATE OF message`,
        [userId, storageKeys, conversationIds],
    );
    for (const message of messages.rows) {
        const cleaned = cleanUserMediaReferences({ content: message.content, metadata: message.metadata }, storageKeys, assetIds);
        if (!cleaned.changed) continue;
        await client.query("UPDATE creative_messages SET content = $2, metadata = $3::jsonb, updated_at = now() WHERE id = $1", [message.id, String(cleaned.value.content || ""), JSON.stringify(cleaned.value.metadata || {})]);
        removed += 1;
    }

    const events = await client.query<{ id: string | number; data: unknown }>(
        `SELECT event.id, event.data FROM creative_run_events event
         WHERE (
             event.run_id = ANY($3::text[])
             OR EXISTS (
                 SELECT 1 FROM generation_tasks task
                 WHERE task.user_id = $1 AND (task.id = event.run_id OR task.run_id = event.run_id)
             )
         )
           AND ${matchesJsonColumns("event", ["data"])}
         FOR UPDATE OF event`,
        [userId, storageKeys, runIds],
    );
    for (const event of events.rows) {
        const cleaned = cleanUserMediaReferences(event.data, storageKeys, assetIds);
        if (!cleaned.changed) continue;
        await client.query("UPDATE creative_run_events SET data = $2::jsonb WHERE id = $1", [event.id, JSON.stringify(cleaned.value ?? null)]);
        removed += 1;
    }

    removed += await deleteMatchingRows(client, "library_assets", "user_id = $1", matchesJsonColumns("library_assets", ["asset_json"]), userId, storageKeys);
    removed += await cleanPostgresCanvasProjects(client, userId, storageKeys);
    removed += await cleanPostgresJsonProjects(client, "drama_projects", "project_json", userId, storageKeys);
    removed += await cleanPostgresRemakeProjects(client, userId, storageKeys);
    removed += await cleanPostgresRemake15Projects(client, userId, storageKeys);
    removed += await cleanAdditionalWorkflowProjects<Remake60Project>(client, "remake60_projects", userId, storageKeys, cleanRemake60ProjectMediaReferences);
    removed += await cleanAdditionalWorkflowProjects<RemakeProductProject>(client, "remake_product_projects", userId, storageKeys, cleanRemakeProductProjectMediaReferences);
    removed += await cleanAdditionalWorkflowProjects<RemakePersonProject>(client, "remake_person_projects", userId, storageKeys, cleanRemakePersonProjectMediaReferences);
    removed += await cleanAdditionalWorkflowProjects<import("@/lib/omni-clothing-contract").OmniClothingProject>(client, "omni_clothing_projects", userId, storageKeys, cleanOmniWorkflowMediaReferences);
    removed += await cleanAdditionalWorkflowProjects<import("@/lib/omni-remake-contract").OmniProject>(client, "omni_remake_projects", userId, storageKeys, cleanOmniWorkflowMediaReferences);
    removed += await cleanAdditionalWorkflowProjects<import("@/lib/bangbang-contract").BangbangProject>(client, "bangbang_projects", userId, storageKeys, cleanBangbangMediaReferences);
    removed += await cleanPostgresJsonProjects(client, "drama_project_versions", "snapshot", userId, storageKeys);

    const logAssets = await client.query<{ generation_log_id: string }>(
        `DELETE FROM generation_log_assets asset
         USING generation_logs log
         WHERE asset.generation_log_id = log.id
           AND log.user_id = $1
           AND ${matchesJsonColumns("asset", ["url", "server_url", "remote_url"])}
         RETURNING asset.generation_log_id`,
        [userId, storageKeys],
    );
    removed += logAssets.rowCount || logAssets.rows.length;
    const logIds = Array.from(new Set(logAssets.rows.map((row) => row.generation_log_id).filter(Boolean)));
    const logs = await client.query<{ id: string; request_snapshot: unknown }>(
        `SELECT id, request_snapshot FROM generation_logs
         WHERE user_id = $1
           AND (id = ANY($3::text[]) OR ${matchesJsonColumns("generation_logs", ["request_snapshot"])})
         FOR UPDATE`,
        [userId, storageKeys, logIds],
    );
    for (const log of logs.rows) {
        const cleaned = cleanUserMediaReferences(log.request_snapshot, storageKeys, assetIds);
        if (!cleaned.changed && !logIds.includes(log.id)) continue;
        await client.query("UPDATE generation_logs SET request_snapshot = $2::jsonb, updated_at = now() WHERE id = $1 AND user_id = $3", [log.id, JSON.stringify(cleaned.value || {}), userId]);
        removed += 1;
    }

    const tasks = await client.query<{ id: string; status: string; execution_phase: string; payload: unknown; result_payload: unknown }>(
        `SELECT id, status, execution_phase, payload, result_payload FROM generation_tasks
         WHERE user_id = $1
           AND ${matchesJsonColumns("generation_tasks", ["payload", "result_payload"])}
         FOR UPDATE`,
        [userId, storageKeys],
    );
    for (const task of tasks.rows) {
        const inputDeleted = containsUserMediaReference(task.payload, storageKeys);
        const payload = cleanUserMediaReferences(task.payload, storageKeys, assetIds);
        const resultPayload = cleanUserMediaReferences(task.result_payload, storageKeys, assetIds);
        const cancel = inputDeleted && (task.status === "pending" || task.status === "running");
        await client.query(
            `UPDATE generation_tasks SET payload = $2::jsonb, result_payload = $3::jsonb,
                status = CASE WHEN $4::boolean THEN 'cancelled' ELSE status END,
                execution_phase = CASE WHEN $4::boolean THEN 'completed' ELSE execution_phase END,
                next_poll_at = CASE WHEN $4::boolean THEN NULL ELSE next_poll_at END,
                lease_until = CASE WHEN $4::boolean THEN NULL ELSE lease_until END,
                updated_at = now()
             WHERE id = $1 AND user_id = $5`,
            [task.id, JSON.stringify(payload.value || {}), resultPayload.value === undefined ? null : JSON.stringify(resultPayload.value), cancel, userId],
        );
        removed += 1;
    }

    const publishedAssets = await client.query<{ version_id: string }>(
        `DELETE FROM published_work_assets asset
         USING published_work_versions version, published_works work
         WHERE asset.version_id = version.id AND version.work_id = work.id
           AND work.owner_user_id = $1 AND asset.storage_key = ANY($2::text[])
         RETURNING asset.version_id`,
        [userId, storageKeys],
    );
    removed += publishedAssets.rowCount || publishedAssets.rows.length;
    const versionIds = Array.from(new Set(publishedAssets.rows.map((row) => row.version_id).filter(Boolean)));
    if (versionIds.length) {
        const hidden = await client.query(
            `UPDATE published_works work SET published_version_id = NULL, is_featured = false, featured_at = NULL, featured_by_user_id = NULL
             WHERE owner_user_id = $1 AND published_version_id = ANY($2::text[])
               AND NOT EXISTS (SELECT 1 FROM published_work_assets asset WHERE asset.version_id = work.published_version_id AND asset.role = 'content')`,
            [userId, versionIds],
        );
        removed += hidden.rowCount || 0;
    }
    const avatars = await client.query("UPDATE users SET avatar_storage_key = NULL, updated_at = now() WHERE id = $1 AND avatar_storage_key = ANY($2::text[])", [userId, storageKeys]);
    removed += avatars.rowCount || 0;
    return removed;
}

async function cleanPostgresCanvasProjects(client: QueryExecutor, userId: string, storageKeys: string[]) {
    const result = await client.query<{ id: string; project_json: CanvasProject }>(
        `SELECT id, project_json FROM canvas_projects
         WHERE user_id = $1 AND ${matchesJsonColumns("canvas_projects", ["project_json"])}
         FOR UPDATE`,
        [userId, storageKeys],
    );
    let changed = 0;
    for (const row of result.rows) {
        const cleaned = cleanCanvasProjectMediaReferences(row.project_json, storageKeys);
        if (!cleaned.changed) continue;
        const project = withUpdatedAt(cleaned.value);
        await client.query("UPDATE canvas_projects SET project_json = $3::jsonb, updated_at = $4 WHERE user_id = $1 AND id = $2", [userId, row.id, JSON.stringify(project), new Date(project.updatedAt)]);
        changed += 1;
    }
    return changed;
}

async function cleanPostgresRemakeProjects(client: QueryExecutor, userId: string, storageKeys: string[]) {
    const result = await client.query<{ id: string; project_json: RemakeProject }>(
        `SELECT id, project_json FROM remake_projects
         WHERE user_id = $1 AND ${matchesJsonColumns("remake_projects", ["project_json"])}
         FOR UPDATE`,
        [userId, storageKeys],
    );
    let changed = 0;
    for (const row of result.rows) {
        const cleaned = cleanRemakeProjectMediaReferences(row.project_json, storageKeys);
        if (!cleaned.changed) continue;
        await client.query("UPDATE remake_projects SET project_json = $3::jsonb, updated_at = $4 WHERE user_id = $1 AND id = $2", [userId, row.id, JSON.stringify(cleaned.value), new Date(cleaned.value.updatedAt)]);
        changed += 1;
    }
    return changed;
}

async function cleanPostgresRemake15Projects(client: QueryExecutor, userId: string, storageKeys: string[]) {
    const result = await client.query<{ id: string; project_json: Remake15Project }>(
        `SELECT id, project_json FROM remake15_projects
         WHERE user_id = $1 AND ${matchesJsonColumns("remake15_projects", ["project_json"])}
         FOR UPDATE`,
        [userId, storageKeys],
    );
    let changed = 0;
    for (const row of result.rows) {
        const cleaned = cleanRemake15ProjectMediaReferences(row.project_json, storageKeys);
        if (!cleaned.changed) continue;
        await client.query("UPDATE remake15_projects SET project_json = $3::jsonb, updated_at = $4 WHERE user_id = $1 AND id = $2", [userId, row.id, JSON.stringify(cleaned.value), new Date(cleaned.value.updatedAt)]);
        changed += 1;
    }
    return changed;
}

async function cleanPostgresJsonProjects(client: QueryExecutor, table: "drama_projects" | "drama_project_versions", column: "project_json" | "snapshot", userId: string, storageKeys: string[]) {
    const result = await client.query<{ id: string; value: Record<string, unknown> }>(
        `SELECT id, ${column} AS value FROM ${table}
         WHERE user_id = $1 AND ${matchesJsonColumns(table, [column])}
         FOR UPDATE`,
        [userId, storageKeys],
    );
    let changed = 0;
    for (const row of result.rows) {
        const cleaned = cleanUserMediaReferences(row.value, storageKeys);
        if (!cleaned.changed) continue;
        const value = table === "drama_projects" ? withUpdatedAt(cleaned.value) : cleaned.value;
        await client.query(
            `UPDATE ${table} SET ${column} = $3::jsonb${table === "drama_projects" ? ", updated_at = $4" : ""} WHERE user_id = $1 AND id = $2`,
            table === "drama_projects" ? [userId, row.id, JSON.stringify(value), new Date(String(value.updatedAt))] : [userId, row.id, JSON.stringify(value)],
        );
        changed += 1;
    }
    return changed;
}

async function cleanFileReferences(userId: string, storageKeys: string[]) {
    return withJsonDataFileLocks([...FILES], async () => {
        const before = await readFileState();
        const registrations = before.media.assets.filter((item) => item.ownerUserId === userId && storageKeys.includes(item.storageKey));
        const keys = registrations.map((item) => item.storageKey);
        if (!keys.length) return { registrations, removedReferences: 0 };
        const next = cleanFileState(before, userId, keys);
        try {
            await writeFileState(next.state);
        } catch (error) {
            await Promise.allSettled(Object.entries(fileStateEntries(before)).map(([name, value]) => writeJsonDataFile(name, value)));
            throw error;
        }
        return { registrations, removedReferences: next.removedReferences };
    });
}

function cleanFileState(state: Awaited<ReturnType<typeof readFileState>>, userId: string, storageKeys: string[]) {
    let removedReferences = 0;
    const conversationIds = new Set(state.runtime.conversations.filter((conversation) => conversation.userId === userId).map((conversation) => conversation.id));
    const userTasks = state.tasks.filter((task) => task.userId === userId);
    const removedAssets = state.runtime.assets.filter((asset) => asset.userId === userId && containsUserMediaReference(asset, storageKeys));
    const assetIds = removedAssets.map((asset) => asset.id);
    const runIds = new Set([...userTasks.flatMap((task) => [task.id, task.runId]), ...removedAssets.map((asset) => asset.sourceRunId)].filter((value): value is string => typeof value === "string" && Boolean(value)));
    removedReferences += removedAssets.length;
    const runtime = {
        ...state.runtime,
        assets: state.runtime.assets.filter((asset) => asset.userId !== userId || !containsUserMediaReference(asset, storageKeys)),
        messages: state.runtime.messages.map((message) => (conversationIds.has(message.conversationId) ? cleanCounted(message, storageKeys, assetIds) : message)),
        events: state.runtime.events.map((event) => (runIds.has(event.runId) ? cleanCounted(event, storageKeys, assetIds) : event)),
    };
    removedReferences += state.library.assets.filter((asset) => ownedBy(asset, userId) && containsUserMediaReference(asset, storageKeys)).length;
    const library = { ...state.library, assets: state.library.assets.filter((asset) => !ownedBy(asset, userId) || !containsUserMediaReference(asset, storageKeys)) };
    const canvas = {
        ...state.canvas,
        projects: state.canvas.projects.map((record) => {
            if (record.userId !== userId) return record;
            const cleaned = cleanCanvasProjectMediaReferences(record.project, storageKeys);
            if (!cleaned.changed) return record;
            removedReferences += 1;
            return { ...record, project: withUpdatedAt(cleaned.value) };
        }),
    };
    const drama = {
        ...state.drama,
        projects: state.drama.projects.map((record) => {
            if (record.userId !== userId) return record;
            const cleaned = cleanUserMediaReferences(record.project, storageKeys, assetIds);
            if (!cleaned.changed) return record;
            removedReferences += 1;
            return { ...record, project: withUpdatedAt(cleaned.value) };
        }),
    };
    const remake = {
        ...state.remake,
        projects: state.remake.projects.map((record) => {
            if (record.userId !== userId) return record;
            const cleaned = cleanRemakeProjectMediaReferences(record.project, storageKeys);
            if (!cleaned.changed) return record;
            removedReferences += 1;
            return { ...record, project: cleaned.value };
        }),
    };
    const logs = { ...state.logs, logs: state.logs.logs.map((log) => (log.userId === userId ? cleanCounted(log, storageKeys, assetIds) : log)) };
    const remake15 = {
        ...state.remake15,
        projects: state.remake15.projects.map((record) => {
            if (record.userId !== userId) return record;
            const cleaned = cleanRemake15ProjectMediaReferences(record.project, storageKeys);
            if (!cleaned.changed) return record;
            removedReferences += 1;
            return { ...record, project: cleaned.value };
        }),
    };
    const remake60 = { ...state.remake60, projects: state.remake60.projects.map((record) => {
        if (record.userId !== userId) return record;
        const cleaned = cleanRemake60ProjectMediaReferences(record.project, storageKeys);
        if (!cleaned.changed) return record;
        removedReferences += 1;
        return { ...record, project: cleaned.value };
    }) };
    const remakeProduct = { ...state.remakeProduct, projects: state.remakeProduct.projects.map((record) => {
        if (record.userId !== userId) return record;
        const cleaned = cleanRemakeProductProjectMediaReferences(record.project, storageKeys);
        if (!cleaned.changed) return record;
        removedReferences += 1;
        return { ...record, project: cleaned.value };
    }) };
    const remakePerson = { ...state.remakePerson, projects: state.remakePerson.projects.map((record) => {
        if (record.userId !== userId) return record;
        const cleaned = cleanRemakePersonProjectMediaReferences(record.project, storageKeys);
        if (!cleaned.changed) return record;
        removedReferences += 1;
        return { ...record, project: cleaned.value };
    }) };
    const omniClothing = { ...state.omniClothing, projects: state.omniClothing.projects.map((record) => {
        if (record.userId !== userId) return record;
        const cleaned = cleanOmniWorkflowMediaReferences(record.project, storageKeys);
        if (!cleaned.changed) return record;
        removedReferences += 1;
        return { ...record, project: cleaned.value };
    }) };
    const omniRemake = { ...state.omniRemake, projects: state.omniRemake.projects.map((record) => {
        if (record.userId !== userId) return record;
        const cleaned = cleanOmniWorkflowMediaReferences(record.project, storageKeys);
        if (!cleaned.changed) return record;
        removedReferences += 1;
        return { ...record, project: cleaned.value };
    }) };
    const bangbang = { ...state.bangbang, projects: state.bangbang.projects.map((record) => {
        if (record.userId !== userId) return record;
        const cleaned = cleanBangbangMediaReferences(record.project, storageKeys);
        if (!cleaned.changed) return record;
        removedReferences += 1;
        return { ...record, project: cleaned.value };
    }) };
    const tasks = state.tasks.map((task) => {
        if (task.userId !== userId) return task;
        const inputDeleted = containsUserMediaReference(task.payload, storageKeys);
        const cleaned = cleanUserMediaReferences(task, storageKeys, assetIds);
        if (!cleaned.changed) return task;
        removedReferences += 1;
        return inputDeleted && (task.status === "pending" || task.status === "running") ? { ...cleaned.value, status: "cancelled" as const, executionPhase: "completed" as const, nextPollAt: undefined, leaseUntil: undefined } : cleaned.value;
    });
    const users = Array.isArray(state.auth.users)
        ? state.auth.users.map((user) => {
              if (!ownedBy(user, userId)) return user;
              const cleaned = cleanUserMediaReferences(user, storageKeys, assetIds);
              if (cleaned.changed) removedReferences += 1;
              return cleaned.value;
          })
        : state.auth.users;
    return { state: { ...state, runtime, library, canvas, drama, remake, remake15, remake60, remakeProduct, remakePerson, omniClothing, omniRemake, bangbang, logs, tasks, auth: { ...state.auth, users } }, removedReferences };

    function cleanCounted<T>(value: T, keys: string[], ids: string[]) {
        const cleaned = cleanUserMediaReferences(value, keys, ids);
        if (cleaned.changed) removedReferences += 1;
        return cleaned.value;
    }
}

function ownedBy(value: unknown, userId: string) {
    return Boolean(value && typeof value === "object" && "userId" in value && (value as { userId?: unknown }).userId === userId) || Boolean(value && typeof value === "object" && "id" in value && (value as { id?: unknown }).id === userId);
}

async function readFileState() {
    const [auth, canvas, runtime, drama, remake, remake15, remake60, remakeProduct, remakePerson, omniClothing, omniRemake, bangbang, logs, tasks, library, media] = await Promise.all([
        readJsonDataFile<Record<string, unknown>>("auth.json", {}),
        readJsonDataFile<CanvasProjectFile>("canvas-projects.json", { version: 1, projects: [] }),
        readJsonDataFile<RuntimeFileDatabase>("creative-runtime.json", { version: 1, nextEventId: 1, conversations: [], messages: [], assets: [], events: [] }),
        readJsonDataFile<ProjectFile>("drama-projects.json", { version: 1, projects: [] }),
        readJsonDataFile<RemakeProjectFile>("remake-projects.json", { version: 1, projects: [] }),
        readJsonDataFile<Remake15ProjectFile>("remake15-projects.json", { version: 1, projects: [] }),
        readJsonDataFile<{ version: 1; projects: Array<{ userId: string; project: Remake60Project }> }>("remake60-projects.json", { version: 1, projects: [] }),
        readJsonDataFile<{ version: 1; projects: Array<{ userId: string; project: RemakeProductProject }> }>("remake-product-projects.json", { version: 1, projects: [] }),
        readJsonDataFile<{ version: 1; projects: Array<{ userId: string; project: RemakePersonProject }> }>("remake-person-projects.json", { version: 1, projects: [] }),
        readJsonDataFile<{ version: 1; projects: Array<{ userId: string; project: import("@/lib/omni-clothing-contract").OmniClothingProject }> }>("omni-clothing-projects.json", { version: 1, projects: [] }),
        readJsonDataFile<{ version: 1; projects: Array<{ userId: string; project: import("@/lib/omni-remake-contract").OmniProject }> }>("omni-remake-projects.json", { version: 1, projects: [] }),
        readJsonDataFile<{ version: 1; projects: Array<{ userId: string; project: import("@/lib/bangbang-contract").BangbangProject }> }>("bangbang-projects.json", { version: 1, projects: [] }),
        readJsonDataFile<GenerationLogDatabase>("generation-logs.json", { version: 1, logs: [] }),
        readJsonDataFile<StoredGenerationTaskRecord[]>("generation-tasks.json", []),
        readJsonDataFile<LibraryAssetFile>("library-assets.json", { version: 1, assets: [] }),
        readJsonDataFile<LocalMediaFile>("local-media-assets.json", { version: 1, assets: [] }),
    ]);
    return { auth, canvas, runtime, drama, remake, remake15, remake60, remakeProduct, remakePerson, omniClothing, omniRemake, bangbang, logs, tasks, library, media };
}

async function writeFileState(state: Awaited<ReturnType<typeof readFileState>>) {
    for (const [name, value] of Object.entries(fileStateEntries(state))) await writeJsonDataFile(name, value);
}

function fileStateEntries(state: Awaited<ReturnType<typeof readFileState>>) {
    return {
        "auth.json": state.auth,
        "canvas-projects.json": state.canvas,
        "creative-runtime.json": state.runtime,
        "drama-projects.json": state.drama,
        "remake-projects.json": state.remake,
        "remake15-projects.json": state.remake15,
        "remake60-projects.json": state.remake60,
        "remake-product-projects.json": state.remakeProduct,
        "remake-person-projects.json": state.remakePerson,
        "omni-clothing-projects.json": state.omniClothing,
        "omni-remake-projects.json": state.omniRemake,
        "bangbang-projects.json": state.bangbang,
        "generation-logs.json": state.logs,
        "generation-tasks.json": state.tasks,
        "library-assets.json": state.library,
    };
}

async function deleteMatchingRows(client: QueryExecutor, table: "library_assets", ownerCondition: string, referenceCondition: string, userId: string, storageKeys: string[]) {
    const result = await client.query(`DELETE FROM ${table} WHERE ${ownerCondition} AND ${referenceCondition}`, [userId, storageKeys]);
    return result.rowCount || 0;
}

function matchesJsonColumns(alias: string, columns: string[], keyParameter = 2) {
    return `EXISTS (
        SELECT 1 FROM unnest($${keyParameter}::text[]) AS requested(storage_key)
        WHERE ${columns.map((column) => `position(requested.storage_key in COALESCE(${alias}.${column}::text, '')) > 0`).join(" OR ")}
    )`;
}

function withUpdatedAt<T extends Record<string, unknown>>(value: T): T & { updatedAt: string } {
    const previous = Date.parse(String(value.updatedAt || ""));
    return { ...value, updatedAt: new Date(Math.max(Date.now(), Number.isFinite(previous) ? previous + 1 : 0)).toISOString() };
}

function cleanRemakeProjectMediaReferences(project: RemakeProject, storageKeys: string[]) {
    const normalized = normalizeRemakeProjectWorkflow(project);
    const sourceVideoRemoved = mediaAssetDeleted(normalized.sourceVideo, storageKeys);
    const framesRemoved = normalized.frames.some((frame) => containsUserMediaReference({ storageKey: frame.storageKey, url: frame.frameUrl }, storageKeys));
    const productRemoved = mediaAssetDeleted(normalized.references.product, storageKeys);
    const characterRemoved = mediaAssetDeleted(normalized.references.character, storageKeys);
    const characterSupplementRemoved = mediaAssetDeleted(normalized.references.characterSupplement, storageKeys);
    const backgroundRemoved = mediaAssetDeleted(normalized.references.background, storageKeys);
    const audioRemoved = mediaAssetDeleted(normalized.references.audio, storageKeys);
    const narrationAudioRemoved = audioRemoved && !isRemakeNoNarrationCopy(normalized.sourceCopy);
    const referenceInputRemoved = productRemoved || characterRemoved || characterSupplementRemoved || backgroundRemoved;
    let contactSheetRemoved = false;
    let replacementResultRemoved = false;
    let storyboardResultRemoved = false;
    let videoResultRemoved = false;
    const groups = normalized.groups.map((group) => {
        const removeContactSheet = mediaAssetDeleted(group.sourceContactSheet, storageKeys);
        const removeReplacement = mediaAssetDeleted(group.replacementGeneration.result, storageKeys);
        const removeStoryboard = mediaAssetDeleted(group.imageGeneration.result, storageKeys);
        const removeVideo = mediaAssetDeleted(group.videoGeneration.result, storageKeys);
        contactSheetRemoved ||= removeContactSheet;
        replacementResultRemoved ||= removeReplacement;
        storyboardResultRemoved ||= removeStoryboard;
        videoResultRemoved ||= removeVideo;
        const replacementInvalid = removeContactSheet || removeReplacement || referenceInputRemoved;
        const storyboardInvalid = replacementInvalid || removeStoryboard;
        if (!replacementInvalid && !storyboardInvalid && !narrationAudioRemoved && !removeVideo) return group;
        return {
            ...group,
            sourceContactSheet: removeContactSheet ? undefined : group.sourceContactSheet,
            replacementGeneration: replacementInvalid ? { status: "idle" as const, prompt: "" } : group.replacementGeneration,
            imageGeneration: storyboardInvalid ? { status: "idle" as const, prompt: "" } : group.imageGeneration,
            videoPrompt: storyboardInvalid || narrationAudioRemoved ? "" : group.videoPrompt,
            videoGeneration: storyboardInvalid || narrationAudioRemoved || removeVideo ? { status: "idle" as const } : group.videoGeneration,
        };
    });
    const generatedResultRemoved = replacementResultRemoved || storyboardResultRemoved;
    const changed = sourceVideoRemoved || framesRemoved || referenceInputRemoved || audioRemoved || contactSheetRemoved || generatedResultRemoved || videoResultRemoved;
    if (!changed) return { value: project, changed: false } as const;

    const references = {
        product: productRemoved ? undefined : normalized.references.product,
        character: characterRemoved ? undefined : normalized.references.character,
        characterSupplement: characterSupplementRemoved ? undefined : normalized.references.characterSupplement,
        background: backgroundRemoved ? undefined : normalized.references.background,
        audio: audioRemoved ? undefined : normalized.references.audio,
    };
    const revision = Math.max(0, Number.isInteger(project.revision) ? project.revision : 0) + 1;
    if (!sourceVideoRemoved && !framesRemoved) {
        return {
            value: withUpdatedAt({
                ...normalized,
                revision,
                references,
                groups,
                pipeline: invalidateRemakeMediaPipeline(normalized.pipeline, {
                    references: referenceInputRemoved || contactSheetRemoved,
                    images: generatedResultRemoved || referenceInputRemoved || contactSheetRemoved,
                    prompts: narrationAudioRemoved,
                }),
            }),
            changed: true,
        } as const;
    }

    const error = sourceVideoRemoved ? "源视频已从媒体库删除，请重新上传后分析" : "部分抽帧已从媒体库删除，请重新分析";
    const pipeline = defaultRemakePipeline({ hasSourceVideo: !sourceVideoRemoved && Boolean(normalized.sourceVideo), analysisStatus: "error" });
    pipeline.steps.analysis = { status: "error", error };
    return {
        value: withUpdatedAt({
            ...normalized,
            revision,
            sourceVideo: sourceVideoRemoved ? undefined : normalized.sourceVideo,
            sourceCopy: "",
            frames: [],
            copyBlocks: [],
            references: { ...references, audio: undefined },
            groups: emptyRemakeRangeGroups(),
            copy: emptyRemakeCopyState(),
            pipeline,
            analysis: { status: "error" as const, error },
        }),
        changed: true,
    } as const;
}

function cleanRemake15ProjectMediaReferences(project: Remake15Project, storageKeys: string[]) {
    const normalized = normalizeRemake15ProjectWorkflow(project);
    const sourceVideoRemoved = mediaAssetDeleted(normalized.sourceVideo, storageKeys);
    const framesRemoved = normalized.frames.some((frame) => containsUserMediaReference({ storageKey: frame.storageKey, url: frame.frameUrl }, storageKeys));
    const productRemoved = mediaAssetDeleted(normalized.references.product, storageKeys);
    const characterRemoved = mediaAssetDeleted(normalized.references.character, storageKeys);
    const characterSupplementRemoved = mediaAssetDeleted(normalized.references.characterSupplement, storageKeys);
    const backgroundRemoved = mediaAssetDeleted(normalized.references.background, storageKeys);
    const audioRemoved = mediaAssetDeleted(normalized.references.audio, storageKeys);
    const narrationAudioRemoved = audioRemoved && !isRemake15NoNarrationCopy(normalized.sourceCopy);
    const referenceInputRemoved = productRemoved || characterRemoved || characterSupplementRemoved || backgroundRemoved;
    let contactSheetRemoved = false;
    let replacementResultRemoved = false;
    let storyboardResultRemoved = false;
    let videoResultRemoved = false;
    const groups = normalized.groups.map((group) => {
        const removeContactSheet = mediaAssetDeleted(group.sourceContactSheet, storageKeys);
        const removeReplacement = mediaAssetDeleted(group.replacementGeneration.result, storageKeys);
        const removeStoryboard = mediaAssetDeleted(group.imageGeneration.result, storageKeys);
        const removeVideo = mediaAssetDeleted(group.videoGeneration.result, storageKeys);
        contactSheetRemoved ||= removeContactSheet;
        replacementResultRemoved ||= removeReplacement;
        storyboardResultRemoved ||= removeStoryboard;
        videoResultRemoved ||= removeVideo;
        const replacementInvalid = removeContactSheet || removeReplacement || referenceInputRemoved;
        const storyboardInvalid = replacementInvalid || removeStoryboard;
        if (!replacementInvalid && !storyboardInvalid && !narrationAudioRemoved && !removeVideo) return group;
        return {
            ...group,
            sourceContactSheet: removeContactSheet ? undefined : group.sourceContactSheet,
            replacementGeneration: replacementInvalid ? { status: "idle" as const, prompt: "" } : group.replacementGeneration,
            imageGeneration: storyboardInvalid ? { status: "idle" as const, prompt: "" } : group.imageGeneration,
            videoPrompt: storyboardInvalid || narrationAudioRemoved ? "" : group.videoPrompt,
            videoGeneration: storyboardInvalid || narrationAudioRemoved || removeVideo ? { status: "idle" as const } : group.videoGeneration,
        };
    });
    const generatedResultRemoved = replacementResultRemoved || storyboardResultRemoved;
    const changed = sourceVideoRemoved || framesRemoved || referenceInputRemoved || audioRemoved || contactSheetRemoved || generatedResultRemoved || videoResultRemoved;
    if (!changed) return { value: project, changed: false } as const;

    const references = {
        product: productRemoved ? undefined : normalized.references.product,
        character: characterRemoved ? undefined : normalized.references.character,
        characterSupplement: characterSupplementRemoved ? undefined : normalized.references.characterSupplement,
        background: backgroundRemoved ? undefined : normalized.references.background,
        audio: audioRemoved ? undefined : normalized.references.audio,
    };
    const revision = Math.max(0, Number.isInteger(project.revision) ? project.revision : 0) + 1;
    if (!sourceVideoRemoved && !framesRemoved) {
        return {
            value: withUpdatedAt({
                ...normalized,
                revision,
                productScript: referenceInputRemoved || contactSheetRemoved ? "" : normalized.productScript,
                storyboardScript: referenceInputRemoved || contactSheetRemoved ? "" : normalized.storyboardScript,
                references,
                groups,
                pipeline: invalidateRemakeMediaPipeline(normalized.pipeline, {
                    references: referenceInputRemoved || contactSheetRemoved,
                    images: generatedResultRemoved || referenceInputRemoved || contactSheetRemoved,
                    prompts: narrationAudioRemoved,
                }),
            }),
            changed: true,
        } as const;
    }

    const error = sourceVideoRemoved ? "源视频已从媒体库删除，请重新上传后分析" : "部分抽帧已从媒体库删除，请重新分析";
    const pipeline = defaultRemake15Pipeline({ hasSourceVideo: !sourceVideoRemoved && Boolean(normalized.sourceVideo), analysisStatus: "error" });
    pipeline.steps.analysis = { status: "error", error };
    return {
        value: withUpdatedAt({
            ...normalized,
            revision,
            sourceVideo: sourceVideoRemoved ? undefined : normalized.sourceVideo,
            sourceCopy: "",
            productScript: "",
            storyboardScript: "",
            frames: [],
            copyBlocks: [],
            references: { ...references, audio: undefined },
            groups: emptyRemake15RangeGroups(),
            copy: emptyRemake15CopyState(),
            pipeline,
            analysis: { status: "error" as const, error },
        }),
        changed: true,
    } as const;
}

function mediaAssetDeleted(asset: RemakeMediaAsset | undefined, storageKeys: string[]) {
    return Boolean(asset && containsUserMediaReference({ storageKey: asset.storageKey, url: asset.url }, storageKeys));
}

function invalidateRemakeMediaPipeline(pipeline: RemakePipeline, input: { references: boolean; images: boolean; prompts: boolean }): RemakePipeline {
    if (!input.references && !input.images && !input.prompts) return pipeline;
    const reset = { status: "pending" as const };
    return {
        ...pipeline,
        stage: input.references ? "references" : input.images ? "images" : "prompts",
        steps: {
            ...pipeline.steps,
            ...(input.references ? { references: reset } : {}),
            ...(input.images ? { images: reset } : {}),
            ...(input.images || input.prompts ? { prompts: reset } : {}),
        },
    };
}

function normalizeKeys(values: string[]) {
    return Array.from(new Set(values.map((value) => value.trim().replace(/\\/g, "/").replace(/^\/+/, "")).filter(Boolean)));
}

function emptyResult() {
    return { deletedFiles: 0, deletedBytes: 0, blocked: [] as Array<{ id: string; storageKey: string; referenceCount: number }>, removedReferences: 0 };
}

function cleanRemake60ProjectMediaReferences(project: Remake60Project, storageKeys: string[]) {
    const normalized = normalizeRemake60ProjectWorkflow(project);
    const sourceVideoRemoved = mediaAssetDeleted(normalized.sourceVideo, storageKeys);
    const framesRemoved = normalized.frames.some((frame) => containsUserMediaReference({ storageKey: frame.storageKey, url: frame.frameUrl }, storageKeys));
    const productRemoved = mediaAssetDeleted(normalized.references.product, storageKeys);
    const characterRemoved = mediaAssetDeleted(normalized.references.character, storageKeys);
    const characterSupplementRemoved = mediaAssetDeleted(normalized.references.characterSupplement, storageKeys);
    const backgroundRemoved = mediaAssetDeleted(normalized.references.background, storageKeys);
    const audioRemoved = mediaAssetDeleted(normalized.references.audio, storageKeys);
    const narrationAudioRemoved = audioRemoved && !isRemake60NoNarrationCopy(normalized.sourceCopy);
    const referenceInputRemoved = productRemoved || characterRemoved || characterSupplementRemoved || backgroundRemoved;
    let contactSheetRemoved = false;
    let replacementResultRemoved = false;
    let storyboardResultRemoved = false;
    let videoResultRemoved = false;
    const groups = normalized.groups.map((group) => {
        const removeContactSheet = mediaAssetDeleted(group.sourceContactSheet, storageKeys);
        const removeReplacement = mediaAssetDeleted(group.replacementGeneration.result, storageKeys);
        const removeStoryboard = mediaAssetDeleted(group.imageGeneration.result, storageKeys);
        const removeVideo = mediaAssetDeleted(group.videoGeneration.result, storageKeys);
        contactSheetRemoved ||= removeContactSheet;
        replacementResultRemoved ||= removeReplacement;
        storyboardResultRemoved ||= removeStoryboard;
        videoResultRemoved ||= removeVideo;
        const replacementInvalid = removeContactSheet || removeReplacement || referenceInputRemoved;
        const storyboardInvalid = replacementInvalid || removeStoryboard;
        if (!replacementInvalid && !storyboardInvalid && !narrationAudioRemoved && !removeVideo) return group;
        return {
            ...group,
            sourceContactSheet: removeContactSheet ? undefined : group.sourceContactSheet,
            replacementGeneration: replacementInvalid ? { status: "idle" as const, prompt: "" } : group.replacementGeneration,
            imageGeneration: storyboardInvalid ? { status: "idle" as const, prompt: "" } : group.imageGeneration,
            videoPrompt: storyboardInvalid || narrationAudioRemoved ? "" : group.videoPrompt,
            videoGeneration: storyboardInvalid || narrationAudioRemoved || removeVideo ? { status: "idle" as const } : group.videoGeneration,
        };
    });
    const generatedResultRemoved = replacementResultRemoved || storyboardResultRemoved;
    const mergedRemoved = mediaAssetDeleted(project.mergedVideo, storageKeys);
    const changed = mergedRemoved || sourceVideoRemoved || framesRemoved || referenceInputRemoved || audioRemoved || contactSheetRemoved || generatedResultRemoved || videoResultRemoved;
    if (!changed) return { value: project, changed: false } as const;

    const references = {
        product: productRemoved ? undefined : normalized.references.product,
        character: characterRemoved ? undefined : normalized.references.character,
        characterSupplement: characterSupplementRemoved ? undefined : normalized.references.characterSupplement,
        background: backgroundRemoved ? undefined : normalized.references.background,
        audio: audioRemoved ? undefined : normalized.references.audio,
    };
    const revision = Math.max(0, Number.isInteger(project.revision) ? project.revision : 0) + 1;
    if (!sourceVideoRemoved && !framesRemoved) {
        return {
            value: withUpdatedAt({
                ...normalized,
                revision,
                mergedVideo: undefined,
                mergedVideoInputVersion: undefined,
                productScript: referenceInputRemoved || contactSheetRemoved ? "" : normalized.productScript,
                storyboardScript: referenceInputRemoved || contactSheetRemoved ? "" : normalized.storyboardScript,
                references,
                groups,
                pipeline: invalidateRemakeMediaPipeline(normalized.pipeline, {
                    references: referenceInputRemoved || contactSheetRemoved,
                    images: generatedResultRemoved || referenceInputRemoved || contactSheetRemoved,
                    prompts: narrationAudioRemoved,
                }),
            }),
            changed: true,
        } as const;
    }

    const error = sourceVideoRemoved ? "源视频已从媒体库删除，请重新上传后分析" : "部分抽帧已从媒体库删除，请重新分析";
    const pipeline = defaultRemake60Pipeline({ hasSourceVideo: !sourceVideoRemoved && Boolean(normalized.sourceVideo), analysisStatus: "error" });
    pipeline.steps.analysis = { status: "error", error };
    return {
        value: withUpdatedAt({
            ...normalized,
            revision,
            mergedVideo: undefined,
            mergedVideoInputVersion: undefined,
            sourceVideo: sourceVideoRemoved ? undefined : normalized.sourceVideo,
            sourceCopy: "",
            productScript: "",
            storyboardScript: "",
            frames: [],
            copyBlocks: [],
            references: { ...references, audio: undefined },
            groups: emptyRemake60RangeGroups(),
            copy: emptyRemake60CopyState(),
            pipeline,
            analysis: { status: "error" as const, error },
        }),
        changed: true,
    } as const;
}


function cleanRemakeProductProjectMediaReferences(project: RemakeProductProject, storageKeys: string[]) {
    const normalized = normalizeRemakeProductProjectWorkflow(project);
    const sourceVideoRemoved = mediaAssetDeleted(normalized.sourceVideo, storageKeys);
    const framesRemoved = normalized.frames.some((frame) => containsUserMediaReference({ storageKey: frame.storageKey, url: frame.frameUrl }, storageKeys));
    const productRemoved = mediaAssetDeleted(normalized.references.product, storageKeys);
    const characterRemoved = mediaAssetDeleted(normalized.references.character, storageKeys);
    const characterSupplementRemoved = mediaAssetDeleted(normalized.references.characterSupplement, storageKeys);
    const backgroundRemoved = mediaAssetDeleted(normalized.references.background, storageKeys);
    const audioRemoved = mediaAssetDeleted(normalized.references.audio, storageKeys);
    const narrationAudioRemoved = audioRemoved && !isRemakeProductNoNarrationCopy(normalized.sourceCopy);
    const referenceInputRemoved = productRemoved || characterRemoved || characterSupplementRemoved || backgroundRemoved;
    let contactSheetRemoved = false;
    let replacementResultRemoved = false;
    let storyboardResultRemoved = false;
    let videoResultRemoved = false;
    const groups = normalized.groups.map((group) => {
        const removeContactSheet = mediaAssetDeleted(group.sourceContactSheet, storageKeys);
        const removeReplacement = mediaAssetDeleted(group.replacementGeneration.result, storageKeys);
        const removeStoryboard = mediaAssetDeleted(group.imageGeneration.result, storageKeys);
        const removeVideo = mediaAssetDeleted(group.videoGeneration.result, storageKeys);
        contactSheetRemoved ||= removeContactSheet;
        replacementResultRemoved ||= removeReplacement;
        storyboardResultRemoved ||= removeStoryboard;
        videoResultRemoved ||= removeVideo;
        const replacementInvalid = removeContactSheet || removeReplacement || referenceInputRemoved;
        const storyboardInvalid = replacementInvalid || removeStoryboard;
        if (!replacementInvalid && !storyboardInvalid && !narrationAudioRemoved && !removeVideo) return group;
        return {
            ...group,
            sourceContactSheet: removeContactSheet ? undefined : group.sourceContactSheet,
            replacementGeneration: replacementInvalid ? { status: "idle" as const, prompt: "" } : group.replacementGeneration,
            imageGeneration: storyboardInvalid ? { status: "idle" as const, prompt: "" } : group.imageGeneration,
            videoPrompt: storyboardInvalid || narrationAudioRemoved ? "" : group.videoPrompt,
            videoGeneration: storyboardInvalid || narrationAudioRemoved || removeVideo ? { status: "idle" as const } : group.videoGeneration,
        };
    });
    const generatedResultRemoved = replacementResultRemoved || storyboardResultRemoved;
    const mergedRemoved = mediaAssetDeleted(project.mergedVideo, storageKeys);
    const changed = mergedRemoved || sourceVideoRemoved || framesRemoved || referenceInputRemoved || audioRemoved || contactSheetRemoved || generatedResultRemoved || videoResultRemoved;
    if (!changed) return { value: project, changed: false } as const;

    const references = {
        product: productRemoved ? undefined : normalized.references.product,
        character: characterRemoved ? undefined : normalized.references.character,
        characterSupplement: characterSupplementRemoved ? undefined : normalized.references.characterSupplement,
        background: backgroundRemoved ? undefined : normalized.references.background,
        audio: audioRemoved ? undefined : normalized.references.audio,
    };
    const revision = Math.max(0, Number.isInteger(project.revision) ? project.revision : 0) + 1;
    if (!sourceVideoRemoved && !framesRemoved) {
        return {
            value: withUpdatedAt({
                ...normalized,
                revision,
                mergedVideo: undefined,
                mergedVideoInputVersion: undefined,
                references,
                groups,
                pipeline: invalidateRemakeMediaPipeline(normalized.pipeline, {
                    references: referenceInputRemoved || contactSheetRemoved,
                    images: generatedResultRemoved || referenceInputRemoved || contactSheetRemoved,
                    prompts: narrationAudioRemoved,
                }),
            }),
            changed: true,
        } as const;
    }

    const error = sourceVideoRemoved ? "源视频已从媒体库删除，请重新上传后分析" : "部分抽帧已从媒体库删除，请重新分析";
    const pipeline = defaultRemakeProductPipeline({ hasSourceVideo: !sourceVideoRemoved && Boolean(normalized.sourceVideo), analysisStatus: "error" });
    pipeline.steps.analysis = { status: "error", error };
    return {
        value: withUpdatedAt({
            ...normalized,
            revision,
            mergedVideo: undefined,
            mergedVideoInputVersion: undefined,
            sourceVideo: sourceVideoRemoved ? undefined : normalized.sourceVideo,
            sourceCopy: "",
            frames: [],
            copyBlocks: [],
            references: { ...references, audio: undefined },
            groups: emptyRemakeProductRangeGroups(),
            copy: emptyRemakeProductCopyState(),
            pipeline,
            analysis: { status: "error" as const, error },
        }),
        changed: true,
    } as const;
}


function cleanRemakePersonProjectMediaReferences(project: RemakePersonProject, storageKeys: string[]) {
    const normalized = normalizeRemakePersonProjectWorkflow(project);
    const sourceVideoRemoved = mediaAssetDeleted(normalized.sourceVideo, storageKeys);
    const framesRemoved = normalized.frames.some((frame) => containsUserMediaReference({ storageKey: frame.storageKey, url: frame.frameUrl }, storageKeys));
    const productRemoved = mediaAssetDeleted(normalized.references.product, storageKeys);
    const characterRemoved = mediaAssetDeleted(normalized.references.character, storageKeys);
    const characterSupplementRemoved = mediaAssetDeleted(normalized.references.characterSupplement, storageKeys);
    const backgroundRemoved = mediaAssetDeleted(normalized.references.background, storageKeys);
    const audioRemoved = mediaAssetDeleted(normalized.references.audio, storageKeys);
    const narrationAudioRemoved = audioRemoved && !isRemakePersonNoNarrationCopy(normalized.sourceCopy);
    const referenceInputRemoved = productRemoved || characterRemoved || characterSupplementRemoved || backgroundRemoved;
    let contactSheetRemoved = false;
    let replacementResultRemoved = false;
    let storyboardResultRemoved = false;
    let videoResultRemoved = false;
    const groups = normalized.groups.map((group) => {
        const removeContactSheet = mediaAssetDeleted(group.sourceContactSheet, storageKeys);
        const removeReplacement = mediaAssetDeleted(group.replacementGeneration.result, storageKeys);
        const removeStoryboard = mediaAssetDeleted(group.imageGeneration.result, storageKeys);
        const removeVideo = mediaAssetDeleted(group.videoGeneration.result, storageKeys);
        contactSheetRemoved ||= removeContactSheet;
        replacementResultRemoved ||= removeReplacement;
        storyboardResultRemoved ||= removeStoryboard;
        videoResultRemoved ||= removeVideo;
        const replacementInvalid = removeContactSheet || removeReplacement || referenceInputRemoved;
        const storyboardInvalid = replacementInvalid || removeStoryboard;
        if (!replacementInvalid && !storyboardInvalid && !narrationAudioRemoved && !removeVideo) return group;
        return {
            ...group,
            sourceContactSheet: removeContactSheet ? undefined : group.sourceContactSheet,
            replacementGeneration: replacementInvalid ? { status: "idle" as const, prompt: "" } : group.replacementGeneration,
            imageGeneration: storyboardInvalid ? { status: "idle" as const, prompt: "" } : group.imageGeneration,
            videoPrompt: storyboardInvalid || narrationAudioRemoved ? "" : group.videoPrompt,
            videoGeneration: storyboardInvalid || narrationAudioRemoved || removeVideo ? { status: "idle" as const } : group.videoGeneration,
        };
    });
    const generatedResultRemoved = replacementResultRemoved || storyboardResultRemoved;
    const mergedRemoved = mediaAssetDeleted(project.mergedVideo, storageKeys);
    const changed = mergedRemoved || sourceVideoRemoved || framesRemoved || referenceInputRemoved || audioRemoved || contactSheetRemoved || generatedResultRemoved || videoResultRemoved;
    if (!changed) return { value: project, changed: false } as const;

    const references = {
        product: productRemoved ? undefined : normalized.references.product,
        character: characterRemoved ? undefined : normalized.references.character,
        characterSupplement: characterSupplementRemoved ? undefined : normalized.references.characterSupplement,
        background: backgroundRemoved ? undefined : normalized.references.background,
        audio: audioRemoved ? undefined : normalized.references.audio,
    };
    const revision = Math.max(0, Number.isInteger(project.revision) ? project.revision : 0) + 1;
    if (!sourceVideoRemoved && !framesRemoved) {
        return {
            value: withUpdatedAt({
                ...normalized,
                revision,
                mergedVideo: undefined,
                mergedVideoInputVersion: undefined,
                references,
                groups,
                pipeline: invalidateRemakeMediaPipeline(normalized.pipeline, {
                    references: referenceInputRemoved || contactSheetRemoved,
                    images: generatedResultRemoved || referenceInputRemoved || contactSheetRemoved,
                    prompts: narrationAudioRemoved,
                }),
            }),
            changed: true,
        } as const;
    }

    const error = sourceVideoRemoved ? "源视频已从媒体库删除，请重新上传后分析" : "部分抽帧已从媒体库删除，请重新分析";
    const pipeline = defaultRemakePersonPipeline({ hasSourceVideo: !sourceVideoRemoved && Boolean(normalized.sourceVideo), analysisStatus: "error" });
    pipeline.steps.analysis = { status: "error", error };
    return {
        value: withUpdatedAt({
            ...normalized,
            revision,
            mergedVideo: undefined,
            mergedVideoInputVersion: undefined,
            sourceVideo: sourceVideoRemoved ? undefined : normalized.sourceVideo,
            sourceCopy: "",
            frames: [],
            copyBlocks: [],
            references: { ...references, audio: undefined },
            groups: emptyRemakePersonRangeGroups(),
            copy: emptyRemakePersonCopyState(),
            pipeline,
            analysis: { status: "error" as const, error },
        }),
        changed: true,
    } as const;
}


async function cleanAdditionalWorkflowProjects<T extends { updatedAt: string }>(client: QueryExecutor, table: "remake60_projects" | "remake_product_projects" | "remake_person_projects" | "omni_clothing_projects" | "omni_remake_projects" | "bangbang_projects", userId: string, storageKeys: string[], clean: (value: T, keys: string[]) => { value: T; changed: boolean }) {
    const result = await client.query<{ id: string; project_json: T }>(`SELECT id, project_json FROM ${table} WHERE user_id = $1 AND ${matchesJsonColumns(table, ["project_json"])} FOR UPDATE`, [userId, storageKeys]);
    let changed = 0;
    for (const row of result.rows) {
        const cleaned = clean(row.project_json, storageKeys);
        if (!cleaned.changed) continue;
        await client.query(`UPDATE ${table} SET project_json = $3::jsonb, updated_at = $4 WHERE user_id = $1 AND id = $2`, [userId, row.id, JSON.stringify(cleaned.value), new Date(cleaned.value.updatedAt)]);
        changed += 1;
    }
    return changed;
}
