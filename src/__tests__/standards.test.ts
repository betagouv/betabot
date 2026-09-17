import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { DatabaseSync } from "node:sqlite";

let tmpDir: string;
let module: typeof import("../tools/standards.js") | undefined;

function buildDb(dir: string): void {
  const db = new DatabaseSync(path.join(dir, "betabot.db"));
  db.exec(`
    CREATE TABLE startups (
      id TEXT PRIMARY KEY, name TEXT, pitch TEXT,
      incubator_id TEXT, incubator TEXT, active_member_count INTEGER DEFAULT 0,
      current_phase TEXT, accessibility_status TEXT, created_at TEXT
    );
    CREATE TABLE startup_thematiques (startup_id TEXT, thematique TEXT);
    CREATE TABLE standards_evaluations (
      startup_id TEXT NOT NULL, category TEXT NOT NULL,
      completion REAL, conformity REAL, PRIMARY KEY (startup_id, category)
    );
  `);
  const insStartup = db.prepare(
    "INSERT INTO startups (id, name, current_phase, incubator) VALUES (?, ?, ?, ?)",
  );
  // Evaluated + active
  insStartup.run("mono", "Service MonOmbre", "construction", "DINUM");
  insStartup.run("verta", "Service VertA", "acceleration", "MTE Ecologie");
  // Not evaluated + active (should appear as missing)
  insStartup.run("zeta", "Service Zeta", "acceleration", "MTE Ecologie");
  // Not evaluated + investigation (should be ignored: not incubated-actif)
  insStartup.run("iota", "Service Iota", "investigation", "DINUM");
  // Not evaluated + transfere (should be ignored)
  insStartup.run("kappa", "Service Kappa", "transfere", "DINUM");

  const insThema = db.prepare("INSERT INTO startup_thematiques VALUES (?, ?)");
  insThema.run("verta", "Écologie");
  insThema.run("zeta", "Écologie");
  insThema.run("mono", "Santé");

  const insEval = db.prepare(
    "INSERT INTO standards_evaluations VALUES (?, ?, ?, ?)",
  );
  // monombre fully completed in 2 categories
  insEval.run("mono", "sécurité", 100, 80);
  insEval.run("mono", "accessibilité", 50, 50);
  // verta partial
  insEval.run("verta", "sécurité", 100, 100);
  insEval.run("verta", "accessibilité", 0, 0);
  db.close();
}

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "betabot-standards-"));
  buildDb(tmpDir);
  process.env.DATA_DIR = tmpDir;
});

after(async () => {
  process.env.DATA_DIR = "./data";
  if (module) {
    try {
      module.reset();
    } catch {
      /* ignore */
    }
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("standards tools", () => {
  it("returns evaluation for a known startup with per-category scores", async () => {
    module = await import("../tools/standards.js");
    const res = (await module.handlers["get_startup_standards_evaluation"]!({
      startup_id: "mono",
    })) as Record<string, unknown>;
    assert.equal(res.evaluated, true);
    const scores = res.scores as Record<
      string,
      { completion: number; conformity: number }
    >;
    assert.equal(scores["sécurité"].completion, 100);
    assert.equal(scores["sécurité"].conformity, 80);
    assert.equal(scores["accessibilité"].completion, 50);
    // categories without a row are null
    assert.equal(scores["équipe"].completion, null);
  });

  it("returns signup guidance for a startup that is not evaluated", async () => {
    module = await import("../tools/standards.js");
    const res = (await module.handlers["get_startup_standards_evaluation"]!({
      startup_id: "zeta",
    })) as Record<string, unknown>;
    assert.equal(res.evaluated, false);
    assert.match(String(res.message), /standards\.beta\.gouv\.fr/);
  });

  it("lists not-evaluated startups among active incubated ones only", async () => {
    module = await import("../tools/standards.js");
    const res = (await module.handlers["list_standards_coverage"]!({})) as {
      summary: { evaluated_count: number; not_evaluated_count: number };
      not_evaluated: Array<{ id: string }>;
      evaluated: string[];
    };
    // evaluated: mono + verta ; not evaluated active: zeta only
    // (iota investigation + kappa transfere are excluded)
    assert.equal(res.summary.evaluated_count, 2);
    assert.equal(res.summary.not_evaluated_count, 1);
    assert.deepEqual(res.evaluated.sort(), ["mono", "verta"]);
    assert.deepEqual(res.not_evaluated.map((s) => s.id), ["zeta"]);
  });

  it("filters coverage by thematique", async () => {
    module = await import("../tools/standards.js");
    const res = (await module.handlers["list_standards_coverage"]!({
      thematique: "Écologie",
    })) as {
      evaluated: string[];
      not_evaluated: Array<{ id: string }>;
    };
    assert.deepEqual(res.evaluated.sort(), ["verta"]);
    assert.deepEqual(res.not_evaluated.map((s) => s.id), ["zeta"]);
  });

  it("computes category and global averages over completion", async () => {
    module = await import("../tools/standards.js");
    const res = (await module.handlers["list_standards_coverage"]!({})) as {
      category_averages: Record<string, number | null>;
      summary: { global_completion_average: number | null };
    };
    // sécurité: (100 + 100)/2 = 100
    assert.equal(res.category_averages["sécurité"], 100);
    // accessibilité: (50 + 0)/2 = 25
    assert.equal(res.category_averages["accessibilité"], 25);
    // global: mono avg 75, verta avg 50 → 62.5
    assert.equal(res.summary.global_completion_average, 62.5);
  });

  it("breaks down by_category sorted worst-first when a category is given", async () => {
    module = await import("../tools/standards.js");
    const res = (await module.handlers["list_standards_coverage"]!({
      category: "accessibilité",
    })) as {
      filter: { category: string };
      by_category: Array<{ startup_id: string; completion: number | null }>;
    };
    // matches category normalization ("accessibilité" is exact here)
    assert.equal(res.filter.category, "accessibilité");
    // mono=50, verta=0 → verta first, ascending order
    assert.deepEqual(
      res.by_category.map((s) => [s.startup_id, s.completion]),
      [
        ["verta", 0],
        ["mono", 50],
      ],
    );
  });

  it("produces a markdown report", async () => {
    module = await import("../tools/standards.js");
    const report = (await module.handlers["standards_report"]!({})) as string;
    assert.match(report, /### Niveau des standards/);
    assert.match(report, /Service MonOmbre/);
    assert.match(report, /Service Zeta/);
    assert.match(report, /Non évaluées/);
  });
});
