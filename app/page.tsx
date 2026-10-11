"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import type { Action, Card, Color, PublicGame } from "../lib/game";
import CardHand from "./components/CardHand";

type Game = PublicGame & { meId: string };
type Player = PublicGame["players"][number];
type PublicRoom = {
  code: string;
  hostName: string;
  playerCount: number;
  botCount: number;
  createdAt: number | string;
};
type Session = { code: string; token: string; playerId: string };
type ApiResult = {
  game?: PublicGame;
  code?: string;
  token?: string;
  playerId?: string;
  error?: string;
};

const colors: Color[] = ["red", "orange", "green", "blue"];
const colorNames: Record<Color, string> = {
  red: "Красный",
  orange: "Оранжевый",
  green: "Зелёный",
  blue: "Синий",
};
const cardNames: Record<Card["kind"], string> = {
  number: "",
  draw3: "Хапёж",
  skip: "Захрапин",
  wild: "Полисвин",
  silence: "Тихохрюн",
  clap: "Хлопкопыт",
};
const sessionKey = (code: string) => `svintus:session:${code}`;
const pendingJoinKey = (code: string) => `svintus:pendingjoin:${code}`;
const cardImage = (card: Card) =>
  card.kind === "wild"
    ? "/cards/wild.jpg"
    : `/cards/${card.color}-${card.kind === "number" ? card.value : card.kind}.jpg`;
const cardLabel = (card: Card) =>
  `${card.color ? `${colorNames[card.color]}, ` : ""}${card.kind === "number" ? card.value : cardNames[card.kind]}`;
const gamePhase = (game: Game | null) =>
  game
    ? [
        game.status,
        game.round,
        game.turnIndex,
        game.colorChoicePlayerId,
        game.topCard?.id,
        game.clap?.id,
      ].join(":")
    : "";
const normalizeCode = (value: string) =>
  value
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 6);

function Icon({
  name,
  size = 20,
  className = "",
}: {
  name:
    | "arrow"
    | "copy"
    | "people"
    | "check"
    | "close"
    | "chat"
    | "book"
    | "spark"
    | "hand"
    | "sound"
    | "back"
    | "refresh";
  size?: number;
  className?: string;
}) {
  const paths: Record<string, ReactNode> = {
    arrow: (
      <>
        <path d="M4 12h16M14 6l6 6-6 6" />
      </>
    ),
    back: (
      <>
        <path d="M20 12H4m6-6-6 6 6 6" />
      </>
    ),
    copy: (
      <>
        <rect x="8" y="8" width="12" height="12" rx="3" />
        <path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" />
      </>
    ),
    people: (
      <>
        <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
        <circle cx="9" cy="7" r="4" />
      </>
    ),
    check: <path d="m5 12 4 4L19 6" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    chat: (
      <path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8z" />
    ),
    book: (
      <>
        <path d="M12 5v16M3 3h4a5 5 0 0 1 5 2 5 5 0 0 1 5-2h4v16h-4a5 5 0 0 0-5 2 5 5 0 0 0-5-2H3z" />
      </>
    ),
    spark: (
      <>
        <path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3" />
      </>
    ),
    hand: (
      <>
        <path d="M8 13V5a2 2 0 0 1 4 0v7-8a2 2 0 0 1 4 0v8-5a2 2 0 0 1 4 0v9a6 6 0 0 1-6 6h-1a6 6 0 0 1-5-2L3 14a2 2 0 0 1 3-2l2 1Z" />
      </>
    ),
    sound: (
      <>
        <path d="m3 9 4 0 5-4v14l-5-4H3V9Zm13-1a5 5 0 0 1 0 8m3-11a9 9 0 0 1 0 14" />
      </>
    ),
    refresh: (
      <>
        <path d="M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 11-2l3 3M4 16l3 3a7 7 0 0 0 11-2" />
      </>
    ),
  };
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}

function Pig({ className = "" }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 48 48"
      fill="none"
      aria-hidden="true"
    >
      <path d="M10 16 5 7l14 5m19 4 5-9-14 5" fill="currentColor" />
      <rect x="5" y="12" width="38" height="30" rx="15" fill="currentColor" />
      <ellipse cx="24" cy="29" rx="12" ry="8" fill="var(--green-deep)" />
      <ellipse cx="20" cy="29" rx="2" ry="3" fill="currentColor" />
      <ellipse cx="28" cy="29" rx="2" ry="3" fill="currentColor" />
      <circle cx="14" cy="20" r="2" fill="var(--green-deep)" />
      <circle cx="34" cy="20" r="2" fill="var(--green-deep)" />
    </svg>
  );
}

function Dialog({
  title,
  onClose,
  children,
  className = "",
}: {
  title: string;
  onClose?: () => void;
  children: ReactNode;
  className?: string;
}) {
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
      const nodes = Array.from(
        element.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), a[href], [tabindex="0"]',
        ),
      );
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (!first) {
        event.preventDefault();
        return;
      }
      if (
        event.shiftKey &&
        (document.activeElement === first || document.activeElement === element)
      ) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previous?.focus();
    };
  }, []);
  return (
    <div
      className={`dialog-backdrop ${className}`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose?.();
      }}
    >
      <div
        className="dialog-panel"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={panel}
      >
        {onClose && (
          <button
            className="icon-button dialog-close"
            onClick={onClose}
            aria-label="Закрыть"
          >
            <Icon name="close" />
          </button>
        )}
        {children}
      </div>
    </div>
  );
}

const rulePages = [
  {
    title: "За одним столом",
    badge: "Начало игры",
    icon: "people" as const,
    paragraphs: [
      "От 2 до 6 участников. Позови друзей или добавь ботов — одному человеку хватит одного бота.",
      "Каждому по 8 карт. В колоде 104 карты, «Перехрюка» нет. Ходим по часовой стрелке.",
      "Первый без карт выигрывает раунд. У остальных каждая карта — одно штрафное очко. Больше всех очков? Ты Свинтус! Следующий раунд — с нуля.",
    ],
  },
  {
    title: "Совпало? Клади.",
    badge: "Твой ход",
    icon: "hand" as const,
    paragraphs: [
      "Клади карту того же цвета или достоинства. Подсвеченные карты подходят.",
      "Не хочешь или не можешь ходить — возьми одну карту. Можно сразу сыграть только что взятую подходящую карту или передать ход.",
      "Нажми карту, смахни её вверх или перетащи на стол. Большая рука разделена на страницы: все карты остаются доступны.",
    ],
  },
  {
    title: "Одна карта? Свинтус!",
    badge: "Успей раньше",
    icon: "spark" as const,
    paragraphs: [
      "После предпоследней карты нажми «Свинтус!». Кнопка — беззвучный жест, разрешённый при «Тихохрюне».",
      "Соперник может нажать «Поймать!» до следующего хода. Если он успел раньше, ты получишь 3 карты. Побеждает первое принятое сервером действие.",
      "Есть точная копия верхней карты? Сыграй её вне очереди: следующий ход продолжится от тебя.",
    ],
  },
  {
    title: "Подложи свинью",
    badge: "Карты предписаний",
    icon: "arrow" as const,
    paragraphs: [
      "Хапёж: следующий берёт 3 карты и пропускает ход. Можно перевести Хапёж таким же Хапежом любого цвета; штрафы складываются.",
      "Захрапин: следующий пропускает ход. Тоже переводится таким же Захрапином любого цвета.",
      "Полисвин: играй на любую карту и выбирай следующий цвет. Можно сыграть, даже если подходят другие карты.",
    ],
  },
  {
    title: "Тс-с-с. Или хлоп!",
    badge: "Все участвуют",
    icon: "hand" as const,
    paragraphs: [
      "Тихохрюн: все молчат до следующей карты его автора. Сообщение в чате или кнопка нарушения тишины снимает запрет и даёт 2 карты.",
      "Хлопкопыт: все нажимают «Хлоп!». Игра ждёт всех участников. Последний получает 2 карты.",
      "Боты играют по тем же правилам, не видят чужих рук и реагируют самостоятельно. Тишину в вашем созвоне контролируйте сами.",
    ],
  },
  {
    title: "Играем в своём темпе",
    badge: "Ходы и штрафы",
    icon: "refresh" as const,
    paragraphs: [
      "Ограничения времени нет. За неправильный ход — 2 карты и пропуск хода. Неправильно сыгранная карта остаётся у тебя.",
      "Накопленный Хапёж всё равно нужно принять. Кнопки помогают избежать неверного хода, а сервер проверяет каждое действие.",
      "Колода закончилась? Стопка перемешается заново, кроме верхней карты. Игра продолжается до первой пустой руки.",
    ],
  },
];

function Rules({ onClose }: { onClose: () => void }) {
  const [page, setPage] = useState(0);
  const rule = rulePages[page];
  return (
    <Dialog title="Правила Свинтуса" onClose={onClose} className="rules-dialog">
      <div className="dialog-heading">
        <span className="eyebrow">{rule.badge}</span>
        <h2>{rule.title}</h2>
      </div>
      <div className="rule-content" aria-live="polite">
        <span className="rule-illustration">
          <Icon name={rule.icon} size={40} />
        </span>
        {rule.paragraphs.map((text, i) => (
          <p key={`${page}-${i}`}>
            <span>0{i + 1}</span>
            {text}
          </p>
        ))}
      </div>
      <div className="pagination rule-pagination">
        <button
          className="icon-button"
          disabled={page === 0}
          onClick={() => setPage(page - 1)}
          aria-label="Предыдущее правило"
        >
          <Icon name="back" />
        </button>
        <span>
          {page + 1} / {rulePages.length}
        </span>
        <button
          className="icon-button"
          disabled={page === rulePages.length - 1}
          onClick={() => setPage(page + 1)}
          aria-label="Следующее правило"
        >
          <Icon name="arrow" />
        </button>
      </div>
    </Dialog>
  );
}

function Avatar({
  player,
  index,
  small = false,
}: {
  player: Player;
  index: number;
  small?: boolean;
}) {
  return (
    <span
      className={`avatar avatar-${index % 6} ${small ? "avatar-small" : ""}`}
      aria-hidden="true"
    >
      {player.name.trim().slice(0, 1).toUpperCase()}
    </span>
  );
}

function BotTag({ player }: { player: Player }) {
  return player.isBot ? (
    <span className="bot-tag" title="Бот — играет автоматически">
      БОТ
    </span>
  ) : null;
}

function CardPicture({
  card,
  className = "",
}: {
  card: Card;
  className?: string;
}) {
  return (
    <img
      className={`card-picture ${className}`}
      src={cardImage(card)}
      alt={cardLabel(card)}
      draggable={false}
    />
  );
}

export default function Home() {
  const [hydrated, setHydrated] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [game, setGame] = useState<Game | null>(null);
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [view, setView] = useState<"home" | "create" | "find">("home");
  const [findMode, setFindMode] = useState<"public" | "code">("public");
  const [isPublic, setIsPublic] = useState(true);
  const [rooms, setRooms] = useState<PublicRoom[]>([]);
  const [roomsLoading, setRoomsLoading] = useState(false);
  const [roomsError, setRoomsError] = useState("");
  const [roomsPage, setRoomsPage] = useState(0);
  const [chatPage, setChatPage] = useState(0);
  const [chatAnchor, setChatAnchor] = useState<string | null>(null);
  const [chatTab, setChatTab] = useState<"chat" | "log">("chat");
  const [viewportHeight, setViewportHeight] = useState(844);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [mode, setMode] = useState<"create" | "join">("create");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [rulesOpen, setRulesOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [playerInfoId, setPlayerInfoId] = useState<string | null>(null);
  const [chatText, setChatText] = useState("");
  const [wild, setWild] = useState<Card | null>(null);
  const [connected, setConnected] = useState(false);
  const polling = useRef(false);
  const acting = useRef(false);
  const revision = useRef(0);
  const pendingJoinTokens = useRef<Record<string, string>>({});
  const gameRef = useRef<Game | null>(null);
  const dropTargetRef = useRef<HTMLDivElement>(null);
  const roomsFetching = useRef(false);
  const viewportBaseline = useRef({ width: 0, height: 0 });
  const wildPhase = useRef("");

  useEffect(() => {
    setHydrated(true);
    try {
      setName(localStorage.getItem("svintus:name") || "");
      const room = normalizeCode(
        new URLSearchParams(window.location.search).get("room") || "",
      );
      if (!room) return;
      setCode(room);
      setMode("join");
      setView("find");
      setFindMode("code");
      const stored = localStorage.getItem(sessionKey(room));
      if (stored) {
        const saved = JSON.parse(stored) as Session;
        if (saved.code === room && saved.token && saved.playerId)
          setSession(saved);
      }
    } catch {
      /* Storage is optional; the current tab still works. */
    }
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 3500);
    return () => window.clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    gameRef.current = game;
  }, [game]);
  useEffect(() => {
    if (game?.clap) {
      setRulesOpen(false);
      setChatOpen(false);
      setPlayerInfoId(null);
      setWild(null);
    }
  }, [game?.clap?.id]);
  useEffect(() => {
    if (game?.status !== "playing") setPlayerInfoId(null);
  }, [game?.status]);
  useEffect(() => {
    const updateViewport = () => {
      const height = window.visualViewport?.height ?? window.innerHeight;
      document.documentElement.style.setProperty("--app-height", `${height}px`);
      const baseline = viewportBaseline.current;
      if (baseline.width !== window.innerWidth) {
        baseline.width = window.innerWidth;
        baseline.height = window.innerHeight;
      }
      baseline.height = Math.max(baseline.height, window.innerHeight, height);
      setViewportHeight(height);
      setKeyboardOpen(height < baseline.height * 0.76);
      window.scrollTo(0, 0);
    };
    updateViewport();
    window.visualViewport?.addEventListener("resize", updateViewport);
    window.visualViewport?.addEventListener("scroll", updateViewport);
    window.addEventListener("resize", updateViewport);
    return () => {
      window.visualViewport?.removeEventListener("resize", updateViewport);
      window.visualViewport?.removeEventListener("scroll", updateViewport);
      window.removeEventListener("resize", updateViewport);
    };
  }, []);

  const loadRooms = useCallback(async () => {
    if (roomsFetching.current) return;
    roomsFetching.current = true;
    setRoomsLoading(true);
    setRoomsError("");
    try {
      const response = await fetch("/api/rooms", { cache: "no-store" });
      const result = (await response.json()) as {
        rooms?: PublicRoom[];
        error?: string;
      };
      if (!response.ok || !result.rooms)
        throw new Error(result.error || "Не удалось найти открытые столы.");
      setRooms(result.rooms);
    } catch (caught) {
      setRoomsError(
        caught instanceof Error ? caught.message : "Нет связи с сервером.",
      );
    } finally {
      roomsFetching.current = false;
      setRoomsLoading(false);
    }
  }, []);
  useEffect(() => {
    if (view !== "find" || findMode !== "public" || session) return;
    void loadRooms();
    const timer = window.setInterval(() => void loadRooms(), 10000);
    return () => window.clearInterval(timer);
  }, [view, findMode, session, loadRooms]);
  useEffect(() => {
    setChatPage(0);
    setChatAnchor(null);
  }, [chatTab, chatOpen]);
  useEffect(() => {
    if (!wild) return;
    if (
      !game ||
      game.status !== "playing" ||
      !game.hand.some((card) => card.id === wild.id) ||
      gamePhase(game) !== wildPhase.current
    )
      setWild(null);
  }, [game, wild]);
  useEffect(() => {
    if (!chatAnchor) return;
    const entries = chatTab === "chat" ? game?.chat || [] : game?.log || [];
    if (!entries.some((entry) => entry.id === chatAnchor))
      setChatAnchor(entries[Math.min(2, entries.length - 1)]?.id || null);
  }, [game?.chat, game?.log, chatAnchor, chatTab]);

  useEffect(() => {
    if (!session) return;
    let active = true;
    const controller = new AbortController();
    const poll = async () => {
      if (polling.current || acting.current) return;
      polling.current = true;
      const currentRevision = revision.current;
      try {
        const response = await fetch(`/api/rooms/${session.code}`, {
          headers: { Authorization: `Bearer ${session.token}` },
          cache: "no-store",
          signal: controller.signal,
        });
        const result = (await response.json()) as ApiResult;
        if (!response.ok || !result.game)
          throw new Error(result.error || "Не удалось обновить стол.");
        if (active && currentRevision === revision.current) {
          setGame({ ...result.game, meId: session.playerId });
          setConnected(true);
        }
      } catch (caught) {
        if (
          active &&
          !(caught instanceof DOMException && caught.name === "AbortError")
        ) {
          setConnected(false);
          if (!gameRef.current)
            setError(
              caught instanceof Error
                ? caught.message
                : "Соединение прервалось. Повторяем попытку…",
            );
        }
      } finally {
        polling.current = false;
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 900);
    return () => {
      active = false;
      controller.abort();
      window.clearInterval(timer);
    };
    // A single polling loop per authenticated session; its responses update the game.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  const getJoinToken = (roomCode: string) => {
    let token = pendingJoinTokens.current[roomCode];
    if (!token) {
      try {
        const saved = localStorage.getItem(pendingJoinKey(roomCode));
        if (saved && /^[A-Za-z0-9_-]{43}$/.test(saved)) token = saved;
      } catch {
        /* The ref retains the token when storage is unavailable. */
      }
    }
    if (!token) {
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      token = btoa(String.fromCharCode(...bytes))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
    }
    pendingJoinTokens.current[roomCode] = token;
    try {
      localStorage.setItem(pendingJoinKey(roomCode), token);
    } catch {
      /* Current-tab retries still reuse it. */
    }
    return token;
  };

  const adoptSession = (result: ApiResult) => {
    if (!result.code || !result.token || !result.playerId || !result.game)
      throw new Error("Сервер не вернул данные комнаты.");
    const saved = {
      code: result.code,
      token: result.token,
      playerId: result.playerId,
    };
    try {
      localStorage.setItem(sessionKey(saved.code), JSON.stringify(saved));
      localStorage.setItem("svintus:name", name.trim());
    } catch {
      /* optional storage */
    }
    delete pendingJoinTokens.current[saved.code];
    try {
      localStorage.removeItem(pendingJoinKey(saved.code));
    } catch {
      /* optional storage */
    }
    window.history.replaceState(null, "", `?room=${saved.code}`);
    setSession(saved);
    setGame({ ...result.game, meId: saved.playerId });
    setConnected(true);
    setCode(saved.code);
  };

  const connectRoom = async (requestedCode?: string) => {
    if (acting.current) return;
    const targetCode = requestedCode || code;
    if (!name.trim()) {
      setError("Как тебя называть за столом?");
      document.getElementById("player-name")?.focus();
      return;
    }
    if (mode === "join" && targetCode.length !== 6) {
      setError("Введи код комнаты из 6 символов.");
      return;
    }
    if (mode === "join") {
      try {
        const stored = localStorage.getItem(sessionKey(targetCode));
        if (stored) {
          const saved = JSON.parse(stored) as Session;
          if (saved.token && saved.playerId) {
            setSession(saved);
            window.history.replaceState(null, "", `?room=${targetCode}`);
            setError("");
            return;
          }
        }
      } catch {
        /* proceed to join */
      }
    }
    acting.current = true;
    setBusy("room");
    setError("");
    try {
      const body =
        mode === "create"
          ? { name: name.trim(), isPublic }
          : { name: name.trim(), joinToken: getJoinToken(targetCode) };
      const response = await fetch(
        mode === "create" ? "/api/rooms" : `/api/rooms/${targetCode}/join`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      const result = (await response.json()) as ApiResult;
      if (!response.ok)
        throw new Error(
          result.error || "Не получилось войти в комнату. Попробуй ещё раз.",
        );
      adoptSession(result);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Сервер недоступен. Попробуй ещё раз.",
      );
    } finally {
      acting.current = false;
      setBusy(null);
    }
  };
  const submitRoom = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void connectRoom();
  };

  const act = useCallback(
    async (action: Action) => {
      if (!session || acting.current) return false;
      acting.current = true;
      revision.current += 1;
      const actionRevision = revision.current;
      setBusy(action.type);
      setError("");
      try {
        const response = await fetch(`/api/rooms/${session.code}/action`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${session.token}`,
            "X-Action-Id": crypto.randomUUID(),
          },
          body: JSON.stringify(action),
        });
        const result = (await response.json()) as ApiResult;
        if (actionRevision !== revision.current) return false;
        if (result.game) setGame({ ...result.game, meId: session.playerId });
        if (!response.ok || !result.game)
          throw new Error(
            result.error || "Действие не удалось. Попробуй ещё раз.",
          );
        setConnected(true);
        return true;
      } catch (caught) {
        setError(
          caught instanceof Error
            ? caught.message
            : "Соединение прервалось. Повторяем подключение…",
        );
        return false;
      } finally {
        acting.current = false;
        setBusy(null);
      }
    },
    [session],
  );

  const playCard = async (card: Card, color?: Color) => {
    if (card.kind === "wild" && !color) {
      wildPhase.current = gamePhase(game);
      setWild(card);
      return;
    }
    setWild(null);
    await act({ type: "play", cardId: card.id, ...(color ? { color } : {}) });
  };

  const copyInvite = async () => {
    if (!session) return;
    const link = `${window.location.origin}/?room=${session.code}`;
    try {
      await navigator.clipboard.writeText(link);
      setNotice("Приглашение скопировано. Отправь его друзьям!");
    } catch {
      setNotice(`Приглашение: ${link}`);
    }
  };

  const home = () => {
    revision.current += 1;
    setSession(null);
    setGame(null);
    setError("");
    setConnected(false);
    setWild(null);
    setChatOpen(false);
    setPlayerInfoId(null);
    setView("home");
    window.history.replaceState(null, "", window.location.pathname);
  };
  const isTurn =
    !!game &&
    !game.colorChoicePlayerId &&
    game.players[game.turnIndex]?.id === game.meId;
  const isHost = !!game && game.hostId === game.meId;
  const currentPlayer = game?.players[game.turnIndex];
  const actingPlayerId = game?.clap ? null : game?.colorChoicePlayerId ?? currentPlayer?.id;
  const clapResponded = !!game?.clap?.responded.includes(game.meId);
  const me = game?.players.find((player) => player.id === game.meId);
  const inspectedPlayer = game?.players.find(
    (player) => player.id === playerInfoId,
  );
  const roundWinner = game?.players.find(
    (player) => player.id === game.roundWinnerId,
  );
  const roomActive = !!session && !!game;

  const screen =
    session && !game ? "restoring" : roomActive ? game!.status : view;
  const roomsPerPage = viewportHeight < 650 ? 2 : 3;
  const roomPageCount = Math.max(1, Math.ceil(rooms.length / roomsPerPage));
  const roomPage = Math.min(roomsPage, roomPageCount - 1);
  // One full message per page keeps every 200-character message readable,
  // including when the on-screen keyboard reduces the available height.
  const chatPerPage = 1;
  const chatEntries = chatTab === "chat" ? game?.chat || [] : game?.log || [];
  const chatPageCount = Math.max(
    1,
    Math.ceil(chatEntries.length / chatPerPage),
  );
  const chatAnchorIndex = chatAnchor
    ? chatEntries.findIndex((entry) => entry.id === chatAnchor)
    : -1;
  const chatEnd =
    chatAnchorIndex >= 0
      ? chatAnchorIndex + 1
      : chatEntries.length -
        Math.min(chatPage, chatPageCount - 1) * chatPerPage;
  const safeChatPage = Math.max(
    0,
    Math.ceil((chatEntries.length - chatEnd) / chatPerPage),
  );
  const shownChat = chatEntries.slice(
    Math.max(0, chatEnd - chatPerPage),
    chatEnd,
  );
  const openCreate = () => {
    setView("create");
    setMode("create");
    setError("");
  };
  const openFind = () => {
    setView("find");
    setMode("join");
    setError("");
  };
  const back = () => {
    if (!busy) home();
  };

  return (
    <main
      className={`app ${roomActive ? "game-app" : "menu-app"} ${keyboardOpen ? "keyboard-open" : ""}`}
      data-screen={screen}
    >
      <div className="app-shell">
        <header className="site-header">
          {view === "home" && !session ? (
            <>
              <span className="brand">
                <Pig />
                <b>
                  свинтус<span>.</span>
                </b>
                <small>ОНЛАЙН</small>
              </span>
              <button
                className="icon-button"
                onClick={() => setRulesOpen(true)}
                aria-label="Правила игры"
              >
                <Icon name="book" />
              </button>
            </>
          ) : (
            <>
              <button
                className="icon-button"
                onClick={back}
                disabled={!!busy}
                aria-label="Назад"
              >
                <Icon name="back" />
              </button>
              <h1>
                {roomActive ? (
                  <button
                    className="header-game-brand"
                    onClick={copyInvite}
                    aria-label={`Скопировать приглашение в комнату ${session!.code}`}
                  >
                    <Pig />
                    свинтус<span>.</span>
                  </button>
                ) : session ? (
                  "Возвращаем за стол"
                ) : view === "create" ? (
                  "Создать игру"
                ) : (
                  "Найти игру"
                )}
              </h1>
              <div className="header-tools">
                {game?.status === "playing" && (
                  <button
                    className="icon-button"
                    onClick={() => {
                      setChatTab("chat");
                      setChatOpen(true);
                    }}
                    aria-label="Чат стола"
                  >
                    <Icon name="chat" />
                  </button>
                )}
                <button
                  className="icon-button"
                  onClick={roomActive ? () => setRulesOpen(true) : back}
                  disabled={!!busy}
                  aria-label={roomActive ? "Правила игры" : "Закрыть"}
                >
                  <Icon name={roomActive ? "book" : "close"} />
                </button>
              </div>
            </>
          )}
        </header>

        {!session && view === "home" && (
          <section className="home-screen" data-testid="home-screen">
            <div className="home-art" aria-hidden="true">
              <div className="home-orbit" />
              <span className="home-spark spark-one">✳</span>
              <span className="home-spark spark-two">✳</span>
              <img
                className="home-card home-card-left"
                src="/cards/red-7.jpg"
                alt=""
              />
              <img
                className="home-card home-card-right"
                src="/cards/green-clap.jpg"
                alt=""
              />
              <div className="home-pig">
                <img
                  src="/art/lemonade-pig.webp"
                  alt=""
                  width="640"
                  height="640"
                  fetchPriority="high"
                />
              </div>
              <span className="home-card-dot" />
            </div>
            <div className="home-heading">
              <span className="eyebrow">Подложи свинью товарищу</span>
              <h1>
                СВИНТУС<span>Друзья, карты и немного свинства.</span>
              </h1>
            </div>
            <div className="home-actions">
              <button
                className="home-action home-action-find"
                onClick={openFind}
              >
                <span className="home-action-icon">
                  <Icon name="people" size={25} />
                </span>
                <span>
                  <b>Найти игру</b>
                  <small>Присоединиться к существующему столу</small>
                </span>
                <Icon name="arrow" />
              </button>
              <button
                className="home-action home-action-create"
                onClick={openCreate}
              >
                <span className="home-action-icon">
                  <Icon name="spark" size={25} />
                </span>
                <span>
                  <b>Создать игру</b>
                  <small>Настроить и пригласить игроков</small>
                </span>
                <Icon name="arrow" />
              </button>
            </div>
            <div className="home-footer">
              <span>2–6 участников</span>
              <i />
              <span>Друзья и боты</span>
              <button onClick={() => setRulesOpen(true)}>Как играть?</button>
            </div>
          </section>
        )}

        {!session && view === "create" && (
          <section
            className="form-screen create-screen"
            data-testid="create-screen"
          >
            <form onSubmit={submitRoom} className="create-form">
              <div className="form-panel">
                <div className="name-field">
                  <label htmlFor="player-name">Твоё имя</label>
                  <input
                    id="player-name"
                    disabled={!hydrated || !!busy}
                    autoComplete="nickname"
                    maxLength={24}
                    placeholder="Например, Хрюша"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    required
                  />
                </div>
                <div className="game-preview">
                  <div className="preview-cards" aria-hidden="true">
                    <img src="/cards/orange-3.jpg" alt="" />
                    <img src="/cards/green-clap.jpg" alt="" />
                  </div>
                  <div>
                    <strong>Классический Свинтус</strong>
                    <span>104 карты · без «Перехрюка»</span>
                    <small>2–6 участников. Можно одному с ботом.</small>
                  </div>
                </div>
                <div className="form-settings">
                  <fieldset>
                    <legend>Доступ к столу</legend>
                    <div className="segmented">
                      <button
                        type="button"
                        className={isPublic ? "selected" : ""}
                        aria-pressed={isPublic}
                        onClick={() => setIsPublic(true)}
                        disabled={!!busy}
                      >
                        Открытая
                      </button>
                      <button
                        type="button"
                        className={!isPublic ? "selected" : ""}
                        aria-pressed={!isPublic}
                        onClick={() => setIsPublic(false)}
                        disabled={!!busy}
                      >
                        По коду
                      </button>
                    </div>
                    <p className="setting-note">
                      {isPublic
                        ? "Стол появится в поиске. Друзей можно позвать по ссылке."
                        : "Стол виден только тем, у кого есть ссылка или код."}
                    </p>
                  </fieldset>
                </div>
              </div>
              <div className="form-bottom">
                <button
                  className="button button-orange"
                  disabled={!hydrated || !!busy}
                >
                  {busy === "room" ? (
                    <span className="spinner" />
                  ) : (
                    <Icon name="spark" />
                  )}
                  Создать комнату
                  <Icon name="arrow" />
                </button>
                <p>Без регистрации. Ботов добавишь перед раздачей.</p>
              </div>
            </form>
          </section>
        )}

        {!session && view === "find" && (
          <section className="find-screen" data-testid="find-screen">
            <div className="name-field">
              <label htmlFor="player-name">Твоё имя</label>
              <input
                id="player-name"
                disabled={!hydrated || !!busy}
                autoComplete="nickname"
                maxLength={24}
                placeholder="Как тебя называть?"
                enterKeyHint="done"
                value={name}
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    event.currentTarget.blur();
                  }
                }}
                required
              />
            </div>
            <div
              className="segmented find-tabs"
              role="tablist"
              aria-label="Способ входа"
            >
              <button
                role="tab"
                aria-selected={findMode === "public"}
                className={findMode === "public" ? "selected" : ""}
                onClick={() => {
                  setFindMode("public");
                  setError("");
                }}
              >
                Открытые столы
              </button>
              <button
                role="tab"
                aria-selected={findMode === "code"}
                className={findMode === "code" ? "selected" : ""}
                onClick={() => {
                  setFindMode("code");
                  setError("");
                }}
              >
                По коду
              </button>
            </div>
            {findMode === "code" ? (
              <form className="join-code-form" onSubmit={submitRoom}>
                <div className="join-illustration" aria-hidden="true">
                  <Pig />
                  <span>У своих — свой код.</span>
                </div>
                <div className="code-field">
                  <label htmlFor="room-code">Код комнаты</label>
                  <input
                    id="room-code"
                    className="code-input"
                    disabled={!hydrated || !!busy}
                    autoCapitalize="characters"
                    autoComplete="off"
                    spellCheck={false}
                    maxLength={6}
                    placeholder="ABC123"
                    value={code}
                    onChange={(event) =>
                      setCode(normalizeCode(event.target.value))
                    }
                    required
                  />
                  <p>Шесть символов из приглашения друга.</p>
                </div>
                <button
                  className="button button-orange"
                  disabled={!hydrated || !!busy}
                >
                  {busy === "room" ? (
                    <span className="spinner" />
                  ) : (
                    <Icon name="arrow" />
                  )}
                  Войти по коду
                </button>
              </form>
            ) : (
              <>
                <div className="room-list" aria-live="polite">
                  {roomsLoading && !rooms.length ? (
                    <div className="empty-state">
                      <span className="spinner" />
                      <h2>Ищем компанию…</h2>
                    </div>
                  ) : roomsError ? (
                    <div className="empty-state">
                      <Icon name="refresh" size={34} />
                      <h2>Не получилось найти столы</h2>
                      <p>{roomsError}</p>
                      <button
                        className="button button-outline"
                        onClick={() => void loadRooms()}
                      >
                        Повторить
                      </button>
                    </div>
                  ) : rooms.length ? (
                    rooms
                      .slice(
                        roomPage * roomsPerPage,
                        (roomPage + 1) * roomsPerPage,
                      )
                      .map((room) => (
                        <button
                          className="public-room-card"
                          key={room.code}
                          onClick={() => {
                            setCode(room.code);
                            void connectRoom(room.code);
                          }}
                          disabled={!!busy}
                          aria-label={`Войти в комнату ${room.code}`}
                        >
                          <span className="room-host-avatar">
                            {room.hostName.slice(0, 1).toUpperCase()}
                          </span>
                          <span className="room-card-copy">
                            <strong>Стол {room.hostName}</strong>
                            <span>
                              {room.playerCount} / 6 участников
                              {room.botCount > 0
                                ? ` · ${room.botCount} бот`
                                : ""}
                            </span>
                            <small>{room.code}</small>
                          </span>
                          <span className="room-join-arrow">
                            <Icon name="arrow" />
                          </span>
                        </button>
                      ))
                  ) : (
                    <div className="empty-state">
                      <Pig />
                      <h2>Пока никто не хрюкает.</h2>
                      <p>
                        Создай стол и позови компанию.
                        <br />
                        Или начни игру с ботом.
                      </p>
                    </div>
                  )}
                </div>
                <div className="pagination rooms-pagination">
                  <button
                    className="icon-button"
                    disabled={roomPage === 0}
                    onClick={() => setRoomsPage(roomPage - 1)}
                    aria-label="Предыдущие комнаты"
                  >
                    <Icon name="back" />
                  </button>
                  <span>
                    {rooms.length
                      ? `${roomPage + 1} / ${roomPageCount}`
                      : "Открытые комнаты"}
                  </span>
                  <button
                    className="icon-button"
                    disabled={roomPage === roomPageCount - 1}
                    onClick={() => setRoomsPage(roomPage + 1)}
                    aria-label="Следующие комнаты"
                  >
                    <Icon name="arrow" />
                  </button>
                </div>
                <div className="find-bottom">
                  <button
                    className="button button-outline"
                    onClick={() => void loadRooms()}
                    disabled={roomsLoading}
                  >
                    {roomsLoading ? (
                      <span className="spinner" />
                    ) : (
                      <Icon name="refresh" />
                    )}
                    Обновить
                  </button>
                  <button className="button button-orange" onClick={openCreate}>
                    <Icon name="spark" />
                    Создать игру
                  </button>
                </div>
              </>
            )}
          </section>
        )}

        {session && !game && (
          <section className="restoring-screen" role="status">
            <span className="spinner" />
            <h2>Возвращаем за стол…</h2>
            <p>{error || "Твоё место сохранено."}</p>
            <button className="button button-outline" onClick={home}>
              На главную
            </button>
          </section>
        )}

        {roomActive && game && session && (
          <>
            <div className="room-toolbar">
              <button
                className="room-code"
                onClick={copyInvite}
                aria-label={`Скопировать приглашение в комнату ${session.code}`}
              >
                <span>КОМНАТА</span>
                {session.code}
                <Icon name="copy" size={16} />
              </button>
              <span className={`connection ${connected ? "is-connected" : ""}`}>
                <i />
                {connected ? "За столом" : "Нет связи…"}
              </span>
              {game.status !== "lobby" && (
                <span className="round-label">Раунд {game.round}</span>
              )}
            </div>
            {game.status === "lobby" ? (
              <section className="lobby" data-testid="lobby-screen">
                <div className="lobby-intro">
                  <h2>Все свои за столом</h2>
                  <p>
                    <b>{game.players.length} / 6</b> участников ·{" "}
                    {game.players.length >= 2
                      ? "Можно начинать!"
                      : "Позови друга или добавь бота"}
                  </p>
                  <button
                    className="button button-outline invite-button"
                    onClick={copyInvite}
                  >
                    <Icon name="copy" size={17} />
                    Пригласить друзей
                  </button>
                </div>
                <div className="lobby-seats">
                  {Array.from({ length: 6 }, (_, index) => {
                    const player = game.players[index];
                    return (
                      <div
                        key={player?.id || index}
                        className={`lobby-seat ${player ? "occupied" : "empty"} ${player?.isBot ? "bot-seat" : ""}`}
                        aria-label={
                          player
                            ? `${player.name}${player.isBot ? ", бот" : ""}`
                            : `Свободное место ${index + 1}`
                        }
                      >
                        {player ? (
                          <>
                            <Avatar player={player} index={index} />
                            <div className="seat-copy">
                              <strong title={player.name}>
                                {player.isBot
                                  ? player.name.replace(/\s*\(бот\)$/i, "")
                                  : player.name}
                              </strong>
                              <span>
                                {player.isBot ? (
                                  <BotTag player={player} />
                                ) : player.id === game.meId ? (
                                  "Это ты"
                                ) : player.id === game.hostId ? (
                                  "Хозяин"
                                ) : (
                                  "Готов"
                                )}
                              </span>
                            </div>
                            {player.isBot && isHost ? (
                              <button
                                className="icon-button remove-bot-button"
                                disabled={!!busy}
                                onClick={() =>
                                  void act({
                                    type: "remove_bot",
                                    targetId: player.id,
                                  })
                                }
                                aria-label={`Удалить бота ${player.name}`}
                              >
                                <Icon name="close" size={17} />
                              </button>
                            ) : (
                              <span className="seat-check">
                                <Icon name="check" size={16} />
                              </span>
                            )}
                          </>
                        ) : (
                          <>
                            <span className="empty-avatar">{index + 1}</span>
                            <div className="seat-copy">
                              <strong>Свободно</strong>
                              <span>Для друга или бота</span>
                            </div>
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
                <div className="lobby-start">
                  {isHost ? (
                    <>
                      <div className="lobby-controls">
                        <button
                          className="button button-outline add-bot-button"
                          disabled={game.players.length >= 6 || !!busy}
                          onClick={() => void act({ type: "add_bot" })}
                        >
                          {busy === "add_bot" ? (
                            <span className="spinner" />
                          ) : (
                            <Icon name="people" />
                          )}
                          Добавить бота
                        </button>
                        <button
                          className="button button-orange"
                          disabled={game.players.length < 2 || !!busy}
                          onClick={() => void act({ type: "start" })}
                        >
                          {busy === "start" ? (
                            <span className="spinner" />
                          ) : (
                            <Icon name="spark" />
                          )}
                          Раздать карты!
                        </button>
                      </div>
                      <p>
                        {game.players.length < 2
                          ? "Для старта нужны минимум два участника."
                          : "Начинаем, когда компания готова. До 6 участников."}
                      </p>
                    </>
                  ) : (
                    <p className="waiting-host">
                      Хозяин скоро раздаст карты.
                      <br />
                      Пока можно открыть правила.
                    </p>
                  )}
                </div>
              </section>
            ) : game.status === "round_end" || game.status === "finished" ? (
              <section className="scoreboard" data-testid="results-screen">
                <div className="scoreboard-heading">
                  <span className="winner-star">✳</span>
                  <span className="eyebrow">Раунд завершён</span>
                  <h2>
                    {roundWinner?.name}
                    <span>выигрывает раунд!</span>
                  </h2>
                  <p>Одна оставшаяся карта — одно штрафное очко.</p>
                </div>
                <div className="scoreboard-list">
                  {[...game.players]
                    .sort((a, b) =>
                      a.id === game.roundWinnerId
                        ? -1
                        : b.id === game.roundWinnerId
                          ? 1
                          : a.score - b.score,
                    )
                    .map((player, index) => (
                      <div
                        key={player.id}
                        className={`score-row ${player.id === game.roundWinnerId ? "score-leader" : ""} ${game.svintusIds.includes(player.id) ? "score-svintus" : ""}`}
                      >
                        <span className="score-rank">{index + 1}</span>
                        <Avatar
                          player={player}
                          index={game.players.findIndex(
                            (p) => p.id === player.id,
                          )}
                          small
                        />
                        <div>
                          <strong title={player.name}>
                            {player.name}
                            <BotTag player={player} />
                          </strong>
                          <span>
                            {player.id === game.roundWinnerId
                              ? "Победитель"
                              : game.svintusIds.includes(player.id)
                                ? "Свинтус раунда!"
                                : player.id === game.meId
                                  ? "Это ты"
                                  : ""}
                          </span>
                        </div>
                        <span className="score-points">
                          {player.score}
                          <small> очков</small>
                        </span>
                      </div>
                    ))}
                </div>
                <p className="svintus-explanation">
                  {game.svintusIds.length > 1
                    ? "Свинтусы раунда отмечены в таблице."
                    : `Свинтус: ${game.players.find((player) => game.svintusIds.includes(player.id))?.name || "—"}`}
                </p>
                {isHost ? (
                  <button
                    className="button button-orange"
                    disabled={!!busy}
                    onClick={() => void act({ type: "next_round" })}
                  >
                    Ещё раунд? Раздаём!
                    <Icon name="arrow" />
                  </button>
                ) : (
                  <p className="waiting-host">
                    Ждём следующую раздачу от хозяина.
                  </p>
                )}
              </section>
            ) : (
              <section className="play-area" data-testid="game-screen">
                <div
                  className="opponents"
                  style={
                    {
                      "--opponent-count": Math.max(1, game.players.length - 1),
                    } as React.CSSProperties
                  }
                >
                  {game.players
                    .filter((player) => player.id !== game.meId)
                    .map((player) => {
                      const index = game.players.findIndex(
                        (p) => p.id === player.id,
                      );
                      return (
                        <div
                          key={player.id}
                          className={`opponent ${actingPlayerId === player.id ? "opponent-active" : ""}`}
                          data-current-player={actingPlayerId === player.id ? "true" : "false"}
                        >
                          <button
                            className="opponent-info"
                            aria-label={`Об игроке ${player.name}${actingPlayerId === player.id ? ", сейчас ходит" : ""}`}
                            onClick={() => setPlayerInfoId(player.id)}
                          />
                          <Avatar player={player} index={index} small />
                          <strong title={player.name}>
                            {player.isBot
                              ? player.name.replace(/\s*\(бот\)$/i, "")
                              : player.name}
                          </strong>
                          <div className="opponent-cards">
                            <span className="mini-card-back" />
                            <b>{player.cardCount}</b>
                            <BotTag player={player} />
                          </div>
                          {game.catchablePlayerId === player.id && (
                            <button
                              className="catch-button"
                              disabled={!!busy}
                              onClick={() =>
                                void act({ type: "catch", targetId: player.id })
                              }
                              aria-label={`Поймать ${player.name}`}
                              title="Не объявил Свинтус!"
                            >
                              Поймать!
                            </button>
                          )}
                        </div>
                      );
                    })}
                </div>
                <div
                  ref={dropTargetRef}
                  className={`game-table ${isTurn ? "my-turn-table" : ""}`}
                  data-testid="card-drop-target"
                >
                  <span className="table-brand" aria-hidden="true">
                    СВИНТУС
                  </span>
                  <div className="table-status" role="status">
                    <span>
                      {game.colorChoicePlayerId
                        ? "Раздающий выбирает цвет"
                        : isTurn
                          ? "Твой ход!"
                          : `Ходит ${currentPlayer?.name || "игрок"}`}
                    </span>
                  </div>
                  <div className="table-cards">
                    <div className="deck-wrap">
                      <button
                        className="card-back deck-button"
                        onClick={() => void act({ type: "draw" })}
                        disabled={
                          !isTurn ||
                          !!game.pending ||
                          !!game.drawnCardId ||
                          !!game.clap ||
                          !!busy
                        }
                        aria-label={`Взять карту из колоды. Осталось ${game.drawPileCount}`}
                      >
                        <Pig />
                        <span>СВИНТУС</span>
                      </button>
                      <span className="deck-caption">
                        Колода · {game.drawPileCount}
                      </span>
                    </div>
                    <div className="discard-wrap">
                      {game.topCard && (
                        <CardPicture
                          key={game.topCard.id}
                          card={game.topCard}
                        />
                      )}
                      <span className="discard-caption">
                        {game.topCard?.kind === "number"
                          ? `Верхняя · ${game.topCard.value}`
                          : game.topCard
                            ? cardNames[game.topCard.kind]
                            : "Стопка"}
                      </span>
                    </div>
                  </div>
                  {game.activeColor && (
                    <div className="active-color">
                      <span className={`color-dot color-${game.activeColor}`} />
                      {colorNames[game.activeColor]}
                    </div>
                  )}
                  {game.pending && (
                    <span className="pending-badge">
                      {game.pending.kind === "draw3"
                        ? `Хапёж +${game.pending.amount}`
                        : "Захрапин"}
                    </span>
                  )}
                  {game.silenceOwnerId && (
                    <div className="silence-banner">
                      <span>
                        🤫 <b>Тихохрюн. Молчим!</b>
                      </span>
                      <button
                        disabled={!!busy}
                        onClick={() => void act({ type: "break_silence" })}
                        aria-label="Нарушить тишину и взять 2 карты"
                      >
                        Нарушить · +2
                      </button>
                    </div>
                  )}
                </div>
                <div className={`hand-toolbar ${actingPlayerId === game.meId ? "hand-toolbar-active" : ""}`}
                  data-current-player={actingPlayerId === game.meId ? "true" : "false"}>
                  <span>
                    <b>{me?.name}</b> · {game.hand.length} карт
                  </span>
                  <span className="hand-round">Раунд {game.round}</span>
                </div>
                <CardHand
                  game={game}
                  busy={
                    !!busy ||
                    !!wild ||
                    !!game.colorChoicePlayerId ||
                    rulesOpen ||
                    chatOpen ||
                    !!inspectedPlayer
                  }
                  onPlay={playCard}
                  dropTargetRef={dropTargetRef}
                />
                <div className="turn-actions">
                  {isTurn && game.pending ? (
                    <button
                      className="button button-cream"
                      disabled={!!busy || !!game.clap}
                      onClick={() => void act({ type: "accept_penalty" })}
                    >
                      {game.pending.kind === "draw3"
                        ? `Взять ${game.pending.amount} карт`
                        : "Пропустить ход"}
                      <Icon name="arrow" size={17} />
                    </button>
                  ) : isTurn && game.drawnCardId ? (
                    <button
                      className="button button-cream"
                      disabled={!!busy || !!game.clap}
                      onClick={() => void act({ type: "pass" })}
                    >
                      Передать ход
                      <Icon name="arrow" size={17} />
                    </button>
                  ) : (
                    <button
                      className="button button-outline"
                      disabled={!isTurn || !!busy || !!game.clap}
                      onClick={() => void act({ type: "draw" })}
                    >
                      Взять карту <b>+1</b>
                    </button>
                  )}
                  <button
                    className={`button declare-button ${game.catchablePlayerId === game.meId ? "declare-urgent" : ""}`}
                    disabled={
                      game.hand.length !== 1 ||
                      game.catchablePlayerId !== game.meId ||
                      !!busy
                    }
                    onClick={() => void act({ type: "declare" })}
                    title="Одна карта? Нажми раньше соперников!"
                  >
                    <Icon name="hand" size={18} />
                    Свинтус!
                  </button>
                </div>
                <button
                  className="game-log"
                  onClick={() => {
                    setChatTab("log");
                    setChatOpen(true);
                  }}
                  aria-label="История игры"
                >
                  <span className="log-dot" />
                  <span>
                    {game.log.at(-1)?.text ||
                      (isTurn
                        ? "Клади карту или возьми одну из колоды."
                        : "Точную копию верхней карты можно перехватить.")}
                  </span>
                  <Icon name="arrow" size={14} />
                </button>
              </section>
            )}
          </>
        )}
      </div>
      {error && (
        <div className="alert-toast" role="alert">
          <span>{error}</span>
          <button
            className="icon-button"
            onClick={() => setError("")}
            aria-label="Скрыть сообщение"
          >
            <Icon name="close" />
          </button>
        </div>
      )}
      {notice && (
        <div className="toast" role="status">
          <Icon name="check" size={18} />
          <span>{notice}</span>
        </div>
      )}
      {rulesOpen && <Rules onClose={() => setRulesOpen(false)} />}
      {inspectedPlayer && game?.status === "playing" && !game.clap && (
        <Dialog
          title="Участник игры"
          onClose={() => setPlayerInfoId(null)}
          className="player-dialog"
        >
          <div className="dialog-heading">
            <span className="eyebrow">
              {inspectedPlayer.isBot
                ? "Бот · играет автоматически"
                : "За твоим столом"}
            </span>
            <h2>{inspectedPlayer.name}</h2>
            <p>
              {inspectedPlayer.cardCount} карт ·{" "}
              {currentPlayer?.id === inspectedPlayer.id
                ? "Сейчас его ход"
                : "Ждёт своего хода"}
            </p>
          </div>
        </Dialog>
      )}
      {game && (wild || game.colorChoicePlayerId === game.meId) && (
        <Dialog
          title="Полисвин: выбери цвет"
          onClose={wild ? () => setWild(null) : undefined}
          className="color-dialog"
        >
          <div className="dialog-heading">
            <span className="eyebrow">Полисвин</span>
            <h2>Выбери цвет</h2>
            <p>
              {wild
                ? "Какой цвет придётся сыграть следующему?"
                : "Первый Полисвин: цвет выбирает раздающий."}
            </p>
          </div>
          <div className="color-options">
            {colors.map((color) => (
              <button
                key={color}
                className={`color-choice color-${color}`}
                disabled={!!busy}
                onClick={() =>
                  void (wild
                    ? playCard(wild, color)
                    : act({ type: "choose_color", color }))
                }
              >
                <span />
                {colorNames[color]}
                <Icon name="arrow" />
              </button>
            ))}
          </div>
        </Dialog>
      )}
      {game?.clap && game.status === "playing" && (
        <Dialog title="Хлопкопыт — нажми Хлоп!" className="clap-dialog">
          <div className="dialog-heading">
            <span className="eyebrow">Хлопкопыт!</span>
            <h2>{clapResponded ? "Успел!" : "Ладонь на стол!"}</h2>
            <p>
              {clapResponded
                ? "Последнему — две карты."
                : "Скорее! Последний получает 2 карты."}
            </p>
          </div>
          <button
            className={`clap-button ${clapResponded ? "clap-done" : ""}`}
            onClick={() => void act({ type: "clap" })}
            disabled={clapResponded || !!busy}
          >
            {clapResponded ? (
              <Icon name="check" size={50} />
            ) : (
              <Icon name="hand" size={50} />
            )}
            <span>{clapResponded ? "ЕСТЬ!" : "ХЛОП!"}</span>
          </button>
          <div className="clap-responders">
            {game.players.map((player, index) => (
              <span
                key={player.id}
                className={
                  game.clap!.responded.includes(player.id) ? "responded" : ""
                }
                title={player.name}
              >
                <Avatar player={player} index={index} small />
                {game.clap!.responded.includes(player.id) && (
                  <Icon name="check" size={12} />
                )}
              </span>
            ))}
          </div>
        </Dialog>
      )}
      {chatOpen && game && (
        <Dialog
          title={chatTab === "chat" ? "Чат стола" : "История игры"}
          onClose={() => setChatOpen(false)}
          className={`chat-dialog ${keyboardOpen ? "chat-keyboard" : ""}`}
        >
          <div className="dialog-heading">
            <span className="eyebrow">Все свои</span>
            <h2>{chatTab === "chat" ? "Чат стола" : "История игры"}</h2>
          </div>
          <div className="segmented">
            <button
              className={chatTab === "chat" ? "selected" : ""}
              onClick={() => setChatTab("chat")}
            >
              Сообщения
            </button>
            <button
              className={chatTab === "log" ? "selected" : ""}
              onClick={() => setChatTab("log")}
            >
              События
            </button>
          </div>
          {game.silenceOwnerId && chatTab === "chat" && (
            <p className="chat-silence">
              🤫 Сообщение нарушит тишину: +2 карты.
            </p>
          )}
          <div className="chat-messages" aria-live="polite">
            {shownChat.length ? (
              shownChat.map((entry) => {
                const message = entry as {
                  id: string;
                  playerId?: string;
                  text: string;
                  at: number;
                };
                return (
                  <div
                    className={`chat-message ${message.playerId === game.meId ? "message-self" : ""}`}
                    key={message.id}
                  >
                    {message.playerId && (
                      <strong>
                        {game.players.find(
                          (player) => player.id === message.playerId,
                        )?.name || "Игрок"}
                      </strong>
                    )}
                    <p>{message.text}</p>
                    <time>
                      {new Date(message.at).toLocaleTimeString("ru-RU", {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </time>
                  </div>
                );
              })
            ) : (
              <div className="empty-state">
                <Icon name="chat" size={30} />
                <p>Пока тихо. Подозрительно тихо.</p>
              </div>
            )}
          </div>
          <div className="pagination chat-pagination">
            <button
              className="icon-button"
              disabled={chatEnd <= chatPerPage}
              onClick={() => {
                setChatPage(safeChatPage + 1);
                setChatAnchor(
                  chatEntries[Math.max(0, chatEnd - chatPerPage - 1)]?.id ||
                    null,
                );
              }}
              aria-label="Предыдущие сообщения"
            >
              <Icon name="back" />
            </button>
            <span>
              {safeChatPage + 1} / {chatPageCount}
            </span>
            <button
              className="icon-button"
              disabled={chatEnd >= chatEntries.length}
              onClick={() => {
                if (chatEnd + chatPerPage >= chatEntries.length) {
                  setChatPage(0);
                  setChatAnchor(null);
                } else {
                  setChatPage(Math.max(0, safeChatPage - 1));
                  setChatAnchor(
                    chatEntries[
                      Math.min(
                        chatEntries.length - 1,
                        chatEnd + chatPerPage - 1,
                      )
                    ]?.id || null,
                  );
                }
              }}
              aria-label="Следующие сообщения"
            >
              <Icon name="arrow" />
            </button>
          </div>
          {chatTab === "chat" && (
            <form
              className="chat-form"
              onSubmit={async (event) => {
                event.preventDefault();
                if (!chatText.trim()) return;
                if (await act({ type: "chat", text: chatText.trim() }))
                  setChatText("");
              }}
            >
              <input
                aria-label="Сообщение всем игрокам"
                disabled={busy === "chat"}
                maxLength={200}
                placeholder="Скажи что-нибудь…"
                value={chatText}
                onChange={(event) => setChatText(event.target.value)}
              />
              <button
                className="button button-orange"
                aria-label="Отправить сообщение"
                disabled={!chatText.trim() || !!busy}
              >
                <Icon name="arrow" />
              </button>
            </form>
          )}
        </Dialog>
      )}
    </main>
  );
}
