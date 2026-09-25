import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { keepParisWallClock } from "../tools/calendar.js";

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
