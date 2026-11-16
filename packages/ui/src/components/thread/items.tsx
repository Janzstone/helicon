import { ArrowLineDownIcon, EyeIcon, ArrowsInIcon, CaretRightIcon, ChatCircleDotsIcon, FileMagnifyingGlassIcon, FilePlusIcon, FileTextIcon, GlobeIcon, ListChecksIcon, MagnifyingGlassIcon, PaperPlaneRightIcon, PencilSimpleLineIcon, RobotIcon, StopCircleIcon, TargetIcon, TerminalWindowIcon, TreeStructureIcon, WarningCircleIcon, WrenchIcon } from "../ui/icons.js";
import { Popover } from "radix-ui";
import { memo, useMemo, useRef, useState, type ReactNode } from "react";
import { useApp, useController } from "../../app/context.js";
import { fileTarget } from "../../model/files.js";
import {
  basename,
  describeTool,
  diffLines,
  diffStats,
  extractDiff,
  extractRevertSteps,
  formatDuration,
  formatTokens,
  humanize,
  lastLine,
  mergeDiffLines,
  parseArgs,
  plural,
  withoutDiffEcho,
  type DiffLine,
  type DiffView,
  type RevertStep,
  type ToolKind,
} from "../../model/format.js";
import type { MspItem, OutputRef, UserInputAnswer } from "../../types.js";
import { CodeBlock, Markdown, highlightCode, languageFromPath } from "../ui/Markdown.js";
import { Button, IconButton, Shimmer, Spinner, cn } from "../ui/primitives.js";
import { Collapse } from "../ui/sourced.js";
import { FLOATING, Tip } from "../ui/overlays.js";

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "g");
const TERMINAL_FAILURES = new Set(["failed", "rejected", "cancelled", "timedOut"]);

export type Gate = "approval" | "input";

const TOOL_ICONS: Record<ToolKind, (props: { size: number; className?: string }) => ReactNode> = {
  shell: (p) => <TerminalWindowIcon {...p} />,
  read: (p) => <FileTextIcon {...p} />,
  edit: (p) => <PencilSimpleLineIcon {...p} />,
  write: (p) => <FilePlusIcon {...p} />,
  search: (p) => <MagnifyingGlassIcon {...p} />,
  list: (p) => <TreeStructureIcon {...p} />,
  web: (p) => <GlobeIcon {...p} />,
  question: (p) => <ChatCircleDotsIcon {...p} />,
  plan: (p) => <ListChecksIcon {...p} />,
  agent: (p) => <RobotIcon {...p} />,
  goal: (p) => <TargetIcon {...p} />,
  monitor: (p) => <EyeIcon {...p} />,
  generic: (p) => <WrenchIcon {...p} />,
};

/**
 * One work-log row: icon, label, an inline chip for what it acted on, and an expandable body.
 * Hovering swaps the icon for the disclosure chevron.
 * Layout via Beautiful UI ToolChips (beautifului.dev), MIT (c) 2026 Shane Levine.
 * Adapted: Helicon tokens, Phosphor icons, real tool data, Collapse body.
 */
function Row(props: {
  icon: ReactNode;
  label: ReactNode;
  chip?: ReactNode;
  mono?: boolean;
  detail?: ReactNode;
  trailing?: ReactNode;
  body?: ReactNode;
  preview?: ReactNode;
  tone?: "default" | "warn" | "danger";
  /** Starts expanded, for output the user asked to see. */
  defaultOpen?: boolean;
  /** Controls beside the row, kept outside its disclosure button so each stays its own control. */
  actions?: ReactNode;
}) {
  const [open, setOpen] = useState(props.defaultOpen ?? false);
  const expandable = Boolean(props.body);
  const toggle = (
    <button
      type="button"
      disabled={!expandable}
      aria-expanded={expandable ? open : undefined}
      onClick={() => setOpen((v) => !v)}
      className={cn(
        "group/row flex h-8 min-w-0 items-center gap-2 overflow-hidden rounded-lg px-1.5 text-left transition-colors duration-100 enabled:hover:bg-hover disabled:cursor-default",
        props.actions ? "flex-1" : "-mx-1.5 w-[calc(100%+0.75rem)]",
      )}
    >
        <span
          className={cn(
            "relative flex size-4 shrink-0 items-center justify-center",
            props.tone === "warn" ? "text-warn" : props.tone === "danger" ? "text-danger" : "text-subtle",
          )}
        >
          <span
            className={cn(
              "flex transition-opacity duration-100",
              expandable && "group-hover/row:opacity-0 group-focus-visible/row:opacity-0",
              expandable && open && "opacity-0",
            )}
          >
            {props.icon}
          </span>
          {expandable ? (
            <CaretRightIcon
              size={13}
              className={cn(
                "absolute text-subtle opacity-0 transition-[opacity,transform] duration-150 ease-out group-hover/row:opacity-100 group-focus-visible/row:opacity-100",
                open && "rotate-90 opacity-100",
              )}
            />
          ) : null}
        </span>
        <span className={cn("shrink-0 text-sm font-medium", props.tone === "danger" ? "text-danger-text" : "text-fg")}>{props.label}</span>
        {props.chip ? (
          <span
            className={cn(
              "min-w-0 truncate rounded-md bg-sunken px-1.5 py-[3px] text-xs leading-4 text-muted shadow-[0_0_0_1px_var(--border)]",
              props.mono && "font-mono text-[11.5px]",
            )}
          >
            {props.chip}
          </span>
        ) : null}
        {props.detail ? <span className="min-w-0 truncate text-sm text-subtle">{props.detail}</span> : null}
        <span className="min-w-2 flex-1" />
        {props.trailing}
    </button>
  );
  return (
    <div className="enter-up">
      {props.actions ? (
        <div className="-mx-1.5 flex w-[calc(100%+0.75rem)] min-w-0 items-center gap-1">
          {toggle}
          <div className="flex shrink-0 items-center gap-0.5 pr-0.5">{props.actions}</div>
        </div>
      ) : (
        toggle
      )}
      {!open && props.preview ? <div className="ml-6 pb-1">{props.preview}</div> : null}
      {expandable ? (
        <Collapse open={open}>
          <div className="mt-0.5 mb-2 ml-[7px] flex flex-col gap-2 border-l border-line py-0.5 pl-[17px]">{props.body}</div>
        </Collapse>
      ) : null}
    </div>
  );
}

/** How much stored output one "show more" loads, and the most a row will hold before sending you to the file. */
const OUTPUT_PAGE_LIMIT = 4 * 1024 * 1024;

/** Where a truncated output's full bytes can be read from, when Muse kept them. */
export interface StoredOutput {
  sessionId: string;
  itemId: string;
  ref: OutputRef;
}

export function OutputBlock(props: { text: string; truncated?: boolean; label?: string; stored?: StoredOutput | null }) {
  const controller = useController();
  const [full, setFull] = useState<{ text: string; next: number; eof: boolean } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shown = full ? full.text : props.text;
  // The shown bytes only change when the page does; stripping them again every flush would cost the whole log.
  const clean = useMemo(() => shown.replace(ANSI, "").replace(/\s+$/, ""), [shown]);
  if (!clean) {
    return null;
  }
  const stored = props.truncated && props.stored?.ref.availability !== "unavailable" ? props.stored : null;
  // Pages until the end or the cap, so a runaway log cannot freeze the thread it is shown in.
  const load = async () => {
    if (!stored || loading) {
      return;
    }
    setLoading(true);
    setError(null);
    try {
      let text = full?.text ?? "";
      let offset = full?.next ?? 0;
      let eof = false;
      while (!eof && offset < OUTPUT_PAGE_LIMIT + (full?.next ?? 0)) {
        const page = await controller.readOutput(stored.sessionId, stored.itemId, stored.ref.id, offset);
        text += page.encoding === "base64" ? "[binary output]" : page.content;
        offset = page.offsetBytes + page.byteLen;
        eof = page.eof || page.byteLen === 0;
      }
      setFull({ text, next: offset, eof });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setLoading(false);
    }
  };
  const total = stored?.ref.byteLen;
  return (
    <div className="overflow-hidden rounded-lg bg-sunken shadow-[0_0_0_1px_var(--border)]">
      {props.label ? <div className="px-3 pt-2 font-sans text-2xs font-medium text-subtle">{props.label}</div> : null}
      <pre className="max-h-72 overflow-x-hidden overflow-y-auto px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap text-muted [overflow-wrap:anywhere]">
        {clean}
      </pre>
      {props.truncated && !full?.eof ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line px-3 py-1.5">
          <p className="min-w-0 flex-1 text-2xs text-subtle">
            {error ? (
              <span className="text-danger-text">{error}</span>
            ) : full ? (
              `Showing the first ${formatBytes(full.next)}${total ? ` of ${formatBytes(total)}` : ""}.`
            ) : stored ? (
              `Output was trimmed here${total ? `; the full log is ${formatBytes(total)}` : ""}.`
            ) : (
              "Output was trimmed here; the full log is in the Muse session."
            )}
          </p>
          {stored ? (
            <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" loading={loading} onClick={() => void load()}>
              {full ? "Show more" : "Show full output"}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The stored-output handle on an item, when its view was truncated and Muse kept the rest. */
function storedOutput(item: MspItem, sessionId: string | undefined): StoredOutput | null {
  const ref = item.outputRef;
  return sessionId && item.truncated && ref && typeof ref.id === "string" ? { sessionId, itemId: item.itemId, ref } : null;
}

/**
 * Moving a running tool call to the background, or stopping one that already runs there. Muse names the task by
 * the tool call's own item id. Hidden on threads another client holds, where Muse would refuse the command.
 */
/** Opens a file a tool touched in the file viewer beside the thread. */
function OpenFileAction(props: { sessionId: string; path: string }) {
  const controller = useController();
  const cwd = useApp((s) => s.sessions[props.sessionId]?.cwd ?? null);
  const target = cwd ? fileTarget(props.path, cwd) : null;
  if (!target) {
    return null;
  }
  return (
    <Tip label="Open in files">
      <IconButton size="sm" label={`Open ${target.path}`} onClick={() => controller.openFile(props.sessionId, target.path, target.line)}>
        <FileMagnifyingGlassIcon size={13} />
      </IconButton>
    </Tip>
  );
}

function TaskActions(props: { item: MspItem; sessionId: string }) {
  const controller = useController();
  const { item, sessionId } = props;
  const readOnly = useApp((s) => s.threads[sessionId]?.readOnly ?? true);
  const busy = useApp((s) => Boolean(s.busy[`task:${sessionId}:${item.itemId}`]));
  if (readOnly || item.status !== "inProgress") {
    return null;
  }
  return item.background ? (
    <Button
      size="sm"
      variant="ghost"
      className="h-6 px-2 text-xs"
      loading={busy}
      onClick={() => void controller.taskAction(sessionId, "stop", item.itemId)}
    >
      <StopCircleIcon size={12} /> Stop
    </Button>
  ) : (
    <Button
      size="sm"
      variant="ghost"
      className="h-6 px-2 text-xs"
      loading={busy}
      title="Let this keep running while Muse moves on"
      onClick={() => void controller.taskAction(sessionId, "background", item.itemId)}
    >
      <ArrowLineDownIcon size={12} /> Background
    </Button>
  );
}

export function DiffBlock(props: { diff: DiffView }) {
  // No header: the receipt row above, or the hovered chip, already names the file and its totals.
  // A diff is code, so it gets the same colours a code block does; the language comes from the file's name.
  return <DiffCard lines={diffLines(props.diff)} language={languageFromPath(props.diff.path)} />;
}

/** Every change to one hovered file as a single continuous card, in turn order. */
function FileDiffCard(props: { diffs: DiffView[] }) {
  return <DiffCard lines={mergeDiffLines(props.diffs)} language={languageFromPath(props.diffs[0]?.path ?? null)} />;
}

function DiffCard(props: { lines: DiffLine[]; language: string | null }) {
  const { lines, language } = props;
  return (
    <div className="overflow-hidden rounded-lg bg-sunken shadow-[0_0_0_1px_var(--border)]">
      <div className="max-h-80 overflow-x-hidden overflow-y-auto py-1 font-mono text-xs leading-[1.65]">
        {lines.map((line, i) => (
          <div
            key={i}
            className={cn(
              "flex pr-3",
              line.kind === "add" && "bg-diff-add",
              line.kind === "del" && "bg-diff-del",
              line.kind === "meta" && "text-subtle",
            )}
          >
            <span
              className={cn(
                "w-6 shrink-0 text-center select-none",
                line.kind === "add" ? "text-ok-text" : line.kind === "del" ? "text-danger-text" : "text-subtle",
              )}
              aria-hidden="true"
            >
              {line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}
            </span>
            <span
              className={cn(
                "min-w-0 flex-1 whitespace-pre-wrap [overflow-wrap:anywhere]",
                line.kind === "ctx" || line.kind === "meta" ? "text-muted" : "text-fg",
              )}
            >
              {line.kind === "meta" ? line.text || " " : <DiffText text={line.text} language={language} />}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** One diff line's code, coloured when the file's language is one sugar-high knows. */
const DiffText = memo(function DiffText(props: { text: string; language: string | null }) {
  const html = useMemo(() => highlightCode(props.text, props.language), [props.text, props.language]);
  if (html === null) {
    return <>{props.text || " "}</>;
  }
  return <span dangerouslySetInnerHTML={{ __html: html }} />;
});

export function DiffCount(props: { added: number; removed: number }) {
  return (
    <span className="shrink-0 font-mono text-2xs tabular-nums">
      <span className="text-ok-text">+{props.added}</span> <span className="text-danger-text">-{props.removed}</span>
    </span>
  );
}

export interface FileChanges {
  path: string;
  added: number;
  removed: number;
  diffs: DiffView[];
  /** Changes made to this file in all, counting the ones already settled and left out of `diffs`. */
  total: number;
  /** What reversing every change takes, latest first; null when any of them cannot be reversed from its arguments. */
  steps: RevertStep[] | null;
}

/**
 * The files a list of items edited, one entry per path, in the order they were first touched. Calls that failed
 * changed nothing and are left out. `settled` says how many of a file's first changes to skip (kept or undone).
 */
export function collectFileChanges(items: Iterable<MspItem>, settled?: (path: string) => number): FileChanges[] {
  const byPath = new Map<string, FileChanges>();
  for (const item of items) {
    if (item.kind !== "toolCall" || item.status === "failed" || item.failureKind) {
      continue;
    }
    const diff = extractDiff(item);
    if (!diff) {
      continue;
    }
    const key = diff.path ?? item.itemId;
    const entry = byPath.get(key) ?? { path: diff.path ?? "file", added: 0, removed: 0, diffs: [], total: 0, steps: [] };
    byPath.set(key, entry);
    entry.total += 1;
    if (diff.path && entry.total <= (settled?.(diff.path) ?? 0)) {
      continue;
    }
    const stats = diffStats(diff);
    entry.added += stats.added;
    entry.removed += stats.removed;
    entry.diffs.push(diff);
    const steps = extractRevertSteps(item);
    entry.steps = entry.steps && steps && diff.path ? [...steps.slice().reverse(), ...entry.steps] : null;
  }
  return [...byPath.values()].filter((entry) => entry.diffs.length > 0);
}

/**
 * The files a turn changed, as chips; hover or focus one to preview its diff.
 * via Beautiful UI ToolChips file-diff chips (beautifului.dev), MIT (c) 2026 Shane Levine.
 * Adapted: Radix Popover for keyboard access instead of a hand-positioned portal.
 */
export function DiffChips(props: { entries: MspItem[]; className?: string; sessionId?: string }) {
  const files = useMemo(() => collectFileChanges(props.entries), [props.entries]);
  if (files.length === 0) {
    return null;
  }
  return (
    <div className={cn("flex max-w-full flex-wrap gap-1.5", props.className)} aria-label="Files changed">
      {files.map((file) => (
        <DiffChip key={file.path} file={file} sessionId={props.sessionId} />
      ))}
    </div>
  );
}

function DiffChip(props: { file: FileChanges; sessionId?: string }) {
  const controller = useController();
  const cwd = useApp((s) => (props.sessionId ? (s.sessions[props.sessionId]?.cwd ?? null) : null));
  const target = cwd ? fileTarget(props.file.path, cwd) : null;
  const [open, setOpen] = useState(false);
  const timer = useRef<number | null>(null);
  const show = () => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
    }
    setOpen(true);
  };
  const hide = () => {
    timer.current = window.setTimeout(() => setOpen(false), 140);
  };
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          onMouseEnter={show}
          onMouseLeave={hide}
          title={props.file.path}
          className="inline-flex h-7 max-w-full items-center gap-2 rounded-lg bg-raised px-2 font-mono text-[11.5px] text-fg shadow-btn transition-colors duration-100 hover:bg-hover data-[state=open]:bg-hover"
        >
          <PencilSimpleLineIcon size={12} className="shrink-0 text-subtle" />
          <span className="min-w-0 truncate">{basename(props.file.path)}</span>
          <DiffCount added={props.file.added} removed={props.file.removed} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="start"
          sideOffset={6}
          {...FLOATING}
          onMouseEnter={show}
          onMouseLeave={hide}
          onOpenAutoFocus={(event) => event.preventDefault()}
          className="pop z-[var(--z-dropdown)] flex max-h-[60vh] w-[min(560px,calc(100dvw-32px))] flex-col gap-2 overflow-y-auto rounded-xl bg-raised p-2 shadow-pop outline-none"
        >
          {target && props.sessionId ? (
            <div className="flex items-center justify-between gap-2 px-1">
              <span className="min-w-0 truncate font-mono text-2xs text-subtle">{target.path}</span>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 shrink-0 px-2 text-xs"
                onClick={() => {
                  setOpen(false);
                  controller.openFile(props.sessionId!, target.path);
                }}
              >
                <FileMagnifyingGlassIcon size={12} /> Open file
              </Button>
            </div>
          ) : null}
          <FileDiffCard diffs={props.file.diffs} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function QuestionSummary(props: { item: MspItem; answers: UserInputAnswer[] | null }) {
  const args = parseArgs(props.item.args);
  const questions = args && Array.isArray(args["questions"]) ? (args["questions"] as Record<string, unknown>[]) : [];
  return (
    <div className="flex flex-col gap-2 text-sm">
      {questions.map((q, i) => {
        const id = typeof q["id"] === "string" ? q["id"] : String(i);
        const answer = props.answers?.find((a) => a.questionId === id);
        const chosen = answer?.selectedLabel ?? answer?.selectedLabels?.join(", ") ?? answer?.freeText ?? null;
        return (
          <div key={id}>
            <p className="text-muted">{typeof q["question"] === "string" ? q["question"] : "Question"}</p>
            <p className="mt-0.5 font-medium text-fg">{chosen ?? (props.answers ? "Skipped" : "Waiting for your answer")}</p>
          </div>
        );
      })}
    </div>
  );
}

export const ToolRow = memo(function ToolRow(props: { item: MspItem; gate?: Gate; answers?: UserInputAnswer[] | null; sessionId?: string }) {
  const { item } = props;
  const d = useMemo(() => describeTool(item), [item]);
  const diff = useMemo(() => (d.kind === "edit" || d.kind === "write" ? extractDiff(item) : null), [d.kind, item]);
  const running = item.status === "inProgress";
  const failed = TERMINAL_FAILURES.has(item.status);
  const stats = diff ? diffStats(diff) : null;
  const Icon = TOOL_ICONS[d.kind];
  const args = parseArgs(item.args);

  let trailing: ReactNode = null;
  if (props.gate) {
    trailing = (
      <span className="shrink-0 text-xs font-medium text-warn-text">
        {props.gate === "approval" ? "Waiting for approval" : "Waiting for your answer"}
      </span>
    );
  } else if (running) {
    trailing = item.background ? (
      <span className="flex shrink-0 items-center gap-1.5 text-xs text-subtle">
        <Spinner size={12} className="text-accent-text" label="Running in the background" /> In the background
      </span>
    ) : (
      <Spinner size={12} className="text-accent-text" label="Running" />
    );
  } else if (failed) {
    trailing = <span className="shrink-0 text-xs text-danger-text">{humanize(item.status)}</span>;
  } else if (stats) {
    trailing = <DiffCount added={stats.added} removed={stats.removed} />;
  }

  const body: ReactNode[] = [];
  if (d.note) {
    body.push(
      <p key="note" className="text-xs text-muted">
        {d.note}
      </p>,
    );
  }
  if (d.kind === "question") {
    body.push(<QuestionSummary key="q" item={item} answers={props.answers ?? null} />);
  } else {
    if (d.kind === "shell" && d.subject && d.subject.includes("\n")) {
      body.push(<CodeBlock key="cmd" code={d.subject} language="bash" className="my-0" />);
    }
    if (diff) {
      body.push(<DiffBlock key="diff" diff={diff} />);
    }
    if (item.visibleOutput) {
      // The runtime echoes the edit below its result header, unaligned; the diff above already shows
      // that change properly, so only whatever else the output carried stays visible.
      const stripped =
        diff && (d.kind === "edit" || d.kind === "write") && !item.truncated ? withoutDiffEcho(item.visibleOutput) : null;
      const text = stripped ?? item.visibleOutput;
      if (text.trim().length > 0) {
        body.push(
          <OutputBlock
            key="out"
            text={text}
            truncated={item.truncated}
            label={d.kind === "shell" ? "Output" : undefined}
            stored={storedOutput(item, props.sessionId)}
          />,
        );
      }
    }
    if (d.kind === "generic" && args) {
      body.push(<CodeBlock key="args" code={JSON.stringify(args, null, 2)} language="json" className="my-0" />);
    }
  }
  if (item.failureReason) {
    body.push(
      <p key="fail" className="flex items-start gap-1.5 text-xs text-danger-text">
        <WarningCircleIcon size={13} className="mt-px shrink-0" /> {item.failureReason}
      </p>,
    );
  }

  const tail = running && d.kind === "shell" ? lastLine(item.visibleOutput) : null;
  return (
    <Row
      icon={<Icon size={14} />}
      tone={props.gate ? "warn" : failed ? "danger" : "default"}
      label={d.verb}
      chip={d.subject ? d.subject.split("\n")[0] : undefined}
      mono={d.mono}
      trailing={trailing}
      body={body.length > 0 ? body : undefined}
      preview={tail ? <p className="truncate font-mono text-2xs text-subtle">{tail}</p> : undefined}
      actions={
        props.sessionId && running && !props.gate ? (
          <TaskActions item={item} sessionId={props.sessionId} />
        ) : props.sessionId && !running && (d.kind === "read" || d.kind === "edit" || d.kind === "write") && d.subject ? (
          <OpenFileAction sessionId={props.sessionId} path={d.subject.split("\n")[0]!} />
        ) : undefined
      }
    />
  );
});

export const ReasoningRow = memo(function ReasoningRow(props: { item: MspItem }) {
  const { item } = props;
  const summary = (item.summary ?? []).filter((part) => part.trim().length > 0);
  const text = summary.length > 0 ? summary.join("\n\n") : (item.text ?? "");
  const running = item.status === "inProgress";
  const headline =
    (summary[summary.length - 1] ?? text)
      .split("\n")
      .find((l) => l.trim())
      ?.replace(/\*\*/g, "") ?? "";
  return (
    <Row
      icon={running ? <Spinner size={11} /> : <span className="size-1.5 rounded-full bg-[var(--border-strong)]" />}
      label={running ? <Shimmer>Thinking</Shimmer> : <span className="text-muted">Thought</span>}
      detail={headline || undefined}
      body={text ? <Markdown text={text} className="text-sm text-muted" /> : undefined}
    />
  );
});

export const ShellRow = memo(function ShellRow(props: { item: MspItem; sessionId?: string }) {
  const { item } = props;
  const running = item.status === "inProgress";
  const code = item.exitCode;
  // A command Muse could not start (no sandbox, say) fails without an exit code; its output says why.
  const failed = (code !== undefined && code !== 0) || TERMINAL_FAILURES.has(item.status);
  // Muse 1.1.1 has no sandbox for `!` commands under `muse serve` on WSL, though the agent's own shell tool works there.
  const noSandbox = failed && /shell sandbox is unavailable/i.test(item.visibleOutput ?? "");
  return (
    <Row
      icon={<TerminalWindowIcon size={14} />}
      label="You ran"
      chip={item.commandText ?? "a command"}
      mono
      defaultOpen
      tone={failed ? "danger" : "default"}
      trailing={
        running ? (
          <Spinner size={12} className="text-accent-text" label="Running" />
        ) : code !== undefined && code !== 0 ? (
          <span className="text-xs text-danger-text">Exit {code}</span>
        ) : failed ? (
          <span className="text-xs text-danger-text">Not run</span>
        ) : item.durationMs ? (
          <span className="text-2xs text-subtle tabular-nums">{formatDuration(item.durationMs)}</span>
        ) : null
      }
      body={
        item.visibleOutput ? (
          <>
            <OutputBlock text={item.visibleOutput} truncated={item.truncated} stored={storedOutput(item, props.sessionId)} />
            {noSandbox ? (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <p className="text-xs text-pretty text-muted">
                  Muse can't sandbox <code className="font-mono">!</code> commands when Helicon hosts it, so this one never started. The
                  agent's own shell works.
                </p>
                {props.sessionId && item.commandText ? <AskToRun sessionId={props.sessionId} command={item.commandText} /> : null}
              </div>
            ) : null}
          </>
        ) : undefined
      }
    />
  );
});

const BACKGROUND_DONE: Record<string, string> = {
  completed: "Background command finished",
  failed: "Background command failed",
  cancelled: "Background command stopped",
  timedOut: "Background command timed out",
  rejected: "Background command declined",
};

/** A command the agent sent to the background has ended (Muse 1.4.12+). It often lands after the turn's reply. */
export function BackgroundDoneRow(props: { item: MspItem }) {
  const done = props.item.backgroundTerminalCompletion;
  if (!done) {
    return <GenericRow item={props.item} />;
  }
  const failed = TERMINAL_FAILURES.has(done.terminalStatus) && done.terminalStatus !== "cancelled";
  return (
    <Row
      icon={<TerminalWindowIcon size={14} />}
      label={BACKGROUND_DONE[done.terminalStatus] ?? "Background command ended"}
      chip={done.command || undefined}
      mono
      tone={failed ? "danger" : "default"}
      body={done.output ? <OutputBlock text={done.output} truncated={done.outputTruncated} /> : undefined}
    />
  );
}

/** A message another session sent to this one. The sender label is already worded by the host. */
export function PeerMessageRow(props: { item: MspItem }) {
  const message = props.item.peerMessage;
  if (!message) {
    return <GenericRow item={props.item} />;
  }
  return (
    <Row
      icon={<ChatCircleDotsIcon size={14} />}
      label="Message from another session"
      detail={message.senderLabel}
      body={message.body ? <Markdown text={message.body} className="text-sm" /> : undefined}
    />
  );
}

/** Something Muse itself wants to tell the user: a hook, a scheduled prompt, a paused workflow. */
export function SystemNoticeRow(props: { item: MspItem }) {
  const { item } = props;
  const severity = item.noticeSeverity;
  const text = (item.text ?? item.fallbackText ?? "").trim();
  return (
    <Row
      icon={severity === "error" || severity === "warning" ? <WarningCircleIcon size={14} /> : <WrenchIcon size={14} />}
      label="Notice from Muse"
      detail={text.split("\n")[0]}
      tone={severity === "error" ? "danger" : severity === "warning" ? "warn" : "default"}
      body={text ? <Markdown text={text} className="text-sm" /> : undefined}
    />
  );
}

function AskToRun(props: { sessionId: string; command: string }) {
  const controller = useController();
  const [sending, setSending] = useState(false);
  // One ask per click: a second send would run the same command twice.
  const ask = () => {
    if (sending) {
      return;
    }
    setSending(true);
    void controller.askToRun(props.sessionId, props.command).finally(() => setSending(false));
  };
  return (
    <Button size="sm" variant="secondary" loading={sending} onClick={ask}>
      Ask Muse to run it
    </Button>
  );
}

export const SubagentRow = memo(function SubagentRow(props: { item: MspItem; sessionId?: string }) {
  const { item } = props;
  const running = item.status === "inProgress";
  const result = item.result?.summary ?? item.result?.text ?? null;
  // Muse addresses a subagent by its durable id; a build that does not report one gets no controls.
  const controls = props.sessionId && item.subagentId ? <SubagentControls item={item} sessionId={props.sessionId} subagentId={item.subagentId} /> : null;
  return (
    <Row
      icon={<RobotIcon size={14} />}
      label={running ? "Subagent working on" : "Subagent"}
      detail={item.objective ?? item.role ?? "a task"}
      tone={TERMINAL_FAILURES.has(item.status) ? "danger" : "default"}
      trailing={
        running ? (
          <Spinner size={12} className="text-accent-text" label="Running" />
        ) : item.usage?.outputTokens ? (
          <span className="text-2xs text-subtle tabular-nums">{formatTokens((item.usage.inputTokens ?? 0) + item.usage.outputTokens)} tokens</span>
        ) : null
      }
      body={
        result || item.failureReason || controls ? (
          <>
            {result ? <Markdown text={result} className="text-sm" /> : null}
            {item.failureReason ? <p className="text-xs text-danger-text">{item.failureReason}</p> : null}
            {controls}
          </>
        ) : undefined
      }
    />
  );
});

/** What `subagent/*` allows for the state the child is in: talk to a running one, or bring a finished one back. */
function SubagentControls(props: { item: MspItem; sessionId: string; subagentId: string }) {
  const controller = useController();
  const { item, sessionId, subagentId } = props;
  const readOnly = useApp((s) => s.threads[sessionId]?.readOnly ?? true);
  const busy = useApp((s) => Boolean(s.busy[`subagent:${sessionId}:${subagentId}`]));
  const [note, setNote] = useState("");
  if (readOnly) {
    return null;
  }
  const control = item.controlStatus ?? "";
  const running = item.status === "inProgress" || control === "running" || control === "starting";
  const act = (action: import("../../types.js").SubagentAction, body?: string) =>
    void controller.subagentAction(sessionId, action, subagentId, body).then((ok) => {
      if (ok && body) {
        setNote("");
      }
    });
  const send = () => {
    const text = note.trim();
    if (text) {
      act(running ? "sendMessage" : "followupTask", text);
    }
  };
  return (
    <div className="flex flex-col gap-2">
      <form
        className="flex items-center gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        <input
          value={note}
          onChange={(event) => setNote(event.target.value)}
          disabled={busy}
          aria-label={running ? "Message this subagent" : "Give this subagent a follow-up task"}
          placeholder={running ? "Tell this subagent something" : "Give it a follow-up task"}
          className="h-7 min-w-0 flex-1 rounded-md bg-sunken px-2 text-sm text-fg shadow-[0_0_0_1px_var(--border)] outline-none placeholder:text-subtle focus-visible:shadow-[0_0_0_1px_var(--accent)]"
        />
        <Button type="submit" size="sm" variant="secondary" disabled={!note.trim()} loading={busy}>
          <PaperPlaneRightIcon size={12} /> Send
        </Button>
      </form>
      <div className="flex flex-wrap items-center gap-1">
        {running ? (
          <>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => act("interrupt")}>
              Pause at next step
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => act("stop")}>
              <StopCircleIcon size={13} /> Stop
            </Button>
          </>
        ) : null}
        {control === "resultReady" ? (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => act("readResult")}>
            Take the result
          </Button>
        ) : null}
        {control === "recoveryPending" ? (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => act("resume")}>
            Resume
          </Button>
        ) : null}
        {!running && (control === "closed" || TERMINAL_FAILURES.has(item.status)) ? (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => act("reopen")}>
            Reopen
          </Button>
        ) : null}
        {!running && control !== "closed" && control !== "closing" ? (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => act("close")}>
            Close
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function CompactionRow(props: { item: MspItem }) {
  const { item } = props;
  const running = item.status === "inProgress";
  const saved =
    item.tokensBefore !== undefined && item.tokensAfter !== undefined
      ? `${formatTokens(item.tokensBefore)} to ${formatTokens(item.tokensAfter)} tokens`
      : null;
  const label = running
    ? "Compacting context"
    : item.outcome === "noop"
      ? "Nothing to compact"
      : item.outcome === "failed"
        ? "Context compaction failed"
        : "Context compacted";
  return (
    <div className="my-1 flex items-center gap-3 text-xs text-subtle" role="note">
      <span className="h-px flex-1 bg-line" />
      <span className="flex items-center gap-1.5">
        {running ? <Spinner size={10} /> : <ArrowsInIcon size={12} />}
        {label}
        {saved ? <span className="tabular-nums">({saved})</span> : null}
      </span>
      <span className="h-px flex-1 bg-line" />
    </div>
  );
}

/** Muse 1.4.14+: what's left of the part of the log Muse pruned, the last few prompts and replies, in place of those items. */
export function EarlierHistoryRow(props: { item: MspItem }) {
  const messages = (props.item.earlierHistory?.messages ?? []).filter((m) => m.role === "user" || m.role === "assistant");
  return (
    <Row
      icon={<ChatCircleDotsIcon size={14} />}
      label="Earlier messages"
      detail={messages.length > 0 ? plural(messages.length, "message", "messages") : "Muse pruned the start of this session"}
      body={
        messages.length > 0 ? (
          <ol className="flex flex-col gap-1.5 text-xs">
            {messages.map((m, index) => (
              <li key={index} className="min-w-0">
                <span className="text-subtle">{m.role === "user" ? "You" : "Muse"}: </span>
                <span className="whitespace-pre-wrap [overflow-wrap:anywhere] text-fg">{m.text}</span>
              </li>
            ))}
          </ol>
        ) : undefined
      }
    />
  );
}

export function GenericRow(props: { item: MspItem }) {
  const { item } = props;
  return (
    <Row
      icon={<WrenchIcon size={14} />}
      label={humanize(item.kind)}
      detail={item.fallbackText}
      trailing={item.status === "inProgress" ? <Spinner size={12} /> : null}
      body={item.text ? <Markdown text={item.text} className="text-sm" /> : undefined}
    />
  );
}

/** A side chat opened from this thread. It is a session of its own, so the row only links to it. */
export function SideChatRow(props: { item: MspItem }) {
  const controller = useController();
  const sideId = typeof props.item["sideSessionId"] === "string" ? props.item["sideSessionId"] : null;
  const title = useApp((s) => (sideId ? (s.sessions[sideId]?.title ?? null) : null));
  return (
    <Row
      icon={<ChatCircleDotsIcon size={14} />}
      label="Side chat"
      detail={title ?? "Opened beside this thread"}
      actions={
        sideId ? (
          <Button size="sm" variant="ghost" onClick={() => controller.openThread(sideId)}>
            Open
          </Button>
        ) : undefined
      }
    />
  );
}

/** Heads a side chat's transcript: it can read its thread, but what is said here stays here. */
export function SideOriginRow(props: { parentId: string }) {
  const controller = useController();
  return (
    <Row
      icon={<ChatCircleDotsIcon size={14} />}
      label="Side chat"
      detail="Muse sees the thread it came from. Nothing here is added to it."
      actions={
        <Button size="sm" variant="ghost" onClick={() => controller.openThread(props.parentId)}>
          Open thread
        </Button>
      }
    />
  );
}

export function SteerBubble(props: { item: MspItem }) {
  return (
    <div className="enter-up flex flex-col items-end gap-1">
      <span className="text-2xs font-medium text-subtle">You added</span>
      <div className="max-w-[85%] rounded-2xl rounded-tr-md bg-active px-3.5 py-2 text-sm whitespace-pre-wrap text-fg">
        {props.item.displayText ?? props.item.text}
      </div>
    </div>
  );
}

export function AgentText(props: { item: MspItem; streaming?: boolean }) {
  return <Markdown text={props.item.text ?? ""} stream={props.streaming} className={cn(props.streaming && "streaming")} />;
}
