import { describe, it, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import path from "path";
import { detectEntities, _setDataDir, _reset } from "../entity-detector.js";

// process.cwd() = project root, works from both src/ and dist/
const FIXTURES = path.join(process.cwd(), "src/__tests__/fixtures");

before(() => _setDataDir(FIXTURES));
afterEach(() => _reset());

describe("detectEntities — members", () => {
  it("detects member by full name", () => {
    const { members } = detectEntities("parle moi de Julien Marteau");
    assert.ok(members.some((m) => m.id === "julien.marteau"));
  });

  it("detects member by dot-separated id", () => {
    const { members } = detectEntities("qui est julien.marteau ?");
    assert.ok(members.some((m) => m.id === "julien.marteau"));
  });

  it("is case-insensitive", () => {
    const { members } = detectEntities("PIERRE DUPONT");
    assert.ok(members.some((m) => m.id === "pierre.dupont"));
  });

  it("handles hyphenated names", () => {
    const { members } = detectEntities("anne-laure martin a designé ça");
    assert.ok(members.some((m) => m.id === "anne-laure.martin"));
  });

  it("returns correct member url", () => {
    const { members } = detectEntities("julien marteau");
    const m = members.find((m) => m.id === "julien.marteau");
    assert.equal(
      m?.url,
      "https://espace-membre.beta.gouv.fr/community/julien.marteau",
    );
  });

  it("returns fullname as label", () => {
    const { members } = detectEntities("julien marteau");
    const m = members.find((m) => m.id === "julien.marteau");
    assert.equal(m?.label, "Julien Marteau");
  });
});

describe("detectEntities — startups", () => {
  it("detects startup by slug used directly", () => {
    const { startups } = detectEntities("parle moi de lasuite");
    assert.ok(startups.some((s) => s.id === "lasuite"));
  });

  it("detects startup by words from hyphenated slug", () => {
    const { startups } = detectEntities("aidants connect aide les aidants");
    assert.ok(startups.some((s) => s.id === "aidants-connect"));
  });

  it("detects startup by natural name words", () => {
    const { startups } = detectEntities("le suivi social c'est important");
    assert.ok(startups.some((s) => s.id === "mon-suivi-social"));
  });

  it("returns correct startup url", () => {
    const { startups } = detectEntities("lasuite");
    const s = startups.find((s) => s.id === "lasuite");
    assert.equal(s?.url, "https://beta.gouv.fr/startups/lasuite");
  });

  it("returns startup name as label", () => {
    const { startups } = detectEntities("lasuite");
    const s = startups.find((s) => s.id === "lasuite");
    assert.equal(s?.label, "La Suite Numérique");
  });
});

describe("detectEntities — no false positives", () => {
  it("returns empty for a generic question", () => {
    const result = detectEntities("il fait beau aujourd'hui");
    assert.equal(result.members.length, 0);
    assert.equal(result.startups.length, 0);
  });

  it("returns empty for an empty string", () => {
    const result = detectEntities("");
    assert.equal(result.members.length, 0);
    assert.equal(result.startups.length, 0);
  });
});

describe("detectEntities — multiple entities", () => {
  it("detects member and startup in the same query", () => {
    const result = detectEntities("parle moi de lasuite et de julien marteau");
    assert.ok(result.members.some((m) => m.id === "julien.marteau"));
    assert.ok(result.startups.some((s) => s.id === "lasuite"));
  });

  it("detects multiple startups", () => {
    const result = detectEntities("compare lasuite et aidants connect");
    assert.ok(result.startups.some((s) => s.id === "lasuite"));
    assert.ok(result.startups.some((s) => s.id === "aidants-connect"));
  });

  it("caps results at 3 per type", () => {
    const result = detectEntities("julien pierre anne");
    assert.ok(result.members.length <= 3);
  });
});
