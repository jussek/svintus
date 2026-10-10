import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { addPlayer, createDeck, createGame, type GameState } from './game';
import { getRoom, roomAction } from './rooms';

const NOW = 1_000_000;
const TOKEN = Buffer.alloc(32, 7).toString('base64url');
function fixture(human: string[], bot: string[]) {
  const state = addPlayer(createGame('human', 'Человек'), 'bot', 'Бот');
  state.players[1].isBot = true;
  const pool = createDeck();
  const take = (id: string) => {
    const index = pool.findIndex(card => card.id === id);
    assert(index >= 0);
    return pool.splice(index, 1)[0];
  };
  state.players[0].hand = human.map(take);
  state.players[1].hand = bot.map(take);
  state.discardPile = [take('red-1-0')];
  state.drawPile = pool;
  Object.assign(state, { status: 'playing', round: 1, turnIndex: 0, activeColor: 'red', turnDeadline: NOW + 5000, lastPlayedById: 'bot' });
  return state;
}

function databaseWithDelayedRead(t: TestContext, state: GameState, arrival: number, completed: number) {
  // The real room handler and SDK execute normally. Only its database transport
  // and wall clock are controlled to reproduce a SELECT crossing a bot's due time.
  const previousUrl = process.env.SUPABASE_URL;
  const previousKey = process.env.SUPABASE_SECRET_KEY;
  process.env.SUPABASE_URL ??= 'https://test.supabase.co';
  process.env.SUPABASE_SECRET_KEY ??= 'test-server-key';
  t.after(() => {
    if (previousUrl === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = previousUrl;
    if (previousKey === undefined) delete process.env.SUPABASE_SECRET_KEY; else process.env.SUPABASE_SECRET_KEY = previousKey;
  });
  let clock = arrival;
  let saved: GameState | undefined;
  t.mock.method(Date, 'now', () => clock);
  t.mock.method(globalThis, 'fetch', async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'GET') {
      clock = completed;
      return Response.json([{ code: 'ABCDEF', state, sessions: { human: { hash: createHash('sha256').update(TOKEN).digest('hex'), requests: [] } }, version: 0, created_at: new Date(NOW).toISOString(), updated_at: new Date(NOW).toISOString() }]);
    }
    assert.equal(init?.method, 'PATCH', 'Only the expected room write is allowed');
    saved = JSON.parse(String(init.body)).state;
    return Response.json([{ code: 'ABCDEF' }]);
  });
  return () => { assert(saved, 'The resulting room state must be persisted'); return saved; };
}

test('a human declaration already received before a bot catch survives a slow database read', async t => {
  const state = fixture(['blue-7-0'], ['red-2-0', 'green-3-0', 'blue-4-0']);
  state.turnIndex = 1;
  state.lastPlayedById = 'human';
  state.catchablePlayerId = 'human';
  const saved = databaseWithDelayedRead(t, state, NOW + 1000, NOW + 2000);
  const result = await roomAction('ABCDEF', TOKEN, { type: 'declare' }, 'human-declare-001');
  assert.equal(result.game.hand.length, 1);
  assert.equal(result.game.catchablePlayerId, null);
  assert.equal(saved().players[0].hand.length, 1);
  assert(!saved().log.some(entry => entry.text.includes('три штрафные карты')));
});

test('a faster human catch beats a bot declaration even when SELECT completes after its due time', async t => {
  const state = fixture(['blue-7-0', 'green-7-0'], ['red-2-0']);
  state.catchablePlayerId = 'bot';
  const saved = databaseWithDelayedRead(t, state, NOW + 200, NOW + 1200);
  const result = await roomAction('ABCDEF', TOKEN, { type: 'catch', targetId: 'bot' }, 'human-catch-001');
  assert.equal(result.game.players.find(player => player.id === 'bot')?.cardCount, 4);
  assert.equal(saved().players[1].hand.length, 4);
  assert.equal(result.game.catchablePlayerId, null);
});

test('the human clap order is preserved across database latency and the last bot takes the penalty', async t => {
  const state = fixture(['blue-7-0', 'green-7-0'], ['red-2-0', 'green-3-0', 'blue-4-0']);
  state.clap = { id: 'clap-fixture', responded: [], deadline: NOW + 5000 };
  state.turnDeadline = null;
  const saved = databaseWithDelayedRead(t, state, NOW + 200, NOW + 1400);
  const result = await roomAction('ABCDEF', TOKEN, { type: 'clap' }, 'human-clap-001');
  assert.equal(result.game.hand.length, 2);
  assert.equal(saved().players[1].hand.length, 5);
  assert.equal(result.game.clap, null);
});

test('a new turn receives its full duration after a delayed read without an instant bot response', async t => {
  const state = fixture(['red-3-0', 'green-7-0', 'blue-7-0'], ['red-2-0', 'green-3-0', 'blue-4-0']);
  const saved = databaseWithDelayedRead(t, state, NOW + 1000, NOW + 2500);
  const result = await roomAction('ABCDEF', TOKEN, { type: 'play', cardId: 'red-3-0' }, 'human-play-001');
  assert.equal(result.game.players[result.game.turnIndex].id, 'bot');
  assert.equal(result.game.turnDeadline, NOW + 7500);
  assert.equal(saved().players[1].hand.length, 3);
  assert.equal(result.game.topCard?.id, 'red-3-0');
});

test('a poll received before a bot reaction does not overtake a concurrent human gesture during SELECT', async t => {
  const state = fixture(['blue-7-0'], ['red-2-0', 'green-3-0', 'blue-4-0']);
  state.turnIndex = 1;
  state.lastPlayedById = 'human';
  state.catchablePlayerId = 'human';
  databaseWithDelayedRead(t, state, NOW + 1000, NOW + 2000);
  const result = await getRoom('ABCDEF', TOKEN);
  assert.equal(result.game.hand.length, 1);
  assert.equal(result.game.catchablePlayerId, 'human');
  assert.equal(result.game.players[1].cardCount, 3);
});

test('a bot move performed by a poll gives the next participant a full new turn after SELECT', async t => {
  const state = fixture(['blue-7-0', 'green-7-0'], ['red-2-0', 'green-3-0', 'blue-4-0']);
  state.turnIndex = 1;
  state.lastPlayedById = 'human';
  const saved = databaseWithDelayedRead(t, state, NOW + 1000, NOW + 2500);
  const result = await getRoom('ABCDEF', TOKEN);
  assert.equal(result.game.topCard?.id, 'red-2-0');
  assert.equal(result.game.players[result.game.turnIndex].id, 'human');
  assert.equal(result.game.turnDeadline, NOW + 7500);
  assert.equal(saved().players[1].hand.length, 2);
});
