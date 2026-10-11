import { test, expect } from "@playwright/test";
import { addPlayer, createDeck, createGame, publicGame } from "../lib/game";

test("six-player results with maximum-length names and tied scores keep every row and next round visible", async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(120000);
  const sizes = [
    { width: 320, height: 568 },
    { width: 360, height: 640 },
    { width: 390, height: 844 },
    { width: 430, height: 932 },
    { width: 667, height: 375 },
  ];
  for (const tied of [false, true]) {
    let state = createGame("result-0", `${"Ш".repeat(23)}0`);
    for (let n = 1; n < 6; n++)
      state = addPlayer(state, `result-${n}`, `${"Ш".repeat(23)}${n}`);
    const deck = createDeck();
    state.players.forEach((player, n) => {
      player.hand = n === 0 ? [] : deck.splice(0, !tied && n === 5 ? 3 : 1);
      player.score = player.hand.length;
    });
    Object.assign(state, {
      status: "round_end",
      round: 1,
      roundWinnerId: "result-0",
      svintusIds: tied
        ? state.players.slice(1).map((player) => player.id)
        : ["result-5"],
      drawPile: deck.slice(1),
      discardPile: deck.slice(0, 1),
    });
    const game = publicGame(state, "result-0");
    expect(
      game.players
        .map((player) => player.cardCount)
        .reduce((sum, count) => sum + count, 0) +
        state.drawPile.length +
        state.discardPile.length,
    ).toBe(104);
    for (const viewport of sizes) {
      const context = await browser.newContext({
        baseURL,
        viewport,
        isMobile: true,
        hasTouch: true,
      });
      try {
        // These are read-only presentation fixtures. No real room is created,
        // no database credentials are used and no game action is submitted.
        await context.addInitScript(() =>
          localStorage.setItem(
            "svintus:session:RESULT",
            JSON.stringify({
              code: "RESULT",
              token: "result-visual-fixture",
              playerId: "result-0",
            }),
          ),
        );
        await context.route("**/api/rooms/RESULT", (route) =>
          route.fulfill({ json: { game } }),
        );
        const page = await context.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto("/?room=RESULT");
        await expect(
          page.locator('[data-testid="results-screen"]'),
        ).toBeVisible();
        await page
          .locator(".scoreboard")
          .evaluate((element) =>
            Promise.all(
              element
                .getAnimations({ subtree: true })
                .map((animation) => animation.finished.catch(() => undefined)),
            ),
          );
        await expect(page.locator(".score-row")).toHaveCount(6);
        await expect(page.locator(".score-svintus")).toHaveCount(tied ? 5 : 1);
        await expect(page.locator(".scoreboard-heading h2")).toContainText(
          state.players[0].name,
        );
        const next = page.getByRole("button", {
          name: "Ещё раунд? Раздаём!",
          exact: true,
        });
        await expect(next).toBeVisible();
        const bounds = await next.boundingBox();
        expect(bounds!.height).toBeGreaterThanOrEqual(44);
        expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(
          viewport.height + 1,
        );
        const panel = await page.locator(".scoreboard-list").boundingBox();
        const heading = await page.locator(".scoreboard-heading").boundingBox();
        const footer = await page
          .locator(".svintus-explanation")
          .evaluate((element) => {
            const range = document.createRange();
            range.selectNodeContents(element);
            const rect = range.getBoundingClientRect();
            return {
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height,
            };
          });
        if (viewport.width < viewport.height) {
          expect(heading!.y + heading!.height).toBeLessThanOrEqual(
            panel!.y + 1,
          );
          expect(panel!.y + panel!.height).toBeLessThanOrEqual(footer.y + 1);
        } else {
          expect(heading!.x + heading!.width).toBeLessThanOrEqual(panel!.x + 1);
          expect(footer.x + footer.width).toBeLessThanOrEqual(panel!.x + 1);
        }
        expect(footer.y + footer.height).toBeLessThanOrEqual(bounds!.y + 1);
        for (const row of await page.locator(".score-row").all()) {
          const rect = await row.boundingBox();
          expect(rect!.y).toBeGreaterThanOrEqual(panel!.y - 1);
          expect(rect!.y + rect!.height).toBeLessThanOrEqual(
            panel!.y + panel!.height + 1,
          );
        }
        for (const text of await page
          .locator(".scoreboard-heading, .svintus-explanation")
          .all()) {
          const rect = await text.boundingBox();
          expect(rect!.x).toBeGreaterThanOrEqual(-1);
          expect(rect!.x + rect!.width).toBeLessThanOrEqual(viewport.width + 1);
          expect(rect!.y + rect!.height).toBeLessThanOrEqual(
            viewport.height + 1,
          );
          expect(
            await text.evaluate(
              (element) => element.scrollHeight <= element.clientHeight + 1,
            ),
          ).toBe(true);
        }
        expect(
          await page.evaluate(
            () =>
              document.documentElement.scrollHeight <= innerHeight + 1 &&
              document.documentElement.scrollWidth <= innerWidth + 1,
          ),
        ).toBe(true);
        expect(errors).toEqual([]);
        await page.screenshot({
          path: `/tmp/svintus-results-long-${viewport.width}-${tied ? "tied" : "single"}.png`,
        });
      } finally {
        await context.close();
      }
    }
  }
});
