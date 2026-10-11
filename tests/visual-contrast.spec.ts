import { test, expect } from '@playwright/test';
import { addPlayer, createDeck, createGame, publicGame } from '../lib/game';

declare global { interface Window { svintusTurnFlashCount: number } }

function contrast(foreground: string, background: string) {
  const luminance = (color: string) => {
    const channels = color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(value => {
      const s = value / 255;
      return s <= .04045 ? s / 12.92 : ((s + .055) / 1.055) ** 2.4;
    });
    return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
  };
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (light + .05) / (dark + .05);
}

test('selected access buttons stay readable, legal cards stand out and each new turn flashes only once', async ({ browser, baseURL }) => {
  let state = createGame('look-me', 'Аня');
  for (let i = 1; i <= 5; i++) state = addPlayer(state, `look-${i}`, `Игрок ${i}`);
  const deck = createDeck();
  const take = (id: string) => {
    const index = deck.findIndex(card => card.id === id);
    expect(index, `fixture owns ${id}`).toBeGreaterThanOrEqual(0);
    return deck.splice(index, 1)[0];
  };
  state.players[0].hand = ['red-2-0', 'green-3-0', 'wild-0', 'blue-1-0'].map(take);
  expect(state.players[0].hand.every(Boolean)).toBe(true);
  state.discardPile = [take('red-1-0')];
  for (const player of state.players.slice(1)) player.hand = [deck.shift()!];
  Object.assign(state, { status: 'playing', round: 1, turnIndex: 0, activeColor: 'red', drawPile: deck, lastPlayedById: 'look-1' });
  const context = await browser.newContext({ baseURL, viewport: { width: 390, height: 740 }, isMobile: true, hasTouch: true });
  try {
    await context.addInitScript(() => {
      localStorage.setItem('svintus:session:LOOKSS', JSON.stringify({ code: 'LOOKSS', token: 'visual-fixture', playerId: 'look-me' }));
      window.svintusTurnFlashCount = 0;
      document.addEventListener('animationstart', event => {
        if (event.animationName === 'your-turn-alert') window.svintusTurnFlashCount++;
      });
    });
    await context.route('**/api/rooms/LOOKSS', route => route.fulfill({ json: { game: publicGame(state, 'look-me') } }));
    const page = await context.newPage();
    await page.goto('/');
    const surface = await page.evaluate(() => ({
      foreground: getComputedStyle(document.body).color,
      background: getComputedStyle(document.querySelector('.app')!).backgroundColor,
    }));
    expect(contrast(surface.foreground, surface.background), 'readable daylight surface').toBeGreaterThanOrEqual(4.5);
    await page.getByRole('button', { name: /^Создать игру/ }).click();
    await page.getByRole('button', { name: 'По коду', exact: true }).click();
    for (const label of ['По коду', 'Открытая']) {
      const button = page.getByRole('button', { name: label, exact: true });
      const colors = await button.evaluate(element => ({ foreground: getComputedStyle(element).color, background: getComputedStyle(element).backgroundColor }));
      expect(contrast(colors.foreground, colors.background), `${label}: readable text`).toBeGreaterThanOrEqual(4.5);
    }
    await page.screenshot({ path: '/tmp/svintus-daylight-create.png' });
    await page.goto('/?room=LOOKSS');
    const notice = page.locator('.turn-callout');
    await expect(notice).toHaveText('Твой ход!');
    await expect(page.locator('.hand-card.playable')).toHaveCount(3);
    await expect(page.locator('.hand-card.unplayable')).toHaveCount(1);
    await page.locator('[data-testid="card-hand"]').evaluate(element =>
      Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => undefined)))
    );
    const styling = await page.evaluate(() => ({
      legal: parseFloat(getComputedStyle(document.querySelector('.hand-card.playable')!).opacity),
      blocked: parseFloat(getComputedStyle(document.querySelector('.hand-card.unplayable')!).opacity),
      tick: getComputedStyle(document.querySelector('.hand-card.playable')!, '::after').content,
      size: parseFloat(getComputedStyle(document.querySelector('.turn-callout')!).fontSize),
      repeats: getComputedStyle(document.querySelector('.turn-callout')!).animationIterationCount,
    }));
    expect(styling.legal).toBeGreaterThan(styling.blocked);
    expect(styling.tick).toContain('✓');
    expect(styling.size).toBeGreaterThanOrEqual(20);
    expect(styling.repeats).toBe('1');
    const flashes = () => page.evaluate(() => window.svintusTurnFlashCount);
    await expect.poll(flashes).toBe(1);
    await notice.evaluate(element => Promise.all(element.getAnimations().map(a => a.finished)));
    await page.screenshot({ path: '/tmp/svintus-daylight-game.png' });
    for (let i = 0; i < 2; i++) await page.waitForResponse(response => new URL(response.url()).pathname === '/api/rooms/LOOKSS');
    expect(await flashes()).toBe(1);
    state.turnIndex = 1;
    await expect(notice).toHaveCount(0);
    await expect(page.locator('.opponent-active')).toHaveCount(1);
    await expect(page.locator('.hand-card.playable')).toHaveCount(0);
    state.turnIndex = 0;
    await expect(notice).toHaveCount(1);
    await expect.poll(flashes).toBe(2);
    const dimensions = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, contentWidth: document.documentElement.scrollWidth, contentHeight: document.documentElement.scrollHeight }));
    expect(dimensions.contentWidth).toBeLessThanOrEqual(dimensions.width + 1);
    expect(dimensions.contentHeight).toBeLessThanOrEqual(dimensions.height + 1);
    await page.locator('[data-card-id="wild-0"]').click();
    await expect(page.getByRole('dialog', { name: 'Полисвин: выбери цвет' })).toBeVisible();
    for (const button of await page.locator('.color-choice').all()) {
      const colors = await button.evaluate(element => ({ foreground: getComputedStyle(element).color, background: getComputedStyle(element).backgroundColor }));
      expect(contrast(colors.foreground, colors.background), 'readable color choice').toBeGreaterThanOrEqual(4.5);
    }
  } finally { await context.close(); }
});
