import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

// Every fixture and delete below targets a code created by this invocation.
// The bot scheduler, HTTP API and Supabase are real; no bot credentials exist.
const base = (process.env.BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
assert(process.env.SUPABASE_URL && key, 'Bot smoke needs the actual Supabase server configuration.');
const db = createClient(process.env.SUPABASE_URL, key, { auth: { persistSession: false, autoRefreshToken: false } });
const createdCodes = new Set();
const checks = [];

async function request(path, { method = 'GET', token, body, actionId } = {}) {
  const headers = { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...(actionId ? { 'X-Action-Id': actionId } : {}) };
  const response = await fetch(`${base}${path}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000) });
  return { status: response.status, ...await response.json() };
}
function ok(result, label) { assert.equal(result.status, 200, `${label}: HTTP ${result.status} ${result.error || ''}`); return result; }
function note(label) { checks.push(label); console.log(`PASS ${label}`); }
async function create(name) {
  const session = ok(await request('/api/rooms', { method: 'POST', body: { name, turnSeconds: 5 } }), 'create bot smoke room');
  assert.match(session.code, /^[A-Z2-9]{6}$/);
  createdCodes.add(session.code);
  return session;
}
const action = (session, body, actionId = randomUUID()) => request(`/api/rooms/${session.code}/action`, { method: 'POST', token: session.token, body, actionId });
const view = (session) => request(`/api/rooms/${session.code}`, { token: session.token });
async function join(session, name) {
  return ok(await request(`/api/rooms/${session.code}/join`, { method: 'POST', body: { name, joinToken: randomBytes(32).toString('base64url') } }), 'join bot smoke room');
}
async function row(code) {
  assert(createdCodes.has(code), 'Only this invocation’s known rooms may be read.');
  const { data, error } = await db.from('svintus_rooms').select('code,state,sessions,version').eq('code', code).single();
  assert(!error && data, 'Could not read this run’s own bot smoke room.');
  return data;
}
async function update(code, mutate) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const saved = await row(code);
    const state = structuredClone(saved.state);
    mutate(state);
    const { data, error } = await db.from('svintus_rooms').update({ state, version: saved.version + 1, updated_at: new Date().toISOString() }).eq('code', code).eq('version', saved.version).select('code');
    assert(!error, 'Could not update this run’s own bot fixture.');
    if (data?.length === 1) return state;
  }
  throw new Error('Could not atomically update this run’s own bot fixture.');
}
function privateView(game, playerId) {
  assert.equal(game.meId, playerId);
  assert(Array.isArray(game.hand));
  for (const field of ['drawPile', 'discardPile', 'sessions', 'token', 'hash']) assert(!Object.hasOwn(game, field), `Private field leaked: ${field}`);
  for (const player of game.players) {
    assert.equal(typeof player.isBot, 'boolean');
    for (const field of ['hand', 'token', 'hash', 'session', 'sessions']) assert(!Object.hasOwn(player, field), `Private player field leaked: ${field}`);
  }
}
const number = (color, value) => ({ kind: 'number', color, value });
async function botFixture(session, { finish = false } = {}) {
  return update(session.code, state => {
    const bot = state.players.find(player => player.isBot);
    assert(bot && state.players.length === 2, 'Autonomous fixture needs exactly one human and one bot.');
    const pool = [...state.drawPile, ...state.discardPile, ...state.players.flatMap(player => player.hand)];
    const take = definition => {
      const index = pool.findIndex(card => card.kind === definition.kind && card.color === definition.color && (card.kind !== 'number' || card.value === definition.value));
      assert(index >= 0, 'The fixture card must be present in the actual dealt deck.');
      return pool.splice(index, 1)[0];
    };
    const top = take(number('red', 1));
    const botCards = [take(number('red', 2)), ...(!finish ? [take(number('blue', 6))] : [])];
    const humanCards = Array.from({ length: finish ? 5 : 2 }, (_, value) => take(number('green', value)));
    for (const player of state.players) { player.hand = player.isBot ? botCards : humanCards; player.score = 0; }
    Object.assign(state, { status: 'playing', turnIndex: state.players.indexOf(bot), activeColor: 'red', drawPile: pool, discardPile: [top], turnDeadline: Date.now() + state.turnSeconds * 1000, drawnCardId: null, pending: null, clap: null, silenceOwnerId: null, catchablePlayerId: null, lastPlayedById: session.playerId, winnerId: null, roundWinnerId: null, svintusIds: [], log: [], chat: [] });
  });
}
async function poll(session, predicate, label) {
  const until = Date.now() + 15000;
  do {
    const game = ok(await view(session), label).game;
    privateView(game, session.playerId);
    if (predicate(game)) return game;
    await new Promise(resolve => setTimeout(resolve, 200));
  } while (Date.now() < until);
  throw new Error(`Bot progress did not arrive: ${label}.`);
}

try {
  ok(await request('/api/health'), 'Supabase health');
  const humanHost = await create('Bots smoke two humans');
  assert.equal((await action(humanHost, { type: 'start' })).status, 409);
  const humanGuest = await join(humanHost, 'Second human');
  assert.equal((await action(humanGuest, { type: 'start' })).status, 409);
  const twoHumans = ok(await action(humanHost, { type: 'start' }), 'start with two humans').game;
  assert.equal(twoHumans.status, 'playing');
  assert.equal(twoHumans.players.length, 2);
  assert(twoHumans.players.every(player => !player.isBot && player.cardCount === 8));
  await update(humanHost.code, state => { if (state.clap) state.clap.deadline = Date.now() + 60000; else state.turnDeadline = Date.now() + 60000; });
  const humanViews = await Promise.all([view(humanHost), view(humanGuest)]);
  [humanHost, humanGuest].forEach((session, index) => { const game = ok(humanViews[index], 'two human private hands').game; privateView(game, session.playerId); assert.equal(game.hand.length, 8); });
  assert.equal(new Set(humanViews.flatMap(result => result.game.hand.map(card => card.id))).size, 16);
  note('two humans can start with eight private cards each; solo and nonhost start are rejected');

  const lobbyHost = await create('Bots smoke lobby');
  const lobbyGuest = await join(lobbyHost, 'Lobby guest');
  assert.equal((await action(lobbyGuest, { type: 'add_bot' })).status, 409);
  const withBot = ok(await action(lobbyHost, { type: 'add_bot' }), 'host add bot').game;
  const removedBot = withBot.players.find(player => player.isBot);
  assert(removedBot);
  assert.equal(withBot.players.length, 3);
  assert.equal((await action(lobbyGuest, { type: 'remove_bot', targetId: removedBot.id })).status, 409);
  const removed = ok(await action(lobbyHost, { type: 'remove_bot', targetId: removedBot.id }), 'host remove bot').game;
  assert.equal(removed.players.length, 2);
  assert(!removed.players.some(player => player.id === removedBot.id));
  assert.equal((await action(lobbyHost, { type: 'remove_bot', targetId: removedBot.id })).status, 409);
  assert.equal((await action(lobbyHost, { type: 'remove_bot', targetId: lobbyGuest.playerId })).status, 409);
  assert.equal((await action(lobbyHost, { type: 'remove_bot', targetId: lobbyHost.playerId })).status, 409);
  let fullLobby;
  for (let index = 0; index < 4; index++) fullLobby = ok(await action(lobbyHost, { type: 'add_bot' }), 'fill bot seat').game;
  assert.equal(fullLobby.players.length, 6);
  assert.equal(fullLobby.players.filter(player => player.isBot).length, 4);
  assert.equal((await action(lobbyHost, { type: 'add_bot' })).status, 409);
  assert.equal((await request(`/api/rooms/${lobbyHost.code}/join`, { method: 'POST', body: { name: 'No seventh seat' } })).status, 409);
  note('only host can add/remove lobby bots; humans cannot be removed; humans and bots share a six-seat limit');

  const lobbyRow = await row(lobbyHost.code);
  assert.deepEqual(Object.keys(lobbyRow.sessions).sort(), [lobbyHost.playerId, lobbyGuest.playerId].sort());
  privateView(fullLobby, lobbyHost.playerId);
  const botToCheck = fullLobby.players.find(player => player.isBot);
  assert.equal((await request(`/api/rooms/${lobbyHost.code}`, { token: botToCheck.id })).status, 401);
  assert.equal((await request(`/api/rooms/${lobbyHost.code}`, { token: 'a'.repeat(43) })).status, 401);
  const spoofed = ok(await request(`/api/rooms/${lobbyHost.code}?meId=${encodeURIComponent(botToCheck.id)}`, { token: lobbyHost.token }), 'client cannot select bot identity').game;
  assert.equal(spoofed.meId, lobbyHost.playerId);
  const combinedStart = ok(await action(lobbyHost, { type: 'start' }), 'start combined six').game;
  assert.equal(combinedStart.players.length, 6);
  assert.equal((await action(lobbyHost, { type: 'add_bot' })).status, 409);
  assert.equal((await action(lobbyHost, { type: 'remove_bot', targetId: botToCheck.id })).status, 409);
  note('bots expose only public counts, have no authentication sessions and cannot be added/removed after start');

  const autoHost = await create('Bots smoke autonomous');
  const autoLobby = ok(await action(autoHost, { type: 'add_bot' }), 'add sole bot').game;
  const bot = autoLobby.players.find(player => player.isBot);
  assert(bot);
  const autoStart = ok(await action(autoHost, { type: 'start' }), 'host plus bot start').game;
  assert.equal(autoStart.players.length, 2);
  assert.equal(autoStart.status, 'playing');
  const fixture = await botFixture(autoHost);
  const playedCard = fixture.players.find(player => player.isBot).hand[0];
  const moved = await poll(autoHost, game => game.topCard?.id === playedCard.id && game.players.find(player => player.id === bot.id)?.cardCount === 1, 'autonomous legal bot move');
  assert.equal(moved.players[moved.turnIndex].id, autoHost.playerId);
  assert.equal(moved.hand.length, 2);
  const declared = await poll(autoHost, game => game.catchablePlayerId === null && game.players.find(player => player.id === bot.id)?.cardCount === 1 && game.log.some(entry => entry.text.includes(bot.name) && entry.text.includes('нажал «Свинтус!»')), 'autonomous bot declaration');
  assert.equal(declared.hand.length, 2);
  const autoRow = await row(autoHost.code);
  assert.deepEqual(Object.keys(autoRow.sessions), [autoHost.playerId]);
  note('one human plus one bot starts; polling alone performs a legal move and a separate last-card declaration');

  await botFixture(autoHost, { finish: true });
  const ended = await poll(autoHost, game => game.status === 'round_end', 'bot round winner');
  assert.equal(ended.roundWinnerId, bot.id);
  assert.equal(ended.winnerId, bot.id);
  assert.equal(ended.players.find(player => player.id === bot.id).score, 0);
  assert.equal(ended.players.find(player => player.id === autoHost.playerId).score, 5);
  assert.deepEqual(ended.svintusIds, [autoHost.playerId]);
  const nextRound = ok(await action(autoHost, { type: 'next_round' }), 'next host-bot round').game;
  assert.equal(nextRound.round, 2);
  assert(nextRound.players.every(player => player.cardCount === 8 && player.score === 0));
  assert.deepEqual(nextRound.svintusIds, []);
  note('autonomous bot can finish a round; remaining-card points/Svintus apply to humans; next round deals afresh');

  const legacyHost = await create('Bots smoke old room');
  await Promise.all(Array.from({ length: 5 }, (_, index) => join(legacyHost, `Legacy human ${index + 2}`)));
  await update(legacyHost.code, state => { for (const player of state.players) delete player.isBot; });
  const oldLobby = ok(await view(legacyHost), 'legacy lobby').game;
  assert(oldLobby.players.every(player => player.isBot === false));
  const oldStart = ok(await action(legacyHost, { type: 'start' }), 'start legacy six-human room').game;
  assert.equal(oldStart.players.length, 6);
  assert(oldStart.players.every(player => player.isBot === false && player.cardCount === 8));
  await update(legacyHost.code, state => { if (state.clap) state.clap.deadline = Date.now() + 60000; else state.turnDeadline = Date.now() + 60000; });
  const idle = await row(legacyHost.code);
  ok(await view(legacyHost), 'legacy idle poll one');
  ok(await view(legacyHost), 'legacy idle poll two');
  assert.equal((await row(legacyHost.code)).version, idle.version, 'No bot scheduling writes should occur in a legacy human-only room.');
  const expired = await update(legacyHost.code, state => { state.clap = null; state.pending = null; state.turnDeadline = Date.now() - 1; });
  const oldTick = ok(await view(legacyHost), 'legacy human timeout').game;
  assert.equal(oldTick.turnIndex, (expired.turnIndex + 1) % 6);
  assert.equal(oldTick.players[expired.turnIndex].cardCount, expired.players[expired.turnIndex].hand.length + 2);
  assert(oldTick.players.every(player => player.isBot === false));
  note('old six-human rooms without isBot remain human, start normally, avoid idle writes and retain ordinary timeout behavior');

  console.log(`Bot live smoke passed ${checks.length} groups against ${base}.`);
} finally {
  for (const code of createdCodes) {
    const { error } = await db.from('svintus_rooms').delete().eq('code', code);
    assert(!error, 'Cleanup of this run’s own bot smoke room failed.');
  }
  console.log(`Deleted only this run’s ${createdCodes.size} bot smoke rooms.`);
}
