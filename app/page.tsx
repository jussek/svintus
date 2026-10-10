"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { Action, Card, Color, PublicGame } from "../lib/game";

type Game = PublicGame & { meId: string };
type Player = PublicGame["players"][number];
type Session = { code: string; token: string; playerId: string };
type ApiResult = { game?: PublicGame; code?: string; token?: string; playerId?: string; error?: string };

const colors: Color[] = ["red", "orange", "green", "blue"];
const colorNames: Record<Color, string> = { red: "Красный", orange: "Оранжевый", green: "Зелёный", blue: "Синий" };
const cardNames: Record<Card["kind"], string> = { number: "", draw3: "Хапёж", skip: "Захрапин", wild: "Полисвин", silence: "Тихохрюн", clap: "Хлопкопыт" };
const sessionKey = (code: string) => `svintus:session:${code}`;
const pendingJoinKey = (code: string) => `svintus:pendingjoin:${code}`;
const cardImage = (card: Card) => card.kind === "wild" ? "/cards/wild.jpg" : `/cards/${card.color}-${card.kind === "number" ? card.value : card.kind}.jpg`;
const cardLabel = (card: Card) => `${card.color ? `${colorNames[card.color]}, ` : ""}${card.kind === "number" ? card.value : cardNames[card.kind]}`;
const normalizeCode = (value: string) => value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
const sameCard = (a: Card, b: Card | null) => !!b && a.color === b.color && a.kind === b.kind && (a.kind !== "number" || a.value === b.value);

function Icon({ name, size = 20, className = "" }: { name: "arrow" | "copy" | "people" | "check" | "close" | "chat" | "book" | "spark" | "hand" | "sound" | "back" | "refresh"; size?: number; className?: string }) {
  const paths: Record<string, ReactNode> = {
    arrow: <><path d="M4 12h16M14 6l6 6-6 6" /></>,
    back: <><path d="M20 12H4m6-6-6 6 6 6" /></>,
    copy: <><rect x="8" y="8" width="12" height="12" rx="3" /><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" /></>,
    people: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /><circle cx="9" cy="7" r="4" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    chat: <path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8z" />,
    book: <><path d="M12 5v16M3 3h4a5 5 0 0 1 5 2 5 5 0 0 1 5-2h4v16h-4a5 5 0 0 0-5 2 5 5 0 0 0-5-2H3z" /></>,
    spark: <><path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3" /></>,
    hand: <><path d="M8 13V5a2 2 0 0 1 4 0v7-8a2 2 0 0 1 4 0v8-5a2 2 0 0 1 4 0v9a6 6 0 0 1-6 6h-1a6 6 0 0 1-5-2L3 14a2 2 0 0 1 3-2l2 1Z" /></>,
    sound: <><path d="m3 9 4 0 5-4v14l-5-4H3V9Zm13-1a5 5 0 0 1 0 8m3-11a9 9 0 0 1 0 14" /></>,
    refresh: <><path d="M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 11-2l3 3M4 16l3 3a7 7 0 0 0 11-2" /></>,
  };
  return <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function Pig({ className = "" }: { className?: string }) {
  return <svg className={className} viewBox="0 0 48 48" fill="none" aria-hidden="true"><path d="M10 16 5 7l14 5m19 4 5-9-14 5" fill="currentColor" /><rect x="5" y="12" width="38" height="30" rx="15" fill="currentColor" /><ellipse cx="24" cy="29" rx="12" ry="8" fill="var(--green-deep)" /><ellipse cx="20" cy="29" rx="2" ry="3" fill="currentColor" /><ellipse cx="28" cy="29" rx="2" ry="3" fill="currentColor" /><circle cx="14" cy="20" r="2" fill="var(--green-deep)" /><circle cx="34" cy="20" r="2" fill="var(--green-deep)" /></svg>;
}

function Dialog({ title, onClose, children, className = "" }: { title: string; onClose?: () => void; children: ReactNode; className?: string }) {
  const panel = useRef<HTMLDivElement>(null);
  const closeHandler = useRef(onClose);
  closeHandler.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const element = panel.current;
    element?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeHandler.current?.();
      if (event.key !== "Tab" || !element) return;
      const nodes = Array.from(element.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), a[href], [tabindex="0"]'));
      const first = nodes[0]; const last = nodes[nodes.length - 1];
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === element)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); previous?.focus(); };
  }, []);
  return <div className={`dialog-backdrop ${className}`} onMouseDown={event => { if (event.target === event.currentTarget) onClose?.(); }}>
    <div className="dialog-panel" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={panel}>
      {onClose && <button className="icon-button dialog-close" onClick={onClose} aria-label="Закрыть"><Icon name="close" /></button>}
      {children}
    </div>
  </div>;
}

function Rules({ onClose }: { onClose: () => void }) {
  return <Dialog title="Правила Свинтуса" onClose={onClose} className="rules-dialog">
    <span className="eyebrow">Свинская инструкция</span><h2>Всё просто.<br /><em>Пока не началось.</em></h2>
    <p className="rules-intro">Шесть друзей, по 8 карт на старте, 104 карты в колоде. Играем по часовой стрелке. «Перехрюк» исключён.</p>
    <div className="rule-row"><span className="rule-number">01</span><div><h3>Совпало? Клади.</h3><p>Карта должна совпасть с верхней по цвету или достоинству. Не хочешь или не можешь ходить — возьми одну карту. Только что взятую подходящую карту можно сразу сыграть; иначе передай ход.</p></div></div>
    <div className="rule-row"><span className="rule-number">02</span><div><h3>Одна карта? «Свинтус!»</h3><p>Как только на руке останется одна карта, нажми «Свинтус!». Соперник может поймать тебя раньше — тогда получишь 3 карты. Побеждает первое принятое сервером действие. Кнопка — беззвучный жест, совместимый с «Тихохрюном».</p></div></div>
    <div className="rule-row"><span className="rule-number">03</span><div><h3>Перехватывай и переводи.</h3><p>Точную копию верхней карты можно сыграть вне очереди — ход продолжится от тебя. «Хапёж» и «Захрапин» можно перевести такой же картой любого цвета. Штраф «Хапежа» складывается.</p></div></div>
    <div className="rules-specials">
      <div><b>Хапёж</b><span>Следующий берёт 3 карты и пропускает ход.</span></div>
      <div><b>Захрапин</b><span>Следующий пропускает ход.</span></div>
      <div><b>Полисвин</b><span>На любую карту. Ты выбираешь следующий цвет.</span></div>
      <div><b>Тихохрюн</b><span>Тишина до следующей карты автора. Нарушитель берёт 2 карты.</span></div>
      <div><b>Хлопкопыт</b><span>Все нажимают «Хлоп!». Последний получает 2 карты.</span></div>
    </div>
    <div className="rule-row"><span className="rule-number">04</span><div><h3>Не мешкай.</h3><p>На ход — выбранные хозяином 2, 3 или 5 секунд. Просрочил или сходил неправильно — 2 карты и пропуск хода.</p></div></div>
    <div className="rules-finish"><Icon name="spark" size={28} /><p><b>Первый без карт выигрывает раунд.</b> У каждого соперника одна оставшаяся карта — одно штрафное очко. У кого больше всего очков, тот «Свинтус» раунда; при равенстве их несколько. Новый раунд начинается с нуля. Закончившаяся колода перемешивается заново, кроме верхней карты.</p></div>
  </Dialog>;
}

function Avatar({ player, index, small = false }: { player: Player; index: number; small?: boolean }) {
  return <span className={`avatar avatar-${index % 6} ${small ? "avatar-small" : ""}`} aria-hidden="true">{player.name.trim().slice(0, 1).toUpperCase()}</span>;
}

function CardPicture({ card, className = "" }: { card: Card; className?: string }) {
  return <img className={`card-picture ${className}`} src={cardImage(card)} alt={cardLabel(card)} draggable={false} />;
}

function canPlay(card: Card, game: Game): boolean {
  if (game.status !== "playing" || game.clap) return false;
  const isTurn = game.players[game.turnIndex]?.id === game.meId;
  if (!isTurn) return game.lastPlayedById !== game.meId && sameCard(card, game.topCard);
  if (game.drawnCardId && card.id !== game.drawnCardId) return false;
  if (game.pending) return card.kind === game.pending.kind;
  return card.kind === "wild" || card.color === game.activeColor || (card.kind === game.topCard?.kind && (card.kind !== "number" || card.value === game.topCard?.value));
}

export default function Home() {
  const [hydrated, setHydrated] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [game, setGame] = useState<Game | null>(null);
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [mode, setMode] = useState<"create" | "join">("create");
  const [turnSeconds, setTurnSeconds] = useState(5);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [rulesOpen, setRulesOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatText, setChatText] = useState("");
  const [wild, setWild] = useState<Card | null>(null);
  const [connected, setConnected] = useState(false);
  const [now, setNow] = useState(Date.now());
  const polling = useRef(false);
  const acting = useRef(false);
  const revision = useRef(0);
  const pendingJoinTokens = useRef<Record<string, string>>({});
  const gameRef = useRef<Game | null>(null);
  const logEnd = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setHydrated(true);
    try {
      setName(localStorage.getItem("svintus:name") || "");
      const room = normalizeCode(new URLSearchParams(window.location.search).get("room") || "");
      if (!room) return;
      setCode(room); setMode("join");
      const stored = localStorage.getItem(sessionKey(room));
      if (stored) {
        const saved = JSON.parse(stored) as Session;
        if (saved.code === room && saved.token && saved.playerId) setSession(saved);
      }
    } catch { /* Storage is optional; the current tab still works. */ }
  }, []);

  useEffect(() => {
    if (game?.status !== "playing") return;
    const timer = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(timer);
  }, [game?.status]);
  useEffect(() => { if (!notice) return; const timer = window.setTimeout(() => setNotice(""), 3500); return () => window.clearTimeout(timer); }, [notice]);
  useEffect(() => { gameRef.current = game; }, [game]);
  useEffect(() => { if (game?.clap) { setRulesOpen(false); setWild(null); } }, [game?.clap?.id]);
  useEffect(() => { if (chatOpen) logEnd.current?.scrollIntoView({ block: "nearest" }); }, [chatOpen, game?.chat.length]);

  useEffect(() => {
    if (!session) return;
    let active = true;
    const controller = new AbortController();
    const poll = async () => {
      if (polling.current || acting.current) return;
      polling.current = true;
      const currentRevision = revision.current;
      try {
        const response = await fetch(`/api/rooms/${session.code}`, { headers: { Authorization: `Bearer ${session.token}` }, cache: "no-store", signal: controller.signal });
        const result = await response.json() as ApiResult;
        if (!response.ok || !result.game) throw new Error(result.error || "Не удалось обновить стол.");
        if (active && currentRevision === revision.current) { setGame({ ...result.game, meId: session.playerId }); setConnected(true); }
      } catch (caught) {
        if (active && !(caught instanceof DOMException && caught.name === "AbortError")) {
          setConnected(false);
          if (!gameRef.current) setError(caught instanceof Error ? caught.message : "Соединение прервалось. Повторяем попытку…");
        }
      } finally { polling.current = false; }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 900);
    return () => { active = false; controller.abort(); window.clearInterval(timer); };
    // A single polling loop per authenticated session; its responses update the game.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  const getJoinToken = (roomCode: string) => {
    let token = pendingJoinTokens.current[roomCode];
    if (!token) {
      try {
        const saved = localStorage.getItem(pendingJoinKey(roomCode));
        if (saved && /^[A-Za-z0-9_-]{43}$/.test(saved)) token = saved;
      } catch { /* The ref retains the token when storage is unavailable. */ }
    }
    if (!token) {
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      token = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    }
    pendingJoinTokens.current[roomCode] = token;
    try { localStorage.setItem(pendingJoinKey(roomCode), token); } catch { /* Current-tab retries still reuse it. */ }
    return token;
  };

  const adoptSession = (result: ApiResult) => {
    if (!result.code || !result.token || !result.playerId || !result.game) throw new Error("Сервер не вернул данные комнаты.");
    const saved = { code: result.code, token: result.token, playerId: result.playerId };
    try { localStorage.setItem(sessionKey(saved.code), JSON.stringify(saved)); localStorage.setItem("svintus:name", name.trim()); } catch { /* optional storage */ }
    delete pendingJoinTokens.current[saved.code];
    try { localStorage.removeItem(pendingJoinKey(saved.code)); } catch { /* optional storage */ }
    window.history.replaceState(null, "", `?room=${saved.code}`);
    setSession(saved); setGame({ ...result.game, meId: saved.playerId }); setConnected(true); setCode(saved.code);
  };

  const submitRoom = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (acting.current) return;
    if (!name.trim()) { setError("Как тебя называть за столом?"); return; }
    if (mode === "join" && code.length !== 6) { setError("Введи код комнаты из 6 символов."); return; }
    // An invite opened in the same browser should return to its existing seat.
    if (mode === "join") {
      try {
        const stored = localStorage.getItem(sessionKey(code));
        if (stored) { const saved = JSON.parse(stored) as Session; if (saved.token && saved.playerId) { setSession(saved); window.history.replaceState(null, "", `?room=${code}`); setError(""); return; } }
      } catch { /* proceed to join */ }
    }
    acting.current = true; setBusy("room"); setError("");
    try {
      const body = mode === "create" ? { name: name.trim(), turnSeconds } : { name: name.trim(), joinToken: getJoinToken(code) };
      const response = await fetch(mode === "create" ? "/api/rooms" : `/api/rooms/${code}/join`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const result = await response.json() as ApiResult;
      if (!response.ok) throw new Error(result.error || "Не получилось войти в комнату. Попробуй ещё раз.");
      adoptSession(result);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Сервер недоступен. Попробуй ещё раз."); }
    finally { acting.current = false; setBusy(null); }
  };

  const act = useCallback(async (action: Action) => {
    if (!session || acting.current) return false;
    acting.current = true; revision.current += 1; const actionRevision = revision.current; setBusy(action.type); setError("");
    try {
      const response = await fetch(`/api/rooms/${session.code}/action`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.token}`, "X-Action-Id": crypto.randomUUID() }, body: JSON.stringify(action) });
      const result = await response.json() as ApiResult;
      if (actionRevision !== revision.current) return false;
      if (result.game) setGame({ ...result.game, meId: session.playerId });
      if (!response.ok || !result.game) throw new Error(result.error || "Действие не удалось. Попробуй ещё раз.");
      setConnected(true);
      return true;
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Соединение прервалось. Повторяем подключение…"); return false; }
    finally { acting.current = false; setBusy(null); }
  }, [session]);

  const playCard = async (card: Card, color?: Color) => {
    if (card.kind === "wild" && !color) { setWild(card); return; }
    setWild(null);
    await act({ type: "play", cardId: card.id, ...(color ? { color } : {}) });
  };

  const copyInvite = async () => {
    if (!session) return;
    const link = `${window.location.origin}/?room=${session.code}`;
    try { await navigator.clipboard.writeText(link); setNotice("Приглашение скопировано. Отправь его друзьям!"); }
    catch { setNotice(`Приглашение: ${link}`); }
  };

  const home = () => { revision.current += 1; setSession(null); setGame(null); setError(""); setConnected(false); setWild(null); setChatOpen(false); window.history.replaceState(null, "", window.location.pathname); };
  const isTurn = !!game && game.players[game.turnIndex]?.id === game.meId;
  const isHost = !!game && game.hostId === game.meId;
  const currentPlayer = game?.players[game.turnIndex];
  const remaining = game?.turnDeadline ? Math.max(0, game.turnDeadline - now) : 0;
  const clapResponded = !!game?.clap?.responded.includes(game.meId);
  const me = game?.players.find(player => player.id === game.meId);
  const roomActive = !!session && !!game;

  return <main className={roomActive ? "app game-app" : "app landing-app"}>
    <header className="site-header">
      <button className="brand" onClick={roomActive ? home : undefined} aria-label={roomActive ? "Свинтус — вернуться на главную" : "Свинтус"}><Pig /><span>свинтус<span className="brand-dot">.</span></span><span className="brand-tag">ОНЛАЙН</span></button>
      <div className="header-actions">
        {roomActive && <span className={`connection ${connected ? "is-connected" : ""}`} title={connected ? "Соединение со столом установлено" : "Повторяем подключение"}><span />{connected ? "За столом" : "Подключаемся…"}</span>}
        <button className="text-button" onClick={() => setRulesOpen(true)}><Icon name="book" size={18} /><span>Правила игры</span></button>
      </div>
    </header>

    {!roomActive && <>
      <section className="landing-hero">
        <div className="hero-copy">
          <span className="eyebrow hero-eyebrow"><span className="tiny-spark">✳</span> Друзья. Карты. Немного свинства.</span>
          <h1>Подложи<br />свинью.<br /><span>Своим друзьям.</span></h1>
          <p className="hero-description">Тот самый «Свинтус» — теперь за одним<br className="desktop-break" /> онлайн-столом. Соберите шестёрку. И погнали.</p>
          <div className="hero-badges"><span><Icon name="people" size={18} />Ровно 6 игроков</span><span><Icon name="spark" size={18} />Никаких ботов</span><span className="badge-yellow">Без карт — победа</span></div>
          <div className="hero-art" aria-hidden="true">
            <img className="hero-card hero-card-one" src="/cards/red-7.jpg" alt="" />
            <img className="hero-card hero-card-two" src="/cards/green-clap.jpg" alt="" />
            <img className="hero-card hero-card-three" src="/cards/orange-3.jpg" alt="" />
            <span className="hero-art-sticker">Дружба<br />под угрозой.</span>
          </div>
        </div>
        <div className="room-form-wrap">
          <div className="room-form-card">
            <span className="form-kicker">МЕСТО ЗА СТОЛОМ ЖДЁТ</span><h2>Ну что,<br /><span>похрюкаем?</span></h2>
            <div className="form-tabs" role="tablist" aria-label="Войти в игру"><button role="tab" aria-selected={mode === "create"} className={mode === "create" ? "selected" : ""} onClick={() => { setMode("create"); setError(""); }}>Создать стол</button><button role="tab" aria-selected={mode === "join"} className={mode === "join" ? "selected" : ""} onClick={() => { setMode("join"); setError(""); }}>Присоединиться</button></div>
            <form onSubmit={submitRoom}>
              <label className="field-label" htmlFor="player-name">Твоё имя</label><input id="player-name" disabled={!hydrated} autoComplete="nickname" maxLength={24} placeholder="Например, Хрюша" value={name} onChange={event => setName(event.target.value)} required />
              {mode === "join" ? <><label className="field-label" htmlFor="room-code">Код комнаты</label><input id="room-code" disabled={!hydrated} className="code-input" autoCapitalize="characters" autoComplete="off" spellCheck={false} maxLength={6} placeholder="ABC123" value={code} onChange={event => setCode(normalizeCode(event.target.value))} required /></> : <><div className="timer-label"><span className="field-label">Время на ход</span><span>Не мешкай!</span></div><div className="timer-options" role="group" aria-label="Время на ход">{[2, 3, 5].map(seconds => <button type="button" disabled={!hydrated} key={seconds} className={turnSeconds === seconds ? "selected" : ""} aria-pressed={turnSeconds === seconds} onClick={() => setTurnSeconds(seconds)}>{seconds}<span>сек</span>{seconds === 3 && <small>классика</small>}</button>)}</div></>}
              {error && <p className="form-error" role="alert">{error}</p>}
              <button className="button button-orange form-submit" disabled={!hydrated || !!busy}>{busy ? <><span className="spinner" />Собираем стол…</> : <>{mode === "create" ? "Создать комнату" : "Занять своё место"}<Icon name="arrow" /></>}</button>
            </form>
            <p className="form-note">{mode === "create" ? "Создай комнату и отправь ссылку пяти друзьям." : "Попроси у друга ссылку или шестизначный код."}<br />Без регистрации. Серьёзно.</p>
          </div>
          <div className="under-form-note"><span>↳</span> Перехрюка нет. Свинтус — у кого больше карт.</div>
        </div>
      </section>
      <section className="how-it-works" aria-label="Как начать игру">
        <div className="how-heading"><span className="eyebrow">Легко начать. Трудно остановиться.</span><h2>Три шага<br />до свинства.</h2></div>
        <div className="how-step"><span>01 /</span><h3>Собери своих.</h3><p>Создай стол и позови пятерых друзей по ссылке.</p></div>
        <div className="how-step"><span>02 /</span><h3>Подложи карту.</h3><p>Совпадает цвет или достоинство? Твой выход.</p></div>
        <div className="how-step"><span>03 /</span><h3>Нажми «Свинтус!»</h3><p>Осталась одна карта? Нажми «Свинтус!» раньше соперников.</p></div>
      </section>
      <footer className="landing-footer"><span>Свинтус. Подложи свинью товарищу.</span><span>Карты и правила — из вашего набора.</span></footer>
    </>}

    {session && !game && <div className="restore-overlay" role="status"><span className="spinner" />Возвращаем тебя за стол…{error && <p className="restore-error">{error}</p>}<button className="text-button" onClick={home}>На главную</button></div>}

    {roomActive && game && session && <>
      <div className="room-toolbar"><div><span className="eyebrow">Комната</span><button className="room-code" onClick={copyInvite} title="Скопировать приглашение">{session.code}<Icon name="copy" size={16} /></button></div><div className="room-settings"><span>{game.turnSeconds} сек на ход</span><span>6 игроков</span><span>Без карт — победа</span></div><button className="button button-outline invite-button" onClick={copyInvite}><Icon name="copy" size={16} />Пригласить друзей</button></div>

      {game.status === "lobby" ? <section className="lobby">
        <div className="lobby-intro"><span className="eyebrow">Хорошее свинство требует компании</span><h1>Собираем<br /><span>всю шестёрку.</span></h1><p>Ссылка уже готова. Осталось позвать своих<br className="desktop-break" /> и занять все места за столом.</p></div>
        <div className="lobby-seats">{Array.from({ length: 6 }, (_, index) => { const player = game.players[index]; return <div key={player?.id || index} className={`lobby-seat ${player ? "occupied" : "empty"}`}>{player ? <><Avatar player={player} index={index} /><div><strong>{player.name}{player.id === game.meId && <small>это ты</small>}</strong><span>{player.id === game.hostId ? "Хозяин стола" : "Готов к свинству"}</span></div><span className="seat-check"><Icon name="check" /></span></> : <><span className="empty-avatar"><Icon name="people" /></span><div><strong>Свободное место</strong><span>Ждём ещё одного друга</span></div><span className="seat-number">0{index + 1}</span></>}</div>; })}</div>
        <div className="lobby-start"><div className="lobby-progress"><span><b>{game.players.length}</b> из 6 игроков за столом</span><div>{Array.from({ length: 6 }, (_, index) => <i key={index} className={index < game.players.length ? "filled" : ""} />)}</div></div>{isHost ? <button className="button button-orange" disabled={game.players.length !== 6 || !!busy} onClick={() => void act({ type: "start" })}>{busy === "start" ? <span className="spinner" /> : <Icon name="spark" />}{game.players.length === 6 ? "Раздать карты!" : `Ждём ещё ${6 - game.players.length}`}</button> : <div className="waiting-host">{game.players.length === 6 ? "Все в сборе! Хозяин скоро раздаст карты." : "Можно пока изучить правила."}</div>}</div>
        <p className="lobby-reminder"><Icon name="sound" size={17} />Для полного свинства созвонитесь с друзьями. «Тихохрюн» действует и на разговор.</p>
      </section> : <section className="play-area">
        <div className="game-meta"><span className="round-label">РАУНД <b>{game.round}</b></span><span className="game-meta-note">По часовой стрелке <span>↻</span></span><button className="text-button chat-toggle" onClick={() => setChatOpen(true)}><Icon name="chat" size={18} />Чат стола{game.chat.length > 0 && <span className="chat-count">{game.chat.length}</span>}</button></div>
        <div className="opponents">{game.players.filter(player => player.id !== game.meId).map(player => { const index = game.players.findIndex(p => p.id === player.id); const active = currentPlayer?.id === player.id && game.status === "playing"; return <div key={player.id} className={`opponent ${active ? "opponent-active" : ""}`}><div className="opponent-top"><Avatar player={player} index={index} small /><div><strong title={player.name}>{player.name}</strong><span>{player.score} штрафных очков</span></div>{active && <span className="turn-dot" title="Сейчас ходит" />}</div><div className="opponent-cards"><span className="mini-card-back" /><b>{player.cardCount}</b><span>{player.cardCount === 1 ? "карта" : player.cardCount > 1 && player.cardCount < 5 ? "карты" : "карт"}</span>{game.catchablePlayerId === player.id && <button className="catch-button" disabled={!!busy} onClick={() => void act({ type: "catch", targetId: player.id })} title="Поймать игрока, который не сказал «Свинтус!»">Поймать!</button>}</div></div>; })}</div>

        {game.silenceOwnerId && game.status === "playing" && <div className="silence-banner"><span className="silence-emoji" aria-hidden="true">🤫</span><div><b>Тихохрюн. Тс-с-с…</b><span>Молчим до следующей карты {game.players.find(p => p.id === game.silenceOwnerId)?.name || "автора"}.</span></div><button disabled={!!busy} onClick={() => void act({ type: "break_silence" })}>Нарушить тишину <span>+2 карты</span></button></div>}

        <div className={`game-table ${isTurn && game.status === "playing" ? "my-turn-table" : ""}`}>
          <div className="table-line" /><span className="table-brand" aria-hidden="true">СВИНТУС</span>
          <div className="table-status" role="status">{game.status === "playing" ? <><span className={isTurn ? "status-your-turn" : ""}>{isTurn ? "Твой ход. Подложи свинью!" : `Ходит ${currentPlayer?.name || "игрок"}`}</span>{game.turnDeadline && !game.clap && <div className={`turn-timer ${remaining < 1200 ? "timer-urgent" : ""}`} aria-label={`Осталось ${Math.ceil(remaining / 1000)} секунд`}><svg viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="17" /><circle cx="20" cy="20" r="17" pathLength="100" strokeDasharray={`${Math.max(0, Math.min(100, remaining / (game.turnSeconds * 1000) * 100))} 100`} /></svg><b>{Math.ceil(remaining / 1000)}</b></div>}</> : <span>Раунд завершён</span>}</div>
          <div className="table-cards"><div className="deck-wrap"><button className="card-back deck-button" onClick={() => void act({ type: "draw" })} disabled={!isTurn || !!game.pending || !!game.drawnCardId || !!game.clap || !!busy || game.status !== "playing"} aria-label={`Взять карту из колоды. Осталось ${game.drawPileCount}`} title={isTurn ? "Взять карту" : "Дождись своего хода"}><Pig /><span>СВИНТУС</span><i /></button><span className="deck-caption">Колода <b>{game.drawPileCount}</b></span></div><div className="discard-wrap">{game.topCard && <CardPicture card={game.topCard} />}<span className="discard-caption">{game.topCard ? (game.topCard.kind === "number" ? `Верхняя карта · ${game.topCard.value}` : cardNames[game.topCard.kind]) : "Игровая стопка"}</span></div></div>
          {game.activeColor && <div className="active-color"><span className={`color-dot color-${game.activeColor}`} /><span>Текущий цвет<br /><b>{colorNames[game.activeColor]}</b></span></div>}
          {game.pending && game.status === "playing" && <div className="pending-badge">{game.pending.kind === "draw3" ? `Хапёж · +${game.pending.amount} карт` : "Захрапин · пропуск хода"}</div>}
        </div>

        {game.status === "playing" && <>
          <div className="hand-toolbar"><div className="your-hand-label"><span className="avatar avatar-self">{me?.name.slice(0, 1).toUpperCase()}</span><div><strong>{me?.name} <span>это ты</span></strong><p>{game.hand.length} карт на руке <span>· {me?.score || 0} очков</span></p></div></div><div className="turn-actions">{isTurn && game.pending ? <button className="button button-cream button-compact" disabled={!!busy || !!game.clap} onClick={() => void act({ type: "accept_penalty" })}>{game.pending.kind === "draw3" ? `Взять ${game.pending.amount} карт` : "Пропустить ход"}<Icon name="arrow" size={17} /></button> : isTurn && game.drawnCardId ? <button className="button button-cream button-compact" disabled={!!busy || !!game.clap} onClick={() => void act({ type: "pass" })}>Передать ход<Icon name="arrow" size={17} /></button> : <button className="button button-outline button-compact" disabled={!isTurn || !!busy || !!game.clap} onClick={() => void act({ type: "draw" })}>Взять карту <span>+1</span></button>}<button className={`declare-button ${game.catchablePlayerId === game.meId ? "declare-urgent" : ""}`} disabled={game.hand.length !== 1 || game.catchablePlayerId !== game.meId || !!busy} title={game.hand.length === 1 ? "Нажми раньше, чем соперник тебя поймает! Беззвучный жест." : "Кнопка появится, когда останется одна карта"} onClick={() => void act({ type: "declare" })}><Icon name="hand" size={18} />Свинтус!</button></div></div>
          <div className="hand-scroll"><div className="hand-cards">{game.hand.map((card, index) => { const playable = canPlay(card, game); const intercept = playable && !isTurn; return <button key={card.id} className={`hand-card ${playable ? "playable" : "unplayable"} ${game.drawnCardId === card.id ? "just-drawn" : ""}`} style={{ "--card-tilt": `${Math.max(-7, Math.min(7, (index - (game.hand.length - 1) / 2) * 1.5))}deg` } as React.CSSProperties} disabled={!playable || !!busy} onClick={() => void playCard(card)} aria-label={`${cardLabel(card)}${intercept ? ", перехватить ход" : playable ? ", сыграть" : ", сейчас нельзя сыграть"}`} title={`${cardLabel(card)}${intercept ? " — перехват!" : playable ? " — можно сыграть" : " — ждёт подходящего хода"}`}><CardPicture card={card} />{intercept && <span className="intercept-tag">Перехват</span>}{game.drawnCardId === card.id && <span className="drawn-tag">Новая</span>}</button>; })}</div></div>
          <p className="hand-hint">{game.clap ? "Все ладони — на колоду!" : isTurn && game.pending ? `Переведи ${game.pending.kind === "draw3" ? "Хапёж" : "Захрапин"} такой же картой или прими штраф.` : isTurn && game.drawnCardId ? "Сыграй взятую карту, если она подходит, или передай ход." : isTurn ? "Подсвеченные карты можно сыграть. Останется одна карта — сразу нажми «Свинтус!»" : "Жди свой ход. Точную копию верхней карты можно сыграть вне очереди."}</p>
        </>}

        {game.status === "round_end" && <div className="scoreboard">
          <div className="scoreboard-heading"><span className="winner-star">✳</span><span className="eyebrow">Без карт. Без штрафа.</span><h2>{game.players.find(p => p.id === game.roundWinnerId)?.name}<span>выигрывает раунд!</span></h2><p>Одна оставшаяся карта — одно штрафное очко.</p></div>
          <div className="scoreboard-list">{[...game.players].sort((a, b) => a.id === game.roundWinnerId ? -1 : b.id === game.roundWinnerId ? 1 : a.score - b.score).map((player, index) => <div key={player.id} className={`score-row ${player.id === game.roundWinnerId ? "score-leader" : ""} ${game.svintusIds.includes(player.id) ? "score-svintus" : ""}`}><span className="score-rank">{index + 1}</span><Avatar player={player} index={game.players.findIndex(p => p.id === player.id)} small /><strong>{player.name}{player.id === game.meId && <small>это ты</small>}{game.svintusIds.includes(player.id) && <span className="svintus-label">Свинтус!</span>}{player.id === game.roundWinnerId && <span className="winner-label">Победитель</span>}</strong><span className="score-points">{player.score}<small> очков</small></span></div>)}</div>
          {game.svintusIds.length > 0 && <p className="svintus-explanation">{game.svintusIds.length > 1 ? "Свинтусы раунда" : "Свинтус раунда"} — {game.players.filter(p => game.svintusIds.includes(p.id)).map(p => p.name).join(", ")}. Больше всего карт на руках!</p>}
          {isHost ? <button className="button button-orange" disabled={!!busy} onClick={() => void act({ type: "next_round" })}>Ещё раунд? Раздаём!<Icon name="arrow" /></button> : <p className="waiting-host">Ждём, пока хозяин начнёт следующий раунд.</p>}
        </div>}
        {game.log.length > 0 && <div className="game-log" aria-label="Последние события игры"><span className="log-dot" /><p>{game.log[game.log.length - 1].text}</p></div>}
      </section>}
      {error && <div className="game-error" role="alert"><span>{error}</span><button className="icon-button" onClick={() => setError("")} aria-label="Скрыть сообщение"><Icon name="close" size={17} /></button></div>}
    </>}

    {notice && <div className="toast" role="status"><Icon name="check" size={19} />{notice}</div>}
    {rulesOpen && <Rules onClose={() => setRulesOpen(false)} />}
    {wild && game && <Dialog title="Полисвин: выбери цвет" onClose={() => setWild(null)} className="color-dialog"><span className="eyebrow">Полисвин</span><h2>Твой цвет.<br /><em>Твои правила.</em></h2><p>Какой цвет придётся сыграть следующему?</p><div className="color-options">{colors.map(color => <button key={color} className={`color-choice color-${color}`} disabled={!!busy} onClick={() => void playCard(wild, color)}><span />{colorNames[color]}<Icon name="arrow" /></button>)}</div></Dialog>}
    {game?.clap && game.status === "playing" && <Dialog title="Хлопкопыт — нажми Хлоп!" className="clap-dialog"><span className="eyebrow">Хлопкопыт!</span><h2>{clapResponded ? "Успел!" : "Ладонь на стол!"}</h2><p>{clapResponded ? "Ждём остальных. Последнему — две карты." : "Последний получает 2 карты. Скорее жми!"}</p><button className={`clap-button ${clapResponded ? "clap-done" : ""}`} onClick={() => void act({ type: "clap" })} disabled={clapResponded || !!busy}>{clapResponded ? <Icon name="check" size={60} /> : <Icon name="hand" size={70} />}<span>{clapResponded ? "ЕСТЬ!" : "ХЛОП!"}</span></button><div className="clap-responders">{game.players.map((player, index) => <span key={player.id} className={game.clap!.responded.includes(player.id) ? "responded" : ""} title={`${player.name}${game.clap!.responded.includes(player.id) ? " — успел" : " — ждём"}`}><Avatar player={player} index={index} small />{game.clap!.responded.includes(player.id) && <Icon name="check" size={12} />}</span>)}</div></Dialog>}
    {chatOpen && game && <Dialog title="Чат стола" onClose={() => setChatOpen(false)} className="chat-dialog"><span className="eyebrow">Все свои</span><h2>Разговоры<br /><em>за столом.</em></h2>{game.silenceOwnerId && <div className="chat-silence">🤫 Тихохрюн! Сообщение нарушит тишину и добавит 2 карты.</div>}<div className="chat-messages" aria-live="polite">{game.chat.length ? game.chat.map(message => { const author = game.players.find(player => player.id === message.playerId); return <div className={`chat-message ${message.playerId === game.meId ? "message-self" : ""}`} key={message.id}><strong>{author?.name || "Игрок"}</strong><p>{message.text}</p><time>{new Date(message.at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}</time></div>; }) : <div className="chat-empty"><Icon name="chat" size={36} /><p>Пока тихо. Подозрительно тихо.</p></div>}<div ref={logEnd} /></div><form className="chat-form" onSubmit={async event => { event.preventDefault(); if (!chatText.trim()) return; if (await act({ type: "chat", text: chatText.trim() })) setChatText(""); }}><input aria-label="Сообщение всем игрокам" disabled={busy === "chat"} maxLength={200} placeholder={game.silenceOwnerId ? "Помни о Тихохрюне…" : "Скажи что-нибудь свинское…"} value={chatText} onChange={event => setChatText(event.target.value)} /><button className="button button-orange" aria-label="Отправить сообщение" disabled={!chatText.trim() || !!busy}><Icon name="arrow" /></button></form><details className="event-history"><summary>События игры</summary><div>{game.log.slice(-30).map(entry => <p key={entry.id}>{entry.text}</p>)}</div></details></Dialog>}
  </main>;
}
