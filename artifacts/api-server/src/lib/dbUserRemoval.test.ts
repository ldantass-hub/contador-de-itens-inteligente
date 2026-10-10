import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => {
  const users = { id: { name: "users.id" } };
  const sessions = {
    id: { name: "sessions.id" },
    userId: { name: "sessions.user_id" },
    status: { name: "sessions.status" },
    startTime: { name: "sessions.start_time" },
    operatorUserId: { name: "sessions.operator_user_id" },
    operatorUsername: { name: "sessions.operator_username" },
  };
  const counts = { id: { name: "counts.id" }, sessionId: { name: "counts.session_id" } };
  const itens = { id: { name: "itens.id" } };
  const updates: Array<{ table: object; values: object; condition: unknown }> = [];
  const transactionDeletes: Array<{ table: object; condition: unknown }> = [];
  const selectedTables: object[] = [];
  const queryState: { targetRows: object[]; sessions: object[]; selectCount: number } = {
    targetRows: [{ id: 9 }],
    sessions: [],
    selectCount: 0,
  };

  const tx = {
    select: vi.fn(() => {
      const selectIndex = queryState.selectCount++;
      const builder: Record<string, ReturnType<typeof vi.fn>> = {};
      builder.from = vi.fn(table => {
        selectedTables.push(table as object);
        return builder;
      });
      builder.where = vi.fn(() => builder);
      builder.for = vi.fn(() => selectIndex === 0 ? builder : Promise.resolve(queryState.sessions));
      builder.orderBy = vi.fn(() => builder);
      builder.limit = vi.fn(() => Promise.resolve(queryState.targetRows));
      return builder;
    }),
    update: vi.fn((table: object) => ({
      set: vi.fn((values: object) => ({
        where: vi.fn(async (condition: unknown) => {
          updates.push({ table, values, condition });
        }),
      })),
    })),
    delete: vi.fn((table: object) => ({
      where: vi.fn(async (condition: unknown) => {
        transactionDeletes.push({ table, condition });
      }),
    })),
  };

  const db = {
    delete: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
    transaction: vi.fn((callback: (transaction: typeof tx) => unknown) => callback(tx)),
  };

  return {
    users,
    sessions,
    counts,
    itens,
    updates,
    transactionDeletes,
    selectedTables,
    queryState,
    tx,
    db,
    existsSync: vi.fn(() => true),
    mkdirSync: vi.fn(),
    appendFileSync: vi.fn(),
    operators: {
      and: vi.fn((...values: unknown[]) => ({ kind: "and", values })),
      desc: vi.fn((value: unknown) => ({ kind: "desc", value })),
      eq: vi.fn((...values: unknown[]) => ({ kind: "eq", values })),
      gte: vi.fn((...values: unknown[]) => ({ kind: "gte", values })),
      lte: vi.fn((...values: unknown[]) => ({ kind: "lte", values })),
      sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({ kind: "sql", strings, values })),
    },
  };
});

vi.mock("@workspace/db", () => ({ db: state.db }));
vi.mock("@workspace/db/schema", () => ({
  users: state.users,
  sessions: state.sessions,
  counts: state.counts,
  itens: state.itens,
}));
vi.mock("drizzle-orm", () => state.operators);
vi.mock("fs", () => ({
  default: {
    existsSync: state.existsSync,
    mkdirSync: state.mkdirSync,
    appendFileSync: state.appendFileSync,
  },
}));

let removeUser: typeof import("./db.js").removeUser;

describe("removeUser transaction logic", () => {
  beforeAll(async () => {
    vi.stubEnv("BOOTSTRAP_USER_USERNAME", "");
    vi.stubEnv("BOOTSTRAP_USER_PASSWORD", "");
    vi.stubEnv("BOOTSTRAP_ADMIN_USERNAME", "");
    vi.stubEnv("BOOTSTRAP_ADMIN_PASSWORD", "");
    ({ removeUser } = await import("./db.js"));
  });

  beforeEach(() => {
    state.updates.length = 0;
    state.transactionDeletes.length = 0;
    state.selectedTables.length = 0;
    state.queryState.targetRows = [{ id: 9 }];
    state.queryState.sessions = [];
    state.queryState.selectCount = 0;
    state.tx.select.mockClear();
    state.tx.update.mockClear();
    state.tx.delete.mockClear();
    state.db.transaction.mockClear();
  });

  afterAll(() => {
    vi.unstubAllEnvs();
  });

  it("runs in one transaction, finalizes active-session fields, and deletes only the user", async () => {
    state.queryState.sessions = [{ id: 31 }, { id: 32 }];

    await expect(removeUser(9, 1)).resolves.toBe("deleted");

    expect(state.db.transaction).toHaveBeenCalledOnce();
    expect(state.selectedTables).toEqual([state.users, state.sessions]);
    expect(state.updates).toHaveLength(2);
    expect(state.updates[0].table).toBe(state.users);
    expect(state.updates[0].condition).toEqual({
      kind: "eq",
      values: [state.users.id, 9],
    });
    expect(state.updates[1].table).toBe(state.sessions);
    expect(state.updates[1].values).toEqual(expect.objectContaining({
      status: "finished",
      endTime: expect.any(String),
    }));
    expect(state.updates[1].values).not.toHaveProperty("userId");
    expect(state.updates[1].values).not.toHaveProperty("operatorUserId");
    expect(state.updates[1].values).not.toHaveProperty("operatorUsername");
    expect(state.updates[1].condition).toEqual({
      kind: "and",
      values: [
        { kind: "eq", values: [state.sessions.userId, 9] },
        { kind: "eq", values: [state.sessions.status, "active"] },
      ],
    });
    expect(state.transactionDeletes).toEqual([{
      table: state.users,
      condition: { kind: "eq", values: [state.users.id, 9] },
    }]);
    expect(state.tx.delete).not.toHaveBeenCalledWith(state.counts);
    expect(state.appendFileSync).not.toHaveBeenCalled();
    expect(state.mkdirSync).not.toHaveBeenCalled();
  });

  it("does not update sessions when the user has no sessions", async () => {
    await expect(removeUser(9, 1)).resolves.toBe("deleted");

    expect(state.updates.map(update => update.table)).toEqual([state.users]);
    expect(state.transactionDeletes).toEqual([{
      table: state.users,
      condition: { kind: "eq", values: [state.users.id, 9] },
    }]);
    expect(state.tx.delete).not.toHaveBeenCalledWith(state.counts);
  });

  it("returns self without opening a transaction", async () => {
    await expect(removeUser(9, 9)).resolves.toBe("self");

    expect(state.db.transaction).not.toHaveBeenCalled();
    expect(state.tx.delete).not.toHaveBeenCalled();
  });

  it("returns not_found without updating or deleting records", async () => {
    state.queryState.targetRows = [];

    await expect(removeUser(404, 1)).resolves.toBe("not_found");

    expect(state.db.transaction).toHaveBeenCalledOnce();
    expect(state.tx.update).not.toHaveBeenCalled();
    expect(state.tx.delete).not.toHaveBeenCalled();
  });

  it("propagates transaction query errors and does not continue to delete", async () => {
    const failure = new Error("query failed");
    state.tx.select.mockImplementationOnce(() => {
      throw failure;
    });

    await expect(removeUser(9, 1)).rejects.toBe(failure);

    expect(state.db.transaction).toHaveBeenCalledOnce();
    expect(state.tx.delete).not.toHaveBeenCalled();
  });
});
