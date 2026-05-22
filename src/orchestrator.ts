import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionToolMessageParam,
} from "openai/resources/chat/completions.js";
import { config } from "./config.js";
import {
  tools as memberTools,
  handlers as memberHandlers,
} from "./tools/members.js";
import {
  tools as startupTools,
  handlers as startupHandlers,
} from "./tools/startups.js";
import { tools as repoTools, handlers as repoHandlers } from "./tools/repos.js";
import { tools as docTools, handlers as docHandlers } from "./tools/docs.js";
import {
  tools as calendarTools,
  handlers as calendarHandlers,
} from "./tools/calendar.js";
import {
  tools as videoTools,
  handlers as videoHandlers,
} from "./tools/videos.js";
import {
  tools as incubatorTools,
  handlers as incubatorHandlers,
} from "./tools/incubators.js";

const SYSTEM_PROMPT = `Tu es l'assistant de la communauté beta.gouv.fr. Tu réponds en français.
Tu as accès à des outils pour chercher des membres, des startups, des dépôts de code,
de la documentation et des actualités. Utilise toujours les outils pour répondre
aux questions factuelles. Ne devine pas les noms ou les données.
Tu emploies le tutoiement respecteux, utilise du markdown riche et un peu d'emojis.

Pour les questions liées à notre actualité, utilise ces données:
 - calendrier
 - les mises à jour sur la documentation
 - les dernieres vidéos peertube
 - le changelog de betagouv/doc.incubateur.net-communaute
 - les changelogs des organisations

Lorsque tu mentionnes une entité, ajoute TOUJOURS un lien:
 - une startup, une produit, une équipe, créé un lien vers https://beta.gouv.fr/startups/[ghid]
 - un membre de la communauté, créé un lien vers https://espace-membre.beta.gouv.fr/community/[username]
 - un repository ou commit GIT, créé un lien vers https://github.com/[ORG]/[REPO]
 - un organisation GIT, créé un lien vers https://github.com/[ORG]
 - la documentation, crée un lien vers https://doc.incubateur.net/[PATH] sans le suffixe \`.md\`.
 - un standard beta.gouv.fr, créé un lien vers https://github.com/betagouv/standards/blob/main/[catagorie]/[standard]

Cite toujours tes sources et lorsque c'est nécessaire tu peux ajouter ces liens en fin de message:
 - [documentation beta.gouv.fr](https://doc.incubateur.net)
 - [espace membre](https://espace-membre.beta.gouv.fr)
 - [site beta.gouv.fr](https://beta.gouv.fr)
`;

const MAX_HISTORY = 20;
const MAX_TOOL_ITERATIONS = 10;

const ALL_TOOLS: ChatCompletionTool[] = [
  ...memberTools,
  ...startupTools,
  ...repoTools,
  ...docTools,
  ...calendarTools,
  ...videoTools,
  ...incubatorTools,
];

const ALL_HANDLERS: Record<
  string,
  (args: Record<string, unknown>) => Promise<unknown>
> = {
  ...memberHandlers,
  ...startupHandlers,
  ...repoHandlers,
  ...docHandlers,
  ...calendarHandlers,
  ...videoHandlers,
  ...incubatorHandlers,
};

export class Orchestrator {
  private client: OpenAI;
  private history: Map<string, ChatCompletionMessageParam[]> = new Map();

  constructor() {
    this.client = new OpenAI({
      baseURL: config.openai.baseUrl,
      apiKey: config.openai.apiKey,
    });
  }

  private getConversationKey(roomId: string, threadId?: string): string {
    return `${roomId}:${threadId ?? "root"}`;
  }

  private getHistory(key: string): ChatCompletionMessageParam[] {
    if (!this.history.has(key)) {
      this.history.set(key, []);
    }
    return this.history.get(key)!;
  }

  private trimHistory(messages: ChatCompletionMessageParam[]): void {
    while (messages.length > MAX_HISTORY) {
      messages.shift();
    }
  }

  clearHistory(roomId: string, threadId?: string): void {
    const key = this.getConversationKey(roomId, threadId);
    this.history.delete(key);
  }

  async handle(input: {
    userId: string;
    roomId: string;
    threadId?: string;
    text: string;
  }): Promise<string> {
    const key = this.getConversationKey(input.roomId, input.threadId);
    const history = this.getHistory(key);

    history.push({ role: "user", content: input.text });
    this.trimHistory(history);

    const messages: ChatCompletionMessageParam[] = [
      { role: "system", content: SYSTEM_PROMPT },
      ...history,
    ];

    const debug = (...args: unknown[]) =>
      process.stderr.write(`[debug] ${args.join(" ")}\n`);

    debug(`handle key=${key} text=${JSON.stringify(input.text)}`);
    debug(`history length=${history.length}`);

    let iterations = 0;

    while (iterations < MAX_TOOL_ITERATIONS) {
      iterations++;
      debug(`--- LLM iteration ${iterations}/${MAX_TOOL_ITERATIONS} ---`);
      debug(
        `sending ${messages.length} messages to model=${config.openai.model}`,
      );

      const response = await this.client.chat.completions.create({
        model: config.openai.model,
        messages,
        tools: ALL_TOOLS,
        tool_choice: "auto",
      });

      const choice = response.choices[0];
      if (!choice) throw new Error("No response from LLM");

      const assistantMessage = choice.message;
      messages.push(assistantMessage);

      debug(
        `finish_reason=${choice.finish_reason} tool_calls=${assistantMessage.tool_calls?.length ?? 0}`,
      );
      if (response.usage) {
        debug(
          `tokens: prompt=${response.usage.prompt_tokens} completion=${response.usage.completion_tokens} total=${response.usage.total_tokens}`,
        );
      }

      if (
        choice.finish_reason === "stop" ||
        !assistantMessage.tool_calls?.length
      ) {
        const text = assistantMessage.content ?? "";
        if (text.trim()) {
          debug(`final response (${text.length} chars)`);
          history.push({ role: "assistant", content: text });
          this.trimHistory(history);
          return text;
        }
        // LLM stopped but returned no content — ask it to summarize what it found
        debug(`empty response after stop, requesting summary`);
        break;
      }

      // Dispatch tool calls
      debug(`dispatching ${assistantMessage.tool_calls.length} tool call(s)`);
      const toolResults: ChatCompletionToolMessageParam[] = await Promise.all(
        assistantMessage.tool_calls.map(async (tc) => {
          const handler = ALL_HANDLERS[tc.function.name];
          let result: unknown;
          debug(`  tool=${tc.function.name} args=${tc.function.arguments}`);
          if (!handler) {
            result = { error: `Unknown tool: ${tc.function.name}` };
            debug(`  -> unknown tool`);
          } else {
            try {
              const args = JSON.parse(tc.function.arguments) as Record<
                string,
                unknown
              >;
              result = await handler(args);
              const resultStr = JSON.stringify(result);
              debug(
                `  -> result (${resultStr.length} chars): ${resultStr.slice(0, 200)}${resultStr.length > 200 ? "..." : ""}`,
              );
            } catch (err) {
              result = { error: String(err) };
              debug(`  -> error: ${err}`);
            }
          }
          return {
            role: "tool" as const,
            tool_call_id: tc.id,
            content: JSON.stringify(result),
          };
        }),
      );

      messages.push(...toolResults);
    }

    // Fallback: ask LLM to summarize with what we have
    debug(`max iterations reached, requesting final summary`);
    const finalResponse = await this.client.chat.completions.create({
      model: config.openai.model,
      messages,
    });

    const text = finalResponse.choices[0]?.message.content ?? "";
    debug(`fallback final response (${text.length} chars)`);
    history.push({ role: "assistant", content: text });
    this.trimHistory(history);
    return text;
  }
}
