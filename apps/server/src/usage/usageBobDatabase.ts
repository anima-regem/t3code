// @effect-diagnostics nodeBuiltinImport:off
/**
 * Usage reader for IBM Bob Shell's SQLite database (`~/.bob/db/bob.db`).
 *
 * Bob stores per-message token spend in the `messages` table's `data` JSON
 * column rather than writing JSONL transcript files. This module queries the
 * database read-only and converts assistant messages that carry `_meta.spend`
 * into the same {@link UsageRecord} shape used by the other providers.
 *
 * The `tasks` table links messages to sessions (task IDs) and carries the wall
 * timestamp; `messages.created_at` mirrors this. Model is not stored per
 * message — Bob uses a single configured model per session, reported via
 * the `model/info` API endpoint but not persisted — so every record uses the
 * model slug from `tasks.env._meta.commandSecurityModel` when present, falling
 * back to the literal `"bob"`.
 *
 * Bob's `spend.input` is *inclusive* of `cacheRead` and `cacheWrite`, matching
 * the Codex / Grok convention. `uncachedInputTokens` is derived by subtraction.
 *
 * @module usageBobDatabase
 */
import * as NodeSqlite from "node:sqlite";

import type { UsageRecord } from "./usageTranscripts.ts";
import { totalTokens } from "./usageTranscripts.ts";

/**
 * One row returned by the query, with just the fields we need.
 *
 * `node:sqlite` returns plain JS objects; keep this interface tight so
 * TypeScript can narrow without casting the whole row.
 */
interface BobMessageRow {
  readonly task_id: string;
  readonly task_created_at: number;
  readonly data: string;
  readonly task_model: string | null;
}

/**
 * Reads all Bob assistant messages in the given time window from the database
 * at `dbPath` and returns them as {@link UsageRecord}s.
 *
 * The database is opened read-only so the call is safe while Bob has the file
 * open for writing. Returns an empty array when the file does not exist or
 * cannot be opened — the same contract as a missing transcript directory.
 *
 * `sinceMs` / `untilMs` are inclusive / exclusive epoch-millisecond bounds
 * that map to `messages.created_at` (which Bob stores as epoch milliseconds).
 */
export function readBobDatabaseRecords(
  dbPath: string,
  sinceMs: number,
  untilMs: number,
): readonly UsageRecord[] {
  let db: NodeSqlite.DatabaseSync;
  try {
    db = new NodeSqlite.DatabaseSync(dbPath, { open: true, readOnly: true });
  } catch {
    return [];
  }

  try {
    // Join tasks to get created_at (the task start time, which is the wall
    // time for the whole session) and env (which carries the model slug).
    // messages.created_at is also epoch-ms and is used for the time filter.
    const stmt = db.prepare(`
      SELECT
        m.task_id,
        m.created_at AS task_created_at,
        m.data,
        t.env AS task_model
      FROM messages m
      JOIN tasks t ON t.id = m.task_id
      WHERE m.role = 'assistant'
        AND m.created_at >= ?
        AND m.created_at < ?
    `);

    const rows = stmt.all(sinceMs, untilMs) as unknown as BobMessageRow[];
    const records: UsageRecord[] = [];

    for (const row of rows) {
      const record = parseBobRow(row);
      if (record !== null) records.push(record);
    }

    return records;
  } catch {
    return [];
  } finally {
    try {
      db.close();
    } catch {
      // Best-effort close.
    }
  }
}

function parseBobRow(row: BobMessageRow): UsageRecord | null {
  let data: unknown;
  try {
    data = JSON.parse(row.data);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;

  const meta = (data as Record<string, unknown>)["_meta"];
  if (typeof meta !== "object" || meta === null) return null;
  const metaRecord = meta as Record<string, unknown>;

  const spend = metaRecord["spend"];
  if (typeof spend !== "object" || spend === null) return null;
  const spendRecord = spend as Record<string, unknown>;

  const timestamp = metaRecord["timestamp"];
  const timestampMs =
    typeof timestamp === "number" && Number.isFinite(timestamp) ? timestamp : row.task_created_at;
  if (!Number.isFinite(timestampMs)) return null;

  const inputInclusive = spendInt(spendRecord["input"]);
  const cacheRead = spendInt(spendRecord["cacheRead"]);
  const cacheWrite = spendInt(spendRecord["cacheWrite"]);
  const outputTokens = spendInt(spendRecord["output"]);
  const reasoningTokens = Math.min(outputTokens, spendInt(spendRecord["reasoningTokens"]));

  // Bob reports input inclusive of cache (same as Codex/Grok).
  const uncachedInputTokens = Math.max(0, inputInclusive - cacheRead - cacheWrite);

  const totals = {
    uncachedInputTokens,
    cachedInputTokens: cacheRead,
    cacheCreationTokens: cacheWrite,
    outputTokens,
    reasoningTokens,
  };

  if (totalTokens(totals) === 0) return null;

  const cost = spendRecord["cost"];
  const reportedCostUsd =
    typeof cost === "number" && Number.isFinite(cost) && cost > 0 ? cost : null;

  // Prefer the per-task model slug stored in tasks.env._meta.commandSecurityModel;
  // fall back to the literal "bob" when it is absent.
  const model = resolveModel(row.task_model) ?? "bob";

  // task_id doubles as the session ID — it is stable across all messages in
  // one Bob task and maps cleanly to a "session" for bucketing purposes.
  return {
    provider: "bob" as const,
    timestampMs,
    model,
    sessionId: row.task_id,
    totals,
    reportedCostUsd,
    // Each assistant message in Bob is a distinct turn; there are no
    // cross-file duplicates to remove.
    dedupeKey: null,
  };
}

function spendInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

/** Extracts the model slug from tasks.env JSON string, or returns null. */
function resolveModel(envJson: string | null): string | null {
  if (envJson === null) return null;
  try {
    const env = JSON.parse(envJson) as unknown;
    if (typeof env !== "object" || env === null) return null;
    const meta = (env as Record<string, unknown>)["_meta"];
    if (typeof meta !== "object" || meta === null) return null;
    const slug = (meta as Record<string, unknown>)["commandSecurityModel"];
    return typeof slug === "string" && slug.length > 0 ? slug : null;
  } catch {
    return null;
  }
}
