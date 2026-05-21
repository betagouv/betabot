import fs from "fs";
import path from "path";
import type { ChatCompletionTool } from "openai/resources/chat/completions.js";
import { config } from "../config.js";

const DATA = config.dataDir;

interface Video {
  title: string;
  date: string;
  url: string;
  channel: string;
}

interface PeertubeItem {
  id: string;
  url: string;
  title: string;
  date_published?: string;
  date_modified?: string;
}

interface PeertubeChannel {
  title: string;
  items?: PeertubeItem[];
}

async function get_videos(channel?: string): Promise<Video[]> {
  const peertubeDir = path.join(DATA, "peertube");
  if (!fs.existsSync(peertubeDir)) return [];

  const files = fs.readdirSync(peertubeDir).filter((f) => f.endsWith(".json"));
  const channelFiles = channel
    ? files.filter((f) => f === `${channel}.json`)
    : files;

  const results: Video[] = [];

  for (const file of channelFiles) {
    const channelName = path.basename(file, ".json");
    let feed: PeertubeChannel;
    try {
      feed = JSON.parse(
        fs.readFileSync(path.join(peertubeDir, file), "utf-8")
      ) as PeertubeChannel;
    } catch {
      continue;
    }

    const items = (feed.items ?? []).slice(0, 10);
    for (const item of items) {
      results.push({
        title: item.title ?? "(sans titre)",
        date: item.date_published ?? item.date_modified ?? "",
        url: item.url ?? item.id ?? "",
        channel: channelName,
      });
    }
  }

  results.sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
  );

  return results;
}

// ─── Tool definition ──────────────────────────────────────────────────────────

const getVideosTool: ChatCompletionTool = {
  type: "function",
  function: {
    name: "get_videos",
    description:
      "Retourne les vidéos récentes de la communauté beta.gouv.fr sur PeerTube.",
    parameters: {
      type: "object",
      properties: {
        channel: {
          type: "string",
          description:
            "Nom de la chaîne (ex: bluehats, animation_beta). Omis = toutes les chaînes.",
        },
      },
    },
  },
};

export const tools = [getVideosTool];

export const handlers: Record<
  string,
  (args: Record<string, unknown>) => Promise<unknown>
> = {
  get_videos: (args) =>
    get_videos(args["channel"] as string | undefined),
};
