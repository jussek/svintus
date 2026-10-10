import { test, expect, type Locator, type Page } from '@playwright/test';
import type { Card, GameState, PublicGame } from '../lib/game';

type Session = { code: string; token: string; playerId: string; game: PublicGame };
type RoomRow = { state: GameState; version: number };
type Definition = Omit<Card, 'id'>;
const serverKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const sizes = [
  { width: 320, height: 568 },
  { width: 360, height: 640 },
  { width: 390, height: 844 },
  { width: 430, height: 932 },
  { width: 667, height: 375 },
];

async function insideViewport(page: Page, target: Locator, description: string) {
  await expect(target, description).toBeVisible();
  const bounds = await target.boundingBox();
  expect(bounds, description).not.toBeNull();
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: Math.min(innerHeight, visualViewport?.height ?? innerHeight) }));
  expect(bounds!.x, `${description}: left`).toBeGreaterThanOrEqual(-1);
  expect(bounds!.y, `${description}: top`).toBeGreaterThanOrEqual(-1);
  expect(bounds!.x + bounds!.width, `${description}: right`).toBeLessThanOrEqual(viewport.width + 1);
  expect(bounds!.y + bounds!.height, `${description}: bottom`).toBeLessThanOrEqual(viewport.height + 1);
  const clippedBy = await target.evaluate(element => {
    const own = element.getBoundingClientRect();
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      const rectangle = parent.getBoundingClientRect();
      const clipsX = /hidden|clip|scroll|auto/.test(style.overflowX);
      const clipsY = /hidden|clip|scroll|auto/.test(style.overflowY);
      if ((clipsX && (own.left < rectangle.left - 1 || own.right > rectangle.right + 1)) ||
          (clipsY && (own.top < rectangle.top - 1 || own.bottom > rectangle.bottom + 1))) {
        return `${parent.tagName.toLowerCase()}.${parent.className}`;
      }
    }
    return null;
  });
  expect(clippedBy, `${description}: control/content must not be masked by an ancestor`).toBeNull();
}

async function completeText(page: Page, target: Locator, description: string) {
  await insideViewport(page, target, description);
  const dimensions = await target.evaluate(element => ({
    contentHeight: element.scrollHeight, visibleHeight: element.clientHeight,
    contentWidth: element.scrollWidth, visibleWidth: element.clientWidth,
    lineClamp: getComputedStyle(element).webkitLineClamp,
  }));
  expect(dimensions.contentHeight, `${description}: text height`).toBeLessThanOrEqual(dimensions.visibleHeight + 1);
  expect(dimensions.contentWidth, `${description}: text width`).toBeLessThanOrEqual(dimensions.visibleWidth + 1);
  expect(['none', '0', '']).toContain(dimensions.lineClamp);
}

async function fits(page: Page, description: string, scope?: Locator) {
  const dimensions = await page.evaluate(() => ({
    width: innerWidth, height: innerHeight,
    documentWidth: document.documentElement.scrollWidth,
    documentHeight: document.documentElement.scrollHeight,
    bodyWidth: document.body.scrollWidth, bodyHeight: document.body.scrollHeight,
    x: scrollX, y: scrollY,
  }));
  expect(dimensions.documentWidth, `${description}: document width`).toBeLessThanOrEqual(dimensions.width + 1);
  expect(dimensions.documentHeight, `${description}: document height`).toBeLessThanOrEqual(dimensions.height + 1);
  expect(dimensions.bodyWidth, `${description}: body width`).toBeLessThanOrEqual(dimensions.width + 1);
  expect(dimensions.bodyHeight, `${description}: body height`).toBeLessThanOrEqual(dimensions.height + 1);
  expect(dimensions.x, `${description}: document scrollX`).toBe(0);
  expect(dimensions.y, `${description}: document scrollY`).toBe(0);
  const controls = (scope || page.locator('body')).locator('button:visible, input:visible, summary:visible').filter({ visible: true });
  for (let index = 0; index < await controls.count(); index++) {
    const control = controls.nth(index);
    const label = (await control.getAttribute('aria-label')) || (await control.textContent()) || await control.getAttribute('placeholder') || 'control';
    await insideViewport(page, control, `${description}: ${label.trim()}`);
  }
  // Paginated screens render only their current page. Every text on that page
  // must remain visible; hiding a paragraph cannot make a compact layout pass.
  const keyboardOpen = await page.locator('main').evaluate(element => element.classList.contains('keyboard-open'));
  const texts = (scope || page.locator('body')).locator(`.rule-content p, .room-card-copy strong, .room-card-copy > span, .room-card-copy small, .chat-message p${keyboardOpen ? ':visible' : ''}`);
  for (let index = 0; index < await texts.count(); index++) {
    await completeText(page, texts.nth(index), `${description}: full text ${index + 1}`);
  }
  const rows = (scope || page.locator('body')).locator('.lobby-seat:visible, .score-row:visible, .opponent:visible, .discard-wrap:visible, .table-status:visible');
  for (let index = 0; index < await rows.count(); index++) {
    await insideViewport(page, rows.nth(index), `${description}: content row ${index + 1}`);
  }
}

for (const size of sizes) {
  test(`mobile screens and every physical card fit ${size.width}x${size.height}`, async ({ browser, request, baseURL }) => {
    test.setTimeout(240000);
    test.skip(!process.env.SUPABASE_URL || !serverKey, 'Requires the actual Supabase server configuration.');
    const context = await browser.newContext({ baseURL, viewport: size, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
    const page = await context.newPage();
    let guestContext: Awaited<ReturnType<typeof browser.newContext>> | undefined;
    const extraDiscoveryCodes: string[] = [];
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    let host: Session | undefined;
    const exactRoomUrl = () => {
      expect(host?.code, 'Only the room created by this test can be changed').toMatch(/^[A-Z2-9]{6}$/);
      return `${process.env.SUPABASE_URL}/rest/v1/svintus_rooms?code=eq.${host!.code}`;
    };
    const dbHeaders = { apikey: serverKey!, Authorization: `Bearer ${serverKey}`, 'Content-Type': 'application/json' };
    const read = async (): Promise<RoomRow> => {
      const response = await fetch(`${exactRoomUrl()}&select=state,version`, { headers: dbHeaders });
      expect(response.status).toBe(200);
      const rows = await response.json() as RoomRow[];
      expect(rows).toHaveLength(1);
      return rows[0];
    };
    const save = async (make: (state: GameState) => GameState) => {
      for (let attempt = 0; attempt < 12; attempt++) {
        const saved = await read();
        const state = make(structuredClone(saved.state));
        const response = await fetch(`${exactRoomUrl()}&version=eq.${saved.version}&select=version`, {
          method: 'PATCH', headers: { ...dbHeaders, Prefer: 'return=representation' },
          body: JSON.stringify({ state, version: saved.version + 1, updated_at: new Date().toISOString() }),
        });
        expect(response.status).toBe(200);
        if ((await response.json() as unknown[]).length === 1) return state;
      }
      throw new Error('Could not seed only this test-created room.');
    };
    const waitScreen = async (screen: string) => {
      await expect(page.locator(`main[data-screen="${screen}"]`)).toBeVisible();
    };
    const findOwnPublicRoom = async (target: Page) => {
      await expect(target.locator('.public-room-card').first()).toBeVisible();
      const next = target.getByRole('button', { name: 'Следующие комнаты', exact: true });
      await expect(next, 'Four own public rooms require discovery pagination').toBeEnabled();
      const own = target.getByRole('button', { name: `Войти в комнату ${host!.code}`, exact: true });
      for (let discoveryPage = 0; discoveryPage < 20; discoveryPage++) {
        await fits(target, `public discovery page ${discoveryPage + 1}`);
        if (await own.isVisible()) return own;
        expect(await next.isEnabled(), 'The test’s own public room must remain reachable').toBe(true);
        await next.click();
      }
      throw new Error('The test-created public room was not reachable through discovery pagination.');
    };
    const screenshot = async (name: string) => page.screenshot({ path: `/tmp/svintus-mobile-${size.width}x${size.height}-${name}.png` });
    const keyboard = async (scope: string, field: Locator, submit: Locator, close: Locator, contentScope?: Locator) => {
      if (size.width !== 390 || size.height !== 844) return;
      await field.focus();
      await page.evaluate(() => {
        if (!window.visualViewport) throw new Error('Chromium visualViewport is required for keyboard layout verification.');
        Object.defineProperty(window.visualViewport, 'height', { configurable: true, get: () => 380 });
        window.visualViewport.dispatchEvent(new Event('resize'));
      });
      try {
        await expect(page.locator('main')).toHaveClass(/keyboard-open/);
        await insideViewport(page, field, `${scope}: focused field above keyboard`);
        await insideViewport(page, submit, `${scope}: submit above keyboard`);
        await insideViewport(page, close, `${scope}: close above keyboard`);
        await fits(page, `${scope}: visual viewport keyboard`, contentScope);
        await screenshot(`${scope}-keyboard`);
      } finally {
        await page.evaluate(() => {
          Reflect.deleteProperty(window.visualViewport!, 'height');
          window.visualViewport!.dispatchEvent(new Event('resize'));
          (document.activeElement as HTMLElement | null)?.blur();
        });
        await expect(page.locator('main')).not.toHaveClass(/keyboard-open/);
        await fits(page, `${scope}: full viewport restored`, contentScope);
      }
    };
    const action = async (button: Locator) => {
      const pending = page.waitForResponse(response => new URL(response.url()).pathname === `/api/rooms/${host!.code}/action` && response.request().method() === 'POST');
      await button.click();
      const response = await pending;
      expect(response.status()).toBe(200);
      return (await response.json() as { game: PublicGame }).game;
    };
    const seed = async (handDefinitions: Definition[], make?: (state: GameState) => void) => save(state => {
      const cards = [...state.drawPile, ...state.discardPile, ...state.players.flatMap(player => player.hand)];
      expect(cards).toHaveLength(104);
      expect(new Set(cards.map(card => card.id)).size).toBe(104);
      const take = (definition: Definition) => {
        const index = cards.findIndex(card => card.kind === definition.kind && card.color === definition.color && (card.kind !== 'number' || card.value === definition.value));
        expect(index, 'Fixture cards must come from the real physical deck').toBeGreaterThanOrEqual(0);
        return cards.splice(index, 1)[0];
      };
      const top = take({ kind: 'number', color: 'red', value: 1 });
      const ownHand = handDefinitions.map(take);
      state.players.forEach(player => { player.hand = player.id === host!.playerId ? ownHand : cards.splice(0, 8); player.score = 0; });
      Object.assign(state, {
        status: 'playing', turnIndex: state.players.findIndex(player => player.id === host!.playerId),
        activeColor: 'red', drawPile: cards, discardPile: [top], turnDeadline: Date.now() + 90000,
        pending: null, drawnCardId: null, clap: null, catchablePlayerId: null, silenceOwnerId: null,
        lastPlayedById: state.players.find(player => player.id !== host!.playerId)!.id,
        roundWinnerId: null, winnerId: null, svintusIds: [], log: [], chat: [],
      });
      make?.(state);
      return state;
    });
    const normalHand: Definition[] = [
      { kind: 'wild', color: null },
      ...Array.from({ length: 7 }, (_, value) => ({ kind: 'number' as const, color: 'red' as const, value })),
    ];

    try {
      await page.goto('/');
      await waitScreen('home');
      await expect(page.getByRole('button', { name: /^Создать игру/ })).toBeEnabled();
      await fits(page, 'home');
      await screenshot('home');

      await page.getByRole('button', { name: 'Правила игры', exact: true }).click();
      const rules = page.getByRole('dialog', { name: 'Правила Свинтуса' });
      await expect(rules).toBeVisible();
      const nextRule = rules.getByRole('button', { name: 'Следующее правило', exact: true });
      let rulePages = 0;
      for (; rulePages < 20; rulePages++) {
        await fits(page, `rules page ${rulePages + 1}`, rules);
        if (await nextRule.isDisabled()) break;
        await nextRule.click();
      }
      expect(rulePages, 'Paginated rules must have a reachable last page').toBeLessThan(20);
      expect(rulePages, 'Rules must exercise more than one page').toBeGreaterThan(0);
      await screenshot('rules');
      await rules.getByRole('button', { name: 'Закрыть', exact: true }).click();

      await page.getByRole('button', { name: /^Создать игру/ }).click();
      await waitScreen('create');
      await expect(page.getByRole('button', { name: 'Открытая', exact: true })).toHaveAttribute('aria-pressed', 'true');
      await page.getByRole('button', { name: 'По коду', exact: true }).click();
      await expect(page.getByRole('button', { name: 'По коду', exact: true })).toHaveAttribute('aria-pressed', 'true');
      await page.getByRole('button', { name: 'Открытая', exact: true }).click();
      await page.getByLabel('Твоё имя', { exact: true }).fill(`Мобильный хозяин ${size.width}`);
      await page.getByRole('group', { name: 'Время на ход' }).getByRole('button').filter({ hasText: '5' }).click();
      await fits(page, 'create');
      await screenshot('create');
      await keyboard('create', page.getByLabel('Твоё имя', { exact: true }), page.getByRole('button', { name: 'Создать комнату', exact: true }), page.getByRole('button', { name: 'Закрыть', exact: true }));
      const created = page.waitForResponse(response => new URL(response.url()).pathname === '/api/rooms' && response.request().method() === 'POST');
      await page.getByRole('button', { name: 'Создать комнату', exact: true }).click();
      const createdResponse = await created;
      expect(createdResponse.status()).toBe(200);
      expect(createdResponse.request().postDataJSON().isPublic).toBe(true);
      host = await createdResponse.json() as Session;
      await waitScreen('lobby');
      for (let extra = 1; extra <= 3; extra++) {
        const response = await request.post('/api/rooms', { data: { name: `Хозяин длинного стола ${extra}`, turnSeconds: 5, isPublic: true } });
        expect(response.status()).toBe(200);
        const fixtureRoom = await response.json() as Session;
        expect(fixtureRoom.code).toMatch(/^[A-Z2-9]{6}$/);
        extraDiscoveryCodes.push(fixtureRoom.code);
      }
      guestContext = await browser.newContext({ baseURL, viewport: size, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
      const guestPage = await guestContext.newPage();
      guestPage.on('pageerror', error => errors.push(error.message));
      await guestPage.goto('/');
      await expect(guestPage.getByRole('button', { name: /^Найти игру/ })).toBeEnabled();
      await guestPage.getByRole('button', { name: /^Найти игру/ }).click();
      await expect(guestPage.locator('main[data-screen="find"]')).toBeVisible();
      await guestPage.getByLabel('Твоё имя', { exact: true }).fill('Второй участник');
      const publicJoin = await findOwnPublicRoom(guestPage);
      await insideViewport(guestPage, publicJoin, 'public discovery join');
      const joining = guestPage.waitForResponse(response => new URL(response.url()).pathname === `/api/rooms/${host!.code}/join` && response.request().method() === 'POST');
      await publicJoin.click();
      const joinedResponse = await joining;
      expect(joinedResponse.status()).toBe(200);
      expect((await joinedResponse.json() as Session).game.players).toHaveLength(2);
      await expect(guestPage.locator('main[data-screen="lobby"]')).toBeVisible();
      await fits(guestPage, 'guest lobby two');
      await guestContext.close();
      guestContext = undefined;
      await expect(page.locator('.lobby-seat.occupied')).toHaveCount(2);
      await fits(page, 'lobby two');
      await screenshot('lobby-two');

      // Navigate the actual public discovery screen and code screen while this
      // test's room is still joinable. Restore the existing host seat afterward.
      await page.goto('/');
      await waitScreen('home');
      await page.getByRole('button', { name: /^Найти игру/ }).click();
      await waitScreen('find');
      const ownPublicRoom = await findOwnPublicRoom(page);
      await expect(ownPublicRoom).toBeVisible();
      await insideViewport(page, ownPublicRoom, 'own public room join');
      await screenshot('find-public');
      await page.getByRole('tab', { name: 'По коду', exact: true }).click();
      await page.getByLabel('Твоё имя', { exact: true }).fill(`Мобильный хозяин ${size.width}`);
      await page.getByLabel('Код комнаты', { exact: true }).fill(host.code);
      await fits(page, 'find by code');
      await screenshot('find-code');
      await keyboard('find-code', page.getByLabel('Код комнаты', { exact: true }), page.getByRole('button', { name: 'Войти по коду', exact: true }), page.getByRole('button', { name: 'Закрыть', exact: true }));
      await page.getByRole('button', { name: 'Войти по коду', exact: true }).click();
      await waitScreen('lobby');
      await expect(page.locator('.lobby-seat.occupied')).toHaveCount(2);
      for (let player = 3; player <= 6; player++) {
        const joined = await request.post(`/api/rooms/${host.code}/join`, { data: { name: `Участник номер ${player}` } });
        expect(joined.status()).toBe(200);
      }
      await expect(page.locator('.lobby-seat.occupied')).toHaveCount(6);
      await fits(page, 'lobby six');
      await screenshot('lobby-six');
      await action(page.getByRole('button', { name: 'Раздать карты!', exact: true }));
      await seed(normalHand);
      await waitScreen('playing');
      await expect(page.locator('.hand-card')).toHaveCount(8);
      await fits(page, 'game eight cards');
      await screenshot('game');

      await page.getByRole('button', { name: 'Об игроке Второй участник', exact: true }).click();
      const participantInfo = page.getByRole('dialog', { name: 'Участник игры', exact: true });
      await expect(participantInfo.getByRole('heading')).toHaveText('Второй участник');
      await fits(page, 'full participant name', participantInfo);
      await participantInfo.getByRole('button', { name: 'Закрыть', exact: true }).click();

      await page.getByRole('button', { name: 'Чат стола', exact: true }).click();
      const chat = page.getByRole('dialog', { name: 'Чат стола' });
      await expect(chat).toBeVisible();
      const message = 'Проверяем мобильный чат: длинное сообщение должно полностью поместиться в экран, остаться читаемым и не прятать отправку, закрытие или соседние элементы. '.repeat(2).slice(0, 200).trim();
      expect(message).toHaveLength(200);
      await chat.getByLabel('Сообщение всем игрокам').fill(message);
      await fits(page, 'chat', chat);
      await keyboard('chat', chat.getByLabel('Сообщение всем игрокам'), chat.getByRole('button', { name: 'Отправить сообщение', exact: true }), chat.getByRole('button', { name: 'Закрыть', exact: true }), chat);
      await action(chat.getByRole('button', { name: 'Отправить сообщение', exact: true }));
      const messageText = chat.getByText(message, { exact: true });
      await expect(messageText).toBeVisible();
      await completeText(page, messageText, 'complete 200-character chat message');
      await fits(page, 'chat with message', chat);
      await chat.getByLabel('Сообщение всем игрокам').fill('Пишем следующее сообщение');
      await keyboard('chat-history', chat.getByLabel('Сообщение всем игрокам'), chat.getByRole('button', { name: 'Отправить сообщение', exact: true }), chat.getByRole('button', { name: 'Закрыть', exact: true }), chat);
      const chatMessages = [message];
      for (let index = 2; index <= 3; index++) {
        const nextMessage = `Сообщение ${index}: ${message}`.slice(0, 200).trim();
        chatMessages.push(nextMessage);
        await chat.getByLabel('Сообщение всем игрокам').fill(nextMessage);
        await action(chat.getByRole('button', { name: 'Отправить сообщение', exact: true }));
        await fits(page, `chat after message ${index}`, chat);
      }
      const seenMessages = new Set<string>();
      const olderMessages = chat.getByRole('button', { name: 'Предыдущие сообщения', exact: true });
      const newerMessages = chat.getByRole('button', { name: 'Следующие сообщения', exact: true });
      for (let chatPage = 0; chatPage < 10; chatPage++) {
        await fits(page, `chat page ${chatPage + 1}`, chat);
        for (const text of await chat.locator('.chat-message p').allTextContents()) seenMessages.add(text);
        if (await olderMessages.isDisabled()) break;
        await olderMessages.click();
      }
      expect([...seenMessages].sort()).toEqual(chatMessages.sort());
      while (!(await newerMessages.isDisabled())) await newerMessages.click();
      await screenshot('chat');
      await chat.getByRole('button', { name: 'Закрыть', exact: true }).click();

      // Cards overlap in a fan; touch the exposed left corner rather than a
      // covered center (the separate touch spec exercises the actual gesture).
      await page.getByRole('button', { name: /Полисвин.*сыграть/ }).click({ position: { x: 12, y: 30 } });
      const color = page.getByRole('dialog', { name: 'Полисвин: выбери цвет' });
      await expect(color).toBeVisible();
      await fits(page, 'color', color);
      await screenshot('color');
      await action(color.getByRole('button', { name: 'Синий', exact: true }));
      await expect(color).toHaveCount(0);

      await seed(normalHand, state => {
        state.clap = { id: `mobile-${size.width}`, responded: [], deadline: Date.now() + 90000 };
        state.turnDeadline = null;
      });
      const clap = page.getByRole('dialog', { name: 'Хлопкопыт — нажми Хлоп!' });
      await expect(clap).toBeVisible();
      await fits(page, 'clap', clap);
      await screenshot('clap');
      await action(clap.getByRole('button', { name: 'ХЛОП!', exact: true }));
      await expect(clap.getByRole('button', { name: 'ЕСТЬ!', exact: true })).toBeDisabled();
      await fits(page, 'clap responded', clap);

      // A real poll can shrink a paginated hand while its current page anchor
      // is still owned. The retained card must not hide the earlier cards.
      const ten = await seed([...normalHand, { kind: 'number', color: 'red', value: 7 }, { kind: 'number', color: 'blue', value: 2 }]);
      await expect(clap).toHaveCount(0);
      await expect(page.locator('.sv-hand-guide')).toContainText('из 10');
      const shrinkPrevious = page.getByRole('button', { name: 'Предыдущие карты', exact: true });
      const shrinkNext = page.getByRole('button', { name: 'Следующие карты', exact: true });
      while (!(await shrinkPrevious.isDisabled())) await shrinkPrevious.click();
      await shrinkNext.click();
      await expect(page.locator('.hand-card')).toHaveCount(2);
      const retainedAnchor = ten.players.find(player => player.id === host!.playerId)!.hand[8].id;
      const eight = await save(state => {
        const own = state.players.find(player => player.id === host!.playerId)!;
        expect(own.hand[8].id).toBe(retainedAnchor);
        const removed = [own.hand[7], own.hand[9]];
        own.hand = [...own.hand.slice(0, 7), own.hand[8]];
        state.drawPile.push(...removed);
        return state;
      });
      await expect(page.locator('.hand-card')).toHaveCount(8);
      expect(await page.locator('.hand-card').evaluateAll(cards => cards.map(card => (card as HTMLElement).dataset.cardId))).toEqual(eight.players.find(player => player.id === host!.playerId)!.hand.map(card => card.id));
      await expect(shrinkNext).toHaveCount(0);
      await expect(shrinkPrevious).toHaveCount(0);
      await fits(page, 'hand shrunk to eight');
      await save(state => {
        state.players.find(player => player.id === host!.playerId)!.hand.push(state.drawPile.pop()!);
        return state;
      });
      await expect(page.locator('.sv-hand-guide')).toContainText('1–8 из 9');
      await expect(shrinkPrevious).toBeDisabled();
      await expect(shrinkNext).toBeEnabled();

      // Keep all 104 physical cards unique: 98 in this hand, one in each of
      // five opponents' hands and one on the table. Then exchange the six
      // excluded cards into the hand and verify those are reachable as well.
      const large = await save(state => {
        const cards = [...state.drawPile, ...state.discardPile, ...state.players.flatMap(player => player.hand)];
        expect(cards).toHaveLength(104);
        const own = state.players.find(player => player.id === host!.playerId)!;
        const opponents = state.players.filter(player => player !== own);
        state.discardPile = [cards.shift()!];
        opponents.forEach(player => { player.hand = [cards.shift()!]; });
        own.hand = cards;
        Object.assign(state, { drawPile: [], activeColor: 'red', turnIndex: state.players.indexOf(own), clap: null, turnDeadline: Date.now() + 90000, pending: null, drawnCardId: null, catchablePlayerId: null });
        return state;
      });
      await expect(clap).toHaveCount(0);
      await expect(page.locator('.sv-hand-guide')).toContainText('из 98');
      const seen = new Set<string>();
      const next = page.getByRole('button', { name: 'Следующие карты', exact: true });
      const previous = page.getByRole('button', { name: 'Предыдущие карты', exact: true });
      // Polling preserves the anchor card, which may now be on a later page.
      // Reach the first page through the user controls before traversing all.
      while (!(await previous.isDisabled())) await previous.click();
      await expect(previous).toBeDisabled();
      for (let handPage = 0; handPage < 20; handPage++) {
        const visibleCards = page.locator('.hand-card');
        await expect(visibleCards).toHaveCount(Math.min(8, 98 - handPage * 8));
        await expect.poll(() => visibleCards.locator('img').evaluateAll(images => images.every(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
        for (const id of await visibleCards.evaluateAll(cards => cards.map(card => (card as HTMLElement).dataset.cardId!))) seen.add(id);
        await fits(page, `large hand page ${handPage + 1}`);
        if (await next.isDisabled()) break;
        await next.click();
      }
      expect(seen.size, 'Every card in a 98-card physical hand is reachable').toBe(98);
      while (!(await previous.isDisabled())) await previous.click();
      const excluded = [large.discardPile[0], ...large.players.filter(player => player.id !== host!.playerId).flatMap(player => player.hand)];
      const swapped = await save(state => {
        const own = state.players.find(player => player.id === host!.playerId)!;
        const removed = own.hand.splice(0, 6, ...excluded);
        state.discardPile = [removed.shift()!];
        state.players.filter(player => player !== own).forEach(player => { player.hand = [removed.shift()!]; });
        return state;
      });
      const firstSwappedId = swapped.players.find(player => player.id === host!.playerId)!.hand[0].id;
      await expect(page.locator(`.hand-card[data-card-id="${firstSwappedId}"]`)).toBeVisible();
      await expect.poll(() => page.locator('.hand-card img').evaluateAll(images => images.every(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
      for (const id of await page.locator('.hand-card').evaluateAll(cards => cards.map(card => (card as HTMLElement).dataset.cardId!))) seen.add(id);
      expect(seen.size, 'All 104 real deck IDs can be reached through hand pagination').toBe(104);
      expect([...seen].every(id => typeof id === 'string' && id.length > 0)).toBe(true);
      await fits(page, 'large hand after polling update');

      await save(state => {
        const own = state.players.find(player => player.id === host!.playerId)!;
        const pool = [...state.drawPile, ...state.discardPile, ...state.players.flatMap(player => player.hand)];
        own.hand = []; own.score = 0;
        const opponents = state.players.filter(player => player !== own);
        opponents.forEach((player, index) => { player.hand = pool.splice(0, index + 1); player.score = player.hand.length; });
        state.discardPile = [pool.shift()!]; state.drawPile = pool;
        Object.assign(state, { status: 'round_end', roundWinnerId: own.id, winnerId: null, svintusIds: [opponents.at(-1)!.id], turnDeadline: null, clap: null, catchablePlayerId: null });
        return state;
      });
      await waitScreen('round_end');
      await fits(page, 'results six players');
      await expect(page.getByRole('button', { name: 'Ещё раунд? Раздаём!', exact: true })).toBeEnabled();
      await screenshot('results');
      expect(errors).toEqual([]);
    } finally {
      await guestContext?.close();
      await context.close();
      const ownCodes = [...(host ? [host.code] : []), ...extraDiscoveryCodes];
      const deleted = await Promise.all(ownCodes.map(async code => {
        expect(code, 'Delete only rooms created by this invocation').toMatch(/^[A-Z2-9]{6}$/);
        return await fetch(`${process.env.SUPABASE_URL}/rest/v1/svintus_rooms?code=eq.${code}`, { method: 'DELETE', headers: dbHeaders });
      }));
      for (const response of deleted) expect(response.status, 'All of this invocation’s own rooms are removed').toBe(204);
    }
  });
}
