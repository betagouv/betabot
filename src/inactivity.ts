import type { MatrixClient } from "matrix-bot-sdk";
import {
  listCreatedRooms,
  removeCreatedRoom,
  setWarned,
} from "./commands/created-rooms.js";
import { detachAndClose, getLastActivityTs } from "./commands/rooms.js";

// Parse a duration like "7d", "12h", "30m", "90s". A bare number means minutes.
// Returns milliseconds, or null if unset/invalid.
export function parseDuration(raw: string | undefined): number | null {
  if (!raw) return null;
  const m = raw.trim().match(/^(\d+)\s*(s|m|h|d)?$/i);
  if (!m) return null;
  const n = parseInt(m[1]!, 10);
  const unit = (m[2] ?? "m").toLowerCase();
  const mult =
    unit === "s" ? 1000 : unit === "h" ? 3_600_000 : unit === "d" ? 86_400_000 : 60_000;
  return n * mult;
}

export function humanDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${(m % 60).toString().padStart(2, "0")}`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh ? `${d}j ${rh}h` : `${d}j`;
}

type Send = (roomId: string, text: string) => Promise<void>;

// One pass over the bot-created rooms: warn the stale ones, delete the dead ones.
export async function sweepInactiveRooms(
  client: MatrixClient,
  spaceId: string | undefined,
  botUserId: string,
  warnMs: number,
  deleteMs: number,
  send: Send,
): Promise<void> {
  const now = Date.now();
  for (const room of listCreatedRooms()) {
    const ts = await getLastActivityTs(client, room.roomId);
    if (ts == null) continue;
    const age = now - ts;

    if (age >= deleteMs) {
      try {
        await send(
          room.roomId,
          `🗑 **Salon supprimé automatiquement** — aucun message depuis ${humanDuration(age)}.`,
        );
      } catch {
        // sending may fail if the room is already unreachable
      }
      try {
        await detachAndClose(client, spaceId, room.roomId, botUserId);
      } catch {
        removeCreatedRoom(room.roomId);
      }
      console.log(
        `[inactivity] closed ${room.roomId} (${room.name}) — inactive ${humanDuration(age)}`,
      );
    } else if (age >= warnMs && room.warnedForTs !== ts) {
      try {
        await send(
          room.roomId,
          `⚠️ **Salon inactif** — aucun message depuis ${humanDuration(age)}.\nSans nouveau message, ce salon sera **supprimé** dans ~${humanDuration(deleteMs - age)}.`,
        );
      } catch {
        // ignore send failure; we'll retry next sweep
      }
      setWarned(room.roomId, ts);
      console.log(`[inactivity] warned ${room.roomId} (${room.name})`);
    }
  }
}
