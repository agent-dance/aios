import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { createFixedStepRuntime } from '../../game-platform/runtime';
import {
  hasVirtualTimeMarker,
  useFullscreenController,
  useGameAutomationBridge,
  useGameLifecycle,
  type GameAutomationTarget,
} from '../../game-platform/web';
import {
  getCard,
  sortCards,
  type CardId,
} from './DoudizhuCards';
import type { CombinationKind } from './DoudizhuCombinations';
import type { DoudizhuSeatId } from './DoudizhuAgentAdapter';
import type { DoudizhuAction, DoudizhuPhase, Seat } from './DoudizhuEngine';
import {
  type DoudizhuMatch,
} from './DoudizhuMatch';
import {
  createNextDoudizhuRoundAfterTerminal,
  createSecureLocalDoudizhuMatch,
  createStickyManualClockOwnership,
  type DoudizhuMatchFactory,
} from './DoudizhuOrchestration';
import {
  calculateDoudizhuMultiplier,
  type LegalActionDescriptor,
  type SeatProjection,
  type SeatRole,
} from './DoudizhuProjection';
import './DoudizhuApp.css';

const HUMAN_SEAT_ID: DoudizhuSeatId = 'seat-0';
const AGENT_THINK_MS = 500;
const REALTIME_INTERVAL_MS = 100;
const MAX_CONSECUTIVE_AGENT_ACTIONS = 256;

const SEAT_IDS: readonly DoudizhuSeatId[] = ['seat-0', 'seat-1', 'seat-2'];
const SEAT_NAMES: Readonly<Record<DoudizhuSeatId, string>> = {
  'seat-0': '你',
  'seat-1': 'Nova Agent',
  'seat-2': 'Atlas Agent',
};

const PHASE_LABELS: Readonly<Record<DoudizhuPhase, string>> = {
  bidding: '叫分',
  'defender-double': '农民加倍',
  'landlord-redouble': '地主再加倍',
  playing: '出牌',
  complete: '本局结束',
};

const COMBINATION_LABELS: Readonly<Record<CombinationKind, string>> = {
  single: '单张',
  pair: '对子',
  triple: '三张',
  'triple-single': '三带一',
  'triple-pair': '三带一对',
  straight: '顺子',
  'pair-straight': '连对',
  airplane: '飞机',
  'airplane-singles': '飞机带单',
  'airplane-pairs': '飞机带对',
  'four-two-singles': '四带二',
  'four-two-pairs': '四带两对',
  bomb: '炸弹',
  rocket: '王炸',
};

interface AgentClockState {
  readonly elapsedMs: number;
}

interface AgentClockInput {
  readonly suspended: boolean;
}

type AgentActivity = '等待中' | '思考中' | '已行动';

const createAgentClock = () => createFixedStepRuntime<AgentClockState, AgentClockInput>({
  createInitialState: () => ({ elapsedMs: 0 }),
  createInitialInput: () => ({ suspended: false }),
  simulate: (state, input, context) => input.suspended
    ? { elapsedMs: state.elapsedMs }
    : { elapsedMs: state.elapsedMs + context.deltaMs },
});

function seatIdToIndex(seatId: DoudizhuSeatId): Seat {
  return Number(seatId.slice(-1)) as Seat;
}

function seatIndexToId(seat: Seat): DoudizhuSeatId {
  return `seat-${seat}` as DoudizhuSeatId;
}

function roleLabel(role: SeatRole): string | null {
  if (role === 'landlord') return '地主';
  if (role === 'defender') return '农民';
  return null;
}

function visibleRole(projection: SeatProjection, seatId: DoudizhuSeatId): SeatRole {
  if (projection.landlordSeat === null) return 'unassigned';
  return seatIdToIndex(seatId) === projection.landlordSeat ? 'landlord' : 'defender';
}

function rankLabel(cardId: CardId): string {
  const rank = getCard(cardId).rank;
  if (rank === 'small-joker') return '小王';
  if (rank === 'big-joker') return '大王';
  return rank;
}

function suitSymbol(cardId: CardId): string {
  const suit = getCard(cardId).suit;
  if (suit === 'clubs') return '♣';
  if (suit === 'diamonds') return '♦';
  if (suit === 'hearts') return '♥';
  if (suit === 'spades') return '♠';
  return '★';
}

function cardLabel(cardId: CardId): string {
  const card = getCard(cardId);
  if (card.suit === 'joker') return rankLabel(cardId);
  const suitNames = { clubs: '梅花', diamonds: '方块', hearts: '红桃', spades: '黑桃' } as const;
  return `${suitNames[card.suit]}${rankLabel(cardId)}`;
}

function CardFace({
  cardId,
  mini = false,
  selected = false,
  interactive = false,
  focused = false,
  buttonRef,
  onClick,
}: {
  readonly cardId: CardId;
  readonly mini?: boolean;
  readonly selected?: boolean;
  readonly interactive?: boolean;
  readonly focused?: boolean;
  readonly buttonRef?: (element: HTMLButtonElement | null) => void;
  readonly onClick?: () => void;
}) {
  const card = getCard(cardId);
  const className = [
    'ddz-card',
    mini ? 'ddz-card-mini' : '',
    selected ? 'is-selected' : '',
    card.suit === 'hearts' || card.suit === 'diamonds' ? 'is-red' : '',
    card.suit === 'joker' ? 'is-joker' : '',
  ].filter(Boolean).join(' ');
  const content = (
    <>
      <span className="ddz-card-rank">{rankLabel(cardId)}</span>
      <span className="ddz-card-suit" aria-hidden="true">{suitSymbol(cardId)}</span>
    </>
  );

  if (!interactive) return <span className={className} aria-label={cardLabel(cardId)}>{content}</span>;
  return (
    <button
      ref={buttonRef}
      className={className}
      type="button"
      aria-label={`${selected ? '取消选择' : '选择'}${cardLabel(cardId)}`}
      aria-pressed={selected}
      tabIndex={focused ? 0 : -1}
      onClick={onClick}
    >
      {content}
    </button>
  );
}

function SeatPanel({
  seatId,
  projection,
  activity,
  className,
}: {
  readonly seatId: DoudizhuSeatId;
  readonly projection: SeatProjection;
  readonly activity: AgentActivity | null;
  readonly className: string;
}) {
  const seat = seatIdToIndex(seatId);
  const active = projection.currentSeat === seat && projection.phase !== 'complete';
  const role = roleLabel(visibleRole(projection, seatId));
  const bid = projection.bids[seat];
  return (
    <section
      className={`ddz-seat ${className}${active ? ' is-active' : ''}`}
      aria-label={`${SEAT_NAMES[seatId]}，${role ?? '身份未确定'}，剩余${projection.remainingCardCounts[seat]}张牌${active ? '，当前行动' : ''}`}
    >
      <div className="ddz-avatar" aria-hidden="true">{seatId === HUMAN_SEAT_ID ? '我' : 'AI'}</div>
      <div className="ddz-seat-copy">
        <div className="ddz-seat-line">
          <span className="ddz-seat-name">{SEAT_NAMES[seatId]}</span>
          {role ? <span className="ddz-role-badge">{role}</span> : null}
        </div>
        <div className="ddz-seat-meta" aria-hidden="true">
          <span>{seatId === HUMAN_SEAT_ID ? 'Human' : 'Agent'}</span>
          <span>{projection.remainingCardCounts[seat]} 张</span>
          {bid !== null ? <span>叫 {bid}</span> : null}
        </div>
        <div className={`ddz-seat-activity${activity === '思考中' ? ' is-thinking' : ''}`}>
          {activity ?? (active ? '等待你行动' : '等待中')}
        </div>
      </div>
    </section>
  );
}

function sameCards(left: readonly CardId[], right: readonly CardId[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((cardId) => rightSet.has(cardId));
}

function matchingPlay(
  legalActions: readonly LegalActionDescriptor[],
  selectedCards: ReadonlySet<CardId>,
): Extract<LegalActionDescriptor, { type: 'play' }> | undefined {
  const cards = [...selectedCards];
  return legalActions.find(
    (action): action is Extract<LegalActionDescriptor, { type: 'play' }> =>
      action.type === 'play' && sameCards(action.cards, cards),
  );
}

function hasAction<T extends LegalActionDescriptor['type']>(
  actions: readonly LegalActionDescriptor[],
  type: T,
): boolean {
  return actions.some((action) => action.type === type);
}

function renderSeatZeroProjection(match: DoudizhuMatch): string {
  const seatZero = match.getHumanObservation();
  const { legalActions, publicHistory, ...visibleState } = seatZero.observation;
  const playActions = legalActions.filter(
    (action): action is Extract<LegalActionDescriptor, { type: 'play' }> => action.type === 'play',
  );
  return JSON.stringify({
    protocol: 'AGAP/1.0.0',
    perspective: HUMAN_SEAT_ID,
    terminal: seatZero.terminal,
    decision: seatZero.decision,
    observation: {
      ...visibleState,
      publicHistory: publicHistory.slice(-12),
    },
    legalActions: {
      count: legalActions.length,
      kinds: [...new Set(legalActions.map((action) => action.type))],
      playCount: playActions.length,
      representativePlays: playActions.slice(0, 12).map((action) => ({
        cards: action.cards,
        combination: action.combination.kind,
      })),
    },
  });
}

export interface DoudizhuAppProps {
  readonly isActive?: boolean;
  /** Dependency injection boundary for deterministic tests or a future remote authority. */
  readonly matchFactory?: DoudizhuMatchFactory;
}

export function DoudizhuApp({ isActive = true, matchFactory = createSecureLocalDoudizhuMatch }: DoudizhuAppProps) {
  const shellRef = useRef<HTMLDivElement>(null);
  const roundRef = useRef(0);
  const matchRef = useRef<DoudizhuMatch | null>(null);
  if (!matchRef.current) matchRef.current = matchFactory(roundRef.current);
  const clockRef = useRef<ReturnType<typeof createAgentClock> | null>(null);
  if (!clockRef.current) clockRef.current = createAgentClock();
  const match = matchRef.current;
  const clock = clockRef.current;

  const [observation, setObservation] = useState(() => match.getHumanObservation());
  const [selectedCards, setSelectedCards] = useState<ReadonlySet<CardId>>(() => new Set());
  const [focusedCardIndex, setFocusedCardIndex] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [agentActivities, setAgentActivities] = useState<Readonly<Record<DoudizhuSeatId, AgentActivity>>>(() => ({
    'seat-0': '等待中',
    'seat-1': '等待中',
    'seat-2': '等待中',
  }));
  const [manualClock, setManualClock] = useState(
    () => typeof window !== 'undefined' && hasVirtualTimeMarker(window as GameAutomationTarget),
  );
  const clockOwnershipRef = useRef<ReturnType<typeof createStickyManualClockOwnership> | null>(null);
  if (!clockOwnershipRef.current) {
    clockOwnershipRef.current = createStickyManualClockOwnership(manualClock);
  }
  const drivingRef = useRef(false);
  const hintIndexRef = useRef(0);
  const cardRefs = useRef(new Map<CardId, HTMLButtonElement>());

  const projection = observation.observation;
  const activeSeatId = observation.decision.activeSeatIds[0] ?? null;
  const humanTurn = activeSeatId === HUMAN_SEAT_ID && !observation.terminal;

  const refresh = useCallback(() => {
    setObservation(matchRef.current!.getHumanObservation());
  }, []);

  const resetInteraction = useCallback(() => {
    setSelectedCards(new Set());
    setFocusedCardIndex(0);
    hintIndexRef.current = 0;
  }, []);

  const requestManualClock = useCallback(() => {
    if (!clockOwnershipRef.current!.requestManual()) return;
    setManualClock(true);
  }, []);

  const driveConsecutiveAgents = useCallback(() => {
    if (drivingRef.current) return 0;
    drivingRef.current = true;
    let actionsTaken = 0;
    const acted = new Set<DoudizhuSeatId>();
    try {
      while (actionsTaken < MAX_CONSECUTIVE_AGENT_ACTIONS) {
        const currentMatch = matchRef.current!;
        const actor = currentMatch.getActiveSeatId();
        if (actor === null || currentMatch.getControllerKind(actor) !== 'agent') break;
        currentMatch.driveAgentTurn();
        acted.add(actor);
        actionsTaken += 1;
      }
      const nextMatch = matchRef.current!;
      const nextActor = nextMatch.getActiveSeatId();
      if (
        actionsTaken === MAX_CONSECUTIVE_AGENT_ACTIONS
        && nextActor !== null
        && nextMatch.getControllerKind(nextActor) === 'agent'
      ) {
        throw new Error('Agent 连续行动超过安全上限');
      }
      if (actionsTaken > 0) {
        setAgentActivities((current) => {
          const next = { ...current };
          acted.forEach((seatId) => { next[seatId] = '已行动'; });
          return next;
        });
        refresh();
      }
      return actionsTaken;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Agent 行动失败');
      return actionsTaken;
    } finally {
      drivingRef.current = false;
    }
  }, [refresh]);

  const advanceGameTime = useCallback((milliseconds: number) => {
    const currentMatch = matchRef.current!;
    const actor = currentMatch.getActiveSeatId();
    if (actor === null || currentMatch.getControllerKind(actor) !== 'agent') {
      clock.reset({ state: { elapsedMs: 0 }, input: { suspended: false } });
      return;
    }
    const result = clock.advance(milliseconds);
    if (result.state.elapsedMs + Number.EPSILON < AGENT_THINK_MS) return;
    clock.replaceState({ elapsedMs: result.state.elapsedMs % AGENT_THINK_MS });
    driveConsecutiveAgents();
  }, [clock, driveConsecutiveAgents]);

  const lifecycle = useGameLifecycle({
    active: isActive,
    suspendOnInactive: true,
    suspendOnBlur: true,
    suspendWhenHidden: true,
    resetInputOnSuspend: true,
    onResetInput: resetInteraction,
    onResetClock: () => clock.reset({ state: { elapsedMs: 0 }, input: { suspended: false } }),
    onSuspend: () => clock.replaceInput({ suspended: true }),
    onResume: () => clock.replaceInput({ suspended: false }),
  });

  useGameAutomationBridge({
    enabled: isActive,
    renderGameToText: () => renderSeatZeroProjection(matchRef.current!),
    advanceTime: advanceGameTime,
    onManualClockRequested: requestManualClock,
  });

  const fullscreen = useFullscreenController({ target: shellRef });

  useEffect(() => {
    if (!isActive) return undefined;
    const handleFullscreenKey = (event: globalThis.KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.repeat) return;
      const key = event.key.toLowerCase();
      if (key === 'f') {
        event.preventDefault();
        void fullscreen.toggle();
      } else if (key === 'escape' && fullscreen.active) {
        event.preventDefault();
        void fullscreen.exit();
      }
    };
    window.addEventListener('keydown', handleFullscreenKey, { capture: true });
    return () => window.removeEventListener('keydown', handleFullscreenKey, { capture: true });
  }, [fullscreen.active, fullscreen.exit, fullscreen.toggle, isActive]);

  useEffect(() => {
    if (
      !isActive
      || lifecycle.suspended
      || manualClock
      || observation.terminal
      || activeSeatId === null
      || matchRef.current!.getControllerKind(activeSeatId) !== 'agent'
    ) return undefined;
    setAgentActivities((current) => ({ ...current, [activeSeatId]: '思考中' }));
    const timer = window.setInterval(() => {
      if (clockOwnershipRef.current!.allowsRealtime()) advanceGameTime(REALTIME_INTERVAL_MS);
    }, REALTIME_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [activeSeatId, advanceGameTime, isActive, lifecycle.suspended, manualClock, observation.terminal]);

  useEffect(() => {
    if (!notice) return undefined;
    const timer = window.setTimeout(() => setNotice(null), 1_800);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const submit = useCallback((action: DoudizhuAction) => {
    if (!isActive || lifecycle.suspended) return false;
    setError(null);
    try {
      matchRef.current!.submit(HUMAN_SEAT_ID, action);
      resetInteraction();
      clock.reset({ state: { elapsedMs: 0 }, input: { suspended: false } });
      refresh();
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作未被接受');
      refresh();
      return false;
    }
  }, [clock, isActive, lifecycle.suspended, refresh, resetInteraction]);

  const playActions = useMemo(
    () => projection.legalActions.filter(
      (action): action is Extract<LegalActionDescriptor, { type: 'play' }> => action.type === 'play',
    ),
    [projection.legalActions],
  );
  const selectedPlay = matchingPlay(projection.legalActions, selectedCards);

  const toggleCard = useCallback((cardId: CardId) => {
    if (!humanTurn || projection.phase !== 'playing') return;
    setSelectedCards((current) => {
      const next = new Set(current);
      if (next.has(cardId)) next.delete(cardId);
      else next.add(cardId);
      return next;
    });
  }, [humanTurn, projection.phase]);

  const hint = useCallback(() => {
    if (!humanTurn || playActions.length === 0) return;
    const action = playActions[hintIndexRef.current % playActions.length]!;
    hintIndexRef.current += 1;
    setSelectedCards(new Set(action.cards));
    setNotice(`提示：${COMBINATION_LABELS[action.combination.kind]}`);
  }, [humanTurn, playActions]);

  const pass = useCallback(() => {
    if (hasAction(projection.legalActions, 'pass')) submit({ type: 'pass' });
  }, [projection.legalActions, submit]);

  const playSelected = useCallback(() => {
    const action = matchingPlay(projection.legalActions, selectedCards);
    if (action) submit({ type: 'play', cards: action.cards });
    else if (selectedCards.size > 0) setError('所选牌不是当前可出的合法牌型');
  }, [projection.legalActions, selectedCards, submit]);

  const restart = useCallback(() => {
    const nextSession = createNextDoudizhuRoundAfterTerminal(
      roundRef.current,
      matchRef.current!,
      matchFactory,
    );
    if (!nextSession) return;
    roundRef.current = nextSession.round;
    matchRef.current = nextSession.match;
    clock.reset({ state: { elapsedMs: 0 }, input: { suspended: false } });
    resetInteraction();
    setAgentActivities({ 'seat-0': '等待中', 'seat-1': '等待中', 'seat-2': '等待中' });
    setNotice('新一局已开始');
    setError(null);
    refresh();
  }, [clock, matchFactory, refresh, resetInteraction]);

  const handleKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!isActive || event.altKey || event.ctrlKey || event.metaKey) return;
    const key = event.key.toLowerCase();
    const target = event.target;
    const fromInteractiveControl = target instanceof HTMLElement
      && (target.matches('button, input, select, textarea, a[href]') || target.isContentEditable);
    if (key === 'h') {
      event.preventDefault();
      hint();
      return;
    }
    if (key === 'p') {
      event.preventDefault();
      pass();
      return;
    }
    if (key === 'arrowleft' || key === 'arrowright') {
      event.preventDefault();
      const length = projection.ownHand.length;
      if (length > 0) {
        const nextIndex = (focusedCardIndex + (key === 'arrowleft' ? length - 1 : 1)) % length;
        setFocusedCardIndex(nextIndex);
        cardRefs.current.get(projection.ownHand[nextIndex]!)?.focus();
      }
      return;
    }
    if (fromInteractiveControl && (key === ' ' || key === 'enter')) return;
    if (key === ' ' && projection.ownHand[focusedCardIndex]) {
      event.preventDefault();
      toggleCard(projection.ownHand[focusedCardIndex]);
      return;
    }
    if (key === 'enter') {
      event.preventDefault();
      playSelected();
      return;
    }
    if (projection.phase === 'bidding' && ['0', '1', '2', '3'].includes(key)) {
      const score = Number(key) as 0 | 1 | 2 | 3;
      const legal = projection.legalActions.some((action) => action.type === 'bid' && action.score === score);
      if (legal) {
        event.preventDefault();
        submit({ type: 'bid', score });
      }
    }
  }, [focusedCardIndex, hint, isActive, pass, playSelected, projection, submit, toggleCard]);

  const bids = projection.legalActions.filter(
    (action): action is Extract<LegalActionDescriptor, { type: 'bid' }> => action.type === 'bid',
  );
  const sortedHand = sortCards(projection.ownHand);
  const settlement = projection.settlement;
  const statusText = observation.terminal
    ? '本局结束'
    : activeSeatId === HUMAN_SEAT_ID
      ? `轮到你：${PHASE_LABELS[projection.phase]}`
      : `${SEAT_NAMES[activeSeatId!]}思考中`;

  return (
    <div
      ref={shellRef}
      id="doudizhu-shell"
      className="doudizhu-app"
      role="application"
      aria-label="AI 共玩斗地主"
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      <header className="ddz-topbar">
        <div className="ddz-brand">
          <span className="ddz-brand-mark" aria-hidden="true">斗</span>
          <span className="ddz-brand-copy">
            <strong>AI 共玩斗地主</strong>
            <small>AGAP · 人机同权对局</small>
          </span>
        </div>
        <div className="ddz-match-facts" aria-label="对局信息">
          <span className="ddz-fact">规则<strong>经典三人</strong></span>
          <span className="ddz-fact">阶段<strong>{PHASE_LABELS[projection.phase]}</strong></span>
          <span className="ddz-fact">最高倍率<strong>×{calculateDoudizhuMultiplier(projection)}</strong></span>
        </div>
        <div className="ddz-top-actions">
          <button
            className="ddz-icon-button"
            type="button"
            title={observation.terminal ? '新一局' : '本局结束后可开始新一局'}
            aria-label={observation.terminal ? '开始新一局' : '本局结束后可开始新一局'}
            disabled={!observation.terminal}
            onClick={restart}
          >↻</button>
          <button
            className="ddz-icon-button"
            type="button"
            title="全屏（F）"
            aria-label={fullscreen.active ? '退出全屏' : '进入全屏'}
            aria-pressed={fullscreen.active}
            disabled={!fullscreen.supported || fullscreen.pending}
            onClick={() => void fullscreen.toggle()}
          >
            {fullscreen.active ? '↙' : '↗'}
          </button>
        </div>
      </header>

      <main className="ddz-app-body">
        <SeatPanel seatId="seat-1" projection={projection} activity={agentActivities['seat-1']!} className="ddz-seat-left" />
        <SeatPanel seatId="seat-2" projection={projection} activity={agentActivities['seat-2']!} className="ddz-seat-right" />
        <SeatPanel seatId="seat-0" projection={projection} activity={null} className="ddz-seat-self" />

        <section className="ddz-table-center" aria-label="牌桌公共区域">
          <div className="ddz-bottom-cards" aria-label={projection.publicBottom.length ? '公开底牌' : '底牌尚未公开'}>
            <span className="ddz-bottom-label">底牌</span>
            {projection.publicBottom.length > 0
              ? projection.publicBottom.map((cardId) => <CardFace key={cardId} cardId={cardId} mini />)
              : <span className="ddz-empty-trick">等待地主确认</span>}
          </div>
          <div className="ddz-trick">
            {projection.currentTrick ? (
              <>
                <div className="ddz-trick-cards">
                  {projection.currentTrick.cards.map((cardId) => <CardFace key={cardId} cardId={cardId} />)}
                </div>
                <span className="ddz-trick-caption">
                  {SEAT_NAMES[seatIndexToId(projection.currentTrick.seat)]} · {COMBINATION_LABELS[projection.currentTrick.combination.kind]}
                </span>
              </>
            ) : <span className="ddz-empty-trick">等待出牌</span>}
          </div>
        </section>

        <section className="ddz-hand-area" aria-label={`你的手牌，共${sortedHand.length}张`}>
          <div className="ddz-hand-scroll">
            <div className="ddz-hand">
              {sortedHand.map((cardId, index) => (
                <CardFace
                  key={cardId}
                  cardId={cardId}
                  interactive
                  selected={selectedCards.has(cardId)}
                  focused={index === focusedCardIndex}
                  buttonRef={(element) => {
                    if (element) cardRefs.current.set(cardId, element);
                    else cardRefs.current.delete(cardId);
                  }}
                  onClick={() => {
                    setFocusedCardIndex(index);
                    toggleCard(cardId);
                  }}
                />
              ))}
            </div>
          </div>
          <div className="ddz-actions" aria-label="可用操作">
            {projection.phase === 'bidding' ? bids.map((action) => (
              <button
                key={action.score}
                className={`ddz-action${action.score === 3 ? ' ddz-action-primary' : ''}`}
                type="button"
                onClick={() => submit({ type: 'bid', score: action.score })}
              >
                {action.score === 0 ? '不叫' : `${action.score} 分`}
              </button>
            )) : null}
            {projection.phase === 'defender-double' ? (
              <>
                <button className="ddz-action" type="button" disabled={!humanTurn} onClick={() => submit({ type: 'commit-defender-double', double: false })}>不加倍</button>
                <button className="ddz-action ddz-action-primary" type="button" disabled={!humanTurn} onClick={() => submit({ type: 'commit-defender-double', double: true })}>加倍</button>
              </>
            ) : null}
            {projection.phase === 'landlord-redouble' ? (
              <>
                <button className="ddz-action" type="button" disabled={!humanTurn} onClick={() => submit({ type: 'landlord-redouble', redouble: false })}>不再加倍</button>
                <button className="ddz-action ddz-action-primary" type="button" disabled={!humanTurn} onClick={() => submit({ type: 'landlord-redouble', redouble: true })}>再加倍</button>
              </>
            ) : null}
            {projection.phase === 'playing' ? (
              <>
                <button className="ddz-action" type="button" disabled={!humanTurn || playActions.length === 0} onClick={hint}>提示</button>
                <button className="ddz-action ddz-action-warn" type="button" disabled={!humanTurn || !hasAction(projection.legalActions, 'pass')} onClick={pass}>不要</button>
                <button className="ddz-action ddz-action-primary" type="button" disabled={!humanTurn || !selectedPlay} onClick={playSelected}>出牌</button>
              </>
            ) : null}
            {!humanTurn && !observation.terminal ? <span className="ddz-action-hint">Agent 正在行动，窗口失活时自动暂停</span> : null}
            {humanTurn ? <span className="ddz-action-hint">← → 选牌 · Space 勾选 · Enter 出牌 · H 提示 · P 不要</span> : null}
          </div>
        </section>
      </main>

      {notice || error ? <div className={`ddz-toast${error ? ' is-error' : ''}`} role="status">{error ?? notice}</div> : null}
      <div className="ddz-status-announcer" aria-live="polite" aria-atomic="true">{statusText}</div>

      {settlement ? (
        <section className="ddz-settlement" aria-label="本局结算">
          <div className="ddz-settlement-card">
            <div className="ddz-settlement-hero">
              <span className="ddz-settlement-eyebrow">Round Complete</span>
              <h2>{settlement.winner === 'landlord' ? '地主获胜' : '农民获胜'}</h2>
              <p>
                底分 {settlement.baseBid} · 最高单边倍率 ×{calculateDoudizhuMultiplier(projection)}
                {settlement.spring ? ` · ${settlement.spring === 'spring' ? '春天' : '反春'}` : ''}
              </p>
            </div>
            <div className="ddz-score-grid">
              {SEAT_IDS.map((seatId) => {
                const delta = settlement.scoreDeltas[seatIdToIndex(seatId)];
                return (
                  <div className="ddz-score-cell" key={seatId}>
                    <span>{SEAT_NAMES[seatId]}</span>
                    <strong className={delta >= 0 ? 'is-positive' : 'is-negative'}>{delta > 0 ? '+' : ''}{delta}</strong>
                  </div>
                );
              })}
            </div>
            <div className="ddz-settlement-footer">
              <button className="ddz-action ddz-action-primary" type="button" onClick={restart}>再来一局</button>
            </div>
          </div>
        </section>
      ) : null}
    </div>
  );
}

export default DoudizhuApp;
