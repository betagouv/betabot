import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { config } from "../config.js";
import { handlers } from "../tools/feedback.js";

const originalFetch = globalThis.fetch;
const configWithWebhook = config as unknown as { feedbackWebhookUrl: string };

afterEach(() => {
  globalThis.fetch = originalFetch;
  configWithWebhook.feedbackWebhookUrl = "";
});

describe("submit_feedback", () => {
  it("reports an error and sends nothing when no webhook is configured", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response(null, { status: 200 });
    }) as typeof fetch;

    const result = await handlers["submit_feedback"]!(
      { feedback: "super réponse", positive: true },
      { userId: "@marie:matrix.org", conversation: [{ role: "user", content: "salut" }] },
    );

    assert.equal(called, false);
    assert.deepEqual(result, {
      ok: false,
      error: "feedback webhook not configured",
    });
  });

  it("posts the initial query, the feedback, the positive flag, the userId and the full conversation", async () => {
    configWithWebhook.feedbackWebhookUrl = "https://n8n.example.org/webhook/feedback";

    let capturedUrl: string | undefined;
    let capturedBody: string | undefined;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedBody = init?.body as string;
      return new Response(null, { status: 200 });
    }) as typeof fetch;

    const conversation = [
      { role: "user", content: "comment configurer DMARC ?" },
      { role: "assistant", content: "Voici comment faire..." },
      { role: "user", content: "merci, c'était exactement ce qu'il fallait" },
    ];

    const result = await handlers["submit_feedback"]!(
      {
        feedback: "L'utilisateur confirme que la réponse DMARC était correcte.",
        positive: true,
      },
      { userId: "@marie:matrix.org", conversation },
    );

    assert.equal(capturedUrl, "https://n8n.example.org/webhook/feedback");
    const payload = JSON.parse(capturedBody!);
    assert.equal(payload.query, "comment configurer DMARC ?");
    assert.equal(
      payload.feedback,
      "L'utilisateur confirme que la réponse DMARC était correcte.",
    );
    assert.equal(payload.positive, true);
    assert.equal(payload.userId, "@marie:matrix.org");
    assert.deepEqual(payload.conversation, conversation);
    assert.deepEqual(result, { ok: true });
  });

  it("marks negative feedback with positive: false", async () => {
    configWithWebhook.feedbackWebhookUrl = "https://n8n.example.org/webhook/feedback";

    let capturedBody: string | undefined;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response(null, { status: 200 });
    }) as typeof fetch;

    await handlers["submit_feedback"]!(
      { feedback: "La réponse sur les phases était fausse.", positive: false },
      { userId: "@marie:matrix.org", conversation: [{ role: "user", content: "salut" }] },
    );

    const payload = JSON.parse(capturedBody!);
    assert.equal(payload.positive, false);
  });

  it("reports an error when the webhook responds with a non-2xx status", async () => {
    configWithWebhook.feedbackWebhookUrl = "https://n8n.example.org/webhook/feedback";
    globalThis.fetch = (async () =>
      new Response(null, { status: 500 })) as typeof fetch;

    const result = await handlers["submit_feedback"]!(
      { feedback: "avis", positive: false },
      { userId: "@marie:matrix.org", conversation: [{ role: "user", content: "salut" }] },
    );

    assert.deepEqual(result, { ok: false, error: "webhook returned 500" });
  });
});
