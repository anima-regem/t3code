// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { assert, describe, it } from "@effect/vitest";

import { readBobDatabaseRecords } from "./usageBobDatabase.ts";

/** Creates a temp directory, writes a Bob-style SQLite database into it, and
 * returns the db path and a cleanup thunk. */
async function makeTestDb(
  rows: {
    taskId: string;
    createdAt: number;
    env?: string;
    messageData: Record<string, unknown>;
  }[],
): Promise<{ dbPath: string; cleanup: () => Promise<void> }> {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "bob-usage-test-"));
  const dbPath = NodePath.join(dir, "bob.db");
  const db = new NodeSqlite.DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      directory TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT 0,
      env TEXT
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  for (const row of rows) {
    db.prepare("INSERT INTO tasks (id, created_at, env) VALUES (?, ?, ?)").run(
      row.taskId,
      row.createdAt,
      row.env ?? null,
    );
    db.prepare(
      "INSERT INTO messages (id, task_id, role, data, created_at) VALUES (?, ?, 'assistant', ?, ?)",
    ).run(`msg-${row.taskId}`, row.taskId, JSON.stringify(row.messageData), row.createdAt);
  }
  db.close();
  return { dbPath, cleanup: () => NodeFSP.rm(dir, { recursive: true, force: true }) };
}

/** A well-formed Bob assistant message with spend data. */
function bobMessage(overrides: {
  timestamp?: number;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: number;
  reasoningTokens?: number;
}): Record<string, unknown> {
  return {
    role: "assistant",
    content: "hello",
    _meta: {
      timestamp: overrides.timestamp ?? 1_788_500_000_000,
      spend: {
        input: overrides.input ?? 100,
        output: overrides.output ?? 50,
        cacheRead: overrides.cacheRead ?? 0,
        cacheWrite: overrides.cacheWrite ?? 0,
        cost: overrides.cost ?? 0.01,
        reasoningTokens: overrides.reasoningTokens ?? 0,
      },
    },
  };
}

describe("readBobDatabaseRecords", () => {
  it("returns empty array when the database file does not exist", async () => {
    const records = readBobDatabaseRecords("/nonexistent/path/bob.db", 0, Date.now());
    assert.strictEqual(records.length, 0);
  });

  it("parses token totals from assistant messages with spend", async () => {
    const { dbPath, cleanup } = await makeTestDb([
      {
        taskId: "task-1",
        createdAt: 1_788_500_000_000,
        messageData: bobMessage({
          input: 200,
          output: 50,
          cacheRead: 30,
          cacheWrite: 10,
          cost: 0.02,
        }),
      },
    ]);
    try {
      const records = readBobDatabaseRecords(dbPath, 0, Date.now() + 1_000_000);
      assert.strictEqual(records.length, 1);
      const rec = records[0]!;
      assert.strictEqual(rec.provider, "bob");
      // input=200 is inclusive of cacheRead=30 and cacheWrite=10
      assert.strictEqual(rec.totals.uncachedInputTokens, 160); // 200 - 30 - 10
      assert.strictEqual(rec.totals.cachedInputTokens, 30);
      assert.strictEqual(rec.totals.cacheCreationTokens, 10);
      assert.strictEqual(rec.totals.outputTokens, 50);
      assert.strictEqual(rec.totals.reasoningTokens, 0);
      assert.strictEqual(rec.reportedCostUsd, 0.02);
      assert.strictEqual(rec.sessionId, "task-1");
      assert.isNull(rec.dedupeKey);
    } finally {
      await cleanup();
    }
  });

  it("uses commandSecurityModel from tasks.env as model when present", async () => {
    const env = JSON.stringify({ _meta: { commandSecurityModel: "anthropic/claude-3-7-sonnet" } });
    const { dbPath, cleanup } = await makeTestDb([
      {
        taskId: "task-model",
        createdAt: 1_788_500_000_000,
        env,
        messageData: bobMessage({ input: 50, output: 10 }),
      },
    ]);
    try {
      const records = readBobDatabaseRecords(dbPath, 0, Date.now() + 1_000_000);
      assert.strictEqual(records[0]?.model, "anthropic/claude-3-7-sonnet");
    } finally {
      await cleanup();
    }
  });

  it("falls back to 'bob' as the model when env is absent", async () => {
    const { dbPath, cleanup } = await makeTestDb([
      {
        taskId: "task-nomodel",
        createdAt: 1_788_500_000_000,
        messageData: bobMessage({ input: 50, output: 10 }),
      },
    ]);
    try {
      const records = readBobDatabaseRecords(dbPath, 0, Date.now() + 1_000_000);
      assert.strictEqual(records[0]?.model, "bob");
    } finally {
      await cleanup();
    }
  });

  it("filters records outside the time window", async () => {
    const ts = 1_788_500_000_000;
    const { dbPath, cleanup } = await makeTestDb([
      {
        taskId: "inside",
        createdAt: ts,
        messageData: bobMessage({ timestamp: ts, input: 10, output: 5 }),
      },
      {
        taskId: "before",
        createdAt: ts - 10_000,
        messageData: bobMessage({ timestamp: ts - 10_000, input: 10, output: 5 }),
      },
      {
        taskId: "after",
        createdAt: ts + 10_000,
        messageData: bobMessage({ timestamp: ts + 10_000, input: 10, output: 5 }),
      },
    ]);
    try {
      // sinceMs=ts-1 (inclusive), untilMs=ts+1 (exclusive)
      const records = readBobDatabaseRecords(dbPath, ts - 1, ts + 1);
      assert.strictEqual(records.length, 1);
      assert.strictEqual(records[0]?.sessionId, "inside");
    } finally {
      await cleanup();
    }
  });

  it("skips messages with zero total tokens", async () => {
    const { dbPath, cleanup } = await makeTestDb([
      {
        taskId: "zero",
        createdAt: 1_788_500_000_000,
        messageData: {
          role: "assistant",
          _meta: {
            timestamp: 1_788_500_000_000,
            spend: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
          },
        },
      },
    ]);
    try {
      const records = readBobDatabaseRecords(dbPath, 0, Date.now() + 1_000_000);
      assert.strictEqual(records.length, 0);
    } finally {
      await cleanup();
    }
  });

  it("skips messages without a spend payload", async () => {
    const { dbPath, cleanup } = await makeTestDb([
      {
        taskId: "nospend",
        createdAt: 1_788_500_000_000,
        messageData: {
          role: "assistant",
          content: "hello",
          _meta: { timestamp: 1_788_500_000_000 },
        },
      },
    ]);
    try {
      const records = readBobDatabaseRecords(dbPath, 0, Date.now() + 1_000_000);
      assert.strictEqual(records.length, 0);
    } finally {
      await cleanup();
    }
  });

  it("clamps reasoningTokens to outputTokens", async () => {
    const { dbPath, cleanup } = await makeTestDb([
      {
        taskId: "reasoning",
        createdAt: 1_788_500_000_000,
        messageData: bobMessage({ input: 100, output: 30, reasoningTokens: 9999 }),
      },
    ]);
    try {
      const records = readBobDatabaseRecords(dbPath, 0, Date.now() + 1_000_000);
      // reasoningTokens must be clamped to outputTokens=30
      assert.strictEqual(records[0]?.totals.reasoningTokens, 30);
    } finally {
      await cleanup();
    }
  });
});
