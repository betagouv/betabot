import fs from "fs";
import path from "path";
import ical from "ical";
import * as rruleModule from "rrule";
import type { ChatCompletionTool } from "openai/resources/chat/completions.js";
import { config } from "../config.js";

// rrule CJS interop differs across environments: v2 exports named, some builds export the class directly
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const RRule: typeof import("rrule").RRule | undefined =
  (rruleModule as any).RRule ??
  (rruleModule as any).default?.RRule ??
  undefined;

const DATA = config.dataDir;

// Renders "HH:MM" of a Date's wall-clock time in Europe/Paris.
function toParisWallTime(date: Date): { h: number; m: number } {
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    dtf.formatToParts(date).map((p) => [p.type, p.value]),
  );
  return { h: Number(parts.hour), m: Number(parts.minute) };
}

// Renders a Date as an ISO-8601 string with the Europe/Paris local time and
// offset, so consumers of this tool never have to reason about UTC.
function toParisISOString(date: Date): string {
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    dtf.formatToParts(date).map((p) => [p.type, p.value]),
  );
  const localDate = `${parts.year}-${parts.month}-${parts.day}`;
  const localTime = `${parts.hour}:${parts.minute}:${parts.second}`;

  const offsetName =
    new Intl.DateTimeFormat("en-US", {
      timeZone: "Europe/Paris",
      timeZoneName: "shortOffset",
    })
      .formatToParts(date)
      .find((p) => p.type === "timeZoneName")?.value ?? "GMT+2";

  const [, sign, h, m] = offsetName.match(/GMT([+-])(\d+)(?::(\d+))?/) ?? [];
  const offset = sign
    ? `${sign}${h!.padStart(2, "0")}:${(m ?? "00").padStart(2, "0")}`
    : "+02:00";

  return `${localDate}T${localTime}${offset}`;
}

// For events anchored in Europe/Paris, rrule expands occurrences at fixed UTC
// offsets from DTSTART. Across a DST transition the local wall-clock time would
// drift by an hour (e.g. a weekly "14:00 Paris" stream would become 13:00 after
// the October change). Re-anchor `occ` so its Paris wall-clock time matches the
// `anchor` occurrence (the authoring DTSTART). Exported for unit-testing.
export function keepParisWallClock(occ: Date, anchor: Date): Date {
  const target = toParisWallTime(anchor);
  const current = toParisWallTime(occ);
  const drift =
    (target.h - current.h) * 60 * 60 * 1000 +
    (target.m - current.m) * 60 * 1000;
  return new Date(occ.getTime() + drift);
}

interface CalendarEvent {
  summary: string;
  start: string;
  end: string;
  location?: string;
  description?: string;
}

async function get_calendar(
  days_ahead = 14,
  days_back = 0,
): Promise<CalendarEvent[]> {
  const icsPath = path.join(DATA, "calendar.ics");
  if (!fs.existsSync(icsPath)) return [];

  const raw = fs.readFileSync(icsPath, "utf-8");
  const parsed = ical.parseICS(raw);

  const now = new Date();
  const from = new Date(now.getTime() - days_back * 24 * 60 * 60 * 1000);
  const to = new Date(now.getTime() + days_ahead * 24 * 60 * 60 * 1000);

  const events: CalendarEvent[] = [];

  for (const [, component] of Object.entries(parsed)) {
    if (component.type !== "VEVENT") continue;

    const start = component.start ? new Date(component.start) : null;
    const end = component.end ? new Date(component.end) : null;

    if (!start) continue;

    const baseFields = {
      summary: component.summary ?? "(sans titre)",
      ...(component.location ? { location: component.location } : {}),
      ...(component.description
        ? { description: (component.description as string).slice(0, 500) }
        : {}),
    };

    if (component.rrule && RRule) {
      const duration = end ? end.getTime() - start.getTime() : 0;
      const dtstart = start
        .toISOString()
        .replace(/[-:]/g, "")
        .replace(/\.\d{3}/, "");
      const rule = RRule.fromString(
        `DTSTART:${dtstart}\nRRULE:${component.rrule}`,
      );
      // For events anchored in Europe/Paris, rrule expands occurrences at fixed
      // UTC offsets from DTSTART. Across a DST transition the local wall-clock
      // time would drift by an hour (e.g. a weekly "14:00 Paris" stream would
      // become 13:00 after the October change). Re-anchor each occurrence so
      // the wall-clock time stays identical to the authoring DTSTART.
      const isParis = (component.start as { tz?: string } | undefined)?.tz === "Europe/Paris";
      for (let occ of rule.between(from, to, true)) {
        if (isParis) {
          occ = keepParisWallClock(occ, start);
        }
        events.push({
          ...baseFields,
          start: toParisISOString(occ),
          end: toParisISOString(new Date(occ.getTime() + duration)),
        });
      }
    } else if (!component.rrule) {
      if (start < from || start > to) continue;
      events.push({
        ...baseFields,
        start: toParisISOString(start),
        end: toParisISOString(end ?? start),
      });
    }
  }

  events.sort(
    (a, b) => new Date(a.start).getTime() - new Date(b.start).getTime(),
  );

  return events;
}

// ─── Tool definition ──────────────────────────────────────────────────────────

const getCalendarTool: ChatCompletionTool = {
  type: "function",
  function: {
    name: "get_calendar",
    description:
      "Retourne les événements du calendrier de la communauté beta.gouv.fr, à venir ou passés. Les heures de début et de fin sont exprimées à l'heure de Paris (Europe/Paris).",
    parameters: {
      type: "object",
      properties: {
        days_ahead: {
          type: "integer",
          description: "Nombre de jours à venir (défaut: 14)",
          default: 14,
        },
        days_back: {
          type: "integer",
          description: "Nombre de jours dans le passé à inclure (défaut: 0)",
          default: 0,
        },
      },
    },
  },
};

export const tools = [getCalendarTool];

export const handlers: Record<
  string,
  (args: Record<string, unknown>) => Promise<unknown>
> = {
  get_calendar: (args) =>
    get_calendar(
      (args["days_ahead"] as number) ?? 14,
      (args["days_back"] as number) ?? 0,
    ),
};
