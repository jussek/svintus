import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

// Exercises the real HTTP API and Supabase. Only this run's created room is
// seeded or deleted; service credentials never appear in output.
const base = (process.env.BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
assert(process.env.SUPABASE_URL && key, 'Live smoke needs SUPABASE_URL and a server Supabase key.');
const db = createClient(process.env.SUPABASE_URL, key, { auth: { persistSession: false, autoRefreshToken: false } });
let ownCode;
let players;
let originalState;
const checks = [];

async function request(path, { method = 'GET', token, body, actionId } = {}) {
  const headers = { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...(actionId ? { 'X-Action-Id': actionId } : {}) };
  const response = await fetch(`${base}${path}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000) });
  const result = await response.json();
  return { status: response.status, ...result };
}
const action = (player, body, actionId = randomUUID()) => request(`/api/rooms/${ownCode}/action`, { method: 'POST', token: player.token, body, actionId });
const view = (player) => request(`/api/rooms/${ownCode}`, { token: player.token });
function ok(result, label) { assert.equal(result.status, 200, `${label}: HTTP ${result.status} ${result.error || ''}`); return result; }
function note(label) { checks.push(label); console.log(`PASS ${label}`); }

async function row() {
  assert(ownCode && /^[A-Z2-9]{6}$/.test(ownCode), 'Only the created smoke room may be accessed.');
  const { data, error } = await db.from('svintus_rooms').select('code,state,version').eq('code', ownCode).single();
  assert(!error && data, 'Could not read the smoke room in Supabase.');
  return data;
}
async function seed({ hands, top = { kind: 'number', color: 'red', value: 1 }, turnIndex = 0, catchablePlayerId = null, silenceOwnerId = null, pending = null, expired = false, clap = null, nextDraw } = {}) {
  const saved = await row();
  const state = structuredClone(originalState);
  const pool = [...state.drawPile, ...state.discardPile, ...state.players.flatMap(p => p.hand)];
  const take = (definition) => {
    const index = pool.findIndex(c => c.kind === definition.kind && c.color === definition.color && (c.kind !== 'number' || c.value === definition.value));
    assert(index >= 0, `Missing fixture card ${definition.color} ${definition.kind} ${definition.value ?? ''}.`);
    return pool.splice(index, 1)[0];
  };
  const topCard = take(top);
  const assigned = state.players.map((_, index) => hands?.[index]?.map(take));
  state.players.forEach((player, index) => {
    player.hand = assigned[index] || pool.splice(0, 3);
    player.score = 0;
  });
  if (nextDraw) pool.push(take(nextDraw));
  Object.assign(state, { status: 'playing', round: 1, turnIndex, activeColor: topCard.color || 'red', drawPile: pool, discardPile: [topCard], turnDeadline: expired ? Date.now() - 1 : Date.now() + 60000, drawnCardId: null, pending, clap, silenceOwnerId, catchablePlayerId, lastPlayedById: state.players[5].id, winnerId: null, roundWinnerId: null, svintusIds: [], log: [], chat: [] });
  if (clap) state.turnDeadline = null;
  const { data, error } = await db.from('svintus_rooms').update({ state, version: saved.version + 1, updated_at: new Date().toISOString() }).eq('code', ownCode).eq('version', saved.version).select('code');
  assert(!error && data?.length === 1, 'Could not atomically seed this smoke room.');
  return state;
}
const number = (color, value) => ({ kind: 'number', color, value });
const special = (color, kind) => ({ kind, color });
const count = (game, player) => game.players.find(p => p.id === player.playerId).cardCount;

try {
  ok(await request('/api/health'), 'Supabase health');
  const host = ok(await request('/api/rooms', { method: 'POST', body: { name: 'Smoke 1', turnSeconds: 5 } }), 'create');
  ownCode = host.code;
  const joinBodies = Array.from({ length: 5 }, (_, i) => ({ name: `Smoke ${i + 2}`, joinToken: randomBytes(32).toString('base64url') }));
  const joins = await Promise.all([...joinBodies, joinBodies[0]].map(body => request(`/api/rooms/${ownCode}/join`, { method: 'POST', body })));
  joins.forEach((result, index) => ok(result, `parallel join ${index + 2}`));
  assert.equal(joins[5].playerId, joins[0].playerId, 'Concurrent identical join tokens must reserve one seat.');
  assert.equal(joins[5].token, joins[0].token);
  joinBodies.forEach((body, index) => assert.equal(joins[index].token, body.joinToken));
  players = [host, ...joins.slice(0, 5)];
  assert.equal(new Set(players.map(p => p.playerId)).size, 6);
  const lobby = ok(await view(host), 'full lobby').game;
  assert.equal(lobby.players.length, 6);
  // Parallel joins may commit in a different order than request creation.
  // Fixtures follow the authoritative seat order, never Promise.all order.
  players = lobby.players.map(seat => players.find(player => player.playerId === seat.id));
  assert.equal((await request(`/api/rooms/${ownCode}/join`, { method: 'POST', body: { name: 'Seventh' } })).status, 409);
  assert.equal((await request(`/api/rooms/${ownCode}`)).status, 401);
  assert.equal((await request(`/api/rooms/${ownCode}`, { token: 'a'.repeat(43) })).status, 401);
  assert.equal((await action(players[1], { type: 'start' })).status, 409);
  note('six parallel seats, seventh rejected, private room, host-only start');

  const retryFull = ok(await request(`/api/rooms/${ownCode}/join`, { method: 'POST', body: joinBodies[0] }), 'retry joined full lobby');
  assert.equal(retryFull.playerId, joins[0].playerId);
  assert.equal(retryFull.token, joins[0].token);
  assert.equal(retryFull.game.players.length, 6);

  const started = ok(await action(host, { type: 'start' }), 'start');
  assert.equal(started.game.status, 'playing');
  assert.equal(started.game.hand.length, 8);
  assert(started.game.players.every(player => player.cardCount === 8));
  // These inspection requests may together outlast a five-second real turn.
  // Keep this run's untouched opening hands stable while checking all six
  // authenticated views; separate timeout cases below exercise real ticking.
  const opening = await row();
  const inspectionState = structuredClone(opening.state);
  assert(inspectionState.players.every(player => player.hand.length === 8));
  if (inspectionState.clap) inspectionState.clap.deadline = Date.now() + 60000;
  else inspectionState.turnDeadline = Date.now() + 60000;
  const inspectionWrite = await db.from('svintus_rooms').update({ state: inspectionState, version: opening.version + 1, updated_at: new Date().toISOString() }).eq('code', ownCode).eq('version', opening.version).select('code');
  assert(!inspectionWrite.error && inspectionWrite.data?.length === 1, 'Could not hold this smoke room’s opening phase for inspection.');
  const retryStarted = ok(await request(`/api/rooms/${ownCode}/join`, { method: 'POST', body: joinBodies[0] }), 'retry joined started round');
  assert.equal(retryStarted.playerId, joins[0].playerId);
  assert.equal(retryStarted.token, joins[0].token);
  assert.equal(retryStarted.game.players.length, 6);
  assert.equal(retryStarted.game.status, 'playing');
  assert.equal(retryStarted.game.hand.length, 8);
  note('same join token is idempotent concurrently and reconnects after full lobby or started round');
  const views = await Promise.all(players.map(view));
  for (let i = 0; i < views.length; i++) {
    const game = ok(views[i], 'initial private hand').game;
    assert.equal(game.hand.length, 8);
    assert.equal(game.meId, players[i].playerId);
    assert(game.players.every(p => p.cardCount === 8 && !Object.hasOwn(p, 'hand')));
    for (const forbidden of ['drawPile', 'discardPile', 'sessions', 'token']) assert(!Object.hasOwn(game, forbidden));
  }
  assert.equal(new Set(views.flatMap(v => v.game.hand.map(c => c.id))).size, 48);
  originalState = (await row()).state;
  note('eight distinct cards per player; no opponents’ hands or deck order exposed');

  await seed();
  const repeatedId = randomUUID();
  const duplicateResults = await Promise.all(Array.from({ length: 6 }, () => action(host, { type: 'chat', text: 'one logical message' }, repeatedId)));
  duplicateResults.forEach(result => ok(result, 'duplicate request'));
  assert.equal(ok(await view(host), 'duplicate view').game.chat.filter(m => m.text === 'one logical message').length, 1);
  const simultaneousMessages = await Promise.all(players.map((player, i) => action(player, { type: 'chat', text: `concurrent-${i}` })));
  simultaneousMessages.forEach(result => ok(result, 'concurrent chat'));
  assert.equal(ok(await view(host), 'chat convergence').game.chat.filter(m => m.text.startsWith('concurrent-')).length, 6);
  const opponentCard = ok(await view(players[1]), 'owned-card check').game.hand[0];
  assert.equal((await action(host, { type: 'play', cardId: opponentCard.id })).status, 409);
  note('concurrent CAS writes converge; duplicate action IDs execute once; card ownership enforced');

  const prepareOne = async () => {
    const state = await seed({ hands: [[number('red', 2), number('blue', 6)], undefined, undefined, undefined, undefined, undefined] });
    const played = ok(await action(host, { type: 'play', cardId: state.players[0].hand[0].id }), 'penultimate play');
    assert.equal(played.game.hand.length, 1);
    assert.equal(played.game.catchablePlayerId, host.playerId);
  };
  await prepareOne();
  ok(await action(host, { type: 'declare' }), 'declare first');
  assert.equal((await action(players[1], { type: 'catch', targetId: host.playerId })).status, 409);
  assert.equal(ok(await view(host), 'declared hand').game.hand.length, 1);
  await prepareOne();
  ok(await action(players[1], { type: 'catch', targetId: host.playerId }), 'catch first');
  assert.equal((await action(host, { type: 'declare' })).status, 409);
  assert.equal(ok(await view(host), 'caught hand').game.hand.length, 4);
  for (let trial = 0; trial < 3; trial++) {
    await prepareOne();
    const race = await Promise.all([action(host, { type: 'declare' }), action(players[1], { type: 'catch', targetId: host.playerId })]);
    assert.deepEqual(race.map(r => r.status).sort(), [200, 409]);
    const after = ok(await view(host), 'race outcome').game;
    assert.equal(after.catchablePlayerId, null);
    assert.equal(after.hand.length, race[0].status === 200 ? 1 : 4);
  }
  await seed({ hands: [[number('red', 2)], undefined, undefined, undefined, undefined, undefined], catchablePlayerId: host.playerId, silenceOwnerId: players[2].playerId });
  const silentDeclare = ok(await action(host, { type: 'declare' }), 'silent declare').game;
  assert.equal(silentDeclare.hand.length, 1);
  assert.equal(silentDeclare.silenceOwnerId, players[2].playerId);
  note('declare-first, catch-first, true concurrent races and silent declaration obey first accepted action');

  let fixture = await seed({ hands: [[special('red', 'draw3'), number('blue', 1)], [special('blue', 'draw3'), number('green', 2)], undefined, undefined, undefined, undefined] });
  assert.equal(ok(await action(host, { type: 'play', cardId: fixture.players[0].hand[0].id }), 'first draw3').game.pending.amount, 3);
  assert.equal(ok(await action(players[1], { type: 'play', cardId: fixture.players[1].hand[0].id }), 'relay draw3').game.pending.amount, 6);
  const beforePenalty = fixture.players[2].hand.length;
  const accepted = ok(await action(players[2], { type: 'accept_penalty' }), 'accept six').game;
  assert.equal(accepted.hand.length, beforePenalty + 6);
  assert.equal(accepted.turnIndex, 3);
  assert.equal(accepted.pending, null);

  fixture = await seed({ hands: [[special('red', 'skip'), number('blue', 1)], [special('blue', 'skip'), number('green', 2)], undefined, undefined, undefined, undefined] });
  ok(await action(host, { type: 'play', cardId: fixture.players[0].hand[0].id }), 'first skip');
  ok(await action(players[1], { type: 'play', cardId: fixture.players[1].hand[0].id }), 'relay skip');
  const skipped = ok(await action(players[2], { type: 'accept_penalty' }), 'accept skip').game;
  assert.equal(skipped.hand.length, fixture.players[2].hand.length);
  assert.equal(skipped.turnIndex, 3);

  fixture = await seed({ hands: [[special(null, 'wild'), number('blue', 1)], undefined, undefined, undefined, undefined, undefined] });
  const chosen = ok(await action(host, { type: 'play', cardId: fixture.players[0].hand[0].id, color: 'green' }), 'choose wild color').game;
  assert.equal(chosen.activeColor, 'green');

  fixture = await seed({ hands: [[special('red', 'silence'), number('blue', 1)], undefined, undefined, undefined, undefined, undefined] });
  const silence = ok(await action(host, { type: 'play', cardId: fixture.players[0].hand[0].id }), 'silence').game;
  assert.equal(silence.silenceOwnerId, host.playerId);
  const spoken = ok(await action(players[1], { type: 'chat', text: 'I broke the silence' }), 'silence violation').game;
  assert.equal(spoken.hand.length, fixture.players[1].hand.length + 2);
  assert.equal(spoken.silenceOwnerId, null);
  note('draw-three stacking, skip relay, wild color and silence penalties');

  fixture = await seed({ hands: [[number('red', 2), number('blue', 1)], [number('red', 1), number('green', 2)], undefined, undefined, undefined, undefined] });
  const intercepted = ok(await action(players[1], { type: 'play', cardId: fixture.players[1].hand[0].id }), 'identical intercept').game;
  assert.equal(intercepted.turnIndex, 2);
  assert.equal(intercepted.topCard.id, fixture.players[1].hand[0].id);

  fixture = await seed({ hands: [[number('red', 2), number('blue', 1)], undefined, undefined, undefined, undefined, undefined], nextDraw: number('red', 3) });
  const drawn = ok(await action(host, { type: 'draw' }), 'matching draw').game;
  assert(drawn.drawnCardId);
  assert.equal(drawn.hand.length, 3);
  assert.equal(drawn.turnIndex, 0);
  const wrong = ok(await action(host, { type: 'play', cardId: fixture.players[0].hand[0].id }), 'only newly drawn may play').game;
  assert.equal(wrong.hand.length, 5);
  assert.equal(wrong.turnIndex, 1);
  note('exact-card intercept and newly drawn-card restriction with wrong-move penalty');

  fixture = await seed({ hands: [[special('red', 'clap'), number('blue', 1)], undefined, undefined, undefined, undefined, undefined] });
  const clapping = ok(await action(host, { type: 'play', cardId: fixture.players[0].hand[0].id }), 'clap card').game;
  assert(clapping.clap);
  assert.equal(clapping.turnDeadline, null);
  const earlyClaps = await Promise.all(players.slice(0, 5).map(player => action(player, { type: 'clap' })));
  earlyClaps.forEach(result => ok(result, 'parallel clap'));
  const lastClap = ok(await action(players[5], { type: 'clap' }), 'last clap').game;
  assert.equal(lastClap.clap, null);
  assert.equal(lastClap.hand.length, fixture.players[5].hand.length + 2);
  for (let i = 0; i < 5; i++) assert.equal(count(lastClap, players[i]), fixture.players[i].hand.length - (i === 0 ? 1 : 0));
  note('six-player clap phase serializes simultaneous replies and penalizes only the last');

  fixture = await seed({ expired: true, pending: { kind: 'draw3', amount: 6 } });
  const expired = ok(await view(host), 'expired turn heartbeat').game;
  assert.equal(expired.hand.length, fixture.players[0].hand.length + 8);
  assert.equal(expired.turnIndex, 1);
  assert.equal(expired.pending, null);
  assert(expired.turnDeadline > Date.now());
  fixture = await seed({ clap: { id: randomUUID(), responded: players.slice(0, 2).map(p => p.playerId), deadline: Date.now() - 1 } });
  const missedClap = ok(await view(host), 'expired clap heartbeat').game;
  assert.equal(missedClap.clap, null);
  for (let i = 0; i < 6; i++) assert.equal(count(missedClap, players[i]), fixture.players[i].hand.length + (i < 2 ? 0 : 2));
  note('heartbeat advances expired turns and clap phases without offline cascades');

  fixture = await seed({ hands: [[special(null, 'wild')], [special(null, 'wild')], undefined, undefined, undefined, undefined], top: special(null, 'wild') });
  const finalCardRace = await Promise.all([
    action(host, { type: 'play', cardId: fixture.players[0].hand[0].id, color: 'red' }),
    action(players[1], { type: 'play', cardId: fixture.players[1].hand[0].id, color: 'green' }),
  ]);
  assert.deepEqual(finalCardRace.map(result => result.status).sort(), [200, 409]);
  const firstAccepted = finalCardRace.findIndex(result => result.status === 200);
  const raceEnd = ok(await view(host), 'concurrent final cards').game;
  assert.equal(raceEnd.status, 'round_end');
  assert.equal(raceEnd.winnerId, players[firstAccepted].playerId);
  assert.equal(count(raceEnd, players[firstAccepted]), 0);
  assert.equal(count(raceEnd, players[1 - firstAccepted]), 1);
  note('simultaneous final-card play and identical intercept produce exactly one round winner');

  fixture = await seed({ hands: [[number('red', 2)], [number('green', 0), number('green', 1)], [number('blue', 0), number('blue', 1), number('blue', 2), number('blue', 3), number('blue', 4)], [number('orange', 0), number('orange', 1), number('orange', 2)], [number('green', 2), number('green', 3), number('green', 4), number('green', 5), number('green', 6)], [number('orange', 3)]] });
  const ended = ok(await action(host, { type: 'play', cardId: fixture.players[0].hand[0].id }), 'win round').game;
  assert.equal(ended.status, 'round_end');
  assert.equal(ended.winnerId, host.playerId);
  assert.equal(ended.roundWinnerId, host.playerId);
  assert.deepEqual(ended.players.map(p => p.score), [0, 2, 5, 3, 5, 1]);
  assert.deepEqual(ended.svintusIds.sort(), [players[2].playerId, players[4].playerId].sort());
  assert.equal(ended.turnDeadline, null);
  assert.equal((await action(players[1], { type: 'next_round' })).status, 409);
  const fresh = ok(await action(host, { type: 'next_round' }), 'next round').game;
  assert.equal(fresh.round, 2);
  assert(fresh.players.every(p => p.score === 0 && p.cardCount === 8));
  assert.deepEqual(fresh.svintusIds, []);
  note('first empty hand wins; one remaining card = one point; max-score ties are Svintus; next round resets');

  console.log(`Live smoke passed ${checks.length} groups against ${base}.`);
} finally {
  if (ownCode) {
    const { error } = await db.from('svintus_rooms').delete().eq('code', ownCode);
    assert(!error, 'Cleanup of this smoke run’s own room failed.');
    console.log('Deleted only this run’s smoke room.');
  }
}
