import test from "node:test";
import assert from "node:assert/strict";
import {
  act,
  addPlayer,
  createDeck,
  createGame,
  publicGame,
  type GameState,
} from "./game";
import { advanceGame, botTurnAction } from "./bots";

const NOW = 1_000_000;
function fixture({
  human = ["blue-7-0", "green-7-0"],
  bot = ["red-2-0", "green-3-0", "blue-4-0"],
  top = "red-1-0",
  nextDraw,
}: {
  human?: string[];
  bot?: string[];
  top?: string;
  nextDraw?: string;
} = {}): GameState {
  const state = addPlayer(createGame("human", "Человек"), "bot", "Бот");
  state.players[1].isBot = true;
  const pool = createDeck();
  const take = (id: string) => {
    const index = pool.findIndex((card) => card.id === id);
    assert(index >= 0, `Fixture card ${id} must exist exactly once`);
    return pool.splice(index, 1)[0];
  };
  state.players[0].hand = human.map(take);
  state.players[1].hand = bot.map(take);
  state.discardPile = [take(top)];
  if (nextDraw) pool.push(take(nextDraw));
  state.drawPile = pool;
  Object.assign(state, {
    status: "playing",
    round: 1,
    turnIndex: 1,
    activeColor: state.discardPile[0].color,
    phaseStartedAt: NOW,
    lastPlayedById: "human",
  });
  return state;
}
function conserved(state: GameState) {
  const cards = [
    ...state.drawPile,
    ...state.discardPile,
    ...state.players.flatMap((player) => player.hand),
  ];
  assert.equal(cards.length, 104);
  assert.equal(new Set(cards.map((card) => card.id)).size, 104);
}

test("bots wait before acting; repeated idle polls neither reset reactions nor mutate state", () => {
  const state = fixture(),
    original = structuredClone(state);
  assert.equal(advanceGame(state, NOW + 100), state);
  assert.equal(advanceGame(state, NOW + 600), state);
  const moved = advanceGame(state, NOW + 1000);
  assert.deepEqual(state, original);
  assert.equal(moved.discardPile.at(-1)?.id, "red-2-0");
  assert.equal(moved.turnIndex, 0);
  assert.equal(moved.players[1].hand.length, 2);
  assert.equal(advanceGame(moved, NOW + 1100), moved);
  conserved(moved);
});

test("a bot chooses from its own hand without inspecting opponents or deck order", () => {
  const state = fixture({ bot: ["red-2-0", "wild-0", "green-3-0"] });
  const altered = structuredClone(state);
  altered.players[0].hand = createDeck().slice(0, 50);
  altered.drawPile.reverse();
  assert.deepEqual(botTurnAction(state, "bot"), botTurnAction(altered, "bot"));
  assert.equal(botTurnAction(state, "human"), null);
  const view = publicGame(advanceGame(state, NOW + 1000), "human");
  assert(view.players.every((player) => !("hand" in player)));
  assert(!("drawPile" in view));
});

test("the opening wild waits for its human dealer; a bot dealer chooses without a turn timer", () => {
  const state = fixture({
    top: "wild-0",
    bot: ["blue-2-0", "blue-3-0", "red-4-0"],
  });
  state.activeColor = null;
  state.colorChoicePlayerId = "human";
  assert.equal(advanceGame(state, NOW + 86400000), state);
  state.colorChoicePlayerId = "bot";
  state.turnIndex = 0;
  const chosen = advanceGame(state, NOW + 1000);
  assert.equal(chosen.activeColor, "blue");
  assert.equal(chosen.colorChoicePlayerId, null);
  assert.equal(chosen.turnIndex, 0);
  assert.deepEqual(chosen.players, state.players);
  conserved(chosen);
});

test("bots transfer draw-three instructions and accept a penalty when unable to transfer", () => {
  const transfer = fixture({
    top: "red-draw3-0",
    bot: ["green-draw3-0", "blue-4-0"],
  });
  transfer.pending = { kind: "draw3", amount: 3 };
  const moved = advanceGame(transfer, NOW + 1000);
  assert.equal(moved.discardPile.at(-1)?.id, "green-draw3-0");
  assert.deepEqual(moved.pending, { kind: "draw3", amount: 6 });
  conserved(moved);
  const accept = fixture({
    top: "red-draw3-0",
    bot: ["green-3-0", "blue-4-0"],
  });
  accept.pending = { kind: "draw3", amount: 6 };
  const accepted = advanceGame(accept, NOW + 1000);
  assert.equal(accepted.players[1].hand.length, 8);
  assert.equal(accepted.pending, null);
  assert.equal(accepted.turnIndex, 0);
  conserved(accepted);
});

test("a bot draws once, plays only the newly drawn matching card, and otherwise passes", () => {
  const matching = advanceGame(
    fixture({ bot: ["green-3-0", "blue-4-0"], nextDraw: "red-5-0" }),
    NOW + 1000,
  );
  assert.equal(matching.discardPile.at(-1)?.id, "red-5-0");
  assert.equal(matching.players[1].hand.length, 2);
  assert.equal(matching.drawnCardId, null);
  assert.equal(matching.turnIndex, 0);
  conserved(matching);
  const miss = advanceGame(
    fixture({ bot: ["green-3-0", "blue-4-0"], nextDraw: "orange-6-0" }),
    NOW + 1000,
  );
  assert.equal(miss.discardPile.at(-1)?.id, "red-1-0");
  assert.equal(miss.players[1].hand.length, 3);
  assert.equal(miss.turnIndex, 0);
  conserved(miss);
});

test("bots choose a wild color from their remaining cards and can win with the final card", () => {
  const wild = advanceGame(
    fixture({ bot: ["wild-0", "green-3-0", "green-4-0", "blue-4-0"] }),
    NOW + 1000,
  );
  assert.equal(wild.activeColor, "green");
  assert.equal(wild.discardPile.at(-1)?.id, "wild-0");
  conserved(wild);
  const won = advanceGame(fixture({ bot: ["wild-0"] }), NOW + 1000);
  assert.equal(won.status, "round_end");
  assert.equal(won.roundWinnerId, "bot");
  assert.deepEqual(won.svintusIds, ["human"]);
  assert.deepEqual(
    won.players.map((player) => player.score),
    [2, 0],
  );
  conserved(won);
});

test("bots declare after a reaction delay, while a faster human catch still draws three", () => {
  const moved = advanceGame(
    fixture({ bot: ["red-2-0", "green-3-0"] }),
    NOW + 1000,
  );
  assert.equal(moved.catchablePlayerId, "bot");
  assert.equal(advanceGame(moved, NOW + 1200), moved);
  const declared = advanceGame(moved, NOW + 1700);
  assert.equal(declared.catchablePlayerId, null);
  assert.equal(declared.players[1].hand.length, 1);
  const caught = act(
    advanceGame(moved, NOW + 1200),
    "human",
    { type: "catch", targetId: "bot" },
    NOW + 1200,
  );
  assert.equal(caught.players[1].hand.length, 4);
  assert.equal(caught.catchablePlayerId, null);
  conserved(caught);
});

test("a bot leaves time for a human declaration and catches an undeclared human first", () => {
  const state = fixture({ human: ["blue-7-0"] });
  state.catchablePlayerId = "human";
  assert.equal(advanceGame(state, NOW + 1000), state);
  const caught = advanceGame(state, NOW + 1800);
  assert.equal(caught.players[0].hand.length, 4);
  assert.equal(caught.catchablePlayerId, null);
  assert.equal(caught.turnIndex, 0);
  conserved(caught);
  const declared = act(state, "human", { type: "declare" }, NOW + 500);
  const moved = advanceGame(declared, NOW + 1000);
  assert.equal(moved.players[0].hand.length, 1);
  assert.equal(moved.turnIndex, 0);
});

test("bots join the clap race and take the same two-card penalty when last", () => {
  const state = fixture();
  state.clap = { id: "clap-fixture", responded: [] };
  const reacted = advanceGame(state, NOW + 1200);
  assert.deepEqual(reacted.clap?.responded, ["bot"]);
  const humanLast = act(reacted, "human", { type: "clap" }, NOW + 1300);
  assert.equal(humanLast.players[0].hand.length, 4);
  assert.equal(humanLast.clap, null);
  conserved(humanLast);
  const humanFirst = act(state, "human", { type: "clap" }, NOW + 100);
  const botLast = advanceGame(humanFirst, NOW + 1200);
  assert.equal(botLast.players[1].hand.length, 5);
  assert.equal(botLast.clap, null);
  conserved(botLast);
});

test("bots intercept only identical cards; long human pauses never cause penalties", () => {
  const state = fixture({ bot: ["red-1-1", "green-3-0"] });
  state.turnIndex = 0;
  const intercepted = advanceGame(state, NOW + 1800);
  assert.equal(intercepted.discardPile.at(-1)?.id, "red-1-1");
  assert.equal(intercepted.turnIndex, 0);
  conserved(intercepted);
  const humanTurn = fixture();
  humanTurn.turnIndex = 0;
  assert.equal(advanceGame(humanTurn, NOW + 7 * 86400000), humanTurn);
  conserved(humanTurn);
});
