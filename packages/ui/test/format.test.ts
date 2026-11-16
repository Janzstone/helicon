import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseModelList } from "../src/client.js";
import {
  alignLines,
  describeApproval,
  describeCuaData,
  describeCuaStep,
  quoteAppText,
  describeTool,
  diffFromEcho,
  diffLines,
  diffStats,
  extractDiff,
  extractRevertSteps,
  formatDuration,
  formatTokens,
  lastLine,
  mergeDiffLines,
  modelDisplayName,
  plural,
  relativeTime,
  shortenPath,
  withoutDiffEcho,
} from "../src/model/format.js";
import type { MspItem } from "../src/types.js";
import { modelList } from "./fixtures/probe.js";

function tool(name: string, args: unknown, status = "completed", visibleOutput?: string): MspItem {
  return {
    itemId: "i",
    kind: "toolCall",
    status,
    revision: 1,
    tool: name,
    args: JSON.stringify(args),
    ...(visibleOutput === undefined ? {} : { visibleOutput }),
  };
}

describe("formatting", () => {
  it("formats relative times compactly", () => {
    const now = Date.parse("2026-09-11T12:00:00Z");
    assert.equal(relativeTime("2026-09-11T11:59:40Z", now), "now");
    assert.equal(relativeTime("2026-09-11T11:56:00Z", now), "4m");
    assert.equal(relativeTime("2026-09-11T09:00:00Z", now), "3h");
    assert.equal(relativeTime("2026-09-09T12:00:00Z", now), "2d");
    assert.equal(relativeTime("2026-08-21T12:00:00Z", now), "3w");
    assert.equal(relativeTime("garbage", now), "");
  });

  it("formats durations and token counts", () => {
    assert.equal(formatDuration(42316), "42s");
    assert.equal(formatDuration(73471), "1m 13s");
    assert.equal(formatDuration(120000), "2m");
    assert.equal(formatDuration(3_900_000), "1h 5m");
    assert.equal(formatDuration(123), "123ms");
    assert.equal(formatDuration(999), "999ms");
    assert.equal(formatDuration(999.6), "1s");
    assert.equal(formatDuration(1000), "1s");
    assert.equal(formatTokens(842), "842");
    assert.equal(formatTokens(21177), "21k");
    assert.equal(formatTokens(1500), "1.5k");
    assert.equal(formatTokens(1_007_997), "1M");
  });

  it("shortens long paths from the middle", () => {
    assert.equal(shortenPath("D:\\Projects\\helicon", 48), "D:\\Projects\\helicon");
    const short = shortenPath("D:\\Projects\\clients\\acme\\platform\\packages\\ui\\src", 32);
    assert.ok(short.startsWith("D:\\...\\"));
    assert.ok(short.endsWith("src"));
    assert.ok(short.length <= 34);
  });

  it("pluralizes a count with its noun", () => {
    assert.equal(plural(0, "call", "calls"), "0 calls");
    assert.equal(plural(1, "call", "calls"), "1 call");
    assert.equal(plural(2, "call", "calls"), "2 calls");
    assert.equal(plural(1, "file read", "files read"), "1 file read");
  });
});

describe("tool descriptions", () => {
  it("describes a real bash call", () => {
    const description = describeTool(tool("bash", { command: "ls -la", description: "List workspace directory contents" }));
    assert.deepEqual(description, {
      kind: "shell",
      verb: "Ran",
      subject: "ls -la",
      mono: true,
      note: "List workspace directory contents",
    });
    assert.equal(describeTool(tool("bash", { command: "npm test" }, "inProgress")).verb, "Running");
  });

  it("uses the tool's own label for its status on tools Helicon has no words for (Muse 1.4.9)", () => {
    const labelled = (status: string): MspItem => ({
      ...tool("lookup_docs", { query: "fold" }, status),
      displayLabel: { active: "Looking up docs", done: "Looked up docs", neutral: "Look up docs" },
    });
    assert.equal(describeTool(labelled("inProgress")).verb, "Looking up docs");
    assert.equal(describeTool(labelled("completed")).verb, "Looked up docs");
    assert.equal(describeTool(labelled("failed")).verb, "Look up docs");
    assert.equal(describeTool(labelled("completed")).note, "fold");
    const blank: MspItem = { ...tool("lookup_docs", {}), displayLabel: { active: " ", done: " ", neutral: " " } };
    assert.notEqual(describeTool(blank).verb.trim(), "", "a blank label falls back to Helicon's own words");
  });

  it("describes questions, file tools, searches and unknown tools", () => {
    const question = describeTool(
      tool("request_user_input", { questions: [{ id: "q", header: "Color", question: "Which color?", options: [], selection: { mode: "single" } }] }),
    );
    assert.equal(question.kind, "question");
    assert.equal(question.subject, "Which color?");
    assert.equal(describeTool(tool("read_file", { path: "src/app.ts" })).subject, "src/app.ts");
    assert.equal(describeTool(tool("str_replace_editor", { file_path: "a.ts", old_string: "a", new_string: "b" })).verb, "Edited");
    const search = describeTool(tool("grep", { pattern: "TODO", path: "src" }));
    assert.equal(search.verb, "Searched for");
    assert.equal(search.note, "src");
    const unknown = describeTool(tool("frobnicate_widgets", { target: "x" }));
    assert.equal(unknown.kind, "generic");
    assert.equal(unknown.subject, "Frobnicate widgets");
    assert.equal(describeTool({ itemId: "i", kind: "toolCall", status: "completed", revision: 1, tool: "bash", args: "{not json" }).subject, "{not json");
  });

  it("extracts reviewable diffs from edit arguments", () => {
    const diff = extractDiff(tool("edit", { path: "a.ts", old_string: "const a = 1;\nconst b = 2;", new_string: "const a = 3;" }));
    assert.ok(diff && "hunks" in diff);
    assert.deepEqual(diffStats(diff), { added: 1, removed: 2 });
    const patch = extractDiff(tool("apply_patch", { input: "*** Begin Patch\n--- a.ts\n+++ a.ts\n@@\n-old\n+new\n+more" }));
    assert.ok(patch && "patch" in patch);
    assert.deepEqual(diffStats(patch), { added: 2, removed: 1 });
    assert.equal(extractDiff(tool("bash", { command: "ls" })), null);
  });

  it("aligns an edit's padding lines as context instead of remove-and-re-add", () => {
    const diff = extractDiff(
      tool("edit", {
        path: "ThreadView.tsx",
        old_string: ["const startedAt = 1;", "const now = 2;", "return (", "<header>", "<SidebarToggle />"].join("\n"),
        new_string: [
          "const startedAt = 1;",
          "const now = 2;",
          "const drag = 3;",
          "const noDrag = 4;",
          "return (",
          "<header now>",
          "<TrafficLightSpacer />",
          "<SidebarToggle />",
        ].join("\n"),
      }),
    );
    assert.ok(diff && "hunks" in diff);
    assert.deepEqual(
      diff.hunks[0]?.rows.map((row) => row.kind),
      ["same", "same", "add", "add", "same", "del", "add", "add", "same"],
    );
    assert.deepEqual(diffStats(diff), { added: 4, removed: 1 });
  });

  it("aligns one-sided changes without hunting for overlap", () => {
    assert.deepEqual(
      alignLines([], ["a", "b"]).map((row) => row.kind),
      ["add", "add"],
    );
    assert.deepEqual(
      alignLines(["a", "b"], []).map((row) => row.kind),
      ["del", "del"],
    );
    assert.deepEqual(alignLines([], []), []);
    const written = extractDiff(tool("write", { path: "note.txt", content: "hello\n" }));
    assert.ok(written && "hunks" in written);
    assert.deepEqual(diffStats(written), { added: 2, removed: 0 });
  });

  it("reads a giant edit as two plain blocks instead of aligning it", () => {
    // A running edit's diff is recomputed on every flush, and the alignment table costs a cell per
    // old/new pair: a 2000-line find/replace would eat the frame budget on its own (#32).
    const removed = Array.from({ length: 2000 }, (_, i) => `old line ${i}`);
    const added = Array.from({ length: 2000 }, (_, i) => `new line ${i}`);
    const started = Date.now();
    const rows = alignLines(removed, added);
    assert.ok(Date.now() - started < 2000, `giant edit took ${Date.now() - started}ms to align`);
    assert.equal(rows.length, 4000);
    assert.ok(rows.every((row, i) => (i < 2000 ? row.kind === "del" : row.kind === "add")));
    assert.deepEqual(
      rows.map((row) => row.text),
      [...removed, ...added],
    );
    // A modest edit still aligns: shared lines read as context, not as churn.
    assert.deepEqual(
      alignLines(["same", "old"], ["same", "new"]).map((row) => row.kind),
      ["same", "del", "add"],
    );
  });

  it("strips the runtime's edit echo but keeps anything else the output carried", () => {
    const echo = ["edited", "changed lines: lines 39-43", "--- original", "+++ updated", "@@", "-old", "+new"].join("\n");
    assert.equal(withoutDiffEcho(echo), "");
    assert.equal(withoutDiffEcho(`${echo}\nnote: lint is unhappy`), "note: lint is unhappy");
    assert.equal(withoutDiffEcho(`${echo}\n${echo}`), "");
    assert.equal(withoutDiffEcho(echo.replace(/\n/g, "\r\n")), "");
    assert.equal(withoutDiffEcho("command not found: frobnicate"), null);
    assert.equal(withoutDiffEcho("edited\nchanged lines: lines 1-2"), null);
    assert.equal(withoutDiffEcho("edited\nchanged lines: lines 1-2\n--- original\n+++ updated"), null);
  });

  it("reads the runtime's find/replace edit arguments", () => {
    const diff = extractDiff(
      tool("edit_file", {
        find: 'import { useApp } from "../../app/context.js";\nimport { modelDisplayName } from "../../model/format.js";',
        path: "packages/ui/src/components/settings/SettingsPage.tsx",
        replace:
          'import { useApp } from "../../app/context.js";\nimport { useOverlayDragProps } from "../../app/frame.js";\nimport { modelDisplayName } from "../../model/format.js";',
      }),
    );
    assert.ok(diff && "hunks" in diff);
    assert.equal(diff.path, "packages/ui/src/components/settings/SettingsPage.tsx");
    assert.deepEqual(
      diff.hunks[0]?.rows.map((row) => row.kind),
      ["same", "add", "same"],
    );
    assert.deepEqual(diffStats(diff), { added: 1, removed: 0 });
  });

  it("builds the diff from the result's echo when the arguments do not carry it", () => {
    const echo = [
      "edited",
      "changed lines: lines 4-5",
      "--- original",
      "+++ updated",
      "@@",
      "-import { useApp } from 1;",
      "-import { modelDisplayName } from 2;",
      "+import { useApp } from 1;",
      "+import { useOverlayDragProps } from 3;",
      "+import { modelDisplayName } from 2;",
    ].join("\n");
    const direct = diffFromEcho(echo, "SettingsPage.tsx");
    assert.ok(direct && "hunks" in direct);
    assert.deepEqual(
      direct.hunks[0]?.rows.map((row) => row.kind),
      ["same", "add", "same"],
    );
    assert.deepEqual(diffStats(direct), { added: 1, removed: 0 });
    assert.equal(diffFromEcho("command not found: frobnicate", null), null);
    // An unfamiliar edit shape still renders a diff, from the echo rather than the arguments.
    const fellBack = extractDiff(tool("edit", { target: "a.ts", patch: null }, "completed", echo));
    assert.ok(fellBack && "hunks" in fellBack);
    assert.deepEqual(diffStats(fellBack), { added: 1, removed: 0 });
    // But a result that echoes nothing still yields no diff.
    assert.equal(extractDiff(tool("edit", { target: "a.ts" }, "completed", "File updated successfully")), null);
  });

  it("flattens one diff into rows, marking the gaps between its hunks", () => {
    const hunks = diffLines({
      path: "a.ts",
      hunks: [
        { rows: [{ kind: "same", text: "top" }] },
        { rows: [{ kind: "del", text: "old" }] },
      ],
    });
    assert.deepEqual(
      hunks.map((line) => [line.kind, line.text]),
      [
        ["ctx", "top"],
        ["meta", "..."],
        ["del", "old"],
      ],
    );
    const patch = diffLines({ path: "a.ts", patch: "@@\n-old\n+new\n context" });
    assert.deepEqual(
      patch.map((line) => [line.kind, line.text]),
      [
        ["meta", "@@"],
        ["del", "old"],
        ["add", "new"],
        ["ctx", "context"],
      ],
    );
  });

  it("joins one file's diffs into a single continuous row stream, in order", () => {
    const first = extractDiff(tool("edit_file", { path: "a.ts", find: "one", replace: "ONE" }));
    const second = extractDiff(tool("edit_file", { path: "a.ts", find: "two", replace: "TWO" }));
    assert.ok(first && "hunks" in first && second && "hunks" in second);
    assert.deepEqual(
      mergeDiffLines([first, second]).map((line) => [line.kind, line.text]),
      [
        ["del", "one"],
        ["add", "ONE"],
        ["meta", "..."],
        ["del", "two"],
        ["add", "TWO"],
      ],
    );
    assert.deepEqual(mergeDiffLines([]), []);
  });
});

describe("approvals and models", () => {
  it("describes approval subjects in plain language", () => {
    const base = { approvalId: "a", sessionId: "s", availableChoices: [], currentRequirementId: null };
    assert.deepEqual(describeApproval({ ...base, subject: { kind: "shell", command: "rm -rf dist" } }), {
      title: "Run a shell command",
      detail: "rm -rf dist",
      mono: true,
    });
    assert.equal(describeApproval({ ...base, subject: { kind: "fileAccess", access: "write", path: "/etc/hosts" } }).title, "Write to a file");
    assert.equal(describeApproval({ ...base, subject: { kind: "network", host: "api.github.com", port: 443, protocol: "https" } }).detail, "https://api.github.com:443");
    assert.equal(describeApproval({ ...base, subject: { kind: "somethingNew", target: "x" } }).title, "Allow something new");
  });

  it("describes a Computer Use takeover with the holder's label quoted", () => {
    const base = { approvalId: "a", sessionId: "s", availableChoices: [], currentRequirementId: null };
    const holder = { sessionLabel: 'Fix "login"', acquiredAt: "2026-11-14T10:00:00Z", lastActivityAt: "2026-11-14T10:05:00Z" };
    const described = describeApproval({ ...base, subject: { kind: "computerUseTakeover", holder } });
    assert.equal(described.title, "Take over Computer Use");
    assert.equal(described.detail, `Another session is using it now: "Fix 'login'"`);
    assert.equal(describeApproval({ ...base, subject: { kind: "computerUseTakeover" } }).detail, "Another session is using it now");
  });

  it("takes the last non-blank line without reading the whole log", () => {
    assert.equal(lastLine(undefined), null);
    assert.equal(lastLine(""), null);
    assert.equal(lastLine("\n"), null);
    assert.equal(lastLine("\n  \n"), null);
    assert.equal(lastLine("only"), "only");
    assert.equal(lastLine("first\nsecond\n\n"), "second");
    assert.equal(lastLine("first\nsecond"), "second");
    assert.equal(lastLine("a\n\x1b[32mok\x1b[0m\n"), "ok");
    assert.equal(lastLine("a\n\x1b[0m\n"), "a");
    assert.equal(lastLine("a\r\nb\r\n"), "b");
    const head = `${"x".repeat(1000)}\n`.repeat(5000);
    assert.equal(lastLine(`${head}tail\n\n\n`), "tail");
  });

  it("parses the real model catalog and flags contributor tiers", () => {
    const models = parseModelList(modelList);
    assert.equal(models.length, 7);
    const contributor = models.find((m) => m.modelId === "muse-spark-1.3-contributor");
    assert.equal(contributor?.contributor, true);
    assert.equal(contributor?.isDefault, true);
    assert.equal(models.find((m) => m.modelId === "muse-spark-1.3")?.contributor, false);
    assert.equal(modelDisplayName("muse-spark-1.3-contributor"), "muse-spark-1.3");
  });

  it("adds Muse Wonder ahead of the catalog until Muse lists it", () => {
    const models = parseModelList(modelList);
    assert.deepEqual(
      models.slice(0, 3).map((m) => [m.modelId, m.contributor, m.isDefault, m.cost]),
      [
        ["muse-wonder-1.0", false, false, { input: 4, output: 20, cached: 0.2, currency: "USD" }],
        ["muse-wonder-1.0-contributor", true, false, null],
        ["muse-wonder-full-1.0", false, false, null],
      ],
    );
    assert.match(models[2]?.description ?? "", /Power Usage and Maximum Usage/);
    const listed = parseModelList({
      models: [
        { modelId: "muse-spark-1.3" },
        { modelId: "muse-wonder-1.0", displayLabel: "Muse Wonder", contextLimit: 1000 },
      ],
    });
    assert.deepEqual(listed.map((m) => m.modelId), ["muse-wonder-1.0-contributor", "muse-wonder-full-1.0", "muse-spark-1.3", "muse-wonder-1.0"]);
    assert.equal(listed.find((m) => m.modelId === "muse-wonder-1.0")?.displayLabel, "Muse Wonder");
    assert.deepEqual(parseModelList({ models: [{ modelId: "local-llama" }] }).map((m) => m.modelId), ["local-llama"]);
    assert.deepEqual(parseModelList({ models: [] }), []);
  });
});

describe("extractRevertSteps", () => {
  it("reads a replacement exactly as the tool wrote it", () => {
    assert.deepEqual(extractRevertSteps(tool("edit", { path: "a.ts", old_string: "a\nb", new_string: "c" })), [{ before: "a\nb", after: "c" }]);
  });

  it("gives one step per edit and none when one is unreadable", () => {
    const edits = [
      { old_string: "a", new_string: "b" },
      { old_string: "c", new_string: "d" },
    ];
    assert.deepEqual(extractRevertSteps(tool("multi_edit", { path: "a.ts", edits })), [
      { before: "a", after: "b" },
      { before: "c", after: "d" },
    ]);
    assert.equal(extractRevertSteps(tool("multi_edit", { path: "a.ts", edits: [...edits, { old_string: "e" }] })), null);
  });

  it("treats a whole-file write as a created file and refuses what it cannot reverse", () => {
    assert.deepEqual(extractRevertSteps(tool("write", { path: "n.txt", content: "hi" })), [{ before: null, after: "hi" }]);
    assert.equal(extractRevertSteps(tool("edit", { path: "a.ts", old_string: "a", new_string: "b", replace_all: true })), null);
    assert.equal(extractRevertSteps(tool("apply_patch", { input: "*** Begin Patch\n--- a.ts\n+++ a.ts\n@@\n-old\n+new" })), null);
    assert.equal(extractRevertSteps(tool("edit", { path: "a.ts", old_string: "a", new_string: "" })), null, "a deletion cannot be found again");
    assert.equal(extractRevertSteps(tool("bash", { command: "ls" })), null);
  });
});

describe("Computer Use approval steps", () => {
  it("names a labelled control with its role, quoting the app's label", () => {
    assert.equal(describeCuaStep({ action: "click", roleWord: "button", label: "Delete repository", step: 1, effect: "", kind: "verb:click" }), 'Click button "Delete repository"');
  });

  it("names the chord of a key step", () => {
    assert.equal(describeCuaStep({ action: "press", chord: "Ctrl+Enter", roleWord: "key", step: 1, effect: "", kind: "verb:key" }), "Press Ctrl+Enter");
  });

  it("gives coordinates only for a step with no label or chord", () => {
    assert.equal(describeCuaStep({ action: "click", point: { x: 120, y: 480 }, step: 1, effect: "", kind: "unlabeled" }), "Click at 120, 480");
    assert.equal(describeCuaStep({ action: "click", label: "OK", point: { x: 1, y: 2 }, step: 1, effect: "", kind: "verb:click" }), 'Click "OK"');
  });

  it("flattens and caps a long label so an app can't fill the card", () => {
    const text = describeCuaStep({ action: "type into", roleWord: "link", label: `a\n${"x".repeat(200)}`, step: 1, effect: "", kind: "verb:type" });
    assert.ok(text.startsWith('Type into link "a x'));
    assert.ok(text.length < 100, `${text.length} characters`);
    assert.ok(text.endsWith('…"'));
  });

  it("keeps an app's label inside its quotes", () => {
    assert.equal(quoteAppText('Cancel" and then "Allow'), `"Cancel' and then 'Allow"`);
    assert.equal(quoteAppText("Pay\u202Eetis\u200B now"), '"Pay etis now"');
  });
});

describe("Computer Use data the call would send", () => {
  it("names a vendor token by its prefix and last 4", () => {
    assert.equal(describeCuaData({ kind: "secret", secretKind: "github_token", mask: { prefix: "ghp_", last4: "3f9a" } }), "Sends a GitHub token ghp_…3f9a");
  });

  it("names a named value by its name and length", () => {
    assert.equal(describeCuaData({ kind: "secret", secretKind: "secret_named_value", mask: { prefix: "password=", chars: 12 } }), "Sends a secret value password=… (12 chars)");
  });

  it("falls back to 'a secret' for a tag it doesn't know, and to the kind alone with no mask", () => {
    assert.equal(describeCuaData({ kind: "secret", secretKind: "stripe_key", mask: { chars: 40 } }), "Sends a secret (40 chars)");
    assert.equal(describeCuaData({ kind: "secret" }), "Sends a secret");
  });

  it("still shows a row for other or unknown kinds", () => {
    assert.equal(describeCuaData({ kind: "other" }), "Sends data Muse couldn't describe");
    assert.equal(describeCuaData({ kind: "file" }), "Sends data Muse couldn't describe");
  });

  it("strips control characters from the mask", () => {
    assert.equal(describeCuaData({ kind: "secret", mask: { prefix: "pw\u202E=", last4: "abcd" } }), "Sends a secret pw =…abcd");
  });
});
