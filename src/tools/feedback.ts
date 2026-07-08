import type { ChatCompletionTool } from "openai/resources/chat/completions.js";
import { config } from "../config.js";

export interface ConversationMessage {
  role: string;
  content: string;
}

export interface ToolContext {
  userId: string;
  conversation: ConversationMessage[];
}

interface FeedbackPayload {
  query: string;
  feedback: string;
  positive: boolean;
  userId: string;
  conversation: ConversationMessage[];
}

interface FeedbackResult {
  ok: boolean;
  error?: string;
}

async function submit_feedback(
  feedback: string,
  positive: boolean,
  context: ToolContext,
): Promise<FeedbackResult> {
  const webhookUrl = config.feedbackWebhookUrl;
  if (!webhookUrl) {
    console.error(
      "[feedback] FEEDBACK_WEBHOOK_URL is not configured, dropping feedback",
    );
    return { ok: false, error: "feedback webhook not configured" };
  }

  const query =
    context.conversation.find((m) => m.role === "user")?.content ?? "";

  const payload: FeedbackPayload = {
    query,
    feedback,
    positive,
    userId: context.userId,
    conversation: context.conversation,
  };

  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.error(`[feedback] webhook responded with status ${res.status}`);
      return { ok: false, error: `webhook returned ${res.status}` };
    }
  } catch (err) {
    console.error("[feedback] failed to reach webhook:", err);
    return { ok: false, error: String(err) };
  }

  return { ok: true };
}

// ─── Tool definition ──────────────────────────────────────────────────────────

const submitFeedbackTool: ChatCompletionTool = {
  type: "function",
  function: {
    name: "submit_feedback",
    description:
      "Enregistre un retour utilisateur (positif ou négatif) sur la conversation en cours et le transmet à l'équipe beta.gouv.fr. " +
      "À utiliser uniquement quand l'utilisateur exprime explicitement un avis sur une réponse du bot ou sur la conversation " +
      "(ex : « merci, exactement ce qu'il me fallait », « ta réponse est fausse », « ça ne répond pas à ma question »). " +
      "Ne pas utiliser pour de simples remerciements de politesse sans contenu évaluatif.",
    parameters: {
      type: "object",
      properties: {
        feedback: {
          type: "string",
          description:
            "Le retour de l'utilisateur, reformulé clairement (ce qui a bien ou mal fonctionné).",
        },
        positive: {
          type: "boolean",
          description:
            "true si le retour est positif (satisfaction), false si le retour est négatif (frustration, erreur, réponse inadaptée).",
        },
      },
      required: ["feedback", "positive"],
    },
  },
};

export const tools = [submitFeedbackTool];

export const handlers: Record<
  string,
  (args: Record<string, unknown>, context: ToolContext) => Promise<unknown>
> = {
  submit_feedback: (args, context) =>
    submit_feedback(
      String(args["feedback"] ?? ""),
      Boolean(args["positive"]),
      context,
    ),
};
