"use client";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import type { Card, Color, PublicGame } from "../../lib/game";
import "./CardHand.css";

type Props = {
  game: PublicGame;
  busy: boolean;
  onPlay: (card: Card) => void | Promise<unknown>;
  dropTargetRef: RefObject<HTMLElement | null>;
};
type Gesture = {
  cardId: string;
  pointerId: number;
  button: HTMLButtonElement;
  startX: number;
  startY: number;
  x: number;
  y: number;
  moved: boolean;
  context: string;
};
type FloatingCard = {
  card: Card;
  x: number;
  y: number;
  allowed: boolean;
  overTable: boolean;
};

const PAGE_SIZE = 8;
const COLORS: Record<Color, string> = {
  red: "Красный",
  orange: "Оранжевый",
  green: "Зелёный",
  blue: "Синий",
};
const NAMES: Record<Card["kind"], string> = {
  number: "",
  draw3: "Хапёж",
  skip: "Захрапин",
  wild: "Полисвин",
  silence: "Тихохрюн",
  clap: "Хлопкопыт",
};
const cardLabel = (card: Card) =>
  `${card.color ? `${COLORS[card.color]}, ` : ""}${card.kind === "number" ? card.value : NAMES[card.kind]}`;
const cardImage = (card: Card) =>
  card.kind === "wild"
    ? "/cards/wild.jpg"
    : `/cards/${card.color}-${card.kind === "number" ? card.value : card.kind}.jpg`;

/** Mirrors server matching; the server remains authoritative when the action arrives. */
function playable(card: Card, game: PublicGame): boolean {
  if (
    game.status !== "playing" ||
    game.clap ||
    game.colorChoicePlayerId ||
    !game.hand.some((owned) => owned.id === card.id)
  )
    return false;
  const top = game.topCard;
  if (!top) return false;
  if (game.players[game.turnIndex]?.id !== game.meId) {
    return (
      game.lastPlayedById !== game.meId &&
      card.color === top.color &&
      card.kind === top.kind &&
      (card.kind !== "number" || card.value === top.value)
    );
  }
  if (game.drawnCardId && game.drawnCardId !== card.id) return false;
  if (game.pending) return game.pending.kind === card.kind;
  return (
    card.kind === "wild" ||
    card.color === game.activeColor ||
    (card.kind === top.kind &&
      (card.kind !== "number" || card.value === top.value))
  );
}

function context(game: PublicGame): string {
  return [
    game.meId,
    game.round,
    game.status,
    game.turnIndex,
    game.colorChoicePlayerId,
    game.topCard?.id,
    game.activeColor,
    game.drawnCardId,
    game.pending?.kind,
    game.pending?.amount,
    game.clap?.id,
  ].join(":");
}

function inDropZone(
  element: HTMLElement | null,
  x: number,
  y: number,
): boolean {
  if (!element) return false;
  const rect = element.getBoundingClientRect();
  if (!rect.width || !rect.height) return false;
  return (
    x >= rect.left - 16 &&
    x <= rect.right + 16 &&
    y >= rect.top - 16 &&
    y <= rect.bottom + 16
  );
}

// Recover the unrotated border box, including the fan's bottom transform origin.
// Bounding-box centres alone shift a rotated card away from its actual slot.
function cardPose(element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  const matrix = new DOMMatrix(style.transform === "none" ? undefined : style.transform);
  const [ox, oy] = style.transformOrigin.split(" ").map(Number.parseFloat);
  const width = element.offsetWidth;
  const height = element.offsetHeight;
  const corners = [[0, 0], [width, 0], [0, height], [width, height]].map(([x, y]) => ({
    x: matrix.a * (x - ox) + matrix.c * (y - oy) + matrix.e + ox,
    y: matrix.b * (x - ox) + matrix.d * (y - oy) + matrix.f + oy,
  }));
  return {
    left: `${rect.left - Math.min(...corners.map(p => p.x))}px`,
    top: `${rect.top - Math.min(...corners.map(p => p.y))}px`,
    width: `${width}px`,
    height: `${height}px`,
    transform: matrix.toString(),
    transformOrigin: style.transformOrigin,
  };
}

export default function CardHand({ game, busy, onPlay, dropTargetRef }: Props) {
  // Pointer release must read the most recent poll, rather than its starting render.
  const latest = useRef({ game, busy, onPlay, dropTargetRef });
  latest.current = { game, busy, onPlay, dropTargetRef };
  const gesture = useRef<Gesture | null>(null);
  const suppressClick = useRef<{ id: string; until: number } | null>(null);
  const submitting = useRef(false);
  const highlightedTarget = useRef<HTMLElement | null>(null);
  const mounted = useRef(true);
  const handElement = useRef<HTMLDivElement | null>(null);
  const previousPositions = useRef(new Map<string, { x: number; y: number }>());
  const moveFrame = useRef<number | null>(null);
  const flights = useRef(new Set<HTMLImageElement>());
  const floatingElement = useRef<HTMLDivElement | null>(null);
  const [floating, setFloating] = useState<FloatingCard | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [page, setPage] = useState({
    anchorId: null as string | null,
    start: 0,
  });

  const anchorIndex = page.anchorId
    ? game.hand.findIndex((card) => card.id === page.anchorId)
    : -1;
  // Once the hand fits, an old page anchor must never hide its first cards.
  const start =
    game.hand.length <= PAGE_SIZE
      ? 0
      : anchorIndex >= 0
        ? anchorIndex
        : Math.min(
            page.start,
            Math.max(
              0,
              Math.floor((game.hand.length - 1) / PAGE_SIZE) * PAGE_SIZE,
            ),
          );
  const cards = game.hand.slice(start, start + PAGE_SIZE);
  const hasPages = game.hand.length > PAGE_SIZE;
  const activeContext = context(game);
  const handIds = game.hand.map((card) => card.id).join("|");

  const clearHighlight = () => {
    highlightedTarget.current?.removeAttribute("data-drop-active");
    highlightedTarget.current = null;
  };

  const cancelGesture = (suppress = true, returnToHand = true) => {
    if (moveFrame.current !== null) {
      cancelAnimationFrame(moveFrame.current);
      moveFrame.current = null;
    }
    const current = gesture.current;
    gesture.current = null;
    if (current) {
      const preview = floatingElement.current?.querySelector("img");
      const card = latest.current.game.hand.find(owned => owned.id === current.cardId);
      if (mounted.current && returnToHand && current.moved && preview && card && current.button.isConnected) {
        const motion = makeMotion(card, preview, current.button, "return");
        if (motion) {
          // Wait one frame for selection to clear before measuring the fan slot.
          requestAnimationFrame(() => {
            if (!motion.image.isConnected || !current.button.isConnected) {
              motion.cleanup();
              return;
            }
            for (const animation of current.button.getAnimations()) animation.cancel();
            const destination = cardPose(current.button);
            const animation = motion.image.animate([motion.from, destination], {
              duration: 340, easing: "cubic-bezier(.22,.75,.24,1)", fill: "forwards",
            });
            animation.onfinish = motion.cleanup;
          });
        }
      }
      if (mounted.current && current.moved) setSelectedId(null);
      if (suppress)
        suppressClick.current = { id: current.cardId, until: Date.now() + 700 };
      if (current.button.hasPointerCapture(current.pointerId))
        current.button.releasePointerCapture(current.pointerId);
    }
    clearHighlight();
    if (mounted.current) setFloating(null);
  };

  const canSubmit = (card: Card) => {
    const current = latest.current;
    return !current.busy && !submitting.current && playable(card, current.game);
  };

  const makeMotion = (card: Card, source: HTMLElement, button: HTMLButtonElement, kind: "return" | "play") => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return null;
    const from = cardPose(source);
    const image = document.createElement("img");
    image.src = cardImage(card);
    image.alt = "";
    image.setAttribute("aria-hidden", "true");
    image.className = "sv-hand-flight";
    image.dataset.motion = kind;
    image.dataset.motionCard = card.id;
    Object.assign(image.style, from);
    const motionId = crypto.randomUUID();
    button.dataset.motionHidden = motionId;
    document.body.append(image);
    flights.current.add(image);
    const cleanup = () => {
      image.remove();
      flights.current.delete(image);
      if (button.dataset.motionHidden === motionId)
        button.removeAttribute("data-motion-hidden");
    };
    return { image, from, cleanup };
  };

  const submit = (id: string, preview?: HTMLElement | null) => {
    const card = latest.current.game.hand.find((owned) => owned.id === id);
    if (!card || !canSubmit(card)) return false;
    submitting.current = true;
    // Visual feedback never delays the authoritative request or one-card race.
    let finishMotion: (() => void) | undefined;
    if (card.kind !== "wild") {
      const button = Array.from(
        handElement.current?.querySelectorAll<HTMLButtonElement>(
          "button[data-card-id]",
        ) ?? [],
      )
        .find((element) => element.dataset.cardId === id);
      const target = latest.current.dropTargetRef.current
        ?.querySelector<HTMLElement>(".discard-wrap img");
      if (button && target) {
        // The stack is already the final pose. A second entrance animation
        // would move its image underneath the travelling card.
        for (const animation of target.getAnimations()) animation.finish();
        const motion = makeMotion(card, preview ?? button, button, "play");
        if (motion) {
          const table = latest.current.dropTargetRef.current!;
          table.dataset.cardFlight = card.id;
          let arrived = false;
          let settled = false;
          const cleanup = () => {
            if (arrived && settled) {
              table.querySelector(".discard-wrap img")?.setAttribute("data-landed", "true");
              motion.cleanup();
              if (table.dataset.cardFlight === card.id) delete table.dataset.cardFlight;
            }
          };
          const animation = motion.image.animate([motion.from, cardPose(target)], {
            duration: 420, easing: "cubic-bezier(.2,.65,.25,1)", fill: "forwards",
          });
          animation.onfinish = () => { arrived = true; cleanup(); };
          finishMotion = () => {
            // Let React paint the authoritative card before handing off the image.
            requestAnimationFrame(() => { settled = true; cleanup(); });
          };
        }
      }
    }
    try {
      const result = latest.current.onPlay(card);
      void Promise.resolve(result)
        .catch(() => undefined)
        .finally(() => {
          submitting.current = false;
          finishMotion?.();
        });
    } catch {
      submitting.current = false;
      finishMotion?.();
    }
    return true;
  };

  useEffect(() => {
    mounted.current = true;
    const cancel = () => cancelGesture();
    const visibility = () => {
      if (document.hidden) cancel();
    };
    window.addEventListener("blur", cancel);
    window.addEventListener("resize", cancel);
    window.visualViewport?.addEventListener("resize", cancel);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      mounted.current = false;
      cancelGesture();
      for (const image of flights.current) {
        for (const animation of image.getAnimations()) animation.cancel();
        image.remove();
      }
      flights.current.clear();
      for (const button of handElement.current?.querySelectorAll("[data-motion-hidden]") ?? [])
        button.removeAttribute("data-motion-hidden");
      latest.current.dropTargetRef.current?.removeAttribute("data-card-flight");
      window.removeEventListener("blur", cancel);
      window.removeEventListener("resize", cancel);
      window.visualViewport?.removeEventListener("resize", cancel);
      document.removeEventListener("visibilitychange", visibility);
    };
    // These listeners operate on refs so that polling cannot restart a gesture.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const current = gesture.current;
    if (
      current &&
      (busy ||
        current.context !== activeContext ||
        !game.hand.some((card) => card.id === current.cardId))
    )
      cancelGesture();
    if (selectedId && !game.hand.some((card) => card.id === selectedId))
      setSelectedId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeContext, busy, handIds, selectedId]);

  useEffect(() => {
    if (
      game.hand.length <= PAGE_SIZE &&
      (page.start !== 0 || page.anchorId !== null)
    )
      setPage({ start: 0, anchorId: null });
  }, [game.hand.length, page.start, page.anchorId]);

  useEffect(() => {
    if (!game.drawnCardId) return;
    const index = game.hand.findIndex((card) => card.id === game.drawnCardId);
    if (index >= 0 && (index < start || index >= start + PAGE_SIZE)) {
      cancelGesture();
      const nextStart = Math.floor(index / PAGE_SIZE) * PAGE_SIZE;
      setPage({ start: nextStart, anchorId: game.hand[nextStart]?.id ?? null });
    }
    // Only a newly drawn card should move the page automatically.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game.drawnCardId]);

  useLayoutEffect(() => {
    const positions = new Map<string, { x: number; y: number }>();
    const reduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    for (const element of handElement.current?.querySelectorAll<HTMLElement>(
      "[data-card-id]",
    ) ?? []) {
      const id = element.dataset.cardId!;
      const rect = element.getBoundingClientRect();
      positions.set(id, { x: rect.x, y: rect.y });
      if (reduced || gesture.current) continue;
      const before = previousPositions.current.get(id);
      if (
        before &&
        (Math.abs(before.x - rect.x) > 1 || Math.abs(before.y - rect.y) > 1)
      ) {
        element.animate(
          [
            { translate: `${before.x - rect.x}px ${before.y - rect.y}px` },
            { translate: "0 0" },
          ],
          { duration: 280, easing: "cubic-bezier(.2,.8,.2,1)" },
        );
      } else if (!before) {
        element.animate(
          [
            { opacity: 0, translate: "0 12px" },
            { opacity: 1, translate: "0 0" },
          ],
          { duration: 260, easing: "cubic-bezier(.2,.8,.2,1)" },
        );
      }
    }
    previousPositions.current = positions;
  }, [handIds, start]);

  const pointerDown = (event: PointerEvent<HTMLButtonElement>, card: Card) => {
    if (
      !event.isPrimary ||
      event.button !== 0 ||
      latest.current.busy ||
      submitting.current ||
      gesture.current
    )
      return;
    for (const image of flights.current) {
      if (image.dataset.motionCard === card.id) {
        for (const animation of image.getAnimations()) animation.cancel();
        image.remove();
        flights.current.delete(image);
      }
    }
    event.currentTarget.removeAttribute("data-motion-hidden");
    setSelectedId(card.id);
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = {
      cardId: card.id,
      pointerId: event.pointerId,
      button: event.currentTarget,
      startX: event.clientX,
      startY: event.clientY,
      x: event.clientX,
      y: event.clientY,
      moved: false,
      context: context(latest.current.game),
    };
  };

  const pointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId) return;
    current.x = event.clientX;
    current.y = event.clientY;
    if (Math.hypot(current.x - current.startX, current.y - current.startY) >= 8)
      current.moved = true;
    if (!current.moved) return;
    event.preventDefault();
    const card = latest.current.game.hand.find(
      (owned) => owned.id === current.cardId,
    );
    if (
      !card ||
      latest.current.busy ||
      current.context !== context(latest.current.game)
    ) {
      cancelGesture();
      return;
    }
    const allowed = canSubmit(card);
    const target = latest.current.dropTargetRef.current;
    const overTable =
      allowed &&
      current.startY - current.y >= 24 &&
      inDropZone(target, current.x, current.y);
    if (highlightedTarget.current !== target || !overTable) clearHighlight();
    if (overTable && target) {
      target.setAttribute("data-drop-active", "true");
      highlightedTarget.current = target;
    }
    if (moveFrame.current === null) {
      moveFrame.current = requestAnimationFrame(() => {
        moveFrame.current = null;
        if (gesture.current === current)
          setFloating({
            card,
            x: current.x,
            y: current.y,
            allowed,
            overTable:
              allowed &&
              current.startY - current.y >= 24 &&
              inDropZone(
                latest.current.dropTargetRef.current,
                current.x,
                current.y,
              ),
          });
      });
    }
  };

  const pointerUp = (event: PointerEvent<HTMLButtonElement>) => {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const dx = event.clientX - current.startX;
    const dy = event.clientY - current.startY;
    const moved = current.moved || Math.hypot(dx, dy) >= 8;
    const latestContext = context(latest.current.game);
    const tableDrop =
      dy <= -24 &&
      inDropZone(
        latest.current.dropTargetRef.current,
        event.clientX,
        event.clientY,
      );
    const upwardSwipe = dy <= -64 && Math.abs(dx) <= Math.max(56, -dy * 0.72);
    const played =
      moved &&
      current.context === latestContext &&
      (tableDrop || upwardSwipe) &&
      submit(current.cardId, floatingElement.current?.querySelector("img"));
    cancelGesture(moved, !played);
  };

  const changePage = (direction: -1 | 1) => {
    cancelGesture();
    setSelectedId(null);
    const nextStart = Math.max(
      0,
      Math.min(
        start + direction * PAGE_SIZE,
        Math.floor((game.hand.length - 1) / PAGE_SIZE) * PAGE_SIZE,
      ),
    );
    setPage({ start: nextStart, anchorId: game.hand[nextStart]?.id ?? null });
  };

  const isTurn = game.players[game.turnIndex]?.id === game.meId;
  return (
    <div
      ref={handElement}
      className={`sv-hand ${hasPages ? "sv-hand-paged" : ""}`}
      data-testid="card-hand"
      role="group"
      aria-label="Ваши карты"
    >
      <div
        className="sv-hand-fan"
        style={{ "--sv-card-count": cards.length } as CSSProperties}
      >
        {cards.map((card, index) => {
          const allowed = playable(card, game);
          const intercept = allowed && !isTurn;
          const label = cardLabel(card);
          const arc =
            cards.length <= 1 ? 0 : (index / (cards.length - 1) - 0.5) * 2;
          return (
            <button
              key={card.id}
              type="button"
              className={`hand-card sv-hand-card ${allowed ? "playable" : "unplayable"} ${selectedId === card.id ? "sv-hand-selected" : ""} ${floating?.card.id === card.id ? "sv-hand-dragging" : ""} ${game.drawnCardId === card.id ? "just-drawn" : ""}`}
              style={
                {
                  "--sv-card-index": index,
                  "--sv-card-rotation": `${arc * 7}deg`,
                  "--sv-card-lift": `${Math.abs(arc) * 9}px`,
                } as CSSProperties
              }
              data-card-id={card.id}
              data-playable={allowed ? "true" : "false"}
              disabled={busy}
              aria-disabled={!allowed || busy}
              aria-label={`${label}${intercept ? ", перехватить ход" : allowed ? ", сыграть" : ", сейчас нельзя сыграть"}`}
              title={`${label}${intercept ? " — перехват" : allowed ? " — потяни на стол или нажми" : " — пока нельзя сыграть"}`}
              onPointerDown={(event) => pointerDown(event, card)}
              onPointerMove={pointerMove}
              onPointerUp={pointerUp}
              onPointerCancel={() => cancelGesture()}
              onLostPointerCapture={(event) => {
                if (gesture.current?.pointerId === event.pointerId)
                  cancelGesture();
              }}
              onFocus={() => setSelectedId(card.id)}
              onClick={(event) => {
                const suppression = suppressClick.current;
                if (
                  event.detail !== 0 &&
                  suppression?.id === card.id &&
                  suppression.until > Date.now()
                ) {
                  suppressClick.current = null;
                  event.preventDefault();
                  return;
                }
                setSelectedId(card.id);
                submit(card.id);
              }}
            >
              <img src={cardImage(card)} alt={label} draggable={false} />
              <span
                className={`sv-hand-corner sv-hand-corner-${card.color ?? "wild"}`}
                aria-hidden="true"
              >
                {card.kind === "number"
                  ? card.value
                  : card.kind === "draw3"
                    ? "+3"
                    : card.kind === "skip"
                      ? "↦"
                      : card.kind === "wild"
                        ? "★"
                        : card.kind === "silence"
                          ? "Тс"
                          : "✋"}
              </span>
              {game.drawnCardId === card.id && (
                <span className="sv-hand-new" aria-hidden="true">
                  Новая
                </span>
              )}
              {intercept && (
                <span className="sv-hand-intercept" aria-hidden="true">
                  ↯
                </span>
              )}
            </button>
          );
        })}
      </div>
      <div className="sv-hand-footer">
        {hasPages && (
          <button
            type="button"
            className="sv-hand-page"
            aria-label="Предыдущие карты"
            disabled={start === 0 || busy}
            onClick={() => changePage(-1)}
          >
            <span aria-hidden="true">‹</span>
          </button>
        )}
        <span className="sv-hand-guide" aria-live="polite">
          {hasPages
            ? `${start + 1}–${Math.min(start + PAGE_SIZE, game.hand.length)} из ${game.hand.length} · `
            : ""}
          {game.clap ? "Скорее жми «Хлоп!»" : hasPages ? "На стол ↑" : "Потяни карту на стол ↑"}
        </span>
        {hasPages && (
          <button
            type="button"
            className="sv-hand-page"
            aria-label="Следующие карты"
            disabled={start + PAGE_SIZE >= game.hand.length || busy}
            onClick={() => changePage(1)}
          >
            <span aria-hidden="true">›</span>
          </button>
        )}
      </div>
      {floating &&
        createPortal(
          <div
            ref={floatingElement}
            className={`sv-hand-floating ${floating.allowed ? "" : "sv-hand-floating-blocked"} ${floating.overTable ? "sv-hand-floating-ready" : ""}`}
            style={
              {
                "--sv-pointer-x": `${floating.x}px`,
                "--sv-pointer-y": `${floating.y}px`,
              } as CSSProperties
            }
            aria-hidden="true"
          >
            <img src={cardImage(floating.card)} alt="" draggable={false} />
            <span>
              {floating.overTable
                ? "Отпусти!"
                : floating.allowed
                  ? "На стол ↑"
                  : "Пока нельзя"}
            </span>
          </div>,
          document.body,
        )}
    </div>
  );
}
