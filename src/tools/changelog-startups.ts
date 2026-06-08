import fs from "fs";
import path from "path";
import type { ChatCompletionTool } from "openai/resources/chat/completions.js";
import { config } from "../config.js";

const DATA = config.dataDir;

let changelog: Record<string, string> | null = null;

function ensureLoaded() {
  if (changelog) return;
  changelog = JSON.parse(
    fs.readFileSync(path.join(DATA, "changelog-startups.json"), "utf-8"),
  ) as Record<string, string>;
}

async function get_startup_updates(
  id: string,
): Promise<{ id: string; diff: string } | null> {
  ensureLoaded();
  const diff = changelog![id];
  if (!diff) return null;
  return { id, diff };
}

const getStartupUpdatesTool: ChatCompletionTool = {
  type: "function",
  function: {
    name: "get_startup_updates",
    description:
      "Retourne le diff git récent du fichier de description d'une startup (modifications de pitch, phases, membres, etc.).",
    parameters: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description:
            "Slug de la startup (ex: recosante), issu de search_startups",
        },
      },
      required: ["id"],
    },
  },
};

export const tools = [getStartupUpdatesTool];

export const handlers: Record<
  string,
  (args: Record<string, unknown>) => Promise<unknown>
> = {
  get_startup_updates: (args) =>
    get_startup_updates(args["id"] as string),
};

export function reset(): void {
  changelog = null;
}
