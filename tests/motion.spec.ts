import { test, expect } from "@playwright/test";
import {
  act,
  addPlayer,
  createDeck,
  createGame,
  publicGame,
} from "../lib/game";

test("card flight submits immediately once and reduced motion disables decorative movement", async ({
  browser,
  baseURL,
}) => {
  for (const reduced of [false, true]) {
    let state = addPlayer(
      createGame("motion-me", "Аня"),
      "motion-other",
      "Боря",
    );
    const deck = createDeck();
    const take = (id: string) =>
      deck.splice(
        deck.findIndex((card) => card.id === id),
        1,
      )[0];
    state.players[0].hand = ["red-2-0", "green-3-0", "blue-4-0"].map(take);
    state.players[1].hand = ["blue-5-0", "green-6-0", "orange-7-0"].map(take);
    state.discardPile = [take("red-1-0")];
    Object.assign(state, {
      status: "playing",
      round: 1,
      turnIndex: 0,
      activeColor: "red",
      drawPile: deck,
      lastPlayedById: "motion-other",
    });
    const context = await browser.newContext({
      baseURL,
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
      reducedMotion: reduced ? "reduce" : "no-preference",
    });
    try {
      await context.addInitScript(() =>
        localStorage.setItem(
          "svintus:session:MOTION",
          JSON.stringify({
            code: "MOTION",
            token: "motion-fixture",
            playerId: "motion-me",
          }),
        ),
      );
      await context.route("**/api/rooms/MOTION", (route) =>
        route.fulfill({ json: { game: publicGame(state, "motion-me") } }),
      );
      let submissions = 0;
      await context.route("**/api/rooms/MOTION/action", async (route) => {
        submissions++;
        state = act(state, "motion-me", route.request().postDataJSON());
        await route.fulfill({ json: { game: publicGame(state, "motion-me") } });
      });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto("/?room=MOTION");
      const card = page.locator('[data-card-id="red-2-0"]');
      await expect(card).toBeVisible();
      await expect
        .poll(() =>
          card
            .locator("img")
            .evaluate(
              (image) =>
                (image as HTMLImageElement).complete &&
                (image as HTMLImageElement).naturalWidth > 0,
            ),
        )
        .toBe(true);
      await card.focus();
      await card.press("Enter");
      if (reduced) await expect(page.locator(".sv-hand-flight")).toHaveCount(0);
      else await expect(page.locator(".sv-hand-flight")).toHaveCount(1);
      await expect(page.locator(".discard-wrap img")).toHaveAttribute(
        "src",
        "/cards/red-2.jpg",
      );
      expect(submissions).toBe(1);
      await expect(page.locator(".sv-hand-flight")).toHaveCount(0);
      await expect(page.locator(".hand-card")).toHaveCount(2);
      if (reduced)
        expect(
          await page.evaluate(() =>
            document
              .getAnimations()
              .every(
                (animation) =>
                  Number(animation.effect?.getComputedTiming().duration ?? 0) <=
                  1,
              ),
          ),
        ).toBe(true);
      await expect(page.locator(".turn-timer")).toHaveCount(0);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }
});
