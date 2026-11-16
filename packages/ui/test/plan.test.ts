import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyEvents, emptyFold, type ThreadFold } from "../src/model/fold.js";
import { backgroundTasks, formatReset, planAge, planView } from "../src/model/plan.js";
import type { MspItem, ViewEvent } from "../src/types.js";

const NOW = 1_800_000_000_000;

describe("plan meter", () => {
  it("shows nothing until Muse has seen a window", () => {
    assert.equal(planView(null, NOW), null);
  });

  it("names the short window by its length and counts down to each reset", () => {
    const view = planView(
      {
        tier: "high_usage",
        observedAtMs: NOW - 60_000,
        window: { usedPercent: 72.4, resetsAtMs: NOW + (2 * 60 + 14) * 60_000, windowDurationMins: 300 },
        weekly: { usedPercent: 94, resetsAtMs: NOW - 1, windowDurationMins: null },
      },
      NOW,
    );
    assert.equal(view?.tier, "High usage");
    assert.deepEqual(view?.rows, [
      { key: "window", label: "5-hour window", percent: 72, used: "72%", tone: "warn", resets: "Resets in 2h 14m" },
      { key: "weekly", label: "Weekly", percent: 94, used: "94%", tone: "danger", resets: "Reset" },
    ]);
    assert.equal(view?.stale, false);
  });

  it("carries how old the reading is, from the first minute", () => {
    // Muse only reports this with a model call, so a percentage on its own says nothing about now.
    const at = (ms: number) =>
      planView(
        {
          tier: "high_usage",
          observedAtMs: NOW - ms,
          window: { usedPercent: 0, resetsAtMs: NOW + 60_000, windowDurationMins: 300 },
          weekly: { usedPercent: 1, resetsAtMs: NOW + 60_000, windowDurationMins: null },
        },
        NOW,
      )?.age;
    assert.equal(at(5_000), "just now");
    assert.equal(at(4 * 60_000), "4m");
    assert.equal(at(3 * 60 * 60_000), "3h");
    assert.equal(at(3 * 24 * 60 * 60_000), "3d");
    assert.equal(planAge(NOW, NOW), "just now");
  });

  it("clamps odd percentages and marks an old reading as stale", () => {
    const view = planView(
      {
        tier: "everyday",
        observedAtMs: NOW - 2 * 60 * 60_000,
        window: { usedPercent: 140, resetsAtMs: NOW + 1_000, windowDurationMins: 90 },
        weekly: { usedPercent: -3, resetsAtMs: NOW + 1_000, windowDurationMins: null },
      },
      NOW,
    );
    assert.equal(view?.rows[0]?.label, "90-minute window");
    assert.equal(view?.rows[0]?.percent, 100);
    assert.equal(view?.rows[1]?.percent, 0);
    assert.equal(view?.rows[1]?.used, "0%", "a negative reading is junk, not proof of use");
    assert.equal(view?.rows[1]?.tone, "ok");
    assert.equal(view?.stale, true);
  });

  it("says under 1% rather than 0% for a live window Muse has reported on", () => {
    // Issue #26: Muse reports whole percentages, and a reading only exists because a model call was made, so a 0
    // for a window that has not reset means "some, under 1%", not "untouched".
    const view = planView(
      {
        tier: "high_usage",
        observedAtMs: NOW - 60_000,
        window: { usedPercent: 0, resetsAtMs: NOW + 60 * 60_000, windowDurationMins: 300 },
        weekly: { usedPercent: 0.4, resetsAtMs: NOW + 24 * 60 * 60_000, windowDurationMins: null },
      },
      NOW,
    );
    assert.equal(view?.rows[0]?.used, "<1%");
    assert.equal(view?.rows[0]?.percent, 0);
    assert.equal(view?.rows[1]?.used, "<1%");
    // Once the window has reset, the old reading says nothing about the new one, so it is not dressed up.
    const reset = planView(
      {
        tier: "high_usage",
        observedAtMs: NOW - 6 * 60 * 60_000,
        window: { usedPercent: 0, resetsAtMs: NOW - 1, windowDurationMins: 300 },
        weekly: { usedPercent: 1, resetsAtMs: NOW + 60_000, windowDurationMins: null },
      },
      NOW,
    );
    assert.equal(reset?.rows[0]?.used, "0%");
    assert.equal(reset?.rows[1]?.used, "1%");
  });

  it("leaves out a tier that is an opaque id rather than a plan name", () => {
    const reading = (tier: string) =>
      planView(
        {
          tier,
          observedAtMs: NOW,
          window: { usedPercent: 0, resetsAtMs: NOW + 1, windowDurationMins: 300 },
          weekly: { usedPercent: 0, resetsAtMs: NOW + 1, windowDurationMins: null },
        },
        NOW,
      )?.tier;
    // What Muse Code 1.3.0 actually reports.
    assert.equal(reading("27681527378179523"), null);
    assert.equal(reading("power_usage"), "Power usage");
  });
});

describe("reset countdown", () => {
  it("stays in hours for a day or so and switches to days for the weekly cap", () => {
    const hour = 60 * 60 * 1000;
    assert.equal(formatReset(2 * hour + 17 * 60_000), "2h 17m");
    assert.equal(formatReset(47 * hour), "47h");
    assert.equal(formatReset(77 * hour), "3d 5h");
    assert.equal(formatReset(72 * hour), "3d");
  });
});

describe("background tasks", () => {
  it("lists only tool calls still running in the background", () => {
    const item = (itemId: string, patch: Partial<MspItem>): MspItem => ({ itemId, kind: "toolCall", status: "inProgress", revision: 1, ...patch });
    const base = emptyFold();
    const events = [
      item("a", { background: true }),
      item("b", { background: false }),
      item("c", { background: true, status: "completed" }),
      item("d", { kind: "subagent", background: true }),
    ].map((i): ViewEvent => ({ at: 1, method: "item/completed", params: { sessionId: "s1", item: i } }));
    const fold: ThreadFold = applyEvents(base, events);
    assert.deepEqual(backgroundTasks(fold), ["a"]);
  });
});
