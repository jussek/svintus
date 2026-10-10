import test from "node:test";
import assert from "node:assert/strict";
import {
  act, addPlayer, canPlay, createDeck, createGame, publicGame, tick,
  type Card, type CardKind, type Color, type GameState,
} from "./game";

const NOW = 1_000_000;
let cardSequence = 0;
function card(kind: CardKind = "number", color: Color | null = "red", value = 4): Card {
  return { id: `test-${++cardSequence}`, kind, color, ...(kind === "number" ? { value } : {}) };
}
function lobby(playerCount = 6): GameState {
  let state = createGame("p0", "Игрок 0");
  for (let n = 1; n < playerCount; n++) state = addPlayer(state, `p${n}`, `Игрок ${n}`);
  return state;
}
function playing(playerCount = 6): GameState {
  const state = lobby(playerCount);
  state.status = "playing";
  state.round = 1;
  state.turnIndex = 0;
  state.activeColor = "red";
  state.turnDeadline = NOW + 5000;
  state.discardPile = [card()];
  state.drawPile = createDeck();
  state.lastPlayedById = state.players.at(-1)!.id;
  for (const p of state.players) p.hand = [card("number", "green", 2), card("number", "blue", 3)];
  return state;
}
function opening(kind: CardKind, color: Color | null = "red", chosenColor?: Color, playerCount = 6): GameState {
  const target = createDeck().findIndex((c) => c.kind === kind && c.color === color);
  assert.ok(target >= 0);
  const original = Math.random;
  let n = 103;
  const openerIndex = 103 - 8 * playerCount;
  Math.random = () => {
    const iteration = n--;
    // Preserve the selected opener below the cards dealt from the top.
    if (kind === "wild" && iteration === 103) return (openerIndex + 0.1) / 104;
    if (kind !== "wild" && iteration === openerIndex) return (target + 0.1) / (openerIndex + 1);
    return 0.999999;
  };
  try { return act(lobby(playerCount), "p0", { type: "start", color: chosenColor }, NOW); }
  finally { Math.random = original; }
}
function allCards(state: GameState): Card[] {
  return [...state.drawPile, ...state.discardPile, ...state.players.flatMap((p) => p.hand)];
}

test("the 104-card deck has correct copies and no Perekhryuk", () => {
  const deck = createDeck();
  assert.equal(deck.length, 104);
  assert.equal(new Set(deck.map((c) => c.id)).size, 104);
  assert.equal(deck.filter((c) => c.kind === "number").length, 64);
  for (const color of ["red", "orange", "green", "blue"] as const) {
    for (let value = 0; value <= 7; value++) assert.equal(deck.filter((c) => c.kind === "number" && c.color === color && c.value === value).length, 2);
    for (const kind of ["draw3", "skip", "silence", "clap"] as const) assert.equal(deck.filter((c) => c.kind === kind && c.color === color).length, 2);
  }
  assert.equal(deck.filter((c) => c.kind === "wild" && c.color === null).length, 8);
});

test("two to six participants and the host are required to start", () => {
  assert.throws(() => act(createGame("p0", "Хозяин"), "p0", { type: "start" }, NOW), /двух.*шести/);
  assert.throws(() => act(lobby(), "p1", { type: "start" }, NOW), /создатель/);
  assert.throws(() => addPlayer(lobby(), "p6", "Седьмой"), /шесть/);
  const state = opening("number");
  assert.equal(state.status, "playing");
  assert.equal(state.turnIndex, 1);
  assert.deepEqual(state.players.map((p) => p.hand.length), [8, 8, 8, 8, 8, 8]);
  assert.equal(state.drawPile.length, 55);
  assert.equal(state.discardPile.length, 1);
  assert.equal(allCards(state).length, 104);
  assert.throws(() => addPlayer(state, "p6", "Новый"), /началась/);
  for (let count = 2; count <= 6; count++) {
    const started = opening("number", "red", undefined, count);
    assert.equal(started.status, "playing");
    assert.equal(started.players.length, count);
    assert.deepEqual(started.players.map((p) => p.hand.length), Array(count).fill(8));
    assert.equal(started.drawPile.length, 103 - count * 8);
    assert.equal(allCards(started).length, 104);
  }
});

test("the host can add a bot and start a two-player game without altering the input", () => {
  const original = createGame("p0", "Игрок");
  const before = structuredClone(original);
  const state = act(original, "p0", { type: "add_bot" }, NOW);
  assert.deepEqual(original, before);
  assert.equal(state.players.length, 2);
  const bot = state.players[1];
  assert.match(bot.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.match(bot.name, /\(бот\)/);
  assert.equal(bot.isBot, true);
  assert.deepEqual(bot.hand, []);
  assert.equal(bot.score, 0);
  assert.equal(publicGame(state, "p0").players[0].isBot, false);
  assert.equal(publicGame(state, "p0").players[1].isBot, true);
  const started = act(state, "p0", { type: "start" }, NOW);
  assert.equal(started.status, "playing");
  assert.equal(started.players[1].isBot, true);
  assert.deepEqual(started.players.map((p) => p.hand.length), [8, 8]);
});

test("bot names are unique alongside humans, and total room capacity remains six", () => {
  let state = createGame("p0", "Хрюша (бот)");
  for (let n = 0; n < 5; n++) state = act(state, "p0", { type: "add_bot" }, NOW + n);
  assert.equal(state.players.length, 6);
  assert.equal(new Set(state.players.map((p) => p.id)).size, 6);
  assert.equal(new Set(state.players.map((p) => p.name)).size, 6);
  assert.equal(state.players.filter((p) => p.isBot).length, 5);
  const before = structuredClone(state);
  assert.throws(() => act(state, "p0", { type: "add_bot" }, NOW + 6), /шесть/);
  assert.throws(() => addPlayer(state, "p6", "Ещё человек"), /шесть/);
  assert.deepEqual(state, before);
});

test("only the host can manage bots, only in the lobby, and humans cannot be removed", () => {
  let state = lobby(2);
  assert.throws(() => act(state, "p1", { type: "add_bot" }, NOW), /создатель/);
  state = act(state, "p0", { type: "add_bot" }, NOW);
  const bot = state.players.at(-1)!;
  assert.throws(() => act(state, "p1", { type: "remove_bot", targetId: bot.id }, NOW), /создатель/);
  assert.throws(() => act(state, "p0", { type: "remove_bot", targetId: "p1" }, NOW), /только ботов/);
  assert.throws(() => act(state, "p0", { type: "remove_bot", targetId: "p0" }, NOW), /только ботов/);
  assert.throws(() => act(state, "p0", { type: "remove_bot", targetId: "missing" }, NOW), /не найден/);
  const started = act(state, "p0", { type: "start" }, NOW);
  assert.throws(() => act(started, "p0", { type: "add_bot" }, NOW), /до начала/);
  assert.throws(() => act(started, "p0", { type: "remove_bot", targetId: bot.id }, NOW), /до начала/);
  const ended = { ...started, status: "round_end" as const };
  assert.throws(() => act(ended, "p0", { type: "add_bot" }, NOW), /до начала/);
  const before = structuredClone(state);
  const removed = act(state, "p0", { type: "remove_bot", targetId: bot.id }, NOW);
  assert.deepEqual(state, before);
  assert.deepEqual(removed.players.map((p) => p.id), ["p0", "p1"]);
  assert.equal(removed.hostId, "p0");
  assert.equal(act(removed, "p0", { type: "start" }, NOW).status, "playing");
});

test("legacy players without an isBot property remain human and can start normally", () => {
  const state = lobby(2);
  state.players.forEach((p) => delete p.isBot);
  assert.deepEqual(publicGame(state, "p0").players.map((p) => p.isBot), [false, false]);
  assert.throws(() => act(state, "p0", { type: "remove_bot", targetId: "p1" }, NOW), /только ботов/);
  assert.equal(act(state, "p0", { type: "start" }, NOW).status, "playing");
});

test("removing the only bot restores a one-person lobby, which cannot start", () => {
  let state = act(createGame("p0", "Игрок"), "p0", { type: "add_bot" }, NOW);
  state = act(state, "p0", { type: "remove_bot", targetId: state.players[1].id }, NOW);
  assert.equal(state.players.length, 1);
  assert.throws(() => act(state, "p0", { type: "start" }, NOW), /двух.*шести/);
});

test("opening instructions apply as if the dealer played them", () => {
  const draw = opening("draw3");
  assert.deepEqual(draw.pending, { kind: "draw3", amount: 3 });
  assert.equal(draw.turnIndex, 1);
  const skip = opening("skip");
  assert.deepEqual(skip.pending, { kind: "skip", amount: 1 });
  assert.equal(opening("silence").silenceOwnerId, "p0");
  const clap = opening("clap");
  assert.ok(clap.clap);
  assert.equal(clap.turnDeadline, null);
  assert.equal(clap.clap.deadline, NOW + 5000);
  const wild = opening("wild", null, "orange");
  assert.equal(wild.discardPile.at(-1)?.kind, "wild");
  assert.equal(wild.activeColor, "orange");
  const automatic = opening("wild", null);
  assert.match(automatic.log.at(-1)!.text, /автоматически/);
  assert.ok(["red", "orange", "green", "blue"].includes(automatic.activeColor!));
});

test("matching colors and numbers are legal, input state stays unchanged", () => {
  const state = playing();
  const match = card("number", "blue", 4);
  state.players[0].hand = [match, card()];
  const before = structuredClone(state);
  assert.equal(canPlay(state, "p0", match), true);
  const next = act(state, "p0", { type: "play", cardId: match.id }, NOW);
  assert.deepEqual(state, before);
  assert.equal(next.discardPile.at(-1)?.id, match.id);
  assert.equal(next.activeColor, "blue");
  assert.equal(next.turnIndex, 1);
  assert.equal(next.catchablePlayerId, "p0");
  assert.equal(next.players[0].hand.length, 1);
});

test("a wrong card stays in hand, incurs two cards, and skips the owner's turn", () => {
  const state = playing();
  const wrong = state.players[0].hand[0];
  const next = act(state, "p0", { type: "play", cardId: wrong.id }, NOW);
  assert.equal(next.players[0].hand.length, 4);
  assert.ok(next.players[0].hand.some((c) => c.id === wrong.id));
  assert.deepEqual(next.discardPile, state.discardPile);
  assert.equal(next.turnIndex, 1);
  assert.equal(state.players[0].hand.length, 2);
});

test("authorization failures cannot penalize other players or mutate the input", () => {
  const state = playing();
  const before = structuredClone(state);
  assert.throws(() => act(state, "outsider", { type: "draw" }, NOW), /участник/);
  assert.throws(() => act(state, "p1", { type: "draw" }, NOW), /не ваш ход/);
  assert.throws(() => act(state, "p0", { type: "play", cardId: state.players[1].hand[0].id }, NOW), /нет у вас/);
  assert.throws(() => act(state, "p1", { type: "play", cardId: state.players[1].hand[0].id }, NOW), /не ваш ход/);
  assert.deepEqual(state, before);
});

test("drawn matching card can be played immediately or passed, no second draw", () => {
  const state = playing();
  const drawn = card("number", "red", 7);
  state.drawPile.push(drawn);
  const afterDraw = act(state, "p0", { type: "draw" }, NOW);
  assert.equal(afterDraw.turnIndex, 0);
  assert.equal(afterDraw.drawnCardId, drawn.id);
  assert.equal(afterDraw.turnDeadline, state.turnDeadline);
  assert.throws(() => act(afterDraw, "p0", { type: "draw" }, NOW), /уже взяли/);
  const played = act(afterDraw, "p0", { type: "play", cardId: drawn.id }, NOW);
  assert.equal(played.turnIndex, 1);
  assert.equal(played.drawnCardId, null);
  const passed = act(afterDraw, "p0", { type: "pass" }, NOW);
  assert.equal(passed.turnIndex, 1);
  assert.equal(passed.drawnCardId, null);
  assert.equal(passed.players[0].hand.length, 3);
});

test("drawing an unplayable card advances automatically; only the drawn card may be played", () => {
  const state = playing();
  state.drawPile.push(card("number", "blue", 6));
  assert.equal(act(state, "p0", { type: "draw" }, NOW).turnIndex, 1);
  const existingMatch = card("number", "red", 2);
  state.players[0].hand = [existingMatch, card()];
  state.drawPile.push(card("number", "red", 7));
  const afterDraw = act(state, "p0", { type: "draw" }, NOW);
  assert.equal(canPlay(afterDraw, "p0", existingMatch), false);
  const wrong = act(afterDraw, "p0", { type: "play", cardId: existingMatch.id }, NOW);
  assert.equal(wrong.players[0].hand.length, 5);
  assert.equal(wrong.turnIndex, 1);
});

test("draw3 may transfer across colors and stacks three per transfer", () => {
  let state = playing();
  const first = card("draw3", "red"), second = card("draw3", "green"), third = card("draw3", "blue");
  state.players[0].hand = [first, card()];
  state.players[1].hand = [second, card()];
  state.players[2].hand = [third, card()];
  state = act(state, "p0", { type: "play", cardId: first.id }, NOW);
  assert.equal(canPlay(state, "p1", second), true);
  assert.equal(canPlay(state, "p1", state.players[1].hand[1]), false);
  state = act(state, "p1", { type: "play", cardId: second.id }, NOW);
  assert.deepEqual(state.pending, { kind: "draw3", amount: 6 });
  state = act(state, "p2", { type: "play", cardId: third.id }, NOW);
  assert.deepEqual(state.pending, { kind: "draw3", amount: 9 });
  const oldCount = state.players[3].hand.length;
  state = act(state, "p3", { type: "accept_penalty" }, NOW);
  assert.equal(state.players[3].hand.length, oldCount + 9);
  assert.equal(state.turnIndex, 4);
  assert.equal(state.pending, null);
});

test("skip chains transfer one skipped turn instead of accumulating skipped seats", () => {
  let state = playing();
  const a = card("skip", "red"), b = card("skip", "green"), c = card("skip", "blue");
  state.players[0].hand = [a, card()];
  state.players[1].hand = [b, card()];
  state.players[2].hand = [c, card()];
  for (const [id, played] of [["p0", a], ["p1", b], ["p2", c]] as const) state = act(state, id, { type: "play", cardId: played.id }, NOW);
  assert.deepEqual(state.pending, { kind: "skip", amount: 1 });
  const count = state.players[3].hand.length;
  state = act(state, "p3", { type: "accept_penalty" }, NOW);
  assert.equal(state.turnIndex, 4);
  assert.equal(state.players[3].hand.length, count);
});

test("two-player skip returns the turn to its author, and a transfer can return the penalty", () => {
  let state = playing(2);
  const first = card("skip", "red"), second = card("skip", "blue");
  state.players[0].hand = [first, card()];
  state.players[1].hand = [second, card()];
  const afterFirst = act(state, "p0", { type: "play", cardId: first.id }, NOW);
  const accepted = act(afterFirst, "p1", { type: "accept_penalty" }, NOW);
  assert.equal(accepted.turnIndex, 0);
  assert.equal(accepted.players[1].hand.length, 2);
  state = act(afterFirst, "p1", { type: "play", cardId: second.id }, NOW);
  assert.equal(state.turnIndex, 0);
  assert.deepEqual(state.pending, { kind: "skip", amount: 1 });
  state = act(state, "p0", { type: "accept_penalty" }, NOW);
  assert.equal(state.turnIndex, 1);
  assert.equal(state.players[0].hand.length, 1);
  assert.equal(state.pending, null);
});

test("two-player draw3 stacks on a transfer back to the original sender", () => {
  let state = playing(2);
  state.players[1].isBot = true;
  const first = card("draw3", "red"), second = card("draw3", "blue");
  state.players[0].hand = [first, card()];
  state.players[1].hand = [second, card()];
  const afterFirst = act(state, "p0", { type: "play", cardId: first.id }, NOW);
  const accepted = act(afterFirst, "p1", { type: "accept_penalty" }, NOW);
  assert.equal(accepted.turnIndex, 0);
  assert.equal(accepted.players[1].hand.length, 5);
  state = act(afterFirst, "p1", { type: "play", cardId: second.id }, NOW);
  assert.deepEqual(state.pending, { kind: "draw3", amount: 6 });
  assert.equal(state.turnIndex, 0);
  state = act(state, "p0", { type: "accept_penalty" }, NOW);
  assert.equal(state.players[0].hand.length, 7);
  assert.equal(state.players[1].hand.length, 1);
  assert.equal(state.turnIndex, 1);
  assert.equal(state.pending, null);
});

test("an exact duplicate intercepts out of turn and continues at the interceptor's neighbor", () => {
  const state = playing();
  const duplicate = card("number", "red", 4);
  const nearMatch = card("number", "blue", 4);
  state.players[3].hand = [duplicate, nearMatch];
  assert.equal(canPlay(state, "p3", duplicate), true);
  assert.equal(canPlay(state, "p3", nearMatch), false);
  const next = act(state, "p3", { type: "play", cardId: duplicate.id }, NOW);
  assert.equal(next.turnIndex, 4);
  assert.equal(next.lastPlayedById, "p3");
  const secondDuplicate = card("number", "red", 4);
  next.players[3].hand.push(secondDuplicate);
  assert.equal(canPlay(next, "p3", secondDuplicate), false);
});

test("intercepting an identical draw3 transfers the accumulated penalty", () => {
  let state = playing();
  const first = card("draw3", "red"), jump = card("draw3", "red");
  state.players[0].hand = [first, card()];
  state.players[4].hand = [jump, card()];
  state = act(state, "p0", { type: "play", cardId: first.id }, NOW);
  state = act(state, "p4", { type: "play", cardId: jump.id }, NOW);
  assert.equal(state.turnIndex, 5);
  assert.deepEqual(state.pending, { kind: "draw3", amount: 6 });
});

test("all gray wild cards are identical, choose any color even with other playable cards", () => {
  let state = playing();
  const first = card("wild", null), jump = card("wild", null);
  state.players[0].hand = [first, card()];
  state.players[3].hand = [jump, card()];
  state = act(state, "p0", { type: "play", cardId: first.id, color: "green" }, NOW);
  assert.equal(state.activeColor, "green");
  assert.equal(canPlay(state, "p3", jump), true);
  state = act(state, "p3", { type: "play", cardId: jump.id, color: "orange" }, NOW);
  assert.equal(state.turnIndex, 4);
  assert.equal(state.activeColor, "orange");
});

test("a wild card without a chosen color is a wrong move and remains in hand", () => {
  const state = playing();
  const wild = card("wild", null);
  state.players[0].hand = [wild, card()];
  const next = act(state, "p0", { type: "play", cardId: wild.id }, NOW);
  assert.equal(next.players[0].hand.length, 4);
  assert.equal(next.turnIndex, 1);
  assert.equal(next.discardPile.at(-1)?.kind, "number");
});

function penultimate(): GameState {
  const state = playing();
  const first = card();
  state.players[0].hand = [first, card("number", "green", 1)];
  return act(state, "p0", { type: "play", cardId: first.id }, NOW);
}

test("declare-first wins the one-card race; catch-first gives three and prevents declaration", () => {
  const state = penultimate();
  const declared = act(state, "p0", { type: "declare" }, NOW + 1);
  assert.equal(declared.catchablePlayerId, null);
  assert.equal(declared.players[0].hand.length, 1);
  assert.throws(() => act(declared, "p1", { type: "catch", targetId: "p0" }, NOW + 2), /нельзя поймать/);
  const caught = act(state, "p1", { type: "catch", targetId: "p0" }, NOW + 1);
  assert.equal(caught.players[0].hand.length, 4);
  assert.equal(caught.catchablePlayerId, null);
  assert.equal(caught.turnIndex, 1);
  assert.throws(() => act(caught, "p0", { type: "declare" }, NOW + 2), /предпоследней/);
  assert.throws(() => act(state, "p1", { type: "declare" }, NOW + 1), /предпоследней/);
  assert.throws(() => act(state, "p0", { type: "catch", targetId: "p0" }, NOW + 1), /нельзя поймать/);
});

test("the catch window lasts through chat, but closes on the next player's draw/play", () => {
  let state = penultimate();
  state = act(state, "p2", { type: "chat", text: "Лови!" }, NOW + 1);
  assert.equal(state.catchablePlayerId, "p0");
  const afterDraw = act(state, "p1", { type: "draw" }, NOW + 2);
  assert.equal(afterDraw.catchablePlayerId, null);
  assert.throws(() => act(afterDraw, "p2", { type: "catch", targetId: "p0" }, NOW + 3), /нельзя поймать/);
  const match = card();
  state.players[1].hand.push(match);
  assert.equal(act(state, "p1", { type: "play", cardId: match.id }, NOW + 2).catchablePlayerId, null);
});

test("silence applies until the owner plays again; chat costs two without skipping", () => {
  let state = playing();
  const quiet = card("silence", "red");
  state.players[0].hand = [quiet, card()];
  state = act(state, "p0", { type: "play", cardId: quiet.id }, NOW);
  assert.equal(state.silenceOwnerId, "p0");
  const count = state.players[2].hand.length;
  const broken = act(state, "p2", { type: "chat", text: "Ой" }, NOW + 1);
  assert.equal(broken.players[2].hand.length, count + 2);
  assert.equal(broken.turnIndex, 1);
  assert.equal(broken.silenceOwnerId, null);
  assert.equal(broken.chat.at(-1)?.text, "Ой");
  assert.equal(broken.catchablePlayerId, "p0");
  state = act(state, "p0", { type: "declare" }, NOW + 1);
  assert.equal(state.silenceOwnerId, "p0", "button declaration is silent");
  assert.equal(state.players[0].hand.length, 1);
  state.players[0].hand.push(card());
  state.turnIndex = 0;
  state = act(state, "p0", { type: "play", cardId: state.players[0].hand[0].id }, NOW + 2);
  assert.equal(state.silenceOwnerId, null);
});

test("explicit breaking of silence costs two cards without advancing the turn", () => {
  const state = playing();
  state.silenceOwnerId = "p3";
  const next = act(state, "p0", { type: "break_silence" }, NOW);
  assert.equal(next.players[0].hand.length, 4);
  assert.equal(next.turnIndex, 0);
  assert.equal(next.silenceOwnerId, null);
});

test("clap pauses turns, records the race, and penalizes only the final respondent", () => {
  let state = playing();
  const clap = card("clap", "red");
  state.players[0].hand = [clap, card()];
  state = act(state, "p0", { type: "play", cardId: clap.id }, NOW);
  assert.equal(state.turnDeadline, null);
  assert.equal(state.turnIndex, 1);
  assert.throws(() => act(state, "p1", { type: "draw" }, NOW + 1), /хлопнуть/);
  const counts = state.players.map((p) => p.hand.length);
  for (const id of ["p2", "p0", "p4", "p1", "p5"]) state = act(state, id, { type: "clap" }, NOW + 1);
  assert.deepEqual(state.clap?.responded, ["p2", "p0", "p4", "p1", "p5"]);
  assert.equal(act(state, "p2", { type: "clap" }, NOW + 1).clap?.responded.length, 5);
  state = act(state, "p3", { type: "clap" }, NOW + 2);
  assert.equal(state.clap, null);
  assert.equal(state.turnIndex, 1);
  assert.equal(state.turnDeadline, NOW + 5002);
  state.players.forEach((p, n) => assert.equal(p.hand.length, counts[n] + (n === 3 ? 2 : 0)));
});

test("clap expiry penalizes all missing responses tied for last, resumes a fresh turn", () => {
  let state = opening("clap");
  for (const id of ["p0", "p1", "p3", "p5"]) state = act(state, id, { type: "clap" }, NOW + 1);
  const before = structuredClone(state);
  state = tick(state, NOW + 6000);
  assert.equal(state.clap, null);
  assert.equal(state.turnDeadline, NOW + 11000);
  assert.equal(state.turnIndex, 1);
  state.players.forEach((p, n) => assert.equal(p.hand.length, 8 + ([2, 4].includes(n) ? 2 : 0)));
  assert.deepEqual(before.players.map((p) => p.hand.length), [8, 8, 8, 8, 8, 8]);
});

test("two-player clap waits for both participants, with one last responder or a tied expiry", () => {
  let state = playing(2);
  state.players[1].isBot = true;
  const clap = card("clap", "red");
  state.players[0].hand = [clap, card()];
  const started = act(state, "p0", { type: "play", cardId: clap.id }, NOW);
  state = act(started, "p0", { type: "clap" }, NOW + 1);
  assert.ok(state.clap);
  assert.equal(state.turnDeadline, null);
  state = act(state, "p1", { type: "clap" }, NOW + 2);
  assert.equal(state.clap, null);
  assert.deepEqual(state.players.map((p) => p.hand.length), [1, 4]);
  assert.equal(state.turnIndex, 1);
  assert.equal(state.turnDeadline, NOW + 5002);
  const expired = tick(started, NOW + 5000);
  assert.deepEqual(expired.players.map((p) => p.hand.length), [3, 4]);
  assert.equal(expired.clap, null);
  assert.equal(expired.catchablePlayerId, null);
  assert.equal(expired.turnIndex, 1);
});

test("timers use the configured interval, return unchanged references when idle, and skip slow players", () => {
  const state = playing();
  state.turnSeconds = 2;
  state.turnDeadline = NOW + 2000;
  assert.equal(tick(state, NOW + 1999), state);
  const idle = lobby();
  assert.equal(tick(idle, NOW), idle);
  const expired = tick(state, NOW + 2000);
  assert.equal(expired.players[0].hand.length, 4);
  assert.equal(expired.turnIndex, 1);
  assert.equal(expired.turnDeadline, NOW + 4000);
});

test("timeout enforces two cards plus a pending draw3 instruction, with no catch-up cascade", () => {
  const state = playing();
  state.turnSeconds = 2;
  state.turnDeadline = NOW + 2000;
  state.pending = { kind: "draw3", amount: 6 };
  state.catchablePlayerId = "p4";
  const before = structuredClone(state);
  const next = tick(state, NOW + 50000);
  assert.equal(next.players[0].hand.length, 10);
  assert.equal(next.players[1].hand.length, 2);
  assert.equal(next.turnIndex, 1);
  assert.equal(next.turnDeadline, NOW + 52000);
  assert.equal(next.pending, null);
  assert.equal(next.catchablePlayerId, null);
  assert.deepEqual(state, before);
});

test("refilling shuffles the old discard pile while preserving its visible top card", () => {
  const state = playing();
  const visible = state.discardPile[0];
  const older = [card("number", "blue", 6), card("number", "green", 5), card("number", "orange", 0)];
  state.discardPile = [...older, visible];
  state.drawPile = [];
  const beforeIds = new Set(allCards(state).map((c) => c.id));
  const next = act(state, "p0", { type: "draw" }, NOW);
  assert.deepEqual(next.discardPile, [visible]);
  assert.equal(next.drawPile.length, 2);
  assert.equal(next.players[0].hand.length, 3);
  assert.deepEqual(new Set(allCards(next).map((c) => c.id)), beforeIds);
});

test("every final card ends immediately without applying its instruction", () => {
  for (const kind of ["number", "draw3", "skip", "silence", "clap", "wild"] as const) {
    const state = playing();
    const final = card(kind, kind === "wild" ? null : "red");
    state.players[0].hand = [final];
    state.silenceOwnerId = "p3";
    state.players[2].hand.push(card());
    const next = act(state, "p0", { type: "play", cardId: final.id, color: "blue" }, NOW);
    assert.equal(next.status, "round_end", kind);
    assert.equal(next.roundWinnerId, "p0", kind);
    assert.equal(next.winnerId, "p0", kind);
    assert.equal(next.pending, null, kind);
    assert.equal(next.clap, null, kind);
    assert.equal(next.silenceOwnerId, null, kind);
    assert.equal(next.turnDeadline, null, kind);
    assert.deepEqual(next.players.map((p) => p.score), [0, 2, 3, 2, 2, 2], kind);
    assert.deepEqual(next.svintusIds, ["p2"], kind);
  }
});

test("score counts retained cards including ties, resets next round, and the dealer rotates", () => {
  let state = playing();
  state.players[0].hand = [card()];
  state.players[1].hand.push(card());
  state.players[4].hand.push(card());
  state.players[2].score = 99;
  state = act(state, "p0", { type: "play", cardId: state.players[0].hand[0].id }, NOW);
  assert.deepEqual(state.svintusIds, ["p1", "p4"]);
  assert.deepEqual(state.players.map((p) => p.score), [0, 3, 2, 2, 3, 2]);
  assert.throws(() => act(state, "p1", { type: "next_round" }, NOW), /создатель/);
  state = act(state, "p0", { type: "next_round" }, NOW);
  assert.equal(state.status, "playing");
  assert.equal(state.round, 2);
  assert.equal(state.dealerIndex, 1);
  assert.equal(state.turnIndex, 2);
  assert.deepEqual(state.players.map((p) => p.score), [0, 0, 0, 0, 0, 0]);
  assert.deepEqual(state.svintusIds, []);
  assert.equal(state.winnerId, null);
});

test("a two-player round scores the loser's retained cards and resets with a rotating dealer", () => {
  let state = playing(2);
  state.players[1].isBot = true;
  state.players[0].hand = [card()];
  state.players[1].hand.push(card());
  state = act(state, "p0", { type: "play", cardId: state.players[0].hand[0].id }, NOW);
  assert.equal(state.status, "round_end");
  assert.equal(state.roundWinnerId, "p0");
  assert.deepEqual(state.players.map((p) => p.score), [0, 3]);
  assert.deepEqual(state.svintusIds, ["p1"]);
  state = act(state, "p0", { type: "next_round" }, NOW);
  assert.equal(state.round, 2);
  assert.equal(state.dealerIndex, 1);
  assert.equal(state.turnIndex, 0);
  assert.equal(state.players[1].isBot, true);
  assert.deepEqual(state.players.map((p) => p.score), [0, 0]);
  assert.deepEqual(state.players.map((p) => p.hand.length), [8, 8]);
});

test("a bot's last special card can win a two-player round immediately", () => {
  const state = playing(2);
  state.turnIndex = 1;
  state.players[1].isBot = true;
  const final = card("draw3", "red");
  state.players[1].hand = [final];
  const next = act(state, "p1", { type: "play", cardId: final.id }, NOW);
  assert.equal(next.status, "round_end");
  assert.equal(next.roundWinnerId, "p1");
  assert.equal(next.pending, null);
  assert.deepEqual(next.players.map((p) => p.score), [2, 0]);
  assert.deepEqual(next.svintusIds, ["p0"]);
});

test("public serialization reveals only the viewer's cards and safe shared fields", () => {
  const state = playing();
  state.drawnCardId = state.players[0].hand[0].id;
  const visible = publicGame(state, "p0");
  assert.equal(visible.meId, "p0");
  assert.deepEqual(visible.hand, state.players[0].hand);
  assert.equal(visible.drawPileCount, 104);
  assert.equal(visible.drawnCardId, state.drawnCardId);
  assert.equal(publicGame(state, "p1").drawnCardId, null);
  assert.equal("drawPile" in visible, false);
  assert.equal("discardPile" in visible, false);
  assert.ok(visible.players.every((p) => !("hand" in p) && p.cardCount === 2));
  const json = JSON.stringify(visible);
  for (const p of state.players.slice(1)) for (const c of p.hand) assert.equal(json.includes(c.id), false);
  for (const c of state.drawPile) assert.equal(json.includes(c.id), false);
  visible.hand.pop();
  visible.players[0].name = "Подмена";
  assert.equal(state.players[0].hand.length, 2);
  assert.equal(state.players[0].name, "Игрок 0");
  assert.throws(() => publicGame(state, "outsider"), /участник/);
});

test("legal play over complete rounds conserves all 104 cards and never leaks hands", () => {
  let state = act(lobby(), "p0", { type: "start" }, NOW);
  let now = NOW;
  for (let n = 0; n < 2000 && state.status === "playing"; n++) {
    now++;
    if (state.clap) {
      const id = state.players.find((p) => !state.clap!.responded.includes(p.id))!.id;
      state = act(state, id, { type: "clap" }, now);
    } else {
      const p = state.players[state.turnIndex];
      const playable = p.hand.find((c) => canPlay(state, p.id, c));
      if (playable) state = act(state, p.id, { type: "play", cardId: playable.id, ...(playable.kind === "wild" ? { color: "red" as const } : {}) }, now);
      else if (state.pending) state = act(state, p.id, { type: "accept_penalty" }, now);
      else if (state.drawnCardId) state = act(state, p.id, { type: "pass" }, now);
      else state = act(state, p.id, { type: "draw" }, now);
    }
    const cards = allCards(state);
    assert.equal(cards.length, 104, `step ${n}`);
    assert.equal(new Set(cards.map((c) => c.id)).size, 104, `step ${n}`);
    assert.ok(state.players.every((p) => p.hand.length >= 0));
    assert.equal(publicGame(state, "p0").players[1].cardCount, state.players[1].hand.length);
  }
  assert.equal(state.status, "round_end");
  assert.equal(state.players.find((p) => p.id === state.roundWinnerId)?.hand.length, 0);
});
