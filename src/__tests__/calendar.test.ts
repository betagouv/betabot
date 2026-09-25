import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { keepParisWallClock, parisWallToUtc } from "../tools/calendar.js";

function parisISO(date: Date): string {
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    dtf.formatToParts(date).map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

describe("keepParisWallClock — recurring event DST re-anchoring", () => {
  // A weekly "Tech stream" authored at 14:00 Paris in summer (2026-06-02,
  // CEST +2 → 12:00Z).
  const anchor = new Date("2026-06-02T12:00:00.000Z");

  it("leaves occurrences unchanged when no DST drift occurs", () => {
    // 2026-10-20 is still CEST (+2), so the fixed-UTC occurrence renders at 14:00.
    const occ = new Date("2026-10-20T12:00:00.000Z");
    const fixed = keepParisWallClock(occ, anchor);
    assert.equal(parisISO(fixed), "2026-10-20T14:00");
  });

  it("shifts an occurrence back to 14:00 Paris after the autumn DST change", () => {
    // After 2026-10-25 Paris is CET (+1); 12:00Z renders as 13:00. Must come
    // back to 14:00 Paris.
    const occ = new Date("2026-10-27T12:00:00.000Z");
    const fixed = keepParisWallClock(occ, anchor);
    assert.equal(parisISO(fixed), "2026-10-27T14:00");
  });

  it("keeps winter occurrences at 14:00 Paris too", () => {
    const occ = new Date("2026-11-03T13:00:00.000Z"); // CET (+1): 13:00Z → 14:00
    const fixed = keepParisWallClock(occ, anchor);
    assert.equal(parisISO(fixed), "2026-11-03T14:00");
  });
});

describe("parisWallToUtc — host-timezone-independent TZID reconstruction", () => {
  // The `ical` library exposes the authored Paris wall-clock through the Date's
  // *local* components. Build those components the same way (authoring them in
  // the local zone) and expect the correct absolute UTC instant regardless of
  // the process timezone (the runtime host is UTC).
  function authoredWall(y: number, mo: number, d: number, h: number, m: number): Date {
    return new Date(y, mo, d, h, m); // local components == authored Paris wall-clock
  }

  it("reconstructs a summer 14:00 Paris instant as 12:00Z", () => {
    // 2026-06-02 14:00 CEST (+2) → 12:00Z
    const utc = parisWallToUtc(authoredWall(2026, 5, 2, 14, 0));
    assert.equal(utc.toISOString(), "2026-06-02T12:00:00.000Z");
  });

  it("reconstructs a winter 14:00 Paris instant as 13:00Z", () => {
    // 2026-01-06 14:00 CET (+1) → 13:00Z
    const utc = parisWallToUtc(authoredWall(2026, 0, 6, 14, 0));
    assert.equal(utc.toISOString(), "2026-01-06T13:00:00.000Z");
  });

  it("reconstructs a post-DST 14:00 Paris instant as 13:00Z", () => {
    // After 2026-10-25, Paris is CET (+1).
    const utc = parisWallToUtc(authoredWall(2026, 9, 27, 14, 0));
    assert.equal(utc.toISOString(), "2026-10-27T13:00:00.000Z");
  });

  it("reconstructs the forum 09:30 Paris instant as 07:30Z", () => {
    const utc = parisWallToUtc(authoredWall(2026, 9, 1, 9, 30));
    assert.equal(utc.toISOString(), "2026-10-01T07:30:00.000Z");
  });
});
