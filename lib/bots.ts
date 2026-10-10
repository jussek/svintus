import { act, canPlay, COLORS, tick, type Action, type Card, type Color, type GameState, type Player } from './game';

type Reaction = { playerId: string; action: Action; dueAt: number; priority: number };

function delay(key: string, minimum: number, spread: number) {
  let hash = 2166136261;
  for (const character of key) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return minimum + (hash >>> 0) % spread;
}

function preferredColor(hand: Card[]): Color {
  return [...COLORS].sort((a, b) => hand.filter(card => card.color === b).length - hand.filter(card => card.color === a).length)[0];
}

function preferredCard(cards: Card[], player: Player): Card {
  const score = (card: Card) => (card.kind === 'wild' ? -10 : card.kind === 'number' ? 0 : 3)
    + player.hand.filter(held => held.color === card.color).length;
  return [...cards].sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id))[0];
}

function playAction(card: Card, player: Player): Action {
  return { type: 'play', cardId: card.id, ...(card.kind === 'wild' ? { color: preferredColor(player.hand.filter(held => held.id !== card.id)) } : {}) };
}

/** Decisions use this bot's cards and public table information only. */
export function botTurnAction(state: GameState, playerId: string): Action | null {
  const player = state.players.find(participant => participant.id === playerId);
  if (!player?.isBot || state.status !== 'playing' || state.clap || state.players[state.turnIndex]?.id !== playerId) return null;
  const playable = player.hand.filter(card => canPlay(state, playerId, card));
  if (playable.length) return playAction(preferredCard(playable, player), player);
  if (state.pending) return { type: 'accept_penalty' };
  return { type: state.drawnCardId ? 'pass' : 'draw' };
}

function reactions(state: GameState): Reaction[] {
  if (state.status !== 'playing') return [];
  const deadline = state.clap?.deadline ?? state.turnDeadline;
  if (deadline === null || deadline === undefined) return [];
  const startedAt = deadline - state.turnSeconds * 1000;
  const phase = `${state.round}:${startedAt}:${state.clap?.id ?? state.turnIndex}:${state.discardPile.at(-1)?.id}`;
  const target = state.players.find(player => player.id === state.catchablePlayerId);
  const options: Reaction[] = [];
  for (const bot of state.players.filter(player => player.isBot)) {
    const key = `${phase}:${bot.id}`;
    const catchingAt = startedAt + delay(`${key}:catch`, 1350, 400);
    if (target?.hand.length === 1) {
      if (target.id === bot.id) options.push({ playerId: bot.id, action: { type: 'declare' }, dueAt: startedAt + delay(`${key}:declare`, 350, 300), priority: 0 });
      else options.push({ playerId: bot.id, action: { type: 'catch', targetId: target.id }, dueAt: catchingAt, priority: 2 });
    }
    if (state.clap) {
      if (!state.clap.responded.includes(bot.id)) options.push({ playerId: bot.id, action: { type: 'clap' }, dueAt: startedAt + delay(`${key}:clap`, 450, 650), priority: 1 });
      continue;
    }
    // Give a human who just reached one card a chance to declare. A bot waits
    // to catch them before moving, rather than closing that window immediately.
    const waitForDeclaration = target && !target.isBot && target.id !== bot.id ? catchingAt + 20 : 0;
    const turnAction = botTurnAction(state, bot.id);
    if (turnAction) {
      options.push({ playerId: bot.id, action: turnAction, dueAt: Math.max(startedAt + delay(`${key}:turn`, 650, 300), waitForDeclaration), priority: 3 });
    } else {
      const intercepts = bot.hand.filter(card => canPlay(state, bot.id, card));
      if (intercepts.length) options.push({ playerId: bot.id, action: playAction(preferredCard(intercepts, bot), bot), dueAt: Math.max(startedAt + delay(`${key}:intercept`, 1200, 500), waitForDeclaration), priority: 3 });
    }
  }
  return options.sort((a, b) => a.dueAt - b.dueAt || a.priority - b.priority || a.playerId.localeCompare(b.playerId));
}

/**
 * Called inside the same version-checked transaction as human actions. Requests
 * from any connected player advance bots; no client acts on a bot's behalf.
 * Delays derive from the saved phase, so polling never resets a bot's reaction.
 * With no due action the original reference is preserved to avoid idle writes.
 */
export function advanceGame(input: GameState, now = Date.now()): GameState {
  let state = tick(input, now);
  for (let count = 0; count < 16; count++) {
    const reaction = reactions(state).find(option => option.dueAt <= now);
    if (!reaction) break;
    state = act(state, reaction.playerId, reaction.action, now);
  }
  return state;
}
