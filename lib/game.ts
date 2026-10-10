/** Server-authoritative Svintus rules. State is never exposed directly to clients. */
export const COLORS = ["red", "orange", "green", "blue"] as const;
export type Color = (typeof COLORS)[number];
export type CardKind = "number" | "draw3" | "skip" | "wild" | "silence" | "clap";
export type Card = { id: string; color: Color | null; kind: CardKind; value?: number };
export type Player = { id: string; name: string; hand: Card[]; score: number; isBot?: boolean };
export type GameState = {
  players: Player[];
  hostId: string;
  status: "lobby" | "playing" | "round_end" | "finished";
  round: number;
  dealerIndex: number;
  turnIndex: number;
  activeColor: Color | null;
  drawPile: Card[];
  discardPile: Card[];
  turnDeadline: number | null;
  turnSeconds: 2 | 3 | 5;
  drawnCardId: string | null;
  pending: { kind: "draw3" | "skip"; amount: number } | null;
  clap: { id: string; responded: string[]; deadline: number } | null;
  silenceOwnerId: string | null;
  catchablePlayerId: string | null;
  lastPlayedById: string | null;
  winnerId: string | null;
  roundWinnerId: string | null;
  svintusIds: string[];
  log: Array<{ id: string; text: string; at: number }>;
  chat: Array<{ id: string; playerId: string; text: string; at: number }>;
};
export type Action =
  | { type: "add_bot" }
  | { type: "remove_bot"; targetId: string }
  | { type: "start"; color?: Color }
  | { type: "next_round"; color?: Color }
  | { type: "play"; cardId: string; color?: Color }
  | { type: "declare" }
  | { type: "draw" }
  | { type: "pass" }
  | { type: "accept_penalty" }
  | { type: "clap" }
  | { type: "catch"; targetId: string }
  | { type: "chat"; text: string }
  | { type: "break_silence" };

export class GameError extends Error {
  constructor(message: string) { super(message); this.name = "GameError"; }
}

const uid = () => globalThis.crypto.randomUUID();
const copy = (state: GameState): GameState => structuredClone(state);
const nextIndex = (state: GameState, index = state.turnIndex) => (index + 1) % state.players.length;
const current = (state: GameState) => state.players[state.turnIndex];
const top = (state: GameState) => state.discardPile.at(-1);
const isColor = (color: unknown): color is Color => COLORS.includes(color as Color);
const cleanName = (name: string) => {
  if (typeof name !== "string") throw new GameError("Введите имя.");
  const value = name.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 24);
  if (!value) throw new GameError("Введите имя.");
  return value;
};
const log = (state: GameState, text: string, now: number) => {
  state.log.push({ id: uid(), text, at: now });
  state.log = state.log.slice(-100);
};

/** 64 number cards + 40 instructions. Perekhryuk is deliberately omitted. */
export function createDeck(): Card[] {
  const cards: Card[] = [];
  for (const color of COLORS) {
    for (let value = 0; value <= 7; value++) {
      for (let n = 0; n < 2; n++) cards.push({ id: `${color}-${value}-${n}`, kind: "number", color, value });
    }
    for (const kind of ["draw3", "skip", "silence", "clap"] as const) {
      for (let n = 0; n < 2; n++) cards.push({ id: `${color}-${kind}-${n}`, kind, color });
    }
  }
  for (let n = 0; n < 8; n++) cards.push({ id: `wild-${n}`, kind: "wild", color: null });
  return cards;
}

function shuffled(cards: Card[]): Card[] {
  const result = [...cards];
  for (let n = result.length - 1; n > 0; n--) {
    const j = Math.floor(Math.random() * (n + 1));
    [result[n], result[j]] = [result[j], result[n]];
  }
  return result;
}

export function createGame(hostId: string, hostName: string, turnSeconds: 2 | 3 | 5 = 5): GameState {
  if (!hostId || ![2, 3, 5].includes(turnSeconds)) throw new GameError("Некорректные настройки комнаты.");
  return {
    players: [{ id: hostId, name: cleanName(hostName), hand: [], score: 0, isBot: false }], hostId,
    status: "lobby", round: 0, dealerIndex: 0, turnIndex: 0, activeColor: null,
    drawPile: [], discardPile: [], turnDeadline: null, turnSeconds,
    drawnCardId: null, pending: null, clap: null, silenceOwnerId: null,
    catchablePlayerId: null, lastPlayedById: null, winnerId: null, roundWinnerId: null, svintusIds: [],
    log: [], chat: [],
  };
}

export function addPlayer(input: GameState, id: string, name: string): GameState {
  if (!id) throw new GameError("Не найден игрок.");
  if (input.players.some((player) => player.id === id)) return copy(input);
  if (input.status !== "lobby") throw new GameError("Партия уже началась.");
  if (input.players.length >= 6) throw new GameError("В комнате уже шесть игроков.");
  const state = copy(input);
  state.players.push({ id, name: cleanName(name), hand: [], score: 0, isBot: false });
  return state;
}

function botName(state: GameState): string {
  const names = ["Хрюша", "Пятачок", "Боря", "Нюша", "Хрюндель"];
  for (let n = 0; ; n++) {
    const suffix = n < names.length ? "" : ` ${Math.floor(n / names.length) + 1}`;
    const name = `${names[n % names.length]}${suffix} (бот)`;
    if (!state.players.some((player) => player.name === name)) return name;
  }
}

function take(state: GameState, player: Player, amount: number): Card[] {
  const drawn: Card[] = [];
  for (let n = 0; n < amount; n++) {
    if (!state.drawPile.length && state.discardPile.length > 1) {
      const last = state.discardPile.pop()!;
      state.drawPile = shuffled(state.discardPile);
      state.discardPile = [last];
    }
    const card = state.drawPile.pop();
    if (!card) break;
    player.hand.push(card);
    drawn.push(card);
  }
  return drawn;
}

function setDeadline(state: GameState, now: number) {
  state.turnDeadline = state.clap ? null : now + state.turnSeconds * 1000;
}

function nextTurn(state: GameState, now: number, index?: number) {
  state.turnIndex = index ?? nextIndex(state);
  state.drawnCardId = null;
  setDeadline(state, now);
}

function majorityColor(player: Player): Color {
  return [...COLORS].sort((a, b) => player.hand.filter((c) => c.color === b).length - player.hand.filter((c) => c.color === a).length)[0];
}

function applyCard(state: GameState, card: Card, playerId: string, now: number, color?: Color) {
  state.activeColor = card.kind === "wild" ? color! : card.color;
  if (card.kind === "draw3") state.pending = { kind: "draw3", amount: (state.pending?.kind === "draw3" ? state.pending.amount : 0) + 3 };
  else if (card.kind === "skip") state.pending = { kind: "skip", amount: 1 };
  else state.pending = null;
  if (card.kind === "silence") {
    state.silenceOwnerId = playerId;
    log(state, "Тихохрюн: молчим, пока его хозяин снова не сыграет карту.", now);
  }
  if (card.kind === "clap") {
    state.clap = { id: uid(), responded: [], deadline: now + state.turnSeconds * 1000 };
    state.turnDeadline = null;
    log(state, "Хлопкопыт! Все должны нажать на колоду. Последнему — две карты.", now);
  }
}

function beginRound(state: GameState, now: number, chosenColor?: Color) {
  if (state.players.length < 2 || state.players.length > 6) throw new GameError("Для начала нужны от двух до шести игроков.");
  state.round++;
  state.dealerIndex = (state.round - 1) % state.players.length;
  state.turnIndex = nextIndex(state, state.dealerIndex);
  state.status = "playing";
  state.drawPile = shuffled(createDeck());
  state.discardPile = [];
  state.pending = null;
  state.clap = null;
  state.silenceOwnerId = null;
  state.catchablePlayerId = null;
  state.drawnCardId = null;
  state.roundWinnerId = null;
  state.winnerId = null;
  state.svintusIds = [];
  for (const player of state.players) { player.hand = []; player.score = 0; }
  for (let n = 0; n < 8; n++) for (const player of state.players) take(state, player, 1);
  const opener = state.drawPile.pop()!;
  state.discardPile.push(opener);
  const dealer = state.players[state.dealerIndex];
  state.lastPlayedById = dealer.id;
  const openingColor = isColor(chosenColor) ? chosenColor : majorityColor(dealer);
  log(state, `Партия ${state.round}. ${dealer.name} раздаёт по восемь карт. Побеждает первый без карт; свинтус — с наибольшим остатком.`, now);
  applyCard(state, opener, dealer.id, now, openingColor);
  if (opener.kind === "wild") log(state, `Первый Полисвин: ${chosenColor ? "выбран" : "автоматически выбран"} цвет ${COLOR_NAMES[openingColor]}.`, now);
  setDeadline(state, now);
}

const COLOR_NAMES: Record<Color, string> = { red: "красный", orange: "оранжевый", green: "зелёный", blue: "синий" };
export function cardName(card: Card): string {
  const names = { number: String(card.value), draw3: "Хапёж", skip: "Захрапин", wild: "Полисвин", silence: "Тихохрюн", clap: "Хлопкопыт" };
  return card.color ? `${COLOR_NAMES[card.color]} ${names[card.kind]}` : names[card.kind];
}

function identical(a: Card, b: Card): boolean {
  return a.color === b.color && a.kind === b.kind && (a.kind !== "number" || a.value === b.value);
}

function matches(state: GameState, card: Card): boolean {
  const previous = top(state);
  if (!previous) return false;
  if (state.pending) return card.kind === state.pending.kind;
  return card.kind === "wild" || card.color === state.activeColor || (card.kind === previous.kind && (card.kind !== "number" || card.value === previous.value));
}

/** Also permits an identical-card intercept by a player outside the current turn. */
export function canPlay(state: GameState, playerId: string, card: Card): boolean {
  if (state.status !== "playing" || state.clap) return false;
  const player = state.players.find((p) => p.id === playerId);
  const owned = player?.hand.find((c) => c.id === card.id);
  if (!owned) return false;
  if (current(state).id === playerId) {
    if (state.drawnCardId && state.drawnCardId !== owned.id) return false;
    return matches(state, owned);
  }
  const previous = top(state);
  return !!previous && state.lastPlayedById !== playerId && identical(owned, previous);
}

function endRound(state: GameState, player: Player, now: number) {
  for (const participant of state.players) participant.score = participant.hand.length;
  const mostCards = Math.max(...state.players.map((p) => p.hand.length));
  state.svintusIds = state.players.filter((p) => p.hand.length === mostCards).map((p) => p.id);
  state.roundWinnerId = player.id;
  state.status = "round_end";
  state.winnerId = player.id;
  state.turnDeadline = null;
  state.drawnCardId = null;
  state.pending = null;
  state.clap = null;
  state.catchablePlayerId = null;
  state.silenceOwnerId = null;
  const losers = state.players.filter((p) => state.svintusIds.includes(p.id)).map((p) => p.name).join(", ");
  log(state, `${player.name} выиграл партию! ${state.svintusIds.length === 1 ? "Свинтус" : "Свинтусы"}: ${losers}, ${mostCards} очков за оставшиеся карты.`, now);
}

function silenceViolation(state: GameState, player: Player, now: number) {
  if (!state.silenceOwnerId) return;
  take(state, player, 2);
  state.silenceOwnerId = null;
  if (state.catchablePlayerId === player.id) state.catchablePlayerId = null;
  log(state, `${player.name} нарушил тишину и взял две карты. Теперь можно говорить.`, now);
}

function wrongMove(state: GameState, player: Player, now: number, reason: string) {
  // The instruction of the previous card must still be fulfilled.
  if (state.pending?.kind === "draw3") take(state, player, state.pending.amount);
  take(state, player, 2);
  state.pending = null;
  state.catchablePlayerId = null;
  log(state, `${player.name}: ${reason}. Штраф — две карты и пропуск хода.`, now);
  nextTurn(state, now);
}

function finishClap(state: GameState, losers: Player[], now: number, missed = false) {
  for (const loser of losers) {
    take(state, loser, 2);
    if (state.catchablePlayerId === loser.id) state.catchablePlayerId = null;
  }
  state.clap = null;
  setDeadline(state, now);
  log(state, `${losers.map((p) => p.name).join(", ")}${missed ? " не успели хлопнуть" : " хлопнул последним"}: по две штрафные карты.`, now);
}

/** Processes one expired phase. A fresh deadline prevents offline catch-up cascades. */
export function tick(input: GameState, now = Date.now()): GameState {
  if (input.status !== "playing") return input;
  const clapExpired = input.clap && now >= input.clap.deadline;
  const turnExpired = !input.clap && input.turnDeadline !== null && now >= input.turnDeadline;
  if (!clapExpired && !turnExpired) return input;
  const state = copy(input);
  if (state.clap && now >= state.clap.deadline) {
    const missing = state.players.filter((p) => !state.clap!.responded.includes(p.id));
    if (missing.length) finishClap(state, missing, now, true);
    return state;
  }
  if (!state.clap && state.turnDeadline !== null && now >= state.turnDeadline) wrongMove(state, current(state), now, "время хода истекло");
  return state;
}

export function act(input: GameState, playerId: string, action: Action, now = Date.now()): GameState {
  if (!action || typeof action.type !== "string") throw new GameError("Неизвестное действие.");
  const state = copy(tick(input, now));
  const player = state.players.find((p) => p.id === playerId);
  if (!player) throw new GameError("Вы не участник комнаты.");
  if (action.type === "add_bot" || action.type === "remove_bot") {
    if (playerId !== state.hostId) throw new GameError("Добавлять и удалять ботов может только создатель комнаты.");
    if (state.status !== "lobby") throw new GameError("Добавлять и удалять ботов можно только до начала игры.");
    if (action.type === "add_bot") {
      if (state.players.length >= 6) throw new GameError("В комнате уже шесть игроков.");
      const name = botName(state);
      state.players.push({ id: uid(), name, hand: [], score: 0, isBot: true });
      log(state, `${name} присоединился к столу.`, now);
    } else {
      const bot = state.players.find((p) => p.id === action.targetId);
      if (!bot) throw new GameError("Этот бот не найден в комнате.");
      if (!bot.isBot) throw new GameError("Удалять можно только ботов, а не людей.");
      state.players = state.players.filter((p) => p.id !== bot.id);
      log(state, `${bot.name} покинул стол.`, now);
    }
    return state;
  }
  if (action.type === "chat") {
    if (typeof action.text !== "string") throw new GameError("Некорректное сообщение.");
    const text = action.text.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 200);
    if (!text) throw new GameError("Сообщение пустое.");
    if (state.status === "playing") silenceViolation(state, player, now);
    state.chat.push({ id: uid(), playerId, text, at: now });
    state.chat = state.chat.slice(-50);
    return state;
  }
  if (action.type === "start" || action.type === "next_round") {
    if (playerId !== state.hostId) throw new GameError("Начать партию может только создатель комнаты.");
    if (action.type === "start" ? state.status !== "lobby" : state.status !== "round_end") throw new GameError("Сейчас нельзя начать эту партию.");
    if (action.color !== undefined && !isColor(action.color)) throw new GameError("Выберите цвет.");
    beginRound(state, now, action.color);
    return state;
  }
  if (state.status !== "playing") throw new GameError("Партия ещё не идёт.");
  if (action.type === "break_silence") {
    if (!state.silenceOwnerId) throw new GameError("Запрета на разговор нет.");
    silenceViolation(state, player, now);
    return state;
  }
  if (action.type === "declare") {
    if (state.catchablePlayerId !== playerId || player.hand.length !== 1) throw new GameError("«Свинтус!» можно объявить только сразу после своей предпоследней карты.");
    state.catchablePlayerId = null;
    log(state, `${player.name} нажал «Свинтус!» и успел объявить последнюю карту.`, now);
    return state;
  }
  if (action.type === "catch") {
    const target = state.players.find((p) => p.id === action.targetId);
    if (!target || target.id === playerId || target.id !== state.catchablePlayerId || target.hand.length !== 1) throw new GameError("Сейчас этого игрока нельзя поймать.");
    take(state, target, 3);
    state.catchablePlayerId = null;
    log(state, `${player.name} поймал ${target.name} без «Свинтус!»: три штрафные карты.`, now);
    return state;
  }
  if (action.type === "clap") {
    if (!state.clap) throw new GameError("Хлопкопыт сейчас не разыгрывается.");
    if (state.clap.responded.includes(playerId)) return state;
    state.clap.responded.push(playerId);
    if (state.clap.responded.length === state.players.length) finishClap(state, [player], now);
    return state;
  }
  if (state.clap) throw new GameError("Сначала все должны хлопнуть по колоде.");
  if (action.type === "play") {
    const card = player.hand.find((c) => c.id === action.cardId);
    if (!card) throw new GameError("Этой карты нет у вас на руке.");
    const ownTurn = current(state).id === playerId;
    if (!canPlay(state, playerId, card)) {
      if (!ownTurn) throw new GameError("Сейчас не ваш ход. Перехват возможен только такой же картой.");
      wrongMove(state, player, now, "карта сыграна неправильно");
      return state;
    }
    if (card.kind === "wild" && !isColor(action.color)) {
      if (!ownTurn) throw new GameError("Для Полисвина выберите цвет.");
      wrongMove(state, player, now, "для Полисвина не выбран цвет");
      return state;
    }
    state.catchablePlayerId = null;
    if (state.silenceOwnerId === playerId) state.silenceOwnerId = null;
    player.hand = player.hand.filter((c) => c.id !== card.id);
    state.discardPile.push(card);
    state.lastPlayedById = playerId;
    state.turnIndex = nextIndex(state, state.players.indexOf(player));
    state.drawnCardId = null;
    log(state, `${player.name}${ownTurn ? " сыграл" : " перехватил:"} ${cardName(card)}.`, now);
    if (!player.hand.length) {
      state.activeColor = card.kind === "wild" ? action.color! : card.color;
      endRound(state, player, now);
      return state;
    }
    if (player.hand.length === 1) state.catchablePlayerId = playerId;
    applyCard(state, card, playerId, now, action.color);
    setDeadline(state, now);
    return state;
  }
  if (current(state).id !== playerId) throw new GameError("Сейчас не ваш ход.");
  if (action.type === "accept_penalty") {
    if (!state.pending) throw new GameError("Нет штрафа для перевода.");
    const penalty = state.pending;
    state.catchablePlayerId = null;
    if (penalty.kind === "draw3") take(state, player, penalty.amount);
    state.pending = null;
    log(state, penalty.kind === "draw3" ? `${player.name} взял ${penalty.amount} карт и пропустил ход.` : `${player.name} пропустил ход из-за Захрапина.`, now);
    nextTurn(state, now);
    return state;
  }
  if (action.type === "draw") {
    if (state.pending) throw new GameError("Переведите предписание или примите его.");
    if (state.drawnCardId) throw new GameError("Вы уже взяли карту: сыграйте её или завершите ход.");
    state.catchablePlayerId = null;
    const card = take(state, player, 1)[0];
    log(state, `${player.name} взял карту.`, now);
    if (card && matches(state, card)) state.drawnCardId = card.id;
    else nextTurn(state, now);
    return state;
  }
  if (action.type === "pass") {
    if (!state.drawnCardId) throw new GameError("Сначала возьмите карту.");
    state.catchablePlayerId = null;
    nextTurn(state, now);
    return state;
  }
  throw new GameError("Неизвестное действие.");
}

export type PublicGame = Omit<GameState, "players" | "drawPile" | "discardPile" | "drawnCardId"> & {
  meId: string;
  players: Array<Omit<Player, "hand" | "isBot"> & { cardCount: number; isBot: boolean }>;
  hand: Card[];
  topCard: Card | null;
  drawPileCount: number;
  drawnCardId: string | null;
};

/** Never includes another player's hand or the order of the deck/discard pile. */
export function publicGame(state: GameState, playerId: string): PublicGame {
  if (!state.players.some((p) => p.id === playerId)) throw new GameError("Вы не участник комнаты.");
  const { players, drawPile, discardPile, drawnCardId, ...shared } = copy(state);
  return {
    ...shared,
    meId: playerId,
    players: players.map(({ hand, isBot, ...player }) => ({ ...player, cardCount: hand.length, isBot: !!isBot })),
    hand: players.find((p) => p.id === playerId)!.hand,
    topCard: discardPile.at(-1) ?? null,
    drawPileCount: drawPile.length,
    drawnCardId: current(state).id === playerId ? drawnCardId : null,
  };
}
