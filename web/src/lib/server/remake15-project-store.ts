import type { RemakeProject, RemakeProjectSummaryPage } from "@/lib/server/remake15-project-contract";
import { summarizeRemakeProject } from "@/lib/server/remake15-project-contract";
import { readJsonDataFile, withJsonDataFileLock, writeJsonDataFile } from "@/lib/server/data-adapter";
import { ensurePostgresSchema, getDatabaseProvider, postgresQuery, withPostgresTransaction } from "@/lib/server/database";

type RemakeProjectRecord = { userId: string; project: RemakeProject };
type RemakeProjectDatabase = { version: 1; projects: RemakeProjectRecord[] };

const FILE_NAME = "remake15-projects.json";

export async function listRemakeProjectSummaries(userId: string, input: { page?: number; pageSize?: number } = {}): Promise<RemakeProjectSummaryPage> {
    const page = Math.max(1, Math.floor(Number(input.page) || 1));
    const pageSize = Math.max(1, Math.min(100, Math.floor(Number(input.pageSize) || 20)));
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        const result = await postgresQuery<{ project_json: RemakeProject; total_count: number | string }>(
            `SELECT project_json, COUNT(*) OVER() AS total_count
             FROM remake15_projects
             WHERE user_id = $1
             ORDER BY updated_at DESC, id DESC
             LIMIT $2 OFFSET $3`,
            [userId, pageSize, (page - 1) * pageSize],
        );
        return { items: result.rows.map((row) => summarizeRemakeProject(row.project_json)), total: Number(result.rows[0]?.total_count) || 0, page, pageSize };
    }
    const summaries = (await readDatabase()).projects
        .filter((record) => record.userId === userId)
        .map((record) => summarizeRemakeProject(record.project))
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id));
    return { items: summaries.slice((page - 1) * pageSize, page * pageSize), total: summaries.length, page, pageSize };
}

export async function getRemakeProject(id: string, userId: string): Promise<RemakeProject | null> {
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        const result = await postgresQuery<{ project_json: RemakeProject }>("SELECT project_json FROM remake15_projects WHERE id = $1 AND user_id = $2", [id, userId]);
        return result.rows[0]?.project_json || null;
    }
    return (await readDatabase()).projects.find((record) => record.userId === userId && record.project.id === id)?.project || null;
}

export async function createRemakeProject(userId: string, project: RemakeProject) {
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        const result = await postgresQuery(
            `INSERT INTO remake15_projects (id, user_id, title, status, project_json, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
             ON CONFLICT DO NOTHING
             RETURNING id`,
            [project.id, userId, project.title, project.status, JSON.stringify(project), new Date(project.createdAt), new Date(project.updatedAt)],
        );
        if (!result.rows[0]) throw new RemakeProjectStoreError("复刻项目已存在", 409);
        return project;
    }
    return withFileMutation((database) => {
        if (database.projects.some((record) => record.project.id === project.id)) throw new RemakeProjectStoreError("复刻项目已存在", 409);
        return { database: { ...database, projects: [{ userId, project }, ...database.projects] }, result: project };
    });
}

export async function updateRemakeProject(userId: string, project: RemakeProject, expectedRevision: number) {
    const updated = await mutateRemakeProject(userId, project.id, (current) => {
        if (current.revision !== expectedRevision) throw new RemakeProjectStoreError("复刻项目已在其他页面更新，请刷新后重试", 409);
        return project;
    });
    if (!updated) throw new RemakeProjectStoreError("复刻项目不存在", 404);
    return updated;
}

export async function mutateRemakeProject(userId: string, id: string, mutate: (current: RemakeProject) => RemakeProject | null): Promise<RemakeProject | null> {
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        return withPostgresTransaction(async (client) => {
            const selected = await client.query<{ project_json: RemakeProject }>("SELECT project_json FROM remake15_projects WHERE id = $1 AND user_id = $2 FOR UPDATE", [id, userId]);
            const current = selected.rows[0]?.project_json;
            if (!current) return null;
            const next = mutate(current);
            if (!next) return current;
            assertMutationIdentity(next, current);
            await client.query(
                `UPDATE remake15_projects
                 SET title = $3, status = $4, project_json = $5::jsonb, updated_at = $6
                 WHERE id = $1 AND user_id = $2`,
                [id, userId, next.title, next.status, JSON.stringify(next), new Date(next.updatedAt)],
            );
            return next;
        });
    }
    return withFileMutation((database) => {
        let result: RemakeProject | null = null;
        const projects = database.projects.map((record) => {
            if (record.userId !== userId || record.project.id !== id) return record;
            const next = mutate(record.project);
            result = next || record.project;
            if (!next) return record;
            assertMutationIdentity(next, record.project);
            return { ...record, project: next };
        });
        return { database: { ...database, projects }, result };
    });
}

export async function deleteRemakeProject(userId: string, id: string) {
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        const result = await postgresQuery<{ project_json: RemakeProject }>("DELETE FROM remake15_projects WHERE id = $1 AND user_id = $2 RETURNING project_json", [id, userId]);
        return result.rows[0]?.project_json || null;
    }
    return withFileMutation((database) => {
        let deleted: RemakeProject | null = null;
        const projects = database.projects.filter((record) => {
            if (record.userId === userId && record.project.id === id) {
                deleted = record.project;
                return false;
            }
            return true;
        });
        return { database: { ...database, projects }, result: deleted };
    });
}

function readDatabase() {
    return readJsonDataFile<RemakeProjectDatabase>(FILE_NAME, { version: 1, projects: [] });
}

function withFileMutation<T>(mutate: (database: RemakeProjectDatabase) => { database: RemakeProjectDatabase; result: T }) {
    return withJsonDataFileLock(FILE_NAME, async () => {
        const mutation = mutate(await readDatabase());
        await writeJsonDataFile(FILE_NAME, mutation.database);
        return mutation.result;
    });
}

function assertMutationIdentity(next: RemakeProject, current: RemakeProject) {
    if (next.id !== current.id || next.createdAt !== current.createdAt) throw new Error("复刻项目更新不能改变项目身份");
}

export class RemakeProjectStoreError extends Error {
    constructor(
        message: string,
        readonly status: number,
    ) {
        super(message);
        this.name = "RemakeProjectStoreError";
    }
}
