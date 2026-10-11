import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { addPlayer, createGame, type GameState } from "./game";
import { ApiError, createRoom, listRooms } from "./rooms";

const NOW = Date.UTC(2026, 9, 10, 12);
const DAY = 24 * 3600 * 1000;
const HIDDEN = "private-discovery-marker";
type ListedRow = {
  code: string;
  state: GameState;
  created_at: string;
  sessions: unknown;
};
type Call = { method: string; url: URL; body?: Record<string, unknown> };

function row(
  code: string,
  options: {
    isPublic?: boolean;
    count?: number;
    status?: GameState["status"];
    age?: number;
    bots?: number;
  } = {},
): ListedRow {
  const { count = 2, age = 1000, bots = 0 } = options;
  let state = createGame(`host-${code}`, "Анна");
  for (let n = 1; n < count; n++)
    state = addPlayer(state, `player-${code}-${n}`, `Игрок ${n}`);
  if (options.isPublic !== undefined) state.isPublic = options.isPublic;
  if (options.status) state.status = options.status;
  state.players.forEach((player, n) => {
    if (n > 0 && n <= bots) player.isBot = true;
    player.hand = [
      { id: `${HIDDEN}-hand-${n}`, kind: "number", color: "red", value: 7 },
    ];
  });
  state.drawPile = [{ id: `${HIDDEN}-deck`, kind: "wild", color: null }];
  state.discardPile = [
    { id: `${HIDDEN}-discard`, kind: "number", color: "blue", value: 2 },
  ];
  state.chat.push({
    id: HIDDEN,
    playerId: state.hostId,
    text: HIDDEN,
    at: NOW,
  });
  return {
    code,
    state,
    created_at: new Date(NOW - age).toISOString(),
    sessions: { [state.hostId]: { hash: HIDDEN, token: HIDDEN, requests: [] } },
  };
}

/** Run the real handlers and SDK with a controlled database transport only. */
function mockDatabase(t: TestContext, respond: (call: Call) => Response) {
  const oldUrl = process.env.SUPABASE_URL;
  const oldKey = process.env.SUPABASE_SECRET_KEY;
  process.env.SUPABASE_URL = "https://test.supabase.co";
  process.env.SUPABASE_SECRET_KEY = "test-server-key";
  t.after(() => {
    if (oldUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = oldUrl;
    if (oldKey === undefined) delete process.env.SUPABASE_SECRET_KEY;
    else process.env.SUPABASE_SECRET_KEY = oldKey;
  });
  t.mock.method(Date, "now", () => NOW);
  const calls: Call[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const call: Call = {
        method: init?.method ?? "GET",
        url: new URL(String(input)),
        ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
      };
      calls.push(call);
      return respond(call);
    },
  );
  return calls;
}

test("room discovery returns only public, unfilled, unexpired lobbies and safe summaries", async (t) => {
  const publicRoom = row("OPEN23", { isPublic: true, count: 3, bots: 1 });
  const hostOnly = row("HOST23", { isPublic: true, count: 1 });
  const rows = [
    publicRoom,
    hostOnly,
    row("PRIV23", { isPublic: false }),
    row("LEGA23"), // An old state with no visibility field stays private.
    row("FULL23", { isPublic: true, count: 6 }),
    row("OLD234", { isPublic: true, age: DAY + 1 }),
    row("PLAY23", { isPublic: true, status: "playing" }),
    row("DONE23", { isPublic: true, status: "round_end" }),
    row("FINI23", { isPublic: true, status: "finished" }),
  ];
  // Returning deliberately mixed rows also checks the handler's defense after
  // the database filters, rather than trusting the mock to enforce them.
  const calls = mockDatabase(t, (call) => {
    assert.equal(call.method, "GET");
    return Response.json(rows);
  });
  const result = await listRooms();
  assert.deepEqual(
    new Set(result.rooms.map((room) => room.code)),
    new Set(["OPEN23", "HOST23"]),
  );
  assert.deepEqual(
    result.rooms.find((room) => room.code === "OPEN23"),
    {
      code: "OPEN23",
      hostName: "Анна",
      playerCount: 3,
      botCount: 1,
      createdAt: publicRoom.created_at,
    },
  );
  assert.equal(
    result.rooms.find((room) => room.code === "HOST23")?.playerCount,
    1,
  );
  for (const summary of result.rooms) {
    assert.deepEqual(Object.keys(summary).sort(), [
      "botCount",
      "code",
      "createdAt",
      "hostName",
      "playerCount",
    ]);
    for (const forbidden of [
      "state",
      "players",
      "hand",
      "drawPile",
      "discardPile",
      "sessions",
      "token",
      "hostId",
      "chat",
    ])
      assert.equal(forbidden in summary, false);
  }
  assert.equal(JSON.stringify(result).includes(HIDDEN), false);
  assert.equal(calls.length, 1);
});

test("room discovery queries only recent public lobbies with a bounded newest-first result", async (t) => {
  const calls = mockDatabase(t, () => Response.json([]));
  assert.deepEqual(await listRooms(), { rooms: [] });
  assert.equal(calls.length, 1);
  const { url, method } = calls[0];
  assert.equal(method, "GET");
  assert.equal(url.pathname, "/rest/v1/svintus_rooms");
  assert.equal(url.searchParams.get("state->>status"), "eq.lobby");
  assert.equal(url.searchParams.get("state->>isPublic"), "eq.true");
  assert.equal(
    url.searchParams.get("created_at"),
    `gte.${new Date(NOW - DAY).toISOString()}`,
  );
  assert.match(url.searchParams.get("order") ?? "", /created_at\.desc/);
  const limit = Number(url.searchParams.get("limit"));
  assert.ok(
    Number.isInteger(limit) && limit > 0 && limit <= 100,
    "Discovery must bound its database read",
  );
  assert.deepEqual(
    new Set((url.searchParams.get("select") ?? "").split(",")),
    new Set(["code", "state", "created_at"]),
  );
});

test("room discovery bounds the returned summaries even when the transport provides more rows", async (t) => {
  const rows = Array.from({ length: 60 }, (_, n) =>
    row(`ROOM${String(n).padStart(2, "0")}`, { isPublic: true, age: 1000 + n }),
  );
  mockDatabase(t, () => Response.json(rows));
  const result = await listRooms();
  assert.equal(result.rooms.length, 30);
  assert.deepEqual(
    result.rooms.map((room) => room.code),
    rows.slice(0, 30).map((room) => room.code),
  );
});

test("room discovery maps database failures to a readable 503 without leaking diagnostics", async (t) => {
  mockDatabase(t, () =>
    Response.json({ code: "XX000", message: HIDDEN }, { status: 503 }),
  );
  await assert.rejects(listRooms(), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 503);
    assert.match(error.message, /загрузить игры/);
    assert.equal(error.message.includes(HIDDEN), false);
    return true;
  });
});

test("new rooms default to private and persist an explicit boolean visibility choice", async (t) => {
  const calls = mockDatabase(t, (call) => {
    assert.equal(call.method, "POST");
    return Response.json([], { status: 201 });
  });
  const defaultRoom = await createRoom({ name: "Анна" });
  const privateRoom = await createRoom({ name: "Борис", isPublic: false });
  const publicRoom = await createRoom({ name: "Нюша", isPublic: true });
  assert.equal(defaultRoom.game.isPublic, false);
  assert.equal(privateRoom.game.isPublic, false);
  assert.equal(publicRoom.game.isPublic, true);
  assert.deepEqual(
    calls.map((call) => (call.body?.state as GameState).isPublic),
    [false, false, true],
  );
});

test("room creation rejects nonboolean visibility before issuing a database request", async (t) => {
  const calls = mockDatabase(t, () => {
    assert.fail("Invalid visibility must not reach the database");
  });
  for (const isPublic of [null, "true", "false", 0, 1, {}, []]) {
    await assert.rejects(
      createRoom({ name: "Игрок", isPublic }),
      (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.status, 400);
        return true;
      },
    );
  }
  assert.equal(calls.length, 0);
});
