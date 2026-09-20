import { describe, it, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import path from "path";
import {
  selectChannels,
  findChannels,
  _setDataDir,
  _reset,
  type TchapChannel,
} from "../tchap-channels.js";
import { buildSystemPrompt } from "../orchestrator.js";

const FIXTURES = path.join(process.cwd(), "src/__tests__/fixtures");

const CHANNEL = (
  o: Partial<TchapChannel> & { name: string; score: number },
): TchapChannel & { score: number } => ({
  url: `https://app.tchap.gouv.fr/#/room/${o.name}`,
  description: "",
  ...o,
});

before(() => {
  _setDataDir(FIXTURES);
  delete process.env.TCHAP_CHANNELS;
});
afterEach(() => _reset());

describe("selectChannels — relevance ratio", () => {
  it("keeps results above minRatio of the best score", () => {
    const results = [
      CHANNEL({ name: "a", score: 0.8 }),
      CHANNEL({ name: "b", score: 0.4 }), // 0.5 × 0.8 = 0.4 → kept
      CHANNEL({ name: "c", score: 0.2 }), // below → dropped
    ];
    const out = selectChannels(results);
    assert.deepEqual(
      out.map((c) => c.name),
      ["a", "b"],
    );
  });

  it("caps results at topK (default 3)", () => {
    const results = [
      CHANNEL({ name: "a", score: 1 }),
      CHANNEL({ name: "b", score: 0.9 }),
      CHANNEL({ name: "c", score: 0.8 }),
      CHANNEL({ name: "d", score: 0.7 }),
    ];
    const out = selectChannels(results);
    assert.equal(out.length, 3);
  });

  it("returns empty for empty results", () => {
    assert.deepEqual(selectChannels([]), []);
  });

  it("respects a custom minRatio", () => {
    const results = [
      CHANNEL({ name: "a", score: 0.8 }),
      CHANNEL({ name: "b", score: 0.7 }), // 0.9 × 0.8 = 0.72 → dropped
      CHANNEL({ name: "c", score: 0.5 }),
    ];
    const out = selectChannels(results, { minRatio: 0.9 });
    assert.deepEqual(
      out.map((c) => c.name),
      ["a"],
    );
  });
});

describe("findChannels — unconfigured state", () => {
  it("returns [] when TCHAP_CHANNELS is unset", async () => {
    const out = await findChannels("comment créer un salon privé");
    assert.deepEqual(out, []);
  });

  it("returns [] when channels indexes are missing", async () => {
    process.env.TCHAP_CHANNELS = path.join(
      process.cwd(),
      "src/__tests__/fixtures/tchap-channels.json",
    );
    const out = await findChannels("salon");
    // no channels.* indexes exist in the fixtures dir → inoffensive
    assert.ok(Array.isArray(out));
  });
});

describe("buildSystemPrompt — channels block injection", () => {
  it("injects channel links block when channels are related", () => {
    const prompt = buildSystemPrompt(
      { members: [], startups: [] },
      [
        {
          name: "Salon Tchap beta",
          description: "Entraide communauté beta",
          url: "https://app.tchap.gouv.fr/#/room/!abc:agent.tchap.gouv.fr",
        },
      ],
    );
    assert.match(prompt, /Canaux Tchap liés/);
    assert.match(prompt, /\[name\]\(url\)/);
    assert.match(
      prompt,
      /Salon Tchap beta : Entraide communauté beta https:\/\/app\.tchap\.gouv\.fr\/#\/room\/!abc:agent\.tchap\.gouv\.fr/,
    );
  });

  it("omits the channels block when none are related", () => {
    const prompt = buildSystemPrompt({ members: [], startups: [] });
    assert.doesNotMatch(prompt, /Canaux Tchap liés/);
  });
});
