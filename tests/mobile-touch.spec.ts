import { test, expect, type Locator } from "@playwright/test";
import type { Card, GameState, PublicGame } from "../lib/game";

type Session = { code: string; token: string; playerId: string };
type Definition = Omit<Card, "id">;
type Point = { x: number; y: number };
type RoomRow = { state: GameState; version: number };
const serverKey =
  process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

test("real touchscreen card gestures submit once, cancel safely and follow live room ownership", async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(180000);
  test.skip(
    !process.env.SUPABASE_URL || !serverKey,
    "Requires the actual Supabase server configuration.",
  );
  const context = await browser.newContext({
    baseURL,
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const runtimeErrors: string[] = [];
  const browserActions: Array<Record<string, unknown>> = [];
  let ownCode: string | undefined;
  let host: Session;
  let guest: Session;
  let original: GameState;
  let fixtureNumber = 0;
  let releaseHeldRequest: (() => void) | undefined;
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  page.on("request", (request) => {
    if (
      ownCode &&
      new URL(request.url()).pathname === `/api/rooms/${ownCode}/action` &&
      request.method() === "POST"
    )
      browserActions.push(request.postDataJSON());
  });
  const databaseHeaders = {
    apikey: serverKey!,
    Authorization: `Bearer ${serverKey}`,
    "Content-Type": "application/json",
  };
  const roomUrl = () => {
    expect(
      ownCode,
      "All database mutations target only this test-created room",
    ).toMatch(/^[A-Z2-9]{6}$/);
    return `${process.env.SUPABASE_URL}/rest/v1/svintus_rooms?code=eq.${ownCode}`;
  };
  const row = async (): Promise<RoomRow> => {
    const response = await fetch(`${roomUrl()}&select=state,version`, {
      headers: databaseHeaders,
    });
    expect(response.status).toBe(200);
    const rows = (await response.json()) as RoomRow[];
    expect(rows.length).toBe(1);
    return rows[0];
  };
  const update = async (makeState: (state: GameState) => GameState) => {
    for (let attempt = 0; attempt < 8; attempt++) {
      const saved = await row();
      const state = makeState(saved.state);
      const response = await fetch(
        `${roomUrl()}&version=eq.${saved.version}&select=version`,
        {
          method: "PATCH",
          headers: { ...databaseHeaders, Prefer: "return=representation" },
          body: JSON.stringify({
            state,
            version: saved.version + 1,
            updated_at: new Date().toISOString(),
          }),
        },
      );
      expect(response.status).toBe(200);
      if (((await response.json()) as unknown[]).length === 1) return state;
    }
    throw new Error("Could not atomically seed this touchscreen test room.");
  };
  const seed = async () => {
    const state = structuredClone(original);
    const pool = [
      ...state.drawPile,
      ...state.discardPile,
      ...state.players.flatMap((player) => player.hand),
    ];
    const take = (definition: Definition) => {
      const index = pool.findIndex(
        (card) =>
          card.kind === definition.kind &&
          card.color === definition.color &&
          (card.kind !== "number" || card.value === definition.value),
      );
      expect(
        index,
        "Fixture cards come from the actual 104-card deck",
      ).toBeGreaterThanOrEqual(0);
      return pool.splice(index, 1)[0];
    };
    const top = take({ kind: "number", color: "red", value: 1 });
    const hostHand = [
      take({ kind: "number", color: "red", value: 2 }),
      take({ kind: "number", color: "red", value: 3 }),
      take({ kind: "number", color: "blue", value: 5 }),
      take({ kind: "wild", color: null }),
    ];
    const guestHand = [
      take({ kind: "number", color: "green", value: 0 }),
      take({ kind: "number", color: "green", value: 6 }),
    ];
    state.players.forEach((player) => {
      player.hand = player.id === host.playerId ? hostHand : guestHand;
      player.score = 0;
    });
    const marker = `Сенсорная проверка ${++fixtureNumber}`;
    Object.assign(state, {
      status: "playing",
      colorChoicePlayerId: null,
      turnIndex: state.players.findIndex(
        (player) => player.id === host.playerId,
      ),
      activeColor: "red",
      drawPile: pool,
      discardPile: [top],
      phaseStartedAt: Date.now(),
      drawnCardId: null,
      pending: null,
      clap: null,
      silenceOwnerId: null,
      catchablePlayerId: null,
      lastPlayedById: guest.playerId,
      winnerId: null,
      roundWinnerId: null,
      svintusIds: [],
      chat: [],
      log: [{ id: crypto.randomUUID(), text: marker, at: Date.now() }],
    });
    const fixturePoll = page.waitForResponse(async (response) => {
      if (
        new URL(response.url()).pathname !== `/api/rooms/${ownCode}` ||
        response.request().method() !== "GET" ||
        !response.ok()
      )
        return false;
      const body = (await response.json()) as { game?: PublicGame };
      return body.game?.log.some((event) => event.text === marker) || false;
    });
    const saved = await update(() => structuredClone(state));
    expect(
      new Set(
        [
          ...saved.drawPile,
          ...saved.discardPile,
          ...saved.players.flatMap((player) => player.hand),
        ].map((card) => card.id),
      ).size,
    ).toBe(104);
    await fixturePoll;
    // Let the real fetch's React update commit even when this fixture has the
    // same hand as the previous cancelled gesture and only its phase changed.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await expect(page.locator(".hand-card")).toHaveCount(4);
    await expect(page.locator(".table-status")).toContainText("Твой ход");
    await expect(
      page.locator(`[data-card-id="${hostHand[0].id}"]`),
    ).toHaveAttribute("data-playable", "true");
    return {
      red2: hostHand[0],
      red3: hostHand[1],
      blue5: hostHand[2],
      wild: hostHand[3],
    };
  };
  const card = (value: Card) =>
    page.locator(`.hand-card[data-card-id="${value.id}"]`);
  const center = async (locator: Locator): Promise<Point> => {
    const bounds = await locator.boundingBox();
    expect(bounds, "The touch target must be rendered").not.toBeNull();
    return {
      x: bounds!.x + bounds!.width / 2,
      y: bounds!.y + bounds!.height / 2,
    };
  };
  const touchPoint = async (locator: Locator): Promise<Point> => {
    const id = await locator.getAttribute("data-card-id");
    if (!id) return center(locator);
    const bounds = await locator.boundingBox();
    expect(bounds).not.toBeNull();
    // Cards form an overlapping fan: a card's centre can belong to its next
    // neighbour. Touch the exposed corner and prove the physical hit target.
    const candidates = [14, 28, bounds!.width / 2, bounds!.width - 12].map(
      (offset) => ({ x: bounds!.x + offset, y: bounds!.y + 32 }),
    );
    const point = await page.evaluate(
      ({ candidates, id }) =>
        candidates.find(
          ({ x, y }) =>
            document
              .elementFromPoint(x, y)
              ?.closest("[data-card-id]")
              ?.getAttribute("data-card-id") === id,
        ),
      { candidates, id },
    );
    expect(
      point,
      "The real touchscreen must hit the intended exposed physical card",
    ).toBeTruthy();
    return point!;
  };
  const finger = async (
    type: "touchStart" | "touchMove" | "touchEnd",
    point?: Point,
  ) => {
    await cdp.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: point
        ? [{ ...point, id: 1, radiusX: 2, radiusY: 2, force: 1 }]
        : [],
    });
  };
  const moveTo = async (start: Point, end: Point) => {
    for (let step = 1; step <= 5; step++) {
      await finger("touchMove", {
        x: start.x + ((end.x - start.x) * step) / 5,
        y: start.y + ((end.y - start.y) * step) / 5,
      });
      await page.waitForTimeout(25);
    }
  };
  const touch = async (
    locator: Locator,
    destination?: (start: Point) => Point | Promise<Point>,
  ) => {
    await locator.scrollIntoViewIfNeeded();
    const start = await touchPoint(locator);
    await finger("touchStart", start);
    if (destination) await moveTo(start, await destination(start));
    await finger("touchEnd");
  };
  const quiet = async () => {
    // A real touch may also synthesize a delayed compatibility click. Give it
    // time to arrive before asserting that no duplicate/accidental POST exists.
    await page.waitForTimeout(500);
  };
  const submittedOnce = async (
    baseline: number,
    played: Card,
    color?: string,
  ) => {
    await expect(page.locator(".hand-card")).toHaveCount(3);
    await quiet();
    expect(browserActions.slice(baseline)).toHaveLength(1);
    expect(browserActions[baseline]).toMatchObject({
      type: "play",
      cardId: played.id,
      ...(color ? { color } : {}),
    });
    const saved = (await row()).state;
    expect(saved.discardPile.at(-1)?.id).toBe(played.id);
    expect(
      saved.players.find((player) => player.id === host.playerId)?.hand,
    ).toHaveLength(3);
  };

  try {
    const create = await context.request.post("/api/rooms", {
      data: { name: "Сенсорный хозяин", isPublic: false },
    });
    expect(create.status()).toBe(200);
    host = (await create.json()) as Session;
    ownCode = host.code;
    const join = await context.request.post(`/api/rooms/${ownCode}/join`, {
      data: { name: "Второй игрок" },
    });
    expect(join.status()).toBe(200);
    guest = (await join.json()) as Session;
    const start = await context.request.post(`/api/rooms/${ownCode}/action`, {
      headers: { Authorization: `Bearer ${host.token}` },
      data: { type: "start" },
    });
    expect(start.status()).toBe(200);
    original = (await row()).state;
    expect(original.players).toHaveLength(2);
    expect(original.players.some((player) => player.isBot)).toBe(false);
    await page.addInitScript(
      (session) =>
        localStorage.setItem(
          `svintus:session:${session.code}`,
          JSON.stringify(session),
        ),
      { code: host.code, token: host.token, playerId: host.playerId },
    );
    await page.goto(`/?room=${ownCode}`);
    // Every fixture enters through real room restoration and regular polling.
    await expect(page.locator(".opponent")).toHaveCount(1);

    let hand = await seed();
    let baseline = browserActions.length;
    await touch(card(hand.red2), () => center(page.locator(".game-table")));
    await submittedOnce(baseline, hand.red2);

    hand = await seed();
    baseline = browserActions.length;
    await touch(card(hand.red2), (start) => ({ x: start.x, y: start.y - 80 }));
    await submittedOnce(baseline, hand.red2);

    hand = await seed();
    baseline = browserActions.length;
    await card(hand.red2).scrollIntoViewIfNeeded();
    let origin = await touchPoint(card(hand.red2));
    await finger("touchStart", origin);
    await moveTo(origin, { x: origin.x, y: origin.y - 85 });
    await expect(page.locator(".sv-hand-floating")).toBeVisible();
    await moveTo(
      { x: origin.x, y: origin.y - 85 },
      { x: origin.x, y: Math.min(820, origin.y + 35) },
    );
    await finger("touchEnd");
    await quiet();
    expect(browserActions.length).toBe(baseline);
    await expect(card(hand.red2)).toBeVisible();
    await expect(page.locator(".sv-hand-floating")).toHaveCount(0);

    baseline = browserActions.length;
    await touch(card(hand.red2), (start) => ({
      x: Math.min(382, start.x + 145),
      y: start.y - 18,
    }));
    await quiet();
    expect(browserActions.length).toBe(baseline);
    await expect(page.locator(".hand-card")).toHaveCount(4);

    baseline = browserActions.length;
    await expect(card(hand.blue5)).toHaveAttribute("data-playable", "false");
    await touch(card(hand.blue5), () => center(page.locator(".game-table")));
    await quiet();
    expect(browserActions.length).toBe(baseline);
    await expect(page.locator(".hand-card")).toHaveCount(4);

    hand = await seed();
    baseline = browserActions.length;
    await touch(card(hand.wild));
    const picker = page.getByRole("dialog", { name: "Полисвин: выбери цвет" });
    await expect(picker).toBeVisible();
    await quiet();
    expect(browserActions.length).toBe(baseline);
    await touch(picker.getByRole("button", { name: "Синий", exact: true }));
    await expect(picker).toHaveCount(0);
    await submittedOnce(baseline, hand.wild, "blue");

    hand = await seed();
    baseline = browserActions.length;
    await card(hand.red2).scrollIntoViewIfNeeded();
    origin = await touchPoint(card(hand.red2));
    await finger("touchStart", origin);
    await moveTo(origin, await center(page.locator(".game-table")));
    await expect(page.locator(".sv-hand-floating")).toBeVisible();
    // A second client using this player's actual session wins the race while
    // the first browser still holds its finger. Its API request is real, and
    // the first browser learns about the lost card through real polling.
    const otherClient = await context.request.post(
      `/api/rooms/${ownCode}/action`,
      {
        headers: { Authorization: `Bearer ${host.token}` },
        data: { type: "play", cardId: hand.red2.id },
      },
    );
    expect(otherClient.status()).toBe(200);
    await update((saved) => ({ ...saved, phaseStartedAt: Date.now() }));
    await expect(card(hand.red2)).toHaveCount(0);
    await expect(page.locator(".table-status")).toContainText("Второй игрок");
    await finger("touchEnd");
    await quiet();
    expect(
      browserActions.length,
      "The stale held gesture must not submit after ownership changes",
    ).toBe(baseline);
    await expect(page.locator(".sv-hand-floating")).toHaveCount(0);
    expect(
      (await row()).state.discardPile.filter(
        (value) => value.id === hand.red2.id,
      ),
    ).toHaveLength(1);

    hand = await seed();
    baseline = browserActions.length;
    const actionPattern = `**/api/rooms/${ownCode}/action`;
    let held = false;
    const gate = new Promise<void>((resolve) => {
      releaseHeldRequest = resolve;
    });
    await page.route(actionPattern, async (route) => {
      if (
        !held &&
        route.request().method() === "POST" &&
        route.request().postDataJSON().type === "play"
      ) {
        held = true;
        // Pause only transport. The original request is subsequently sent to
        // the actual server, with no fabricated API response or database mock.
        await gate;
      }
      await route.continue();
    });
    const busyResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/api/rooms/${ownCode}/action` &&
        response.request().method() === "POST",
    );
    try {
      await touch(card(hand.red2), () => center(page.locator(".game-table")));
      await expect.poll(() => held, { timeout: 5000 }).toBe(true);
      await expect(card(hand.red3)).toBeDisabled();
      await touch(card(hand.red3), () => center(page.locator(".game-table")));
      await quiet();
      expect(
        browserActions.length,
        "A gesture during a pending real request must not submit again",
      ).toBe(baseline + 1);
    } finally {
      releaseHeldRequest?.();
      releaseHeldRequest = undefined;
      await page.unrouteAll({ behavior: "wait" });
    }
    expect((await busyResponse).status()).toBe(200);
    await submittedOnce(baseline, hand.red2);

    hand = await seed();
    baseline = browserActions.length;
    await update((saved) => ({ ...saved, phaseStartedAt: Date.now() }));
    await expect(page.locator(".turn-timer")).toHaveCount(0);
    await card(hand.red2).scrollIntoViewIfNeeded();
    origin = await touchPoint(card(hand.red2));
    await finger("touchStart", origin);
    await moveTo(origin, await center(page.locator(".game-table")));
    await expect(page.locator(".sv-hand-floating")).toBeVisible();
    await expect(page.locator(".game-table")).toHaveAttribute(
      "data-drop-active",
      "true",
    );
    await page.screenshot({
      path: "/tmp/svintus-mobile-touch-drag.png",
      fullPage: true,
    });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchCancel",
      touchPoints: [],
    });
    await quiet();
    expect(
      browserActions.length,
      "A browser touch cancellation never commits the preview",
    ).toBe(baseline);
    await expect(page.locator(".sv-hand-floating")).toHaveCount(0);
    expect(runtimeErrors).toEqual([]);
    test
      .info()
      .annotations.push({
        type: "touch-input",
        description:
          "Chromium CDP Input.dispatchTouchEvent; real Supabase, API and room polling; transport paused only for busy-state validation.",
      });
    test
      .info()
      .annotations.push({
        type: "artifacts",
        description: "/tmp/svintus-mobile-touch-drag.png",
      });
  } finally {
    releaseHeldRequest?.();
    await cdp
      .send("Input.dispatchTouchEvent", {
        type: "touchCancel",
        touchPoints: [],
      })
      .catch(() => undefined);
    await cdp.detach().catch(() => undefined);
    await context.close();
    if (ownCode) {
      const response = await fetch(roomUrl(), {
        method: "DELETE",
        headers: databaseHeaders,
      });
      expect(response.status, "Clean up only this test-created room").toBe(204);
    }
  }
});
