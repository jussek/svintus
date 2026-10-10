import { test, expect, type Page } from '@playwright/test';
import type { Card, GameState, PublicGame } from '../lib/game';

type Session = { code: string; token: string; playerId: string; game: PublicGame };
type RoomRow = { state: GameState; version: number; sessions: Record<string, unknown> };
type Definition = Omit<Card, 'id'>;
const serverKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

test('the host manages lobby bots and plays a two-player game with a real autonomous bot', async ({ page }) => {
  test.skip(!process.env.SUPABASE_URL || !serverKey, 'Requires the actual Supabase server configuration.');
  let ownCode: string | undefined;
  let host: Session;
  const runtimeErrors: string[] = [];
  page.on('pageerror', error => runtimeErrors.push(error.message));

  const roomUrl = () => {
    expect(ownCode, 'Only this test-created room may be read, seeded or deleted').toMatch(/^[A-Z2-9]{6}$/);
    return `${process.env.SUPABASE_URL}/rest/v1/svintus_rooms?code=eq.${ownCode}`;
  };
  const databaseHeaders = {
    apikey: serverKey!,
    Authorization: `Bearer ${serverKey}`,
    'Content-Type': 'application/json',
  };
  const row = async (): Promise<RoomRow> => {
    const response = await fetch(`${roomUrl()}&select=state,version,sessions`, { headers: databaseHeaders });
    expect(response.status, 'Read only the room created by this test').toBe(200);
    const rows = await response.json() as RoomRow[];
    expect(rows.length).toBe(1);
    return rows[0];
  };
  const save = async (makeState: (saved: GameState) => GameState) => {
    for (let attempt = 0; attempt < 8; attempt++) {
      const saved = await row();
      const state = makeState(saved.state);
      const response = await fetch(`${roomUrl()}&version=eq.${saved.version}&select=version`, {
        method: 'PATCH',
        headers: { ...databaseHeaders, Prefer: 'return=representation' },
        body: JSON.stringify({ state, version: saved.version + 1, updated_at: new Date().toISOString() }),
      });
      expect(response.status, 'Atomically seed only this test room').toBe(200);
      const updated = await response.json() as Array<{ version: number }>;
      if (updated.length === 1) return state;
    }
    throw new Error('Could not atomically update this test-created room.');
  };
  const submit = async (name: string, route: string): Promise<{ game: PublicGame } & Partial<Session>> => {
    const pending = page.waitForResponse(response => new URL(response.url()).pathname === route && response.request().method() === 'POST');
    await page.getByRole('button', { name, exact: true }).click();
    const response = await pending;
    expect(response.status()).toBe(200);
    return await response.json();
  };
  const assertPublic = (game: PublicGame) => {
    expect(game.players.every(player => typeof player.isBot === 'boolean')).toBe(true);
    expect(game.players.every(player => !Object.hasOwn(player, 'hand') && !Object.hasOwn(player, 'token'))).toBe(true);
    expect(Object.hasOwn(game, 'drawPile')).toBe(false);
    expect(Object.hasOwn(game, 'sessions')).toBe(false);
  };
  const noHorizontalOverflow = async (target: Page) => {
    expect(await target.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  };

  try {
    await page.goto('/');
    // React handlers must be hydrated before filling controlled fields.
    await expect(page.locator('main[data-screen="home"]')).toBeVisible();
    await expect(page.getByRole('button', { name: /^Создать игру/ })).toBeEnabled();
    await page.getByRole('button', { name: 'Правила игры', exact: true }).click();
    const rules = page.getByRole('dialog', { name: 'Правила Свинтуса' });
    await expect(rules).toBeVisible();
    await expect(rules).toContainText(/2.*6/);
    await rules.getByRole('button', { name: 'Закрыть', exact: true }).click();
    await page.getByRole('button', { name: /^Создать игру/ }).click();
    await expect(page.locator('main[data-screen="create"]')).toBeVisible();
    await expect(page.getByLabel('Твоё имя')).toBeEnabled();
    await page.getByLabel('Твоё имя').fill('Хозяин с ботами');
    await page.getByRole('group', { name: 'Время на ход' }).getByRole('button').filter({ hasText: '5' }).click();
    host = await submit('Создать комнату', '/api/rooms') as Session;
    ownCode = host.code;
    assertPublic(host.game);
    expect(host.game.players).toHaveLength(1);
    expect(host.game.players[0].isBot).toBe(false);
    await expect(page.getByRole('button', { name: 'Раздать карты!', exact: true })).toBeDisabled();

    // Every supported lobby size must enable starting once a second seat exists.
    for (let count = 2; count <= 6; count++) {
      const result = await submit('Добавить бота', `/api/rooms/${ownCode}/action`);
      assertPublic(result.game);
      expect(Object.hasOwn(result, 'token')).toBe(false);
      expect(result.game.players).toHaveLength(count);
      expect(result.game.players.filter(player => player.isBot)).toHaveLength(count - 1);
      await expect(page.locator('.lobby-seat.occupied')).toHaveCount(count);
      await expect(page.locator('.lobby-seat.bot-seat')).toHaveCount(count - 1);
      await expect(page.getByRole('button', { name: 'Раздать карты!', exact: true })).toBeEnabled();
    }
    await expect(page.getByRole('button', { name: 'Добавить бота', exact: true })).toBeDisabled();
    const fullLobby = await row();
    expect(Object.keys(fullLobby.sessions), 'Bots never receive player authentication sessions').toEqual([host.playerId]);

    for (let count = 5; count >= 2; count--) {
      const remove = page.getByRole('button', { name: /^Удалить бота / }).first();
      const name = await remove.getAttribute('aria-label');
      expect(name).toBeTruthy();
      const result = await submit(name!, `/api/rooms/${ownCode}/action`);
      expect(result.game.players).toHaveLength(count);
      await expect(page.locator('.lobby-seat.occupied')).toHaveCount(count);
      await expect(page.getByRole('button', { name: 'Раздать карты!', exact: true })).toBeEnabled();
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await noHorizontalOverflow(page);
    await page.screenshot({ path: '/tmp/svintus-bots-mobile-lobby.png', fullPage: true });
    const remainingBot = (await row()).state.players.find(player => player.isBot)!;
    expect(remainingBot).toBeTruthy();
    const storedSession = await page.evaluate(code => JSON.parse(localStorage.getItem(`svintus:session:${code}`)!), ownCode);
    expect(storedSession.playerId).toBe(host.playerId);
    expect(storedSession.playerId === remainingBot.id).toBe(false);

    const started = await submit('Раздать карты!', `/api/rooms/${ownCode}/action`);
    assertPublic(started.game);
    expect(started.game.status).toBe('playing');
    expect(started.game.players).toHaveLength(2);
    expect(started.game.players.filter(player => player.isBot)).toHaveLength(1);
    await expect(page.locator('.opponent')).toHaveCount(1);
    await expect(page.locator('.opponent .bot-tag')).toHaveText('БОТ');
    await expect(page.getByRole('button', { name: /^Удалить бота / })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Добавить бота', exact: true })).toHaveCount(0);

    // Use the actual dealt deck and keep the database, API and browser polls
    // real. Only this room is made deterministic: the bot has one legal move.
    const original = (await row()).state;
    const pool = [...original.drawPile, ...original.discardPile, ...original.players.flatMap(player => player.hand)];
    const take = (definition: Definition) => {
      const index = pool.findIndex(card => card.kind === definition.kind && card.color === definition.color && (card.kind !== 'number' || card.value === definition.value));
      expect(index, 'The fixture card belongs to the real deck').toBeGreaterThanOrEqual(0);
      return pool.splice(index, 1)[0];
    };
    const topCard = take({ kind: 'number', color: 'red', value: 1 });
    const botMove = take({ kind: 'number', color: 'red', value: 2 });
    const botHand = [botMove, take({ kind: 'number', color: 'green', value: 3 }), take({ kind: 'number', color: 'blue', value: 4 })];
    const hostHand = Array.from({ length: 8 }, (_, value) => take({ kind: 'number', color: 'orange', value }));
    const fixture = structuredClone(original);
    fixture.players.forEach(player => { player.hand = player.isBot ? botHand : hostHand; player.score = 0; });
    Object.assign(fixture, {
      status: 'playing', turnIndex: fixture.players.findIndex(player => player.isBot), activeColor: 'red',
      drawPile: pool, discardPile: [topCard], drawnCardId: null, pending: null, clap: null,
      silenceOwnerId: null, catchablePlayerId: null, lastPlayedById: host.playerId,
      winnerId: null, roundWinnerId: null, svintusIds: [], log: [], chat: [],
    });
    // Bot timing derives from the real five-second phase, so do not extend it.
    const autonomousPoll = page.waitForResponse(async response => {
      if (new URL(response.url()).pathname !== `/api/rooms/${ownCode}` || response.request().method() !== 'GET' || !response.ok()) return false;
      const body = await response.json() as { game?: PublicGame };
      return body.game?.topCard?.id === botMove.id && body.game.players.find(player => player.isBot)?.cardCount === 2;
    }, { timeout: 15000 });
    await save(() => ({ ...structuredClone(fixture), turnDeadline: Date.now() + 5000 }));
    const observed = (await (await autonomousPoll).json()).game as PublicGame;
    assertPublic(observed);
    expect(observed.lastPlayedById).toBe(remainingBot.id);
    expect(observed.players[observed.turnIndex].id).toBe(host.playerId);
    expect(observed.hand).toHaveLength(8);
    expect(observed.log.some(event => event.text.includes(remainingBot.name) && event.text.includes('сыграл'))).toBe(true);
    // The autonomous move has already been verified. Hold only this room's
    // subsequent human deadline while inspecting its mobile presentation.
    await save(saved => {
      expect(saved.lastPlayedById).toBe(remainingBot.id);
      expect(saved.players[saved.turnIndex].id).toBe(host.playerId);
      return { ...saved, turnDeadline: Date.now() + 30000 };
    });
    await expect(page.locator('.opponent-cards b')).toHaveText('2');
    await expect(page.locator('.discard-wrap img')).toHaveAttribute('src', '/cards/red-2.jpg');
    await expect(page.locator('.table-status')).toContainText('Твой ход');
    await expect(page.locator('.hand-card')).toHaveCount(8);
    await expect.poll(() => page.locator('.hand-card img').evaluateAll(images => images.every(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
    await noHorizontalOverflow(page);
    for (const viewport of [{ width: 320, height: 568 }, { width: 667, height: 375 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      const botLabel = page.locator('.opponent .bot-tag');
      await expect(botLabel).toBeVisible();
      expect(await botLabel.evaluate(element => Number.parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(7);
      await noHorizontalOverflow(page);
      await page.getByRole('button', { name: `Об игроке ${remainingBot.name}`, exact: true }).click();
      const info = page.getByRole('dialog', { name: 'Участник игры', exact: true });
      await expect(info.getByRole('heading')).toHaveText(remainingBot.name);
      await info.getByRole('button', { name: 'Закрыть', exact: true }).click();
    }
    // Restore the configured five-second timer for the actual screenshot.
    await save(saved => {
      expect(saved.players[saved.turnIndex].id).toBe(host.playerId);
      return { ...saved, turnDeadline: Date.now() + 5000 };
    });
    await expect(page.locator('.turn-timer')).toHaveAttribute('aria-label', /Осталось [1-5] секунд/);
    await page.screenshot({ path: '/tmp/svintus-bots-mobile-game.png', fullPage: true });
    expect(Object.keys((await row()).sessions)).toEqual([host.playerId]);
    expect(runtimeErrors).toEqual([]);
    test.info().annotations.push({ type: 'artifacts', description: '/tmp/svintus-bots-mobile-{lobby,game}.png' });
  } finally {
    // Stop real browser polling before deleting only this run's exact room.
    await page.close();
    if (ownCode) {
      const response = await fetch(roomUrl(), { method: 'DELETE', headers: databaseHeaders });
      expect(response.status, 'Delete only this browser test’s own room').toBe(204);
    }
  }
});
