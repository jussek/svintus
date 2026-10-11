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
      await context.addInitScript(() => {
        // Hold each short decorative flight at creation so the test can inspect
        // its start/end poses even when other browser workers are busy.
        const animate = Element.prototype.animate;
        Element.prototype.animate = function (
          this: Element,
          keyframes: Keyframe[] | PropertyIndexedKeyframes | null,
          options?: number | KeyframeAnimationOptions,
        ) {
          const animation = animate.call(this, keyframes, options);
          if (this.classList.contains('sv-hand-flight')) animation.pause();
          return animation;
        };
        localStorage.setItem(
          "svintus:session:MOTION",
          JSON.stringify({
            code: "MOTION",
            token: "motion-fixture",
            playerId: "motion-me",
          }),
        );
      });
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
      await expect(page.locator('.hand-toolbar')).toHaveAttribute('data-current-player', 'true');
      await expect(page.locator('.opponent-active')).toHaveCount(0);
      const cdp = await context.newCDPSession(page);
      for (const id of ['red-2-0', 'green-3-0', 'blue-4-0']) {
        const slot = page.locator(`[data-card-id="${id}"]`);
        await slot.evaluate(element => Promise.all(element.getAnimations().map(a => a.finished.catch(() => undefined))));
        const before = (await slot.boundingBox())!;
        const x = before.x + before.width / 2;
        const y = before.y + 30;
        await cdp.send('Input.dispatchTouchEvent', {type:'touchStart',touchPoints:[{x,y}]});
        await cdp.send('Input.dispatchTouchEvent', {type:'touchMove',touchPoints:[{x: x - 40,y: y + 20}]});
        const preview = page.locator('.sv-hand-floating img');
        await expect(preview).toBeVisible();
        const releasedFrom = (await preview.boundingBox())!;
        await cdp.send('Input.dispatchTouchEvent', {type:'touchEnd',touchPoints:[]});
        const returning = page.locator('.sv-hand-flight[data-motion="return"]');
        if (reduced) {
          await expect(returning).toHaveCount(0);
        } else {
          await expect(returning).toHaveCount(1);
          await expect.poll(() => returning.evaluate(element => element.getAnimations().length)).toBe(1);
          await returning.evaluate(element => {
            const animation = element.getAnimations()[0];
            animation.pause();
            animation.currentTime = 0;
          });
          const first = (await returning.boundingBox())!;
          for (const key of ['x','y','width','height'] as const)
            expect(Math.abs(first[key]-releasedFrom[key]), `return starts at preview ${key}`).toBeLessThan(1.5);
          await expect(slot).not.toHaveClass(/sv-hand-selected/);
          await returning.evaluate(element => element.getAnimations()[0].currentTime = 340);
          const landed = (await returning.boundingBox())!;
          const destination = (await slot.boundingBox())!;
          for (const key of ['x','y','width','height'] as const)
            expect(Math.abs(landed[key]-destination[key]), `return lands in exact fan slot ${key}`).toBeLessThan(1.5);
          await returning.evaluate(element => element.getAnimations()[0].finish());
          await expect(returning).toHaveCount(0);
          expect(await slot.getAttribute('data-motion-hidden')).toBeNull();
          const restored = (await slot.boundingBox())!;
          for (const key of ['x','y','width','height'] as const)
            expect(Math.abs(restored[key]-before[key]), `slot restores original pose ${key}`).toBeLessThan(1.5);
        }
        expect(submissions).toBe(0);
      }
      await card.focus();
      await card.press("Enter");
      if (reduced) await expect(page.locator(".sv-hand-flight")).toHaveCount(0);
      else {
        await expect(page.locator(".sv-hand-flight")).toHaveCount(1);
        await expect.poll(() => page.locator('.sv-hand-flight[data-motion="play"]').evaluate(element =>
          element.getAnimations().length
        )).toBe(1);
      }
      await expect(page.locator(".discard-wrap img")).toHaveAttribute(
        "src",
        "/cards/red-2.jpg",
      );
      expect(submissions).toBe(1);
      await expect(page.locator('.hand-toolbar')).toHaveAttribute('data-current-player', 'false');
      await expect(page.locator('.opponent-active')).toHaveCount(1);
      if (!reduced) {
        const flight = page.locator('.sv-hand-flight[data-motion="play"]');
        await flight.evaluate(element => {
          const animation = element.getAnimations()[0];
          animation.pause();
          animation.currentTime = 420;
        });
        const landed = (await flight.boundingBox())!;
        const pile = (await page.locator('.discard-wrap img').boundingBox())!;
        for (const key of ['x','y','width','height'] as const)
          expect(Math.abs(landed[key]-pile[key]), `play lands on stack ${key}`).toBeLessThan(1.5);
        expect(await flight.evaluate(element => getComputedStyle(element).opacity)).toBe('1');
        await flight.evaluate(element => element.getAnimations()[0].finish());
      }
      await expect(page.locator(".sv-hand-flight")).toHaveCount(0);
      if (!reduced)
        expect(await page.locator('.discard-wrap img').evaluate(element => element.getAnimations().length)).toBe(0);
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
