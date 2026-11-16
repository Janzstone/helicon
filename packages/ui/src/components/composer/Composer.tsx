import { ArrowUpIcon, ArrowsInIcon, BrainIcon, CaretDownIcon, CpuIcon, FolderIcon, GitBranchIcon, LightningIcon, LockIcon, QuestionIcon, ShieldChevronIcon, ShieldIcon, ShieldWarningIcon, SquareIcon, TerminalWindowIcon, UserIcon } from "../ui/icons.js";
import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { AttachButton, AttachmentTray, readFiles, restoreFiles, toOutgoing, toPreview, type PendingFile } from "./attachments.js";
import { CostMeter } from "./CostPanel.js";
import { resolveSteer } from "./keys.js";
import { Popover, Slider, Switch } from "radix-ui";
import { shallowEqual, useApp, useController } from "../../app/context.js";
import { useImeGuard } from "../../app/ime.js";
import { useSampled } from "../../app/sampled.js";
import { basename, formatDuration, formatSpeed, formatTokens, modelDisplayName } from "../../model/format.js";
import { lastPrompt } from "../../model/fold.js";
import { isSshPath } from "../../model/paths.js";
import { matchSlash, parseSlash, resolveSlash, slashCommands, type SlashCommand } from "../../model/slash.js";
import type { SkillsState } from "../../model/store.js";
import { lastTurnSpeed, streamingSpeed } from "../../model/usage.js";
import type { ApprovalMode, ReasoningEffort } from "../../types.js";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuOption, MenuRadioGroup, MenuSeparator, MenuTrigger, Modal, Tip, FLOATING } from "../ui/overlays.js";
import { Button, IconButton, MOD, Spinner, cn } from "../ui/primitives.js";
import { PixelFlow } from "../ui/PixelFlow.js";
import { ContextMeter } from "./ContextPanel.js";
import { SlashMenu, slashOptionId, type SlashMenuState } from "./SlashMenu.js";
import { SwapIcon } from "../ui/sourced.js";
import { FOCUS_HOME } from "../../app/a11y.js";

const DRAFT_PREFIX = "helicon.draft.";

function readDraft(key: string): string {
  try {
    return window.localStorage.getItem(DRAFT_PREFIX + key) ?? "";
  } catch {
    return "";
  }
}

/** A composer draft that survives switching threads and reloads. */
function useDraft(key: string): [string, (value: string) => void] {
  const [state, setState] = useState(() => ({ key, value: readDraft(key) }));
  const value = state.key === key ? state.value : readDraft(key);
  if (state.key !== key) {
    setState({ key, value });
  }
  const set = useCallback(
    (next: string) => {
      setState({ key, value: next });
      try {
        if (next) {
          window.localStorage.setItem(DRAFT_PREFIX + key, next);
        } else {
          window.localStorage.removeItem(DRAFT_PREFIX + key);
        }
      } catch {
        /* drafts are best effort */
      }
    },
    [key],
  );
  return [value, set];
}

/** The slash menu for a draft, with what picking a row writes in front of the command's name. */
type SlashMenuView = SlashMenuState & { prefix: string };

/**
 * What the menu shows for the draft and caret. While the caret is in the first word it lists matching
 * commands; `/skill <name>` lists skills; after that it only appears to flag a command Muse does not know.
 */
function slashMenuFor(text: string, caret: number, commands: SlashCommand[], skills: SkillsState | undefined): SlashMenuView | null {
  const first = /^\/(\S*)/.exec(text);
  if (!first) {
    return null;
  }
  const loading = !skills || skills.status === "loading";
  const error = skills?.status === "error" ? skills.error : null;
  // Only while typing the command word: a caret before the slash is not typing a command.
  if (caret >= 1 && caret <= first[0].length) {
    const query = first[1] as string;
    const items = matchSlash(commands, query);
    if (items.length > 0 || !query) {
      return { kind: "list", items, loading, error, prefix: "/" };
    }
    return loading ? { kind: "loading", prefix: "/" } : { kind: "unknown", name: query.toLowerCase(), prefix: "/" };
  }
  const naming = /^\/skill\s+(\S*)$/i.exec(text);
  if (naming && caret === text.length) {
    const items = matchSlash(
      commands.filter((c) => c.kind === "skill"),
      naming[1] as string,
    );
    if (items.length > 0) {
      return { kind: "list", items, loading, error, prefix: "/skill " };
    }
  }
  const parsed = parseSlash(text);
  if (!parsed || resolveSlash(parsed, commands, skills?.skills ?? []).kind !== "unknown") {
    return null;
  }
  return loading ? { kind: "loading", prefix: "/" } : { kind: "unknown", name: parsed.name, prefix: "/" };
}

/** As many files per message as the server takes. */
const MAX_FILES = 10;

export interface ComposerProps {
  sessionId: string | null;
  cwd: string | null;
  running: boolean;
  readOnly: boolean;
  variant: "thread" | "home";
  autoFocus?: boolean;
}

export function Composer(props: ComposerProps) {
  const controller = useController();
  const draftKey = props.sessionId ?? `new:${props.cwd ?? ""}`;
  const [text, setText] = useDraft(draftKey);
  // A prompt that failed to send from another composer (the new-thread screen) comes back here.
  const handoff = useApp((s) => (s.draftHandoff?.key === draftKey ? s.draftHandoff : null));
  useEffect(() => {
    if (handoff) {
      const handed = controller.takeDraftHandoff(draftKey);
      if (handed) {
        setText(handed.text);
        if (handed.attachments?.length) {
          setFiles(restoreFiles(handed.attachments, handed.previews ?? []));
        }
      }
    }
  }, [handoff, draftKey, controller, setText]);
  const ref = useRef<HTMLTextAreaElement>(null);
  const ime = useImeGuard();
  // One keypress, one send: clearing is React state, so a second Enter in the same frame re-reads the
  // same draft. The marker is synchronous where state is not; only an unchanged draft matches it, so a
  // genuinely new message typed while a send is in flight still goes.
  const consumedRef = useRef<{ value: string; files: PendingFile[] | null } | null>(null);
  const tryConsume = (value: string, files: PendingFile[] | null): boolean => {
    const last = consumedRef.current;
    if (last && last.value === value && last.files === files) {
      return false;
    }
    consumedRef.current = { value, files };
    return true;
  };
  const id = useId();
  const menuId = useId();
  const starting = useApp((s) => Boolean(s.busy["start"]));
  const stopping = useApp((s) => (props.sessionId ? Boolean(s.busy[`stop:${props.sessionId}`]) : false));
  const steerByDefault = useApp((s) => s.prefs.steerByDefault);
  const hasText = text.trim().length > 0;
  const showStop = props.running && Boolean(props.sessionId) && !hasText;
  const shell = !props.readOnly && /^!\s*\S/.test(text);

  // Files ride along with the next message: Muse sees images itself, anything else lands in the workspace.
  const [files, setFiles] = useState<PendingFile[]>([]);
  const addFiles = (incoming: Iterable<File>) => {
    if (props.readOnly) {
      return;
    }
    void readFiles(incoming).then((read) => setFiles((current) => [...current, ...read].slice(0, MAX_FILES)));
  };
  const removeFile = (id: string) => {
    setFiles((current) => {
      const gone = current.find((file) => file.id === id);
      if (gone?.url) {
        URL.revokeObjectURL(gone.url);
      }
      return current.filter((file) => file.id !== id);
    });
  };

  // The slash menu: which commands match, which row is active, and whether Esc closed it for this word.
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const skills = useApp((s) => (props.cwd ? s.skills[props.cwd] : undefined));
  const slashing = !props.readOnly && text.startsWith("/");
  useEffect(() => {
    if (slashing && props.cwd) {
      void controller.loadSkills(props.cwd);
    }
  }, [slashing, props.cwd, controller]);
  const commands = useMemo(
    () => slashCommands(skills?.skills ?? [], { inThread: Boolean(props.sessionId) }),
    [skills?.skills, props.sessionId],
  );
  const word = /^\/\S*/.exec(text)?.[0] ?? null;
  /** The menu for a caret position. Keys read the caret live: a restored draft moves it without a select event. */
  const menuAt = (at: number): SlashMenuView | null => {
    const view = slashing ? slashMenuFor(text, at, commands, skills) : null;
    return view && dismissed !== word ? view : null;
  };
  const menu = menuAt(caret);
  const rows = menu?.kind === "list" ? menu.items.length : menu ? 1 : 0;
  const activeRow = Math.max(0, Math.min(active, rows - 1));
  useEffect(() => {
    setActive(0);
  }, [word, menu?.kind, menu?.prefix]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) {
      return;
    }
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, Math.round(window.innerHeight * 0.4))}px`;
    // A draft restored, handed back or filled in puts the caret at the end without a select event.
    setCaret(el.selectionStart);
  }, [text]);

  useEffect(() => {
    const el = ref.current;
    if (props.autoFocus && !props.readOnly && el) {
      el.focus({ preventScroll: true });
      // Focusing puts the caret before a restored draft; carry on typing at its end instead.
      el.setSelectionRange(el.value.length, el.value.length);
      setCaret(el.value.length);
    }
  }, [props.autoFocus, props.readOnly, props.sessionId, props.cwd]);

  const submit = async (steer: boolean) => {
    if ((!hasText && files.length === 0) || props.readOnly || starting) {
      return;
    }
    const value = text;
    const outgoing = files;
    if (!tryConsume(value, outgoing)) {
      return;
    }
    setText("");
    setFiles([]);
    const sent = await controller.send(value, {
      steer,
      attachments: outgoing.map(toOutgoing),
      previews: outgoing.map(toPreview),
    });
    if (!sent) {
      consumedRef.current = null;
      setText(value);
      setFiles(outgoing);
    }
  };

  /** Runs a command picked from the menu, or sends the draft as a plain prompt when Muse has no such command. */
  const runNow = async (value: string, raw: boolean) => {
    if (props.readOnly || starting) {
      return;
    }
    if (!tryConsume(value, null)) {
      return;
    }
    setText("");
    const sent = await controller.send(value, { raw });
    if (!sent) {
      consumedRef.current = null;
      setText(value);
    }
  };

  const fill = (prefix: string, command: SlashCommand) => {
    const next = `${prefix}${command.name} `;
    setText(next);
    setCaret(next.length);
    requestAnimationFrame(() => {
      const el = ref.current;
      el?.focus();
      el?.setSelectionRange(next.length, next.length);
    });
  };

  const pick = (view: SlashMenuView, command: SlashCommand) => {
    if (view.prefix === "/" && command.kind === "action" && command.runsBare) {
      void runNow(`/${command.name}`, false);
    } else {
      fill(view.prefix, command);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (ime.isImeKey(event)) {
      return;
    }
    const live = menuAt(event.currentTarget.selectionStart);
    if (live) {
      const list = live.kind === "list" ? live.items : [];
      const row = Math.max(0, Math.min(active, list.length - 1));
      if ((event.key === "ArrowDown" || event.key === "ArrowUp") && list.length > 0) {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setActive((row + step + list.length) % list.length);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setDismissed(word);
        return;
      }
      if (event.key === "Tab" && !event.shiftKey && list[row]) {
        event.preventDefault();
        fill(live.prefix, list[row] as SlashCommand);
        return;
      }
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        // A held Enter repeats: the first press already picked, so later ones do nothing.
        if (event.repeat) {
          return;
        }
        if (live.kind === "list" && list[row]) {
          pick(live, list[row] as SlashCommand);
        } else if (live.kind === "unknown") {
          void runNow(text, true);
        } else {
          // Skills are still loading: send anyway, and the controller resolves the command once they arrive.
          void submit(resolveSteer(props.running, event.metaKey || event.ctrlKey, steerByDefault));
        }
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      // A held Enter repeats: the first press already sent, so later ones do nothing. Shift+Enter keeps
      // repeating, since holding it for several new lines is deliberate.
      if (event.repeat) {
        return;
      }
      void submit(resolveSteer(props.running, event.metaKey || event.ctrlKey, steerByDefault));
    } else if (event.key === "ArrowUp" && !hasText && props.sessionId && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey) {
      // Like the muse CLI: Up in an empty composer brings back the last prompt to edit and send again.
      const fold = controller.store.get().threads[props.sessionId]?.fold;
      const previous = fold ? lastPrompt(fold) : null;
      if (previous) {
        event.preventDefault();
        setText(previous);
        setCaret(previous.length);
        requestAnimationFrame(() => ref.current?.setSelectionRange(previous.length, previous.length));
      }
    } else if (event.key === "Escape" && props.running && !hasText && props.sessionId) {
      event.preventDefault();
      void controller.stop(props.sessionId);
    }
  };

  const threadTitle = useApp((s) => (props.sessionId ? (s.sessions[props.sessionId]?.title ?? null) : null));
  const placeholder = props.readOnly
    ? "Read-only while another Muse session has this thread open"
    : props.running
      ? steerByDefault
        ? `Steer this turn, or press ${MOD}+Enter to queue for later`
        : `Queue a follow-up, or press ${MOD}+Enter to add it to this turn`
      : props.variant === "home"
        ? "Describe a change, a fix, or a question about the code. Use @path to point at files."
        : "Reply, or ask for the next change";

  const sendLabel = showStop
    ? "Stop the turn"
    : shell
      ? "Run command"
      : props.running
        ? steerByDefault
          ? "Steer turn"
          : "Queue message"
        : "Send";

  return (
    <div
      className={cn(
        "relative min-w-0 max-w-full rounded-[18px] bg-raised shadow-[0_0_0_1px_var(--border-strong),0_1px_2px_oklch(0_0_0/0.05)] transition-shadow duration-150 ease-out focus-within:shadow-[0_0_0_1px_color-mix(in_oklch,var(--fg)_30%,transparent),0_2px_8px_-2px_oklch(0_0_0/0.12)]",
        props.readOnly && "opacity-75",
      )}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          event.preventDefault();
          ref.current?.focus();
        }
      }}
      onPaste={(event) => {
        // Only take over the paste when the clipboard actually holds files; pasted text stays text.
        if (event.clipboardData?.files?.length) {
          event.preventDefault();
          addFiles(Array.from(event.clipboardData.files));
        }
      }}
      onDragOver={(event) => {
        if (event.dataTransfer?.types?.includes("Files")) {
          event.preventDefault();
        }
      }}
      onDrop={(event) => {
        if (event.dataTransfer?.files?.length) {
          event.preventDefault();
          addFiles(Array.from(event.dataTransfer.files));
        }
      }}
    >
      {menu ? (
        <SlashMenu
          id={menuId}
          state={menu}
          placement={props.variant === "home" ? "below" : "above"}
          active={activeRow}
          onActive={setActive}
          onPick={(command) => pick(menu, command)}
          onSendRaw={() => void runNow(text, true)}
        />
      ) : null}
      {/* Names the thread, so landing in the composer says which conversation a message would go to. */}
      <label htmlFor={id} className="sr-only">
        {threadTitle ? `Message Muse in ${threadTitle}` : "Message Muse"}
      </label>
      {shell ? (
        <div className="flex items-center gap-1.5 px-4 pt-2.5 text-xs text-muted">
          <TerminalWindowIcon size={13} className="shrink-0" />
          <span className="truncate">
            Helicon runs this{props.cwd ? ` in ${basename(props.cwd)}` : ""}; the output stays here until you send it to Muse
          </span>
        </div>
      ) : null}
      <AttachmentTray files={files} onRemove={removeFile} />
      <textarea
        id={id}
        ref={ref}
        {...{ [FOCUS_HOME]: "" }}
        value={text}
        rows={props.variant === "home" ? 3 : 1}
        disabled={props.readOnly}
        placeholder={placeholder}
        spellCheck
        role={menu ? "combobox" : undefined}
        aria-expanded={menu ? true : undefined}
        aria-controls={menu ? menuId : undefined}
        aria-autocomplete={menu ? "list" : undefined}
        aria-activedescendant={menu ? slashOptionId(menuId, activeRow) : undefined}
        onChange={(event) => {
          setText(event.currentTarget.value);
          setCaret(event.currentTarget.selectionStart);
          if (!event.currentTarget.value.startsWith("/")) {
            setDismissed(null);
          }
        }}
        onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
        onKeyDown={onKeyDown}
        onKeyUp={ime.onKeyUp}
        onCompositionStart={ime.onCompositionStart}
        onCompositionEnd={ime.onCompositionEnd}
        onBlur={() => setDismissed(word)}
        onFocus={() => setDismissed(null)}
        className={cn(
          "block max-h-[40vh] min-h-[52px] w-full min-w-0 max-w-full resize-none overflow-x-hidden bg-transparent px-4 pb-1.5 text-md leading-relaxed text-fg outline-none [field-sizing:fixed] [overflow-wrap:anywhere] whitespace-pre-wrap placeholder:text-subtle focus-visible:outline-none disabled:cursor-not-allowed",
          shell ? "pt-1.5 font-mono text-sm" : "pt-3.5",
        )}
      />
      <div className="flex min-w-0 flex-wrap items-center gap-0.5 px-2 pb-2">
        {/* The new-thread composer sits high, so its menus open downward; they still flip when there is no room. */}
        <AttachButton onFiles={(picked) => addFiles(Array.from(picked))} disabled={props.readOnly || files.length >= MAX_FILES} />
        <ModelPicker sessionId={props.sessionId} side={props.variant === "home" ? "bottom" : "top"} />
        <EffortPicker side={props.variant === "home" ? "bottom" : "top"} />
        <AccessPicker sessionId={props.sessionId} side={props.variant === "home" ? "bottom" : "top"} />
        <AccountPicker sessionId={props.sessionId} cwd={props.cwd} variant={props.variant} />
        <span className="min-w-2 flex-1" />
        {props.sessionId ? <SpeedReadout sessionId={props.sessionId} /> : null}
        {props.sessionId ? <CostMeter sessionId={props.sessionId} /> : null}
        {props.sessionId ? <ContextMeter sessionId={props.sessionId} /> : null}
        {props.running && props.sessionId && hasText ? (
          <Tip label="Stop the turn" shortcut={["Esc"]}>
            <IconButton size="md" label="Stop the turn" disabled={stopping} onClick={() => void controller.stop(props.sessionId as string)}>
              <SquareIcon weight="fill" size={11} />
            </IconButton>
          </Tip>
        ) : null}
        <Tip label={sendLabel} shortcut={[showStop ? "Esc" : "Enter"]}>
          <button
            type="button"
            aria-label={
              showStop ? "Stop the turn" : shell ? "Run command" : props.running ? (steerByDefault ? "Steer turn" : "Queue message") : "Send message"
            }
            disabled={showStop ? stopping : (!hasText && files.length === 0) || props.readOnly || starting}
            onClick={() =>
              showStop ? void controller.stop(props.sessionId as string) : void submit(resolveSteer(props.running, false, steerByDefault))
            }
            className={cn(
              "ml-1 inline-flex size-8 shrink-0 items-center justify-center rounded-full transition-[transform,background-color,color] duration-150 active:scale-95",
              showStop ? "bg-inverse text-inverse-fg" : "bg-accent text-accent-fg hover:bg-accent-hover disabled:bg-active disabled:text-subtle",
            )}
          >
            <SwapIcon value={starting || stopping ? "busy" : showStop ? "stop" : "send"}>
              {starting || stopping ? (
                <Spinner size={13} />
              ) : showStop ? (
                <SquareIcon weight="fill" size={11} />
              ) : (
                <ArrowUpIcon size={16} />
              )}
            </SwapIcon>
          </button>
        </Tip>
      </div>
    </div>
  );
}

const ToolbarTrigger = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { icon: ReactNode; label: ReactNode; tone?: "warn" }
>(function ToolbarTrigger({ icon, label, tone, className, ...rest }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      {...rest}
      className={cn(
        "inline-flex h-7 max-w-[240px] min-w-0 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-muted transition-colors duration-100 hover:bg-hover hover:text-fg data-[state=open]:bg-hover data-[state=open]:text-fg",
        tone === "warn" && "text-warn-text hover:text-warn-text",
        className,
      )}
    >
      <span className="shrink-0">{icon}</span>
      <span className="flex min-w-0 items-center truncate">{label}</span>
      <CaretDownIcon size={12} className="shrink-0 opacity-60" />
    </button>
  );
});

/** Marks contributor-tier models. In menus the option's description explains it; elsewhere a tooltip does. */
function ContributorBadge(props: { tip?: boolean }) {
  const badge = <span className="shrink-0 rounded-[5px] bg-warn-soft px-1 py-px text-2xs font-medium text-warn-text">Contributor</span>;
  return props.tip ? <Tip label="Your chats may be used to improve Meta's products">{badge}</Tip> : badge;
}

/** Which way a composer menu opens: away from the screen edge the composer sits against. */
type PickerSide = "top" | "bottom";

function ModelPicker(props: { sessionId: string | null; side: PickerSide }) {
  const controller = useController();
  const open = useApp((s) => s.picker === "model");
  const models = useApp((s) => s.models);
  const sessionModel = useApp((s) =>
    props.sessionId ? (s.threads[props.sessionId]?.fold.meta.modelId ?? s.sessions[props.sessionId]?.modelId ?? null) : null,
  );
  const preferred = useApp((s) => s.prefs.defaultModelId);
  const current = props.sessionId ? sessionModel : (preferred ?? models.find((m) => m.isDefault)?.modelId ?? null);
  const model = models.find((m) => m.modelId === current);
  const contributor = model?.contributor ?? /contributor/i.test(current ?? "");
  return (
    <Menu open={open} onOpenChange={(next) => (next ? controller.setPicker("model") : controller.closePicker("model"))}>
      <MenuTrigger asChild>
        <ToolbarTrigger
          icon={<CpuIcon size={13} />}
          label={
            <>
              {/* Name comes from the content, so it always contains the visible text (voice control). */}
              <span className="sr-only">Model: </span>
              <span className="truncate">{modelDisplayName(current)}</span>
              {contributor ? (
                <span className="ml-1.5">
                  <ContributorBadge tip />
                </span>
              ) : null}
            </>
          }
        />
      </MenuTrigger>
      <MenuContent side={props.side} className="w-[330px]">
        <MenuLabel>Model</MenuLabel>
        {models.length === 0 ? (
          <p className="px-2 pb-2 text-xs text-muted">The model list loads once Muse is running.</p>
        ) : (
          <MenuRadioGroup value={current ?? ""} onValueChange={(value) => void controller.setModel(value)}>
            {models.map((m) => (
              <MenuOption
                key={m.modelId}
                value={m.modelId}
                label={modelDisplayName(m.modelId)}
                badge={m.contributor ? <ContributorBadge /> : null}
                description={
                  m.contributor
                    ? "Prompts and outputs may be used to improve Meta's products."
                    : m.contextLimit
                      ? `${formatTokens(m.contextLimit)} token context`
                      : undefined
                }
              />
            ))}
          </MenuRadioGroup>
        )}
      </MenuContent>
    </Menu>
  );
}

/**
 * Sets the project's default account for new threads (`startThread` reads `project.defaultAccountId`); no
 * transient state of its own. Shows only on the new-thread composer, and only once accounts exist. On an
 * existing thread the account is fixed at spawn and shown by the sidebar badge instead.
 */
function AccountPicker(props: { sessionId: string | null; cwd: string | null; variant: "thread" | "home" }) {
  const controller = useController();
  const accounts = useApp((s) => s.accounts);
  const open = useApp((s) => s.picker === "account");
  const current = useApp((s) => s.projects.find((p) => p.cwd === props.cwd)?.defaultAccountId ?? null);
  // An SSH project runs on the remote host's own login; a local account cannot reach it.
  if (props.sessionId !== null || !props.cwd || isSshPath(props.cwd) || !(accounts && accounts.length > 0)) {
    return null;
  }
  const label = accounts.find((a) => a.id === current)?.name ?? "Default login";
  return (
    <Menu open={open} onOpenChange={(next) => (next ? controller.setPicker("account") : controller.closePicker("account"))}>
      <MenuTrigger asChild>
        <ToolbarTrigger aria-label={`Account: ${label}`} icon={<UserIcon size={13} />} label={<span className="truncate">{label}</span>} />
      </MenuTrigger>
      <MenuContent side={props.variant === "home" ? "bottom" : "top"} className="w-[300px]">
        <MenuLabel>Account</MenuLabel>
        <MenuRadioGroup
          value={current ?? ""}
          onValueChange={(value) => void controller.setProjectDefaultAccount(props.cwd as string, value || null)}
        >
          <MenuOption value="" label="Default login" />
          {accounts.map((a) => (
            <MenuOption key={a.id} value={a.id} label={a.name} description={a.hasLogin ? (a.email ?? "Signed in") : "Not signed in"} />
          ))}
        </MenuRadioGroup>
      </MenuContent>
    </Menu>
  );
}

/** Effort levels on the faster-to-smarter scale. Auto sits outside it: Muse picks per turn. */
export const LEVELS: { value: ReasoningEffort; label: string; description: string }[] = [
  { value: "none", label: "Off", description: "Answers right away, without reasoning" },
  { value: "minimal", label: "Minimal", description: "A quick think before answering" },
  { value: "low", label: "Low", description: "Light reasoning for simple changes" },
  { value: "medium", label: "Medium", description: "Balanced speed and depth" },
  { value: "high", label: "High", description: "Thinks harder problems through" },
  { value: "xhigh", label: "Extra high", description: "Deep reasoning for tricky work" },
  // No Ultra: Muse Code 1.3.0 sends "ultra" to the model as "max", and the CLI stopped offering it.
  { value: "max", label: "Max", description: "The slowest and most thorough" },
];
const TOP = LEVELS.length - 1;
// Where the slider rests while Auto is on and nothing was picked yet: Medium.
const RESTING = 3;

/** Reasoning effort as a stepped slider in a popover, after the Claude desktop effort control. */
function EffortPicker(props: { side: PickerSide }) {
  const controller = useController();
  const open = useApp((s) => s.picker === "effort");
  const effort = useApp((s) => s.prefs.effort);
  const [resting, setResting] = useState(RESTING);
  const thumb = useRef<HTMLSpanElement>(null);
  const switchId = useId();
  const picked = LEVELS.findIndex((l) => l.value === effort);
  const auto = picked < 0;
  const position = auto ? resting : picked;
  const label = auto ? "Auto" : (LEVELS[picked]?.label ?? "Auto");
  const ultra = !auto && picked === TOP;
  const choose = (index: number) => {
    const level = LEVELS[index];
    if (level) {
      setResting(index);
      controller.setEffort(level.value);
    }
  };
  return (
    <Popover.Root open={open} onOpenChange={(next) => (next ? controller.setPicker("effort") : controller.closePicker("effort"))}>
      <Popover.Trigger asChild>
        <ToolbarTrigger aria-label={`Reasoning effort: ${label}`} icon={<BrainIcon size={13} />} label={label} />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side={props.side}
          align="start"
          sideOffset={6}
          {...FLOATING}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            thumb.current?.focus();
          }}
          className="pop z-[var(--z-dropdown)] w-[300px] max-w-[calc(100dvw-24px)] rounded-xl bg-raised p-3.5 text-fg shadow-pop outline-none"
        >
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted">Effort</span>
            <span className={cn("text-sm font-semibold", !auto && picked === TOP ? "text-accent-text" : "text-fg")}>{label}</span>
            <span className="flex-1" />
            <Tip label="Higher effort thinks longer for more thorough answers, but each turn takes more time.">
              <button
                type="button"
                aria-label="What effort does"
                className="-m-1 rounded-full p-1 text-subtle transition-colors duration-100 hover:text-fg"
              >
                <QuestionIcon size={15} />
              </button>
            </Tip>
          </div>
          <div className="mt-4 flex justify-between text-xs text-subtle">
            <span>Faster</span>
            <span>Smarter</span>
          </div>
          <Slider.Root
            min={0}
            max={TOP}
            step={1}
            value={[position]}
            onValueChange={([index]) => {
              if (index !== undefined) {
                choose(index);
              }
            }}
            aria-label="Reasoning effort"
            className={cn("effort-slider relative mt-2 flex h-8 touch-none items-center select-none", auto && "opacity-60")}
          >
            <Slider.Track className="relative h-full grow overflow-hidden rounded-lg bg-active">
              <Slider.Range className={cn("effort-range absolute h-full overflow-hidden", ultra ? "bg-accent-soft" : "bg-fg/15")}>
                {ultra ? <PixelFlow className="text-accent-text" /> : null}
              </Slider.Range>
              {/* One dot per level, inset by half the thumb so each sits exactly where the thumb stops. */}
              {ultra ? null : (
                <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-[9px] left-[9px]">
                  {LEVELS.map((level, index) => (
                    <span
                      key={level.value}
                      className="absolute top-1/2 size-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-fg/30"
                      style={{ left: `${(index / TOP) * 100}%` }}
                    />
                  ))}
                </span>
              )}
            </Slider.Track>
            <Slider.Thumb
              ref={thumb}
              aria-valuetext={LEVELS[position]?.label}
              className="block h-6 w-[18px] rounded-md bg-white shadow-[0_0_0_1px_oklch(0_0_0/0.08),0_1px_3px_oklch(0_0_0/0.3)] outline-none transition-transform duration-100 ease-out focus-visible:ring-2 focus-visible:ring-accent active:scale-95"
            />
          </Slider.Root>
          <p className={cn("mt-2 text-xs", auto ? "text-subtle" : "text-muted")}>
            {auto ? "Muse picks the effort for each turn" : LEVELS[position]?.description}
          </p>
          <div className="mt-3 flex items-center gap-3 border-t border-line pt-3">
            <label htmlFor={switchId} className="min-w-0 flex-1 cursor-default text-sm text-fg">
              Let Muse decide
            </label>
            <Switch.Root
              id={switchId}
              checked={auto}
              onCheckedChange={(on) => controller.setEffort(on ? null : (LEVELS[position]?.value ?? "medium"))}
              className="relative inline-flex h-[18px] w-8 shrink-0 items-center rounded-full bg-line-strong outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-accent data-[state=checked]:bg-accent"
            >
              <Switch.Thumb className="block size-3.5 translate-x-0.5 rounded-full bg-white shadow-[0_1px_2px_oklch(0_0_0/0.3)] transition-transform duration-150 ease-out data-[state=checked]:translate-x-4" />
            </Switch.Root>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

export const MODES: { value: ApprovalMode; label: string; description: string; icon: ReactNode }[] = [
  { value: "onRequest", label: "Ask first", description: "Muse asks before anything that needs approval.", icon: <ShieldIcon size={14} /> },
  {
    value: "promptUnmatched",
    label: "Ask for unlisted",
    description: "Commands your rules allow just run; anything else asks.",
    icon: <ShieldChevronIcon size={14} />,
  },
  {
    value: "denyUnmatched",
    label: "Deny unlisted",
    description: "Commands your rules allow just run; anything else is refused.",
    icon: <LockIcon size={14} />,
  },
  {
    value: "allowAll",
    label: "Full access",
    description: "Every tool runs without asking. Only for sandboxes.",
    icon: <ShieldWarningIcon size={14} />,
  },
];

function AccessPicker(props: { sessionId: string | null; side: PickerSide }) {
  const controller = useController();
  const open = useApp((s) => s.picker === "permissions");
  // `/permissions full` opens the confirmation directly, so it lives in app state rather than here.
  const confirming = useApp((s) => s.picker === "confirmFullAccess");
  const bypass = useApp((s) => s.bypassAll);
  const confirmingBypass = useApp((s) => s.picker === "confirmBypass");
  const bypassId = useId();
  const yolo = useApp((s) => s.yoloSettings?.enabled === true);
  const yoloLoaded = useApp((s) => s.yoloSettings !== null);
  const confirmingYolo = useApp((s) => s.picker === "confirmYolo");
  const yoloId = useId();
  const preferred = useApp((s) => s.prefs.defaultMode);
  const threadMode = useApp((s) => (props.sessionId ? (s.threads[props.sessionId]?.fold.meta.approvalMode ?? null) : null));
  const current = (props.sessionId ? threadMode : null) ?? preferred;
  const mode = MODES.find((m) => m.value === current) ?? MODES[0];
  const setConfirming = (next: boolean) => (next ? controller.setPicker("confirmFullAccess") : controller.closePicker("confirmFullAccess"));
  return (
    <>
      <Menu open={open} onOpenChange={(next) => (next ? controller.setPicker("permissions") : controller.closePicker("permissions"))}>
        <MenuTrigger asChild>
          <ToolbarTrigger
            aria-label={yolo ? "Permissions: YOLO mode" : `Permissions: ${mode?.label}`}
            icon={yolo ? <LightningIcon size={14} /> : mode?.icon}
            label={yolo ? "YOLO" : mode?.label}
            tone={yolo || current === "allowAll" || bypass ? "warn" : undefined}
          />
        </MenuTrigger>
        <MenuContent side={props.side} className="w-[300px]">
          <MenuLabel>Permissions</MenuLabel>
          {/* The `muse --yolo` posture: no approvals, no sandbox, trusted workspace. Above the modes because it owns them while on. */}
          <div className="flex items-start gap-3 px-2 pt-1 pb-2.5">
            <label htmlFor={yoloId} className="min-w-0 flex-1 cursor-default">
              <span className="flex items-center gap-1.5 text-sm text-fg">
                <LightningIcon size={14} className="text-warn-text" aria-hidden="true" />
                YOLO mode
              </span>
              <span className="block text-xs text-muted">Nothing asks, new threads run unsandboxed. Restarts Muse hosts.</span>
            </label>
            <Switch.Root
              id={yoloId}
              checked={yolo}
              disabled={!yoloLoaded}
              onCheckedChange={(on) => (on ? controller.setPicker("confirmYolo") : void controller.setYoloEnabled(false))}
              className="relative mt-0.5 inline-flex h-[18px] w-8 shrink-0 items-center rounded-full bg-line-strong outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50 data-[state=checked]:bg-accent"
            >
              <Switch.Thumb className="block size-3.5 translate-x-0.5 rounded-full bg-white shadow-[0_1px_2px_oklch(0_0_0/0.3)] transition-transform duration-150 ease-out data-[state=checked]:translate-x-4" />
            </Switch.Root>
          </div>
          <MenuRadioGroup
            value={current}
            onValueChange={(value) => {
              if (value === "allowAll") {
                setConfirming(true);
              } else {
                void controller.setMode(value as ApprovalMode);
              }
            }}
          >
            {MODES.map((m) => (
              <MenuOption key={m.value} value={m.value} icon={m.icon} label={m.label} description={m.description} disabled={yolo} />
            ))}
          </MenuRadioGroup>
          {yolo ? <p className="px-2 pt-1 text-xs text-subtle">YOLO owns every thread&apos;s mode while it is on. Switch it off to choose.</p> : null}
          {/* Muse asks whenever it cannot resolve a command's argv, whatever mode it is in. This answers those. */}
          <div className="mt-1 flex items-start gap-3 border-t border-line px-2 pt-2.5 pb-1">
            <label htmlFor={bypassId} className="min-w-0 flex-1 cursor-default">
              <span className="block text-sm text-fg">Answer approvals for me</span>
              <span className="block text-xs text-muted">Allowed once each, in every thread, until you close Helicon.</span>
            </label>
            <Switch.Root
              id={bypassId}
              checked={bypass}
              onCheckedChange={(on) => (on ? controller.setPicker("confirmBypass") : controller.setBypassAll(false))}
              className="relative mt-0.5 inline-flex h-[18px] w-8 shrink-0 items-center rounded-full bg-line-strong outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-accent data-[state=checked]:bg-accent"
            >
              <Switch.Thumb className="block size-3.5 translate-x-0.5 rounded-full bg-white shadow-[0_1px_2px_oklch(0_0_0/0.3)] transition-transform duration-150 ease-out data-[state=checked]:translate-x-4" />
            </Switch.Root>
          </div>
        </MenuContent>
      </Menu>
      <Modal
        open={confirming}
        onOpenChange={setConfirming}
        title="Give Muse full access?"
        description="Every tool call, including shell commands and file writes, will run without asking you first. The OS sandbox still confines shells unless this thread started while sandboxing was switched off, or with YOLO mode on, in Settings. Use this only in a disposable environment."
      >
        <div className="mt-6 flex justify-end gap-2">
          <Button
            variant="ghost"
            onClick={() => {
              setConfirming(false);
              controller.navigate({ kind: "settings" });
            }}
          >
            Settings
          </Button>
          <Button variant="ghost" onClick={() => setConfirming(false)}>
            Keep asking
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              setConfirming(false);
              void controller.setMode("allowAll");
            }}
          >
            Allow full access
          </Button>
        </div>
      </Modal>
      <Modal
        open={confirmingBypass}
        onOpenChange={(next) => (next ? controller.setPicker("confirmBypass") : controller.closePicker("confirmBypass"))}
        title="Answer approvals for you?"
        description="Every approval Muse raises, in any thread, is allowed once without showing you the command first. Muse asks about the commands it could not resolve, so these are the ones nothing else has checked. This lasts until you close Helicon."
      >
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => controller.closePicker("confirmBypass")}>
            Keep asking
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              controller.closePicker("confirmBypass");
              controller.setBypassAll(true);
            }}
          >
            Answer them for me
          </Button>
        </div>
      </Modal>
      <Modal
        open={confirmingYolo}
        onOpenChange={(next) => (next ? controller.setPicker("confirmYolo") : controller.closePicker("confirmYolo"))}
        title="Turn on YOLO mode?"
        description="Like muse --yolo: nothing asks for approval in any thread, new threads run without sandbox confinement, and workspaces are trusted. The running Muse hosts restart, interrupting their turns, and threads already open keep the sandbox posture they started with. This stays on until you switch it off."
      >
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => controller.closePicker("confirmYolo")}>
            Keep asking
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              controller.closePicker("confirmYolo");
              void controller.setYoloEnabled(true);
            }}
          >
            Turn on YOLO
          </Button>
        </div>
      </Modal>
    </>
  );
}

/** Output speed beside the context ring: an estimate while text streams, else the last turn's measured speed. */
function SpeedReadout(props: { sessionId: string }) {
  const controller = useController();
  const running = useApp((s) => Boolean(s.threads[props.sessionId]?.fold.activeTurnId));
  const last = useApp((s) => {
    const fold = s.threads[props.sessionId]?.fold;
    const speed = fold ? lastTurnSpeed(fold) : null;
    return speed ? { tps: speed.tokensPerSecond, tokens: speed.outputTokens, ms: speed.generationMs } : null;
  }, shallowEqual);
  const live = useSampled(() => {
    const fold = controller.store.get().threads[props.sessionId]?.fold;
    return fold?.activeTurnId ? streamingSpeed(fold.turns[fold.activeTurnId]) : null;
  }, running);
  if (running && live !== null) {
    return (
      <Tip label="Estimated from the text streaming now">
        <span tabIndex={0} className="shrink-0 px-1 text-2xs text-subtle tabular-nums">
          ~{formatSpeed(live)}
        </span>
      </Tip>
    );
  }
  if (!last) {
    return null;
  }
  return (
    <Tip label={`Last turn: ${formatTokens(last.tokens)} output tokens over ${formatDuration(last.ms)} of model calls`}>
      <span tabIndex={0} className="shrink-0 px-1 text-2xs text-subtle tabular-nums">
        {formatSpeed(last.tps)}
      </span>
    </Tip>
  );
}

export function ComposerFooter(props: { cwd: string | null; branch: string | null; running: boolean }) {
  const steerByDefault = useApp((s) => s.prefs.steerByDefault);
  return (
    <div className="flex h-8 items-center gap-3 px-2 text-xs text-subtle">
      {props.cwd ? (
        <Tip label={props.cwd} side="top" align="start">
          <span className="flex min-w-0 items-center gap-1.5" tabIndex={0}>
            <FolderIcon size={12} className="shrink-0" />
            <span className="truncate">{basename(props.cwd)}</span>
          </span>
        </Tip>
      ) : null}
      {props.branch ? (
        <span className="flex min-w-0 items-center gap-1.5">
          <GitBranchIcon size={12} className="shrink-0" />
          <span className="truncate font-mono text-2xs">{props.branch}</span>
        </span>
      ) : null}
      <span className="flex-1" />
      <span className="hidden truncate md:inline">
        {props.running
          ? steerByDefault
            ? `Enter steers this turn, ${MOD}+Enter queues, Esc stops`
            : `Enter queues, ${MOD}+Enter adds to this turn, Esc stops`
          : "Enter to send, Shift+Enter for a new line, / for commands, ! for shell"}
      </span>
    </div>
  );
}
