import { describe, it, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import path from "path";
import {
  selectFaqAnswers,
  findFaqAnswers,
  _setDataDir,
  _reset,
  type FaqAnswer,
} from "../faq.js";
import { buildSystemPrompt } from "../orchestrator.js";

const FIXTURES = path.join(process.cwd(), "src/__tests__/fixtures");

const ANSWER = (
  o: Partial<Omit<FaqAnswer, "question">> & { question: string; score: number },
): FaqAnswer & { score: number } => ({
  answer: "",
  sources: [],
  ...o,
});

before(() => {
  _setDataDir(FIXTURES);
});
afterEach(() => _reset());

describe("selectFaqAnswers — relevance ratio", () => {
  it("keeps answers above minRatio of the best score", () => {
    const results = [
      ANSWER({ question: "a", score: 0.8 }),
      ANSWER({ question: "b", score: 0.4 }), // 0.5 × 0.8 = 0.4 → kept
      ANSWER({ question: "c", score: 0.2 }), // below → dropped
    ];
    const out = selectFaqAnswers(results);
    assert.deepEqual(
      out.map((a) => a.question),
      ["a", "b"],
    );
  });

  it("caps results at topK (default 3)", () => {
    const results = [
      ANSWER({ question: "a", score: 1 }),
      ANSWER({ question: "b", score: 0.9 }),
      ANSWER({ question: "c", score: 0.8 }),
      ANSWER({ question: "d", score: 0.7 }),
    ];
    const out = selectFaqAnswers(results);
    assert.equal(out.length, 3);
  });

  it("returns empty for empty results", () => {
    assert.deepEqual(selectFaqAnswers([]), []);
  });

  it("respects a custom minRatio", () => {
    const results = [
      ANSWER({ question: "a", score: 0.9 }),
      ANSWER({ question: "b", score: 0.8 }), // 0.9 × 0.9 = 0.81 → dropped
      ANSWER({ question: "c", score: 0.5 }),
    ];
    const out = selectFaqAnswers(results, { minRatio: 0.9 });
    assert.deepEqual(
      out.map((a) => a.question),
      ["a"],
    );
  });

  it("drops the score field and keeps sources", () => {
    const results = [
      ANSWER({
        question: "q",
        answer: "a",
        sources: ["https://example.com"],
        score: 1,
      }),
    ];
    assert.deepEqual(selectFaqAnswers(results), [
      { question: "q", answer: "a", sources: ["https://example.com"], url: undefined },
    ]);
  });
});

describe("findFaqAnswers — unconfigured state", () => {
  it("returns [] when the FAQ index is missing", async () => {
    const out = await findFaqAnswers("comment accéder à mattermost");
    // no faq/* indexes exist in the fixtures dir → inoffensive
    assert.ok(Array.isArray(out));
    assert.deepEqual(out, []);
  });
});

describe("buildSystemPrompt — FAQ block injection", () => {
  it("injects the FAQ reference answers block when matches are found", () => {
    const prompt = buildSystemPrompt(
      { members: [], startups: [] },
      [],
      [
        {
          question: "Comment accéder au Mattermost ?",
          answer: "Ton compte est créé automatiquement.",
          sources: ["https://doc.incubateur.net/communaute"],
        },
      ],
    );
    assert.match(prompt, /Réponses de référence \(FAQ\)/);
    assert.match(prompt, /Comment accéder au Mattermost \?/);
    assert.match(prompt, /Ton compte est créé automatiquement\./);
    assert.match(prompt, /https:\/\/doc\.incubateur\.net\/communaute/);
  });

  it("omits the FAQ block when no answers match", () => {
    const prompt = buildSystemPrompt({ members: [], startups: [] });
    // `❓` only appears in the injected FAQ block, not in the system prompt
    assert.doesNotMatch(prompt, /❓/);
  });
});
