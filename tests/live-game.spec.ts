import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import type { Card, GameState, PublicGame } from '../lib/game';

type Session = { code: string; token: string; playerId: string; game: PublicGame };
type Definition = Omit<Card, 'id'>;
const serverKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

test('six real browsers play, reconnect, declare/catch and clap using live Supabase', async ({ browser, baseURL }) => {
  test.skip(!process.env.SUPABASE_URL || !serverKey, 'Requires the actual Supabase server configuration.');
  const db = createClient(process.env.SUPABASE_URL!, serverKey!, { auth: { persistSession: false, autoRefreshToken: false } });
  const contexts: BrowserContext[] = [];
  const pages: Page[] = [];
  const sessions: Session[] = [];
  let ownCode: string | undefined;
  let original: GameState;
  const runtimeErrors: string[] = [];

  const row = async () => {
    expect(ownCode).toMatch(/^[A-Z2-9]{6}$/);
    const { data, error } = await db.from('svintus_rooms').select('code,state,version').eq('code', ownCode!).single();
    expect(error, 'Read only this browser run’s own room').toBeNull();
    return data! as { code: string; state: GameState; version: number };
  };
  const seed = async (hands?: Array<Definition[] | undefined>, turnIndex = 0) => {
    const state = structuredClone(original);
    const pool = [...state.drawPile, ...state.discardPile, ...state.players.flatMap(player => player.hand)];
    const take = (definition: Definition) => {
      const index = pool.findIndex(card => card.kind === definition.kind && card.color === definition.color && (card.kind !== 'number' || card.value === definition.value));
      expect(index, 'Fixture card must exist in the real deck').toBeGreaterThanOrEqual(0);
      return pool.splice(index, 1)[0];
    };
    const top = take({ kind: 'number', color: 'red', value: 1 });
    // Assign all explicitly requested hands first so default hands cannot take
    // the cards needed by a later fixture player.
    const assigned = state.players.map(player => hands?.[sessions.findIndex(session => session.playerId === player.id)]?.map(take));
    state.players.forEach((player, index) => { player.hand = assigned[index] || pool.splice(0, 8); player.score = 0; });
    Object.assign(state, { status: 'playing', turnIndex: state.players.findIndex(player => player.id === sessions[turnIndex].playerId), activeColor: 'red', drawPile: pool, discardPile: [top], turnDeadline: Date.now() + 5000, drawnCardId: null, pending: null, clap: null, silenceOwnerId: null, catchablePlayerId: null, lastPlayedById: state.players[5].id, winnerId: null, roundWinnerId: null, svintusIds: [], log: [], chat: [] });
    for (let attempt = 0; attempt < 8; attempt++) {
      const saved = await row();
      const { data, error } = await db.from('svintus_rooms').update({ state, version: saved.version + 1, updated_at: new Date().toISOString() }).eq('code', ownCode!).eq('version', saved.version).select('code');
      expect(error, 'Seed only this browser test room').toBeNull();
      if (data?.length === 1) return state;
    }
    throw new Error('Could not atomically seed this browser test room.');
  };
  const gameView = async (index: number) => {
    const response = await pages[index].request.get(`/api/rooms/${ownCode}`, { headers: { Authorization: `Bearer ${sessions[index].token}` } });
    expect(response.status()).toBe(200);
    return (await response.json()).game as PublicGame;
  };
  const holdOpeningForBrowserInspection = async () => {
    // Preserve the actual first deal before six independently polling browsers
    // inspect it. The live API suite covers the configured five-second expiry.
    for (let attempt = 0; attempt < 8; attempt++) {
      const saved = await row();
      expect(saved.state.status).toBe('playing');
      if (saved.state.clap) saved.state.clap.deadline = Date.now() + 60000;
      else saved.state.turnDeadline = Date.now() + 60000;
      const { data, error } = await db.from('svintus_rooms').update({ state: saved.state, version: saved.version + 1, updated_at: new Date().toISOString() }).eq('code', ownCode!).eq('version', saved.version).select('code');
      expect(error, 'Preserve only this browser test room’s opening phase').toBeNull();
      if (data?.length === 1) return;
    }
    throw new Error('Could not preserve this browser test room’s actual first deal.');
  };
  const holdClapForBrowserInspection = async () => {
    // Six browser polls and screenshots can consume a real five-second phase.
    // Timing/expiration is covered by live API tests. Here only this run's
    // already-created clap deadline is extended; all replies remain real.
    for (let attempt = 0; attempt < 8; attempt++) {
      const saved = await row();
      expect(saved.state.clap, 'The real UI play must have started a clap phase').not.toBeNull();
      saved.state.clap!.deadline = Date.now() + 30000;
      const { data, error } = await db.from('svintus_rooms').update({ state: saved.state, version: saved.version + 1, updated_at: new Date().toISOString() }).eq('code', ownCode!).eq('version', saved.version).select('code');
      expect(error, 'Extend only this browser test room’s clap phase').toBeNull();
      if (data?.length === 1) return;
    }
    throw new Error('Could not hold this browser test room’s clap phase.');
  };
  const submit = async (page: Page, buttonName: string, route: string) => {
    const response = page.waitForResponse(response => new URL(response.url()).pathname === route && response.request().method() === 'POST', { timeout: 15000 });
    await page.getByRole('button', { name: buttonName, exact: true }).click();
    const result = await response;
    expect(result.status()).toBe(200);
    return await result.json() as Session;
  };
  const ready = async (page: Page) => {
    if (new URL(page.url()).searchParams.has('room')) {
      await expect(page.locator('main[data-screen="find"]')).toBeVisible();
      await expect(page.getByLabel('Код комнаты')).toBeEnabled();
      await expect(page.getByRole('button', { name: 'Войти по коду', exact: true })).toBeEnabled();
      return;
    }
    // Visible HTML arrives before React hydration. Confirm a real UI handler
    // works before typing into controlled fields or submitting the form.
    await expect(page.locator('main[data-screen="home"]')).toBeVisible();
    await page.getByRole('button', { name: 'Правила игры', exact: true }).click();
    const rules = page.getByRole('dialog', { name: 'Правила Свинтуса' });
    await expect(rules).toBeVisible();
    await rules.getByRole('button', { name: 'Закрыть', exact: true }).click();
    await expect(rules).toHaveCount(0);
  };

  try {
    for (let index = 0; index < 6; index++) {
      const context = await browser.newContext(index === 5 ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, baseURL } : { viewport: { width: 1440, height: 1000 }, baseURL });
      contexts.push(context);
      const page = await context.newPage();
      page.on('pageerror', error => runtimeErrors.push(error.message));
      pages.push(page);
    }
    await Promise.all([pages[0].goto('/'), pages[5].goto('/')]);
    await Promise.all([ready(pages[0]), ready(pages[5])]);
    await expect(pages[0].getByRole('heading', { level: 1 })).toContainText('СВИНТУС');
    await Promise.all([
      pages[0].screenshot({ path: '/tmp/svintus-desktop-landing.png', fullPage: true }),
      pages[5].screenshot({ path: '/tmp/svintus-mobile-landing.png', fullPage: true }),
    ]);
    expect(await pages[5].evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await pages[0].getByRole('button', { name: /^Создать игру/ }).click();
    await expect(pages[0].locator('main[data-screen="create"]')).toBeVisible();
    await pages[0].getByLabel('Твоё имя').fill('Игрок 1');
    await pages[0].getByRole('group', { name: 'Время на ход' }).getByRole('button').filter({ hasText: '5' }).click();
    const host = await submit(pages[0], 'Создать комнату', '/api/rooms');
    sessions.push(host);
    ownCode = host.code;
    expect(host.game.turnSeconds).toBe(5);
    await expect(pages[0].locator('.lobby-seat.occupied')).toHaveCount(1);
    await expect(pages[0].getByRole('button', { name: 'Раздать карты!', exact: true })).toBeDisabled();

    // Lose the first guest's response only after the real server has committed
    // its seat. Retrying through the UI must recover that exact seat/token.
    // The database and every response body remain real; only transport fails.
    const firstGuestPage = pages[1];
    await firstGuestPage.goto(`/?room=${ownCode}`);
    await ready(firstGuestPage);
    await firstGuestPage.getByLabel('Твоё имя').fill('Игрок 2');
    let lostResponse: Session | undefined;
    let responseLost = false;
    const joinPattern = `**/api/rooms/${ownCode}/join`;
    await firstGuestPage.route(joinPattern, async route => {
      if (!responseLost && route.request().method() === 'POST') {
        responseLost = true;
        const response = await route.fetch();
        expect(response.status(), 'Seat committed before deliberately losing the response').toBe(200);
        lostResponse = await response.json() as Session;
        await route.abort('failed');
      } else await route.continue();
    });
    await firstGuestPage.getByRole('button', { name: 'Войти по коду', exact: true }).click();
    await expect(firstGuestPage.getByRole('alert')).toBeVisible();
    await expect(pages[0].locator('.lobby-seat.occupied')).toHaveCount(2);
    await expect(firstGuestPage.getByRole('button', { name: 'Войти по коду', exact: true })).toBeEnabled();
    await firstGuestPage.reload();
    await ready(firstGuestPage);
    await firstGuestPage.getByLabel('Твоё имя').fill('Игрок 2');
    const recoveredGuest = await submit(firstGuestPage, 'Войти по коду', `/api/rooms/${ownCode}/join`);
    expect(recoveredGuest.playerId).toBe(lostResponse!.playerId);
    expect(recoveredGuest.token).toBe(lostResponse!.token);
    expect(recoveredGuest.game.players.length).toBe(2);
    await expect(pages[0].locator('.lobby-seat.occupied')).toHaveCount(2);
    await firstGuestPage.unroute(joinPattern);
    sessions.push(recoveredGuest);

    const guests = await Promise.all(pages.slice(2).map(async (page, index) => {
      await page.goto(`/?room=${ownCode}`);
      await ready(page);
      await page.getByLabel('Твоё имя').fill(`Игрок ${index + 3}`);
      await expect(page.getByLabel('Код комнаты')).toHaveValue(ownCode!);
      return await submit(page, 'Войти по коду', `/api/rooms/${ownCode}/join`);
    }));
    sessions.push(...guests);
    await expect(pages[0].locator('.lobby-seat.occupied')).toHaveCount(6);
    await pages[0].screenshot({ path: '/tmp/svintus-desktop-lobby.png', fullPage: true });
    const started = await submit(pages[0], 'Раздать карты!', `/api/rooms/${ownCode}/action`);
    expect(started.game.players.map(player => player.cardCount)).toEqual([8, 8, 8, 8, 8, 8]);
    expect(started.game.hand).toHaveLength(8);
    await holdOpeningForBrowserInspection();
    const initialViews = await Promise.all(sessions.map((_, index) => gameView(index)));
    expect(initialViews.map(game => game.hand.length)).toEqual([8, 8, 8, 8, 8, 8]);
    expect(new Set(initialViews.flatMap(game => game.hand.map(card => card.id))).size).toBe(48);
    for (const game of initialViews) {
      expect(game.players.every(player => !Object.hasOwn(player, 'hand'))).toBe(true);
      expect(Object.hasOwn(game, 'drawPile')).toBe(false);
    }
    original = (await row()).state;

    // A neutral opener makes screenshots independent of the shuffled first
    // instruction. The game, HTTP transport and database stay real.
    await seed();
    await Promise.all(pages.map(page => expect(page.locator('.hand-card')).toHaveCount(8)));
    await Promise.all(pages.map(page => expect(page.getByRole('dialog', { name: 'Хлопкопыт — нажми Хлоп!' })).toHaveCount(0)));
    for (const page of pages) {
      await expect(page.locator('.opponent')).toHaveCount(5);
      await expect.poll(() => page.locator('.hand-card img').evaluateAll(images => images.every(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
    }
    // Refresh the five-second deadline immediately before capturing the table.
    await seed();
    await Promise.all([
      pages[0].screenshot({ path: '/tmp/svintus-desktop-game.png', fullPage: true }),
      pages[5].screenshot({ path: '/tmp/svintus-mobile-game.png', fullPage: true }),
    ]);
    expect(await pages[5].evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await seed();
    await pages[3].reload();
    await expect(pages[3].locator('.hand-card')).toHaveCount(8);
    expect((await gameView(3)).meId).toBe(sessions[3].playerId);
    expect((await gameView(3)).players.length).toBe(6);

    const oneCard = [{ kind: 'number', color: 'red', value: 2 }, { kind: 'number', color: 'blue', value: 6 }] as Definition[];
    await seed([oneCard]);
    await expect(pages[0].locator('.hand-card')).toHaveCount(2);
    await pages[0].getByRole('button', { name: 'Красный, 2, сыграть', exact: true }).click({ position: { x: 12, y: 30 } });
    await expect(pages[0].locator('.hand-card')).toHaveCount(1);
    const declaration = pages[0].getByRole('button', { name: 'Свинтус!', exact: true });
    await expect(declaration).toBeEnabled();
    await expect(pages[1].getByRole('button', { name: 'Поймать Игрок 1', exact: true })).toBeEnabled();
    await declaration.click();
    await expect(declaration).toBeDisabled();
    await expect(pages[1].getByRole('button', { name: 'Поймать Игрок 1', exact: true })).toHaveCount(0);
    expect((await gameView(0)).hand.length).toBe(1);

    await seed([oneCard]);
    await expect(pages[0].locator('.hand-card')).toHaveCount(2);
    await pages[0].getByRole('button', { name: 'Красный, 2, сыграть', exact: true }).click({ position: { x: 12, y: 30 } });
    await expect(pages[1].getByRole('button', { name: 'Поймать Игрок 1', exact: true })).toBeEnabled();
    await pages[1].getByRole('button', { name: 'Поймать Игрок 1', exact: true }).click();
    await expect(pages[0].locator('.hand-card')).toHaveCount(4);
    await expect(pages[0].getByRole('button', { name: 'Свинтус!', exact: true })).toBeDisabled();

    await seed([[{ kind: 'clap', color: 'red' }, { kind: 'number', color: 'blue', value: 6 }]]);
    await expect(pages[0].locator('.hand-card')).toHaveCount(2);
    await pages[0].getByRole('button', { name: 'Красный, Хлопкопыт, сыграть', exact: true }).click({ position: { x: 12, y: 30 } });
    const clapDialog = (page: Page) => page.getByRole('dialog', { name: 'Хлопкопыт — нажми Хлоп!' });
    await expect(clapDialog(pages[0])).toBeVisible();
    await holdClapForBrowserInspection();
    await Promise.all(pages.map(page => expect(clapDialog(page)).toBeVisible()));
    await pages[0].screenshot({ path: '/tmp/svintus-desktop-clap.png', fullPage: true });
    await Promise.all(pages.slice(0, 5).map(page => clapDialog(page).getByRole('button', { name: 'ХЛОП!', exact: true }).click()));
    await clapDialog(pages[5]).getByRole('button', { name: 'ХЛОП!', exact: true }).click();
    await Promise.all(pages.map(page => expect(clapDialog(page)).toHaveCount(0)));
    expect((await gameView(5)).hand).toHaveLength(10);
    await expect(pages[5].locator('.hand-card')).toHaveCount(8);
    await pages[5].getByRole('button', { name: 'Следующие карты', exact: true }).click();
    await expect(pages[5].locator('.hand-card')).toHaveCount(2);

    await seed([
      [{ kind: 'number', color: 'red', value: 2 }],
      [{ kind: 'number', color: 'green', value: 0 }, { kind: 'number', color: 'green', value: 1 }],
      Array.from({ length: 5 }, (_, value) => ({ kind: 'number', color: 'blue', value } as Definition)),
      Array.from({ length: 3 }, (_, value) => ({ kind: 'number', color: 'orange', value } as Definition)),
      Array.from({ length: 3 }, (_, index) => ({ kind: 'number', color: 'green', value: index + 2 } as Definition)),
      [{ kind: 'number', color: 'orange', value: 3 }],
    ]);
    await pages[0].getByRole('button', { name: 'Красный, 2, сыграть', exact: true }).click({ position: { x: 12, y: 30 } });
    await Promise.all(pages.map(page => expect(page.locator('.score-row')).toHaveCount(6)));
    await expect(pages[0].getByRole('heading', { name: /Игрок 1.*выигрывает раунд/ })).toBeVisible();
    await expect(pages[0].locator('.score-leader .score-points')).toHaveText('0 очков');
    await expect(pages[0].locator('.score-svintus')).toHaveCount(1);
    await expect(pages[0].locator('.score-svintus')).toContainText('Игрок 3');
    await expect(pages[0].locator('.score-svintus .score-points')).toHaveText('5 очков');
    await Promise.all([
      pages[0].screenshot({ path: '/tmp/svintus-desktop-results.png', fullPage: true }),
      pages[5].screenshot({ path: '/tmp/svintus-mobile-results.png', fullPage: true }),
    ]);
    expect(runtimeErrors).toEqual([]);
    test.info().annotations.push({ type: 'artifacts', description: '/tmp/svintus-{desktop,mobile}-{landing,game,results}.png; desktop-lobby.png; desktop-clap.png' });
  } finally {
    await Promise.all(contexts.map(context => context.close()));
    if (ownCode) {
      const { error } = await db.from('svintus_rooms').delete().eq('code', ownCode);
      expect(error, 'Delete only this browser run’s own room').toBeNull();
    }
  }
});
