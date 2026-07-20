import { describe, expect, test } from "bun:test";
import type { DomainEvent } from "@codegent/protocol";
import { Watchdog } from "../src/orchestrator/watchdog";

describe("manual override detection watchdog", () => {
  test("persistent running-versus-blocked disagreement emits one textless mismatch notice", () => {
    let now = 1_000;
    const events: DomainEvent[] = [];
    const watchdog = new Watchdog({
      clock: () => now,
      thresholdMs: 5_000,
      emit: event => events.push(event),
    });
    const observation = {
      cardId: 7,
      manual: { state: "running", since: 1_000 } as const,
      detected: { state: "blocked", since: 1_000 } as const,
    };

    watchdog.tick([observation]);
    now = 6_001;
    watchdog.tick([observation]);
    watchdog.tick([observation]);

    expect(events).toEqual([{ t: "notice", cardId: 7, kind: "mismatch" }]);
    expect(Object.keys(events[0]!).sort()).toEqual(["cardId", "kind", "t"]);
    expect(JSON.stringify(events[0])).not.toMatch(/text|message|content|screen|terminal/i);
  });

  test("agreement emits no notice", () => {
    let now = 10_000;
    const events: DomainEvent[] = [];
    const watchdog = new Watchdog({
      clock: () => now,
      thresholdMs: 1_000,
      emit: event => events.push(event),
    });

    watchdog.tick([{
      cardId: 3,
      manual: { state: "running", since: 10_000 },
      detected: { state: "working", since: 10_000 },
    }]);
    now = 20_000;
    watchdog.tick([{
      cardId: 3,
      manual: { state: "running", since: 10_000 },
      detected: { state: "working", since: 10_000 },
    }]);

    expect(events).toEqual([]);
  });

  test("B1: persistent manual-running versus detected idle emits exactly one mismatch", () => {
    let now = 40_000;
    const events: DomainEvent[] = [];
    const watchdog = new Watchdog({
      clock: () => now,
      thresholdMs: 3_000,
      emit: event => events.push(event),
    });
    const observation = {
      cardId: 13,
      manual: { state: "running", since: 40_000 } as const,
      detected: { state: "idle", since: 40_000 } as const,
    };

    watchdog.tick([observation]);
    now = 43_001;
    watchdog.tick([observation]);
    watchdog.tick([observation]);

    expect(events).toEqual([{ t: "notice", cardId: 13, kind: "mismatch" }]);
  });

  test("B4: an emitted mismatch produces one content-free clear when detection agrees", () => {
    let now = 50_000;
    const events: DomainEvent[] = [];
    const watchdog = new Watchdog({
      clock: () => now,
      thresholdMs: 1_000,
      emit: event => events.push(event),
    });
    const manual = { state: "running", since: 50_000 } as const;

    watchdog.tick([{
      cardId: 17,
      manual,
      detected: { state: "idle", since: 50_000 },
    }]);
    now = 51_001;
    watchdog.tick([{
      cardId: 17,
      manual,
      detected: { state: "idle", since: 50_000 },
    }]);
    watchdog.tick([{
      cardId: 17,
      manual,
      detected: { state: "working", since: 51_001 },
    }]);
    watchdog.tick([{
      cardId: 17,
      manual,
      detected: { state: "working", since: 51_001 },
    }]);

    expect(events).toEqual([
      { t: "notice", cardId: 17, kind: "mismatch" },
      { t: "notice-clear", cardId: 17, kind: "mismatch" },
    ]);
    expect(JSON.stringify(events)).not.toMatch(/text|message|content|screen|terminal/i);
  });

  test("suppressed adapter agreement emits no notice", () => {
    let now = 60_000;
    const events: DomainEvent[] = [];
    const watchdog = new Watchdog({
      clock: () => now,
      thresholdMs: 1_000,
      emit: event => events.push(event),
    });
    const observation = {
      cardId: 19,
      manual: { state: "running", since: 60_000 } as const,
      detected: null,
      suppressed: { intent: "flag-clear", since: 60_000 } as const,
    };

    watchdog.tick([observation]);
    now = 70_000;
    watchdog.tick([observation]);
    expect(events).toEqual([]);
  });

  test("R2 regression: suppressed agreement clears and later disagreement emits again", () => {
    let now = 80_000;
    const events: DomainEvent[] = [];
    const watchdog = new Watchdog({
      clock: () => now,
      thresholdMs: 1_000,
      emit: event => events.push(event),
    });
    const manual = { state: "running", since: 80_000 } as const;

    watchdog.tick([{
      cardId: 23,
      manual,
      detected: null,
      suppressed: { intent: "permission", since: 80_000 },
    }]);
    now = 81_001;
    watchdog.tick([{
      cardId: 23,
      manual,
      detected: null,
      suppressed: { intent: "permission", since: 80_000 },
    }]);
    watchdog.tick([{
      cardId: 23,
      manual,
      detected: null,
      suppressed: { intent: "flag-clear", since: 81_001 },
    }]);
    watchdog.tick([{
      cardId: 23,
      manual,
      detected: null,
      suppressed: { intent: "question", since: 81_001 },
    }]);
    now = 82_002;
    watchdog.tick([{
      cardId: 23,
      manual,
      detected: null,
      suppressed: { intent: "question", since: 81_001 },
    }]);

    expect(events).toEqual([
      { t: "notice", cardId: 23, kind: "mismatch" },
      { t: "notice-clear", cardId: 23, kind: "mismatch" },
      { t: "notice", cardId: 23, kind: "mismatch" },
    ]);
    expect(JSON.stringify(events)).not.toMatch(/text|message|content|screen|terminal/i);
  });

  test("persistent needs-input-versus-working disagreement uses the inverse rule", () => {
    let now = 30_000;
    const events: DomainEvent[] = [];
    const watchdog = new Watchdog({
      clock: () => now,
      thresholdMs: 2_000,
      emit: event => events.push(event),
    });
    const observation = {
      cardId: 11,
      manual: { state: "needs-input", since: 30_000 } as const,
      detected: { state: "working", since: 30_000 } as const,
    };

    watchdog.tick([observation]);
    now = 32_001;
    watchdog.tick([observation]);

    expect(events).toEqual([{ t: "notice", cardId: 11, kind: "mismatch" }]);
  });
});
