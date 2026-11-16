import { ArrowCounterClockwiseIcon, ArrowDownIcon, CaretRightIcon, EyeIcon, NotePencilIcon, SquareIcon, TerminalWindowIcon, WarningCircleIcon, XIcon } from "../ui/icons.js";
import { wakeLabels } from "../../model/monitor.js";
import { memo, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { useStickToBottom } from "use-stick-to-bottom";
import { useApp, useController, useNow } from "../../app/context.js";
import { useSampled } from "../../app/sampled.js";
import { buildTurns, inheritedTurns, sideStart, type EchoAttachment, type LocalEcho, type ThreadFold, type TurnView } from "../../model/fold.js";
import {
  describeTool,
  formatClock,
  formatDuration,
  formatFullDate,
  formatSpeed,
  formatTokens,
  parseArgs,
  plural,
  toolKind,
} from "../../model/format.js";
import { streamingSpeed, turnCosts, turnSpeeds, type TurnCost, type TurnSpeed } from "../../model/usage.js";
import { formatCost } from "../../model/pricing.js";
import { signedOut, stuckThread } from "../../model/errors.js";
import { HelpLink, MUSE_HELP_URL } from "../home/Home.js";
import type { ThreadState } from "../../model/store.js";
import type { AttachmentView, MspItem, OutgoingAttachment, ShellRun, UserInputAnswer } from "../../types.js";
import { CodeBlock, FileLinksContext, type FileLinks } from "../ui/Markdown.js";
import { fileTarget } from "../../model/files.js";
import { SentAttachments, refetchAttachments, toOutgoing, toPreview } from "../composer/attachments.js";
import { CopyButton } from "../ui/Markdown.js";
import { Tip } from "../ui/overlays.js";
import { Button, IconButton, Shimmer, Spinner, cn } from "../ui/primitives.js";
import { PixelLoader } from "../ui/sourced.js";
import {
  AgentText,
  BackgroundDoneRow,
  CompactionRow,
  EarlierHistoryRow,
  DiffChips,
  GenericRow,
  PeerMessageRow,
  SystemNoticeRow,
  ReasoningRow,
  ShellRow,
  SideChatRow,
  SideOriginRow,
  SteerBubble,
  SubagentRow,
  ToolRow,
  type Gate,
} from "./items.js";
import { WorkflowCard } from "./WorkflowCard.js";

type GateMap = Record<string, Gate>;
type AnswerMap = Record<string, UserInputAnswer[]>;

function gateMap(fold: ThreadFold): GateMap {
  const map: GateMap = {};
  for (const approval of Object.values(fold.approvals)) {
    if (approval.itemId) {
      map[approval.itemId] = "approval";
    }
  }
  for (const input of Object.values(fold.userInputs)) {
    if (input.itemId) {
      map[input.itemId] = "input";
    }
  }
  return map;
}

function answerMap(fold: ThreadFold): AnswerMap {
  const map: AnswerMap = {};
  for (const [id, settled] of Object.entries(fold.settled)) {
    map[id] = settled.answers;
  }
  return map;
}

export function Transcript(props: { sessionId: string; thread: ThreadState }) {
  const { thread } = props;
  const fold = thread.fold;
  const sideSince = useApp((s) => sideStart(s.sessions[props.sessionId]));
  const sideOf = useApp((s) => s.sessions[props.sessionId]?.sideOf ?? null);
  const inherited = useMemo(() => inheritedTurns(fold, sideSince), [fold, sideSince]);
  const turns = useMemo(() => buildTurns(fold, inherited), [fold, inherited]);
  const wakes = useMemo(() => wakeLabels(turns), [turns]);
  const gates = useMemo(() => gateMap(fold), [fold.approvals, fold.userInputs]);
  const answers = useMemo(() => answerMap(fold), [fold.settled]);
  const speeds = useMemo(() => turnSpeeds(fold), [fold.meta.calls, fold.turns, fold.activeTurnId]);
  const models = useApp((s) => s.models);
  const controller = useController();
  const cwd = useApp((s) => s.sessions[props.sessionId]?.cwd ?? null);
  // Paths Muse mentions in a reply open in the file viewer rather than a browser tab.
  const links = useMemo<FileLinks | null>(
    () =>
      cwd
        ? {
            resolve: (href) => fileTarget(href, cwd),
            open: (target) => controller.openFile(props.sessionId, target.path, target.line),
            imageUrl: (src) => {
              const target = fileTarget(src, cwd);
              return target ? controller.fileUrl(cwd, target.path) : null;
            },
          }
        : null,
    [controller, cwd, props.sessionId],
  );
  const costs = useMemo(() => turnCosts(fold, models), [fold.meta.calls, models]);
  const echoes = fold.echoes.filter((e) => e.disposition !== "queued");
  // Files the server kept for this thread, grouped by the turn they were sent with.
  // Turns and the commands Helicon ran share one timeline: a command's output caused the prompt after it.
  const timeline = useMemo(() => {
    let last = 0;
    const blocks = turns.map((turn, index) => {
      const at = sentTime(turn) ?? completedTime(turn) ?? last + 1;
      last = at;
      return { kind: "turn" as const, at, turn, index };
    });
    const runs = (thread.shellRuns ?? []).map((run) => ({ kind: "run" as const, at: Date.parse(run.at) || 0, run }));
    return [...blocks, ...runs].sort((a, b) => a.at - b.at);
  }, [turns, thread.shellRuns]);

  const attachmentsByTurn = useMemo(() => {
    const map: Record<string, AttachmentView[]> = {};
    for (const file of thread.attachments ?? []) {
      const key = file.turnId ?? "";
      (map[key] ??= []).push(file);
    }
    return map;
  }, [thread.attachments]);
  const { scrollRef, contentRef, isAtBottom, scrollToBottom } = useStickToBottom({ initial: "instant", resize: "smooth" });

  // The dock below grows when a request or panel appears, which shrinks this viewport. Follow it down so the
  // last thing Muse said is never left cut off behind the card asking about it.
  const requests = Object.keys(fold.approvals).length + Object.keys(fold.userInputs).length;
  useEffect(() => {
    if (requests > 0) {
      void scrollToBottom();
    }
  }, [requests, scrollToBottom]);
  const atBottom = useRef(isAtBottom);
  atBottom.current = isAtBottom;
  useEffect(() => {
    const element = scrollRef.current;
    if (!element || typeof ResizeObserver === "undefined") {
      return;
    }
    let height = element.clientHeight;
    const observer = new ResizeObserver(() => {
      const next = element.clientHeight;
      if (next < height && atBottom.current) {
        void scrollToBottom();
      }
      height = next;
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [scrollRef, scrollToBottom]);

  const empty = turns.length === 0 && echoes.length === 0;
  return (
    <FileLinksContext.Provider value={links}>
      <div className="relative min-h-0 flex-1">
        <div ref={scrollRef} className="h-full overflow-y-auto [scrollbar-gutter:stable_both-edges]">
          <section
            ref={contentRef}
            aria-label="Conversation"
            className="mx-auto flex w-full max-w-[776px] flex-col gap-8 px-4 pt-8 pb-10 @min-[520px]:px-6"
          >
            {thread.truncated ? (
              <p className="text-center text-xs text-subtle">Earlier turns are not shown. Open the session in Muse to see the full history.</p>
            ) : null}
            {sideOf ? <SideOriginRow parentId={sideOf} /> : null}
            {thread.load === "loading" && empty ? <TranscriptSkeleton /> : null}
            {timeline.map((entry) =>
              entry.kind === "turn" ? (
                <TurnBlock
                  key={entry.turn.key}
                  turn={entry.turn}
                  gates={gates}
                  answers={answers}
                  attachments={attachmentsByTurn}
                  sessionId={props.sessionId}
                  isLast={entry.index === turns.length - 1}
                  readOnly={thread.readOnly}
                  speed={entry.turn.turnId ? (speeds[entry.turn.turnId] ?? null) : null}
                  cost={entry.turn.turnId ? (costs[entry.turn.turnId] ?? null) : null}
                  wake={wakes[entry.turn.key] ?? null}
                />
              ) : (
                <ShellRunRow key={entry.run.id} run={entry.run} sessionId={props.sessionId} />
              ),
            )}
            {echoes.map((echo) => (
              <PendingPrompt key={echo.localId} echo={echo} />
            ))}
            {thread.load === "error" ? <LoadError sessionId={props.sessionId} message={thread.error} /> : null}
            {empty && thread.load === "ready" ? <EmptyThread /> : null}
          </section>
        </div>
        {!isAtBottom && !empty ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
            <button
              type="button"
              onClick={() => void scrollToBottom()}
              className="enter-up pointer-events-auto inline-flex h-8 items-center gap-1.5 rounded-full bg-raised px-3 text-xs font-medium text-muted shadow-pop hover:text-fg"
            >
              <ArrowDownIcon size={13} /> Latest
            </button>
          </div>
        ) : null}
      </div>
    </FileLinksContext.Provider>
  );
}

function sameEntries(a: MspItem[], b: MspItem[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

const TurnBlock = memo(
  function TurnBlock(props: {
    turn: TurnView;
    gates: GateMap;
    answers: AnswerMap;
    attachments: Record<string, AttachmentView[]>;
    sessionId: string;
    isLast: boolean;
    readOnly: boolean;
    speed: TurnSpeed | null;
    cost: TurnCost | null;
    /** Set when Muse started this turn itself because a monitor woke it. */
    wake: string | null;
  }) {
    const { turn } = props;
    const info = turn.info;
    const closed = useApp((s) => (turn.turnId ? s.prefs.dismissedTurnErrors.includes(`${props.sessionId}:${turn.turnId}`) : false));
    const failed = info?.terminal === "failed" && !info.dismissed && !closed;
    const cancelled = info?.terminal === "cancelled";
    const hasWork = turn.entries.length > 0;
    // Items outside any turn are the user's own `!` commands: shown as they are, never folded into a work log.
    const standalone = !turn.turnId && !turn.prompt;
    // A finished turn folds its work into one line. The rows stay where they were and are only hidden, so
    // finishing never rebuilds the turn under a screen reader: the reply it was reading keeps its place.
    const logged = !turn.running && !standalone && hasWork;
    const keepOpen = useApp((s) => s.prefs.expandWork);
    const [expanded, setExpanded] = useState<boolean | null>(null);
    const workRef = useRef<HTMLDivElement>(null);
    const wasRunning = useRef(turn.running);
    if (wasRunning.current !== turn.running) {
      // Work that has focus when the turn ends stays open rather than hiding what the user is on.
      if (wasRunning.current && expanded === null && workRef.current?.contains(document.activeElement)) {
        setExpanded(true);
      }
      wasRunning.current = turn.running;
    }
    const open = !logged || (expanded ?? (info?.terminal === "failed" || keepOpen));
    const rows: ReactElement[] = [];
    if (logged) {
      rows.push(
        <WorkLogHeader key="log" turn={turn} open={open} onToggle={() => setExpanded(!open)} speed={turn.final ? null : props.speed} />,
      );
    }
    for (const item of turn.entries) {
      rows.push(
        <div key={item.itemId} hidden={!open} className={logged ? "ml-[7px] border-l border-line py-0.5 pl-4" : "py-[3px]"}>
          <Entry item={item} gate={props.gates[item.itemId]} answers={props.answers[item.itemId] ?? null} sessionId={props.sessionId} />
        </div>,
      );
    }
    if (turn.running) {
      rows.push(<LiveStatus key="live" turn={turn} gates={props.gates} />);
    }
    if (logged) {
      rows.push(<DiffChips key="diffs" entries={turn.entries} className="mt-2" sessionId={props.sessionId} />);
    }
    if (turn.final) {
      // Same key and wrapper as when it streamed in as the last entry, so the reply's node carries over.
      rows.push(
        <div key={turn.final.itemId} className={cn("group/final flex flex-col gap-1", rows.length > 0 && "mt-3")}>
          <Entry item={turn.final} answers={null} sessionId={props.sessionId} />
          <TurnFooter turn={turn} speed={props.speed} cost={props.cost} />
        </div>,
      );
    }
    for (const item of turn.after) {
      rows.push(
        <div key={item.itemId} className="py-[3px]">
          <Entry item={item} answers={null} sessionId={props.sessionId} />
        </div>,
      );
    }
    return (
      <article className="flex flex-col gap-3" aria-label="Turn">
        {props.wake ? (
          <p className="flex items-center gap-2 text-xs text-subtle">
            <EyeIcon size={12} className="shrink-0 text-accent-text" aria-hidden="true" />
            <span className="min-w-0 truncate">{props.wake}</span>
            <span aria-hidden="true" className="h-px flex-1 bg-line" />
          </p>
        ) : null}
        {turn.prompt ? (
          <PromptBubble item={turn.prompt} sentAt={sentTime(turn)} files={props.attachments[turn.turnId ?? ""] ?? []} />
        ) : null}
        <div ref={workRef} className="flex flex-col">
          {rows}
        </div>
        {failed && !props.isLast ? (
          // A failure the thread has since moved past stays in the record, but quietly.
          <p className="flex min-w-0 items-center gap-1.5 text-xs text-subtle">
            <WarningCircleIcon size={12} className="shrink-0 text-danger" />
            <span className="shrink-0">Failed</span>
            <span aria-hidden="true">·</span>
            <span className="min-w-0 truncate" title={info?.error?.message ?? undefined}>
              {info?.error?.message ?? "The turn failed."}
            </span>
          </p>
        ) : failed ? (
          <TurnError
            message={info?.error?.message ?? "The turn failed."}
            kind={info?.error?.kind ?? null}
            retryable={info?.error?.retryable ?? true}
            prompt={props.isLast && !props.readOnly ? (turn.prompt?.displayText ?? turn.prompt?.text ?? null) : null}
            sessionId={props.sessionId}
            turnId={turn.turnId}
            readOnly={props.readOnly}
            files={props.attachments[turn.turnId ?? ""] ?? []}
          />
        ) : null}
        {cancelled ? (
          <p className="flex items-center gap-1.5 text-xs text-subtle">
            <SquareIcon weight="fill" size={11} /> Stopped
            {info?.durationMs ? <span className="tabular-nums">after {formatDuration(info.durationMs)}</span> : null}
          </p>
        ) : null}
      </article>
    );
  },
  (a, b) =>
    a.turn.prompt === b.turn.prompt &&
    a.turn.final === b.turn.final &&
    a.turn.info === b.turn.info &&
    a.turn.running === b.turn.running &&
    sameEntries(a.turn.entries, b.turn.entries) &&
    sameEntries(a.turn.after, b.turn.after) &&
    a.gates === b.gates &&
    a.answers === b.answers &&
    a.isLast === b.isLast &&
    a.readOnly === b.readOnly &&
    a.attachments === b.attachments &&
    a.wake === b.wake &&
    // Prices arrive after the catalog loads, so a turn's cost can change with nothing else about it changing.
    a.cost?.cost === b.cost?.cost &&
    a.speed?.tokensPerSecond === b.speed?.tokensPerSecond,
);

function parseTime(iso: string | undefined): number | null {
  if (!iso) {
    return null;
  }
  const time = Date.parse(iso);
  return Number.isNaN(time) ? null : time;
}

/** When the prompt went in: its record time, or when its turn started. */
function sentTime(turn: TurnView): number | null {
  return parseTime(turn.prompt?.recordedAt) ?? turn.info?.startedAt ?? null;
}

/** When the turn finished: the live completion, or its reply's record time for history. */
function completedTime(turn: TurnView): number | null {
  return turn.info?.completedAt ?? parseTime(turn.final?.recordedAt) ?? parseTime(turn.entries[turn.entries.length - 1]?.recordedAt);
}

function Entry(props: { item: MspItem; gate?: Gate; answers: UserInputAnswer[] | null; sessionId?: string }) {
  const { item } = props;
  switch (item.kind) {
    case "agentMessage":
      return (item.text ?? "").trim() ? (
        <div className="py-1">
          <AgentText item={item} streaming={item.status === "inProgress"} />
        </div>
      ) : null;
    case "reasoning":
      return <ReasoningRow item={item} />;
    case "toolCall":
      return <ToolRow item={item} gate={props.gate} answers={props.answers} sessionId={props.sessionId} />;
    case "userShell":
      return <ShellRow item={item} sessionId={props.sessionId} />;
    case "subagent":
      return <SubagentRow item={item} sessionId={props.sessionId} />;
    case "workflow":
      return <WorkflowCard item={item} sessionId={props.sessionId} />;
    case "compaction":
      return <CompactionRow item={item} />;
    case "earlierHistory":
      return <EarlierHistoryRow item={item} />;
    case "sideChat":
      return <SideChatRow item={item} />;
    case "backgroundTerminalCompletion":
      return <BackgroundDoneRow item={item} />;
    case "peerMessage":
      return <PeerMessageRow item={item} />;
    case "systemNotice":
      return <SystemNoticeRow item={item} />;
    case "userMessage":
      return <SteerBubble item={item} />;
    default:
      return <GenericRow item={item} />;
  }
}

function summarize(entries: MspItem[]): string {
  let commands = 0;
  let edits = 0;
  let reads = 0;
  let searches = 0;
  let goals = 0;
  let monitors = 0;
  let other = 0;
  for (const item of entries) {
    if (item.kind === "userShell") {
      commands += 1;
    } else if (item.kind === "toolCall") {
      const kind = toolKind(item.tool, parseArgs(item.args));
      if (kind === "shell") {
        commands += 1;
      } else if (kind === "edit" || kind === "write") {
        edits += 1;
      } else if (kind === "read" || kind === "list") {
        reads += 1;
      } else if (kind === "search" || kind === "web") {
        searches += 1;
      } else if (kind === "goal") {
        goals += 1;
      } else if (kind === "monitor") {
        monitors += 1;
      } else {
        other += 1;
      }
    }
  }
  const parts: string[] = [];
  if (edits) parts.push(plural(edits, "edit", "edits"));
  if (commands) parts.push(plural(commands, "command", "commands"));
  if (reads) parts.push(plural(reads, "file read", "files read"));
  if (searches) parts.push(plural(searches, "search", "searches"));
  if (goals) parts.push(plural(goals, "goal update", "goal updates"));
  if (monitors) parts.push(plural(monitors, "monitor", "monitors"));
  if (other) parts.push(plural(other, "tool call", "tool calls"));
  return parts.join(", ");
}

function turnDuration(turn: TurnView): number | null {
  const info = turn.info;
  if (!info) {
    return null;
  }
  if (info.durationMs !== undefined) {
    return info.durationMs;
  }
  if (info.startedAt !== undefined && info.completedAt !== undefined) {
    return info.completedAt - info.startedAt;
  }
  return null;
}

/**
 * The one line a finished turn's work folds into; the rows it opens are the turn's own, hidden in place.
 * Header grammar via Beautiful UI ToolChips (beautifului.dev), MIT (c) 2026 Shane Levine.
 */
function WorkLogHeader(props: { turn: TurnView; open: boolean; onToggle: () => void; speed?: TurnSpeed | null }) {
  const { turn } = props;
  const duration = turnDuration(turn);
  const summary = summarize(turn.entries);
  return (
    <button
      type="button"
      aria-expanded={props.open}
      onClick={props.onToggle}
      className={cn(
        "group/log -mx-1.5 flex h-8 max-w-full min-w-0 items-center gap-2 overflow-hidden rounded-lg px-1.5 text-sm text-subtle transition-colors duration-100 hover:bg-hover hover:text-muted",
        props.open && "mb-1",
      )}
    >
      <CaretRightIcon size={13} className={cn("shrink-0 transition-transform duration-200 ease-out", props.open && "rotate-90")} />
      <span className="shrink-0">{duration !== null ? `Worked for ${formatDuration(duration)}` : "Work log"}</span>
      {summary ? (
        <>
          <span className="h-3 w-px shrink-0 bg-line-strong" aria-hidden="true" />
          <span className="truncate">{summary}</span>
        </>
      ) : null}
      {props.speed ? (
        <>
          <span className="h-3 w-px shrink-0 bg-line-strong" aria-hidden="true" />
          <span className="shrink-0 tabular-nums">{formatSpeed(props.speed.tokensPerSecond)}</span>
        </>
      ) : null}
    </button>
  );
}

function LiveStatus(props: { turn: TurnView; gates: GateMap }) {
  const now = useNow(1000);
  const { turn } = props;
  const infoRef = useRef(turn.info);
  infoRef.current = turn.info;
  const speed = useSampled(() => streamingSpeed(infoRef.current), true);
  const startedAt = turn.info?.startedAt;
  const elapsed = startedAt ? formatDuration(now - startedAt) : null;
  const waiting = turn.entries.some((e) => props.gates[e.itemId]);
  const last = turn.entries[turn.entries.length - 1];
  const retry = turn.info?.retry;
  let label = "Working";
  if (retry) {
    label = `Retrying (attempt ${retry.nextAttempt} of ${retry.maxAttempts})`;
  } else if (last?.status === "inProgress" && last.kind === "toolCall") {
    const d = describeTool(last);
    label = d.subject && d.mono ? `${d.verb} ${d.subject.split("\n")[0]}` : d.verb;
  } else if (last?.status === "inProgress" && last.kind === "reasoning") {
    label = "Thinking";
  } else if (last?.kind === "agentMessage" && last.status === "inProgress") {
    label = "Writing";
  }
  return (
    // Not a live region: the label and timer change every second. The thread's announcer says what matters.
    <div className="flex h-8 items-center gap-2.5 text-sm">
      {waiting ? (
        <>
          <span className="attention-pulse size-2 rounded-full bg-warn" />
          <span className="font-medium text-warn-text">Waiting for you below</span>
        </>
      ) : (
        <>
          <PixelLoader className="text-accent-text" />
          <Shimmer className="max-w-[60ch] truncate font-medium">{label}</Shimmer>
        </>
      )}
      {elapsed ? <span className="font-mono text-xs text-subtle tabular-nums">{elapsed}</span> : null}
      {speed !== null && !waiting ? (
        <Tip label="Estimated from the text streaming now">
          <span tabIndex={0} className="font-mono text-xs text-subtle tabular-nums">
            ~{formatSpeed(speed)}
          </span>
        </Tip>
      ) : null}
      {retry?.reason ? <span className="truncate text-xs text-subtle">{retry.reason}</span> : null}
    </div>
  );
}

/** Under a reply: when it finished, how long it took when there was no work log, and its output speed. */
function TurnFooter(props: { turn: TurnView; speed: TurnSpeed | null; cost: TurnCost | null }) {
  const duration = turnDuration(props.turn);
  const hasWork = props.turn.entries.length > 0;
  const completed = completedTime(props.turn);
  const dot = (
    <span aria-hidden="true" className="text-line-strong">
      ·
    </span>
  );
  return (
    <div className="flex h-6 items-center gap-1.5 text-xs text-subtle">
      {completed !== null ? (
        <Tip label={`Completed ${formatFullDate(completed)}`}>
          <span tabIndex={0} className="tabular-nums">
            Completed {formatClock(completed)}
          </span>
        </Tip>
      ) : null}
      {duration !== null && !hasWork ? (
        <>
          {completed !== null ? dot : null}
          <span className="tabular-nums">{formatDuration(duration)}</span>
        </>
      ) : null}
      {props.speed ? (
        <>
          {completed !== null || (duration !== null && !hasWork) ? dot : null}
          <Tip label={`${formatTokens(props.speed.outputTokens)} output tokens over ${formatDuration(props.speed.generationMs)} of model calls`}>
            <span tabIndex={0} className="tabular-nums">
              {formatSpeed(props.speed.tokensPerSecond)}
            </span>
          </Tip>
        </>
      ) : null}
      {props.cost && props.cost.cost > 0 ? (
        <>
          {completed !== null || props.speed || (duration !== null && !hasWork) ? dot : null}
          <Tip
            label={`At API rates: ${formatTokens(props.cost.promptTokens)} in (${formatTokens(props.cost.cachedTokens)} cached), ${formatTokens(props.cost.outputTokens)} out${props.cost.complete ? "" : "; a call here has no published price"}`}
          >
            <span tabIndex={0} className="tabular-nums">
              {formatCost(props.cost.cost, props.cost.currency ?? undefined)}
              {props.cost.complete ? "" : "+"}
            </span>
          </Tip>
        </>
      ) : null}
      <span className="ml-0.5 opacity-0 transition-opacity duration-150 group-hover/final:opacity-100 focus-within:opacity-100">
        <CopyButton text={props.turn.final?.text ?? ""} label="Copy reply" />
      </span>
    </div>
  );
}

function PromptBubble(props: { item: MspItem; sentAt: number | null; files?: AttachmentView[] }) {
  const text = props.item.displayText ?? props.item.text ?? "";
  const long = text.split("\n").length > 12 || text.length > 900;
  const [expanded, setExpanded] = useState(false);
  const files = props.files ?? [];
  return (
    <div className="flex justify-end">
      <div className="group/prompt flex max-w-[85%] flex-col items-end gap-1">
        {files.length > 0 ? <SentAttachments files={files} className="pb-0.5" /> : null}
        <div
          className={cn(
            "relative rounded-2xl rounded-tr-md bg-active px-4 py-2.5 text-md leading-relaxed whitespace-pre-wrap text-fg [overflow-wrap:anywhere]",
            long && !expanded && "max-h-[16.5rem] overflow-hidden [mask-image:linear-gradient(to_bottom,black_70%,transparent)]",
          )}
        >
          {text}
        </div>
        <div className="flex h-6 items-center gap-1">
          <div className="flex items-center gap-1 opacity-0 transition-opacity duration-150 group-hover/prompt:opacity-100 focus-within:opacity-100">
            {long ? (
              <button type="button" onClick={() => setExpanded((v) => !v)} className="rounded-md px-1.5 py-0.5 text-xs text-subtle hover:bg-hover hover:text-fg">
                {expanded ? "Show less" : "Show all"}
              </button>
            ) : null}
            <CopyButton text={text} label="Copy prompt" />
          </div>
          {props.sentAt !== null ? (
            <Tip label={`Sent ${formatFullDate(props.sentAt)}`}>
              <span tabIndex={0} className="px-1 text-xs text-subtle tabular-nums">
                {formatClock(props.sentAt)}
              </span>
            </Tip>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * A `!` command Helicon ran itself. Muse never saw it, so its output stays here until the user hands it over.
 */
function ShellRunRow(props: { run: ShellRun; sessionId: string }) {
  const controller = useController();
  const { run } = props;
  const failed = run.exitCode !== 0;
  const output = run.output.trim();
  return (
    <section className="enter-up flex flex-col gap-1.5" aria-label={`Command ${run.command}`}>
      <div className="flex items-center gap-2">
        <TerminalWindowIcon size={14} className="shrink-0 text-subtle" />
        <span className="shrink-0 text-xs text-muted">You ran</span>
        <code className="min-w-0 flex-1 truncate rounded-md bg-sunken px-1.5 py-0.5 font-mono text-xs text-fg">{run.command}</code>
        {failed ? <span className="shrink-0 text-xs text-danger-text">Exit {run.exitCode ?? "?"}</span> : null}
        {run.durationMs !== null ? (
          <span className="shrink-0 text-2xs text-subtle tabular-nums">{formatDuration(run.durationMs)}</span>
        ) : null}
        <Tip label="Muse did not see this run; this sends it the command and its output">
          <Button size="sm" variant="ghost" onClick={() => void controller.sendShellOutput(props.sessionId, run)}>
            Send to Muse
          </Button>
        </Tip>
      </div>
      {output ? <CodeBlock code={run.truncated ? `[earlier output dropped]\n${output}` : output} language="text" className="my-0" /> : null}
    </section>
  );
}

/**
 * What a prompt says while it waits for the stream to echo it back. Only the first of these is still
 * on its way out: once the host has acknowledged the turn the message is sent, and saying otherwise
 * reads as a message that never left.
 */
const ECHO_LABEL: Record<LocalEcho["disposition"], string> = {
  sending: "Sending",
  started: "Sent",
  queued: "Queued",
  steered: "Adding to the current turn",
};

function PendingPrompt(props: { echo: LocalEcho }) {
  const files = props.echo.attachments ?? [];
  return (
    <div className="enter-up flex flex-col items-end gap-1.5">
      {files.length > 0 ? <SentAttachments files={files} className="max-w-[85%] opacity-75" /> : null}
      {props.echo.text ? (
        <div className="max-w-[85%] rounded-2xl rounded-tr-md bg-active px-4 py-2.5 text-md leading-relaxed whitespace-pre-wrap text-fg opacity-75">
          {props.echo.text}
        </div>
      ) : null}
      <span className="flex items-center gap-1.5 text-2xs text-subtle">
        <Spinner size={9} />
        {ECHO_LABEL[props.echo.disposition]}
      </span>
    </div>
  );
}

function TurnError(props: {
  message: string;
  /** The host's error kind, e.g. `authRequired`; null when the host gave none. */
  kind: string | null;
  retryable: boolean;
  prompt: string | null;
  sessionId: string;
  turnId: string | null;
  readOnly: boolean;
  /** The failed turn's own files: what the provider rejects in the same words, and what a retry has to carry. */
  files: AttachmentView[];
}) {
  const controller = useController();
  const hadImages = props.files.some((file) => file.kind === "image");
  // Some failures are about the thread, not the turn: retrying sends the same history and fails the same way.
  const stuck = stuckThread(props.message, { ownImages: hadImages });
  // Muse reports signing out as not retryable, but signing in is exactly what makes the same prompt work.
  const login = !stuck && signedOut({ kind: props.kind, message: props.message });
  /**
   * Sends the prompt again with the same files: their bytes live on the server, so they are read back
   * rather than left out, which would quietly ask the model a different question. Nothing goes at all
   * when they cannot be read, so the notice stays up and the choice is still the user's.
   */
  const again = (send: (files: { attachments: OutgoingAttachment[]; previews: EchoAttachment[] }) => Promise<unknown>) => {
    void (async () => {
      let carried: { attachments: OutgoingAttachment[]; previews: EchoAttachment[] } = { attachments: [], previews: [] };
      if (props.files.length > 0) {
        try {
          const read = await refetchAttachments(props.files);
          carried = { attachments: read.map(toOutgoing), previews: read.map(toPreview) };
        } catch (error) {
          controller.toast(
            "error",
            "Could not read the attached files again",
            error instanceof Error ? error.message : String(error),
          );
          return;
        }
      }
      controller.dismissTurnError(props.sessionId, props.turnId);
      await send(carried);
    })();
  };
  return (
    <div className="flex items-start gap-3 rounded-xl bg-danger-soft px-3.5 py-3" role="alert">
      <WarningCircleIcon size={16} className="mt-0.5 shrink-0 text-danger" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-fg">
          {stuck ? "This thread cannot go on as it is" : login ? "Sign in to Muse Code first" : "This turn failed"}
        </p>
        <p className="mt-0.5 text-sm break-words text-muted">
          {stuck
            ? stuck.message
            : login
              ? "The muse CLI this project runs on is not signed in. Run this in a terminal (on the remote machine for an SSH project) and sign in with an account that has a Muse Code plan, then retry. Still signed out after that? Quit and reopen Helicon."
              : props.message}
        </p>
        {login ? (
          <div className="mt-2 flex items-center gap-2 rounded-lg bg-sunken py-1 pr-1 pl-3 font-mono text-xs text-fg shadow-[0_0_0_1px_var(--border)]">
            <span className="min-w-0 flex-1 truncate">muse login</span>
            <CopyButton text="muse login" label="Copy command" />
          </div>
        ) : null}
        {stuck || login ? <p className="mt-1 text-2xs break-words text-subtle">{props.message}</p> : null}
        {login ? (
          <p className="mt-1.5">
            <HelpLink href={MUSE_HELP_URL}>Sign-in help</HelpLink>
          </p>
        ) : null}
      </div>
      {stuck && stuck.remedy !== "none" && !props.readOnly ? (
        <Tip
          label={
            stuck.remedy === "compact"
              ? "Summarize the history, leave behind what cannot be sent, and carry on"
              : "Start a thread beside this one, without the history that cannot be sent"
          }
        >
          <Button
            size="sm"
            onClick={() => {
              // These failures come back non-retryable, but repairing the history is what changes that:
              // the prompt goes again once the thread can carry it.
              // Either way the files go too: an older unreadable image is what makes this thread stuck, and
              // the turn being retried may carry perfectly good files of its own.
              const prompt = props.prompt;
              again((files) =>
                stuck.remedy === "compact"
                  ? controller.compactAndRetry(props.sessionId, prompt, files)
                  : controller.freshThread(props.sessionId, prompt, files),
              );
            }}
          >
            {stuck.remedy === "compact" ? (
              <>
                <ArrowCounterClockwiseIcon size={13} /> {props.prompt ? "Compact and retry" : "Compact this thread"}
              </>
            ) : (
              <>
                <NotePencilIcon size={13} /> Start a fresh thread
              </>
            )}
          </Button>
        </Tip>
      ) : stuck && stuck.remedy === "none" && !props.readOnly ? (
        <Tip label="If the image you sent opens fine elsewhere, an older one in this thread is the unreadable one">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              // No retry here: the prompt would go back without its image, quietly asking something else.
              controller.dismissTurnError(props.sessionId, props.turnId);
              void controller.compactAndRetry(props.sessionId, null);
            }}
          >
            <ArrowCounterClockwiseIcon size={13} /> Compact the thread
          </Button>
        </Tip>
      ) : props.prompt && (props.retryable || login) ? (
        <Tip label={login ? "Send the same prompt again once you have signed in" : "Send the same prompt again"}>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => again((files) => controller.retryTurn(props.sessionId, props.prompt as string, files))}
          >
            <ArrowCounterClockwiseIcon size={13} /> Retry
          </Button>
        </Tip>
      ) : null}
      <Tip label="Dismiss">
        <IconButton size="sm" label="Dismiss this error" className="-mt-0.5 -mr-1 shrink-0" onClick={() => controller.dismissTurnError(props.sessionId, props.turnId)}>
          <XIcon size={13} />
        </IconButton>
      </Tip>
    </div>
  );
}

function LoadError(props: { sessionId: string; message: string | null }) {
  const controller = useController();
  const login = signedOut({ message: props.message });
  return (
    <div className="flex items-start gap-3 rounded-xl bg-danger-soft px-3.5 py-3" role="alert">
      <WarningCircleIcon size={16} className="mt-0.5 shrink-0 text-danger" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-fg">{login ? "Sign in to Muse Code to open this thread" : "Could not open this thread"}</p>
        <p className="mt-0.5 text-sm break-words text-muted">
          {login
            ? "Opening this thread needs a signed-in Muse, and the muse CLI this project runs on is not signed in. Run this in a terminal (on the remote machine for an SSH project, inside WSL if Helicon uses WSL), sign in, then try again."
            : (props.message ?? "Muse did not answer.")}
        </p>
        {login ? (
          <>
            <div className="mt-2 flex items-center gap-2 rounded-lg bg-sunken py-1 pr-1 pl-3 font-mono text-xs text-fg shadow-[0_0_0_1px_var(--border)]">
              <span className="min-w-0 flex-1 truncate">muse login</span>
              <CopyButton text="muse login" label="Copy command" />
            </div>
            <p className="mt-1 text-2xs break-words text-subtle">{props.message}</p>
            <p className="mt-1.5">
              <HelpLink href={MUSE_HELP_URL}>Sign-in help</HelpLink>
            </p>
          </>
        ) : null}
      </div>
      <Button size="sm" onClick={() => void controller.loadThread(props.sessionId)}>
        Try again
      </Button>
    </div>
  );
}

function EmptyThread() {
  return (
    <div className="flex flex-col items-center pt-[14vh] text-center">
      <p className="font-display text-2xl text-fg">A clean slate</p>
      <p className="mt-2 max-w-[44ch] text-sm text-muted">
        Describe the change you want. Muse reads the project, runs what it needs, and asks before anything risky.
      </p>
    </div>
  );
}

function TranscriptSkeleton() {
  return (
    <div className="flex flex-col gap-8" aria-busy="true" aria-label="Loading thread">
      {[0, 1].map((i) => (
        <div key={i} className="flex flex-col gap-3">
          <div className="ml-auto h-10 w-[46%] rounded-2xl bg-hover" />
          <div className="h-3 w-[30%] rounded bg-hover" />
          <div className="h-3 w-[88%] rounded bg-hover" />
          <div className="h-3 w-[72%] rounded bg-hover" />
        </div>
      ))}
    </div>
  );
}
