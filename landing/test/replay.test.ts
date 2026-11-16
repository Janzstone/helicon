import { afterEach, describe, expect, test, vi } from "vitest";
import { ReplayClient, buildSteps, runDuration, type Recording } from "@/demo/replay";
import { HeliconController, type Platform } from "@/product/model/controller";
import paginate from "@/demo/recordings/paginate-users.json";
import fixTest from "@/demo/recordings/fix-failing-test.json";
import readme from "@/demo/recordings/readme-oneliner.json";

const recordings = { paginate, fixTest, readme } as unknown as Record<string, Recording>;

afterEach(() => {
  vi.useRealTimers();
});

describe("recordings", () => {
  test.each(Object.entries(recordings))("%s holds no machine paths or names", (_name, recording) => {
    const text = JSON.stringify(recording);
    expect(text).not.toMatch(/\/var\/folders|\/private\/|harjjot/i);
    expect(recording.cwd).toMatch(/^\/Users\/you\/code\//);
  });
});

describe("buildSteps", () => {
  test.each(Object.entries(recordings))("%s keeps every event, in order, and ends the turn in the last step", (_name, recording) => {
    const steps = buildSteps(recording);
    const replayed = steps.flatMap((s) => s.events);
    const expected = recording.live.filter((e) => e.method !== "approval/updated" && e.method !== "approval/resolved");
    expect(replayed).toEqual(expected);
    expect(steps[0].kind).toBe("prompt");
    expect(steps.at(-1)!.events.some((e) => e.method === "turn/completed")).toBe(true);
  });

  test("stops on each approval of the pagination run", () => {
    const steps = buildSteps(recordings.paginate);
    expect(steps.filter((s) => s.kind === "approval")).toHaveLength(3);
    expect(steps.map((s) => s.label)).toContain("Edited src/server.js");
  });

  test("reads the real run time from the turn", () => {
    expect(runDuration(recordings.paginate)).toBeGreaterThan(60_000);
  });
});

describe("ReplayClient", () => {
  test("plays to the end, waiting on each approval until it is decided", async () => {
    vi.useFakeTimers();
    const client = new ReplayClient(recordings.paginate);
    const methods: string[] = [];
    client.subscribe((event) => {
      if (event.type === "msp") methods.push(event.method);
    });
    let approvals = 0;
    for (let guard = 0; guard < 200 && !client.state().done; guard++) {
      if (client.state().waiting) {
        const pending = (await client.loadTranscript(client.sessionId)).pending.approvals[0];
        const allow = pending.availableChoices!.find((c) => c.decision === "approved")!;
        await client.decideApproval({ sessionId: client.sessionId, approvalId: pending.approvalId, choiceId: allow.choiceId });
        approvals++;
      } else {
        client.next();
      }
      vi.runOnlyPendingTimers();
    }
    expect(client.state().done).toBe(true);
    expect(approvals).toBe(3);
    expect(methods.filter((m) => m === "approval/resolved")).toHaveLength(3);
    expect(methods.at(-1)).toBe("session/branchChanged");
    expect(methods).toContain("turn/completed");
    client.dispose();
  });

  test("a rejected approval stops the run until the visitor approves it", async () => {
    vi.useFakeTimers();
    const client = new ReplayClient(recordings.paginate);
    client.next();
    client.next();
    vi.runOnlyPendingTimers();
    expect(client.state().waiting).toBe(true);
    const pending = (await client.loadTranscript(client.sessionId)).pending.approvals[0];
    const reject = pending.availableChoices!.find((c) => c.decision === "abort")!;
    await client.decideApproval({ sessionId: client.sessionId, approvalId: pending.approvalId, choiceId: reject.choiceId });
    expect(client.state()).toMatchObject({ waiting: false, denied: true });
    expect(client.next()).toBe(false);
    client.askAgain();
    expect(client.state()).toMatchObject({ waiting: true, denied: false });
    const again = (await client.loadTranscript(client.sessionId)).pending.approvals[0];
    expect(again.approvalId).not.toBe(pending.approvalId);
    client.dispose();
  });

  test("a visitor who pauses between steps never sees the thread reported as stopped", async () => {
    vi.useFakeTimers();
    const client = new ReplayClient(recordings.paginate);
    const loadTranscript = vi.spyOn(client, "loadTranscript");
    const platform: Platform = {
      loadPrefs: () => null,
      savePrefs: () => {},
      readHash: () => `#/t/${encodeURIComponent(client.sessionId)}`,
      writeHash: () => {},
      onHashChange: () => () => {},
      now: () => Date.now(),
      schedule: (fn, ms) => setTimeout(fn, ms),
      cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      focused: () => true,
    };
    const controller = new HeliconController(client, platform);
    const stop = controller.start();
    await vi.advanceTimersByTimeAsync(1_000);
    client.next();
    await vi.advanceTimersByTimeAsync(5_000);
    const thread = () => controller.store.get().threads[client.sessionId];
    expect(thread()?.fold.activeTurnId).not.toBeNull();
    const loads = loadTranscript.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(thread()?.stalled).toBe(false);
    expect(loadTranscript.mock.calls.length).toBe(loads);
    stop();
    client.dispose();
  });
});
