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
import {
  tools as sqliteTools,
  handlers as sqliteHandlers,
} from "./tools/sqlite.js";
import {
  tools as proconnectDocTools,
  handlers as proconnectDocHandlers,
} from "./tools/docs-proconnect.js";
import {
  tools as franceconnectDocTools,
  handlers as franceconnectDocHandlers,
} from "./tools/docs-franceconnect.js";
import {
  tools as dsfrDocTools,
  handlers as dsfrDocHandlers,
} from "./tools/docs-dsfr.js";
import { tools as wttjTools, handlers as wttjHandlers } from "./tools/wttj.js";
import {
  tools as changelogStartupsTools,
  handlers as changelogStartupsHandlers,
} from "./tools/changelog-startups.js";
import {
  tools as messagerieDocTools,
  handlers as messagerieDocHandlers,
} from "./tools/docs-messagerie.js";
import { detectEntities, type DetectedEntities } from "./entity-detector.js";

const SYSTEM_PROMPT = `Tu es l'assistant de la communauté beta.gouv.fr. Tu réponds en français.
Tu as accès à des outils pour chercher des membres, des startups, des dépôts de code,
de la documentation et des actualités, offres d'emploi et missions. uniquement des données publiques. Utilise toujours les outils pour répondre
aux questions factuelles. Ne devine pas les noms ou les données. Ne répond pas aux questions hors de ton périmètre.
Pour les questions statistiques ou d'agrégation (comptages, classements, distributions), utilise l'outil query_data avec du SQL plutôt que de chaîner plusieurs recherches sémantiques.
Pour les questions liées à la configuration email, messagerie ou DNS mail (MX, DKIM, DMARC, SPF), utilise search_docs_messagerie en complément de search_docs.
Tu emploies le tutoiement respecteux, utilise du markdown riche et un peu d'emojis.
Tes réponses sont concises et vont à l'essentiel.
Formate ton markdown pour un affichage dans un panneau de discussion étroit : préfère les listes courtes aux tableaux larges, garde les paragraphes concis et évite les blocs de code très larges.
Tu utilises le modèle de language open weight "${process.env.OPENAI_MODEL}" hébergé sur une infrastructure souveraine.

Pour les questions liées à notre actualité, utilise ces données:
 - calendrier
 - les dernieres vidéos peertube
 - le changelog de betagouv/doc.incubateur.net-communaute
 - le changelog de betagouv/beta.gouv.fr
 - les derniers membres et startups (sqlite)
 - les changelogs gitscan des organisations si mentionnées
 - les dernieres offres d'emploi

Lorsque tu mentionnes une entité, ajoute TOUJOURS un lien:
 - une startup, une produit, une équipe, créé un lien vers https://beta.gouv.fr/startups/[ghid]
 - un incubateur, créé un lien vers https://beta.gouv.fr/incubateurs/[id]
 - un membre de la communauté, créé un lien vers https://espace-membre.beta.gouv.fr/community/[username]
 - un repository ou commit GIT, créé un lien vers https://github.com/[ORG]/[REPO]
 - une PR ou issue GIT, créé un lien vers https://github.com/[ORG]/[REPO]/issues/[ID]
 - un organisation GIT, créé un lien vers https://github.com/[ORG]
 - la documentation beta.gouv.fr, crée un lien vers https://doc.incubateur.net/[PATH] sans le suffixe \`.md\` et sans le suffixe \`README\`.
 - la documentation ProConnect, utilise le champ \`url\` retourné par l'outil de recherche si disponible, sinon crée un lien vers https://partenaires.proconnect.gouv.fr/docs/[PATH]
 - la documentation FranceConnect, utilise le champ \`url\` retourné par l'outil de recherche si disponible, sinon crée un lien vers https://docs.partenaires.franceconnect.gouv.fr/[PATH]
 - la documentation DSFR, utilise le champ \`url\` retourné par l'outil de recherche si disponible, sinon crée un lien vers https://www.systeme-de-design.gouv.fr/[PATH]
 - la documentation messagerie (email), utilise le champ \`url\` retourné par l'outil de recherche
 - un standard beta.gouv.fr, créé un lien vers https://github.com/betagouv/standards/blob/main/[categorie]/[standard]

Cite tes sources avec leurs URLS en fin de message
 - [documentation beta.gouv.fr](https://doc.incubateur.net)
 - [espace membre](https://espace-membre.beta.gouv.fr)
 - [site beta.gouv.fr](https://beta.gouv.fr)
 - [standards des produits beta.gouv.fr](https://standards.beta.gouv.fr)
 - ton code source est dispo sur github.com/betagouv/betabot
 - ne mentionne pas les tools internes utilisés
 - présente et explique ls requetes SQL utilisées
`;

function buildSystemPrompt(entities: DetectedEntities): string {
  const lines: string[] = [];
  if (entities.members.length) {
    lines.push("Membres détectés dans la question :");
    entities.members.forEach((e) =>
      lines.push(`  - ${e.label} : slug="${e.id}", url=${e.url}`),
    );
  }
  if (entities.startups.length) {
    lines.push("Startups détectées dans la question :");
    entities.startups.forEach((e) =>
      lines.push(`  - ${e.label} : slug="${e.id}", url=${e.url}`),
    );
  }
  if (!lines.length) return SYSTEM_PROMPT;
  return (
    SYSTEM_PROMPT +
    "\n\nEntités identifiées dans cette question (utilise ces slugs et URLs) :\n" +
    lines.join("\n")
  );
}

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
  ...sqliteTools,
  ...proconnectDocTools,
  ...franceconnectDocTools,
  ...dsfrDocTools,
  ...wttjTools,
  ...changelogStartupsTools,
  ...messagerieDocTools,
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
  ...sqliteHandlers,
  ...proconnectDocHandlers,
  ...franceconnectDocHandlers,
  ...dsfrDocHandlers,
  ...wttjHandlers,
  ...changelogStartupsHandlers,
  ...messagerieDocHandlers,
};

export class Orchestrator {
  private client: OpenAI;
  private history: Map<string, ChatCompletionMessageParam[]> = new Map();

  constructor() {
    this.client = new OpenAI({
      baseURL: config.openai.baseUrl,
      apiKey: config.openai.apiKey,
      timeout: config.openai.timeoutMs,
      maxRetries: 5,
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

    const debug = (...args: unknown[]) =>
      process.stderr.write(`[debug] ${args.join(" ")}\n`);

    const debugHeaders = (httpResponse: { headers: { has(n: string): boolean; get(n: string): string | null } }) => {
      const interesting = [
        "x-request-id",
        "cf-ray",
        "x-ratelimit-limit-requests",
        "x-ratelimit-remaining-requests",
        "x-ratelimit-limit-tokens",
        "x-ratelimit-remaining-tokens",
        "x-ratelimit-reset-requests",
        "x-ratelimit-reset-tokens",
        "retry-after",
      ];
      const found = interesting
        .filter((h) => httpResponse.headers.has(h))
        .map((h) => `${h}=${httpResponse.headers.get(h)}`)
        .join(" ");
      if (found) debug(`response headers: ${found}`);
    };

    debug(`handle key=${key} text=${JSON.stringify(input.text)}`);
    debug(`history length=${history.length}`);

    const detectedEntities = detectEntities(input.text);
    const memberCount = detectedEntities.members.length;
    const startupCount = detectedEntities.startups.length;
    if (memberCount || startupCount) {
      debug(
        `entity pre-pass: ${memberCount} member(s) [${detectedEntities.members.map((e) => e.id).join(", ")}], ` +
          `${startupCount} startup(s) [${detectedEntities.startups.map((e) => e.id).join(", ")}]`,
      );
    }
    const messages: ChatCompletionMessageParam[] = [
      { role: "system", content: buildSystemPrompt(detectedEntities) },
      ...history,
    ];

    let iterations = 0;

    while (iterations < MAX_TOOL_ITERATIONS) {
      iterations++;
      debug(`--- LLM iteration ${iterations}/${MAX_TOOL_ITERATIONS} ---`);
      const payloadChars = messages.reduce((sum, m) => {
        const c = m.content;
        return sum + (typeof c === "string" ? c.length : JSON.stringify(c ?? "").length);
      }, 0);
      debug(
        `sending ${messages.length} messages to model=${config.openai.model} (~${payloadChars} chars)`,
      );

      let response: Awaited<ReturnType<typeof this.client.chat.completions.create>>;
      try {
        const { data, response: httpResponse } = await this.client.chat.completions.create({
          model: config.openai.model,
          messages,
          tools: ALL_TOOLS,
          tool_choice: "auto",
        }).withResponse();
        debugHeaders(httpResponse);
        response = data;
      } catch (err) {
        if (err instanceof OpenAI.APIError && err.headers) {
          const rid = err.headers["x-request-id"];
          if (rid) debug(`  x-request-id=${rid}`);
        }
        debug(`LLM call failed at iteration ${iterations}: ${err}`);
        throw err;
      }

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
    messages.push({
      role: "user",
      content:
        "Réponds maintenant à la question en te basant uniquement sur les informations récupérées ci-dessus. Ne fais plus d'appel d'outil.",
    });
    const fallbackPayloadChars = messages.reduce((sum, m) => {
      const c = m.content;
      return sum + (typeof c === "string" ? c.length : JSON.stringify(c ?? "").length);
    }, 0);
    debug(`sending fallback summary request (~${fallbackPayloadChars} chars)`);
    let finalResponse: Awaited<ReturnType<typeof this.client.chat.completions.create>>;
    try {
      const { data, response: httpResponse } = await this.client.chat.completions.create({
        model: config.openai.model,
        messages,
      }).withResponse();
      debugHeaders(httpResponse);
      finalResponse = data;
    } catch (err) {
      if (err instanceof OpenAI.APIError && err.headers) {
        const rid = err.headers["x-request-id"];
        if (rid) debug(`  x-request-id=${rid}`);
      }
      debug(`LLM fallback call failed: ${err}`);
      throw err;
    }

    const text = finalResponse.choices[0]?.message.content ?? "";
    debug(`fallback final response (${text.length} chars)`);
    history.push({ role: "assistant", content: text });
    this.trimHistory(history);
    return text;
  }
}
