import fs from "fs";
import path from "path";
import { DatabaseSync } from "node:sqlite";

const DATA_DIR = process.env["DATA_DIR"] ?? "./data";
const DB_PATH = path.join(DATA_DIR, "betabot.db");

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
}

interface MemberIndex {
  id: string;
  fullname: string;
  domaine: string;
  role: string;
  competences: string[];
}

interface RawMember {
  id: string;
  missions?: Array<{ start: string }>;
}

interface RawIncubator {
  title: string;
  contact: string;
  website: string | null;
}

interface StartupPhase {
  name: string;
  start: string;
  end?: string;
}

interface StartupAttributes {
  name: string;
  pitch: string;
  phases: StartupPhase[];
  thematiques: string[];
  technos: string[];
  accessibility_status: string;
}

interface StartupItem {
  id: string;
  attributes: StartupAttributes;
  relationships?: {
    incubator?: { data?: { id: string } | null };
  };
}

interface StartupsJSONAPI {
  data: StartupItem[];
}

interface StartupDetail {
  name: string;
  active_members?: string[];
  previous_members?: string[];
  expired_members?: string[];
}

console.log("betabot — build-db");
console.log("==================");
const t0 = Date.now();

if (fs.existsSync(DB_PATH)) {
  fs.unlinkSync(DB_PATH);
}

const db = new DatabaseSync(DB_PATH);

db.exec(`
  CREATE TABLE members (
    id TEXT PRIMARY KEY,
    fullname TEXT,
    domaine TEXT,
    role TEXT,
    created_at TEXT
  );
  CREATE TABLE member_competences (
    member_id TEXT,
    competence TEXT
  );
  CREATE INDEX idx_mc_member ON member_competences(member_id);
  CREATE INDEX idx_mc_competence ON member_competences(competence);

  CREATE TABLE incubators (
    id TEXT PRIMARY KEY,
    title TEXT,
    contact TEXT,
    website TEXT
  );

  CREATE TABLE startups (
    id TEXT PRIMARY KEY,
    name TEXT,
    pitch TEXT,
    incubator_id TEXT,
    incubator TEXT,
    active_member_count INTEGER DEFAULT 0,
    current_phase TEXT,
    accessibility_status TEXT,
    created_at TEXT
  );
  CREATE INDEX idx_startups_incubator ON startups(incubator_id);
  CREATE INDEX idx_startups_phase ON startups(current_phase);

  CREATE TABLE startup_phases (
    startup_id TEXT,
    name TEXT,
    start_date TEXT,
    end_date TEXT
  );
  CREATE INDEX idx_sp_startup ON startup_phases(startup_id);

  CREATE TABLE startup_members (
    startup_id TEXT,
    member_id TEXT,
    status TEXT
  );
  CREATE INDEX idx_sm_startup ON startup_members(startup_id);
  CREATE INDEX idx_sm_member ON startup_members(member_id);

  CREATE TABLE startup_thematiques (
    startup_id TEXT,
    thematique TEXT
  );
  CREATE INDEX idx_st_thematique ON startup_thematiques(thematique);

  CREATE TABLE startup_technos (
    startup_id TEXT,
    techno TEXT
  );
`);

// ─── Members ──────────────────────────────────────────────────────────────────

console.log("\n[1/4] Loading members…");
const members = readJson<MemberIndex[]>(path.join(DATA_DIR, "index/members.json"));
const rawMembers = readJson<RawMember[]>(path.join(DATA_DIR, "API/members.json"));
const createdAtMap = new Map<string, string | null>(
  rawMembers.map((m) => {
    const starts = (m.missions ?? []).map((ms) => ms.start).filter(Boolean).sort();
    return [m.id, starts[0] ?? null];
  })
);

const insertMember = db.prepare("INSERT INTO members VALUES (?, ?, ?, ?, ?)");
const insertCompetence = db.prepare("INSERT INTO member_competences VALUES (?, ?)");

db.exec("BEGIN");
try {
  for (const m of members) {
    insertMember.run(m.id, m.fullname ?? null, m.domaine ?? null, m.role ?? null, createdAtMap.get(m.id) ?? null);
    for (const c of m.competences ?? []) {
      insertCompetence.run(m.id, c);
    }
  }
  db.exec("COMMIT");
} catch (e) {
  db.exec("ROLLBACK");
  throw e;
}
console.log(`  ✓ ${members.length} members`);

// ─── Incubators ───────────────────────────────────────────────────────────────

console.log("\n[2/4] Loading incubators…");
const incubatorsRaw = readJson<Record<string, RawIncubator>>(
  path.join(DATA_DIR, "API/incubators.json")
);

const insertIncubator = db.prepare("INSERT INTO incubators VALUES (?, ?, ?, ?)");

db.exec("BEGIN");
try {
  for (const [id, inc] of Object.entries(incubatorsRaw)) {
    insertIncubator.run(id, inc.title ?? null, inc.contact ?? null, inc.website ?? null);
  }
  db.exec("COMMIT");
} catch (e) {
  db.exec("ROLLBACK");
  throw e;
}
console.log(`  ✓ ${Object.keys(incubatorsRaw).length} incubators`);

const incubatorTitleMap = new Map<string, string>(
  Object.entries(incubatorsRaw).map(([id, inc]) => [id, inc.title])
);

// ─── Startups ─────────────────────────────────────────────────────────────────

console.log("\n[3/4] Loading startups…");
const startupsApi = readJson<StartupsJSONAPI>(
  path.join(DATA_DIR, "API/startups.json")
);

const insertStartup = db.prepare(
  "INSERT OR IGNORE INTO startups (id, name, pitch, incubator_id, incubator, active_member_count, current_phase, accessibility_status, created_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)"
);
const insertPhase = db.prepare(
  "INSERT INTO startup_phases VALUES (?, ?, ?, ?)"
);
const insertThematique = db.prepare(
  "INSERT INTO startup_thematiques VALUES (?, ?)"
);
const insertTechno = db.prepare("INSERT INTO startup_technos VALUES (?, ?)");

db.exec("BEGIN");
try {
  for (const item of startupsApi.data) {
    const attrs = item.attributes;
    const incubatorId =
      item.relationships?.incubator?.data?.id ?? null;

    const phases = [...(attrs.phases ?? [])].sort((a, b) =>
      b.start.localeCompare(a.start)
    );
    const currentPhase = phases[0]?.name ?? null;
    const createdAt = phases[phases.length - 1]?.start ?? null;

    insertStartup.run(
      item.id,
      attrs.name ?? null,
      attrs.pitch ?? null,
      incubatorId,
      incubatorId ? (incubatorTitleMap.get(incubatorId) ?? null) : null,
      currentPhase,
      attrs.accessibility_status ?? null,
      createdAt
    );

    for (const p of attrs.phases ?? []) {
      insertPhase.run(item.id, p.name, p.start, p.end ?? null);
    }
    for (const t of attrs.thematiques ?? []) {
      insertThematique.run(item.id, t);
    }
    for (const t of attrs.technos ?? []) {
      insertTechno.run(item.id, t);
    }
  }
  db.exec("COMMIT");
} catch (e) {
  db.exec("ROLLBACK");
  throw e;
}
console.log(`  ✓ ${startupsApi.data.length} startups`);

// ─── Startup members ──────────────────────────────────────────────────────────

console.log("\n[4/4] Loading startup members…");
const details = readJson<Record<string, StartupDetail>>(
  path.join(DATA_DIR, "API/startups_details.json")
);

const upsertStartup = db.prepare(
  "INSERT OR IGNORE INTO startups (id, name, active_member_count) VALUES (?, ?, 0)"
);
const updateCount = db.prepare(
  "UPDATE startups SET active_member_count = ? WHERE id = ?"
);
const insertMemberStartup = db.prepare(
  "INSERT INTO startup_members VALUES (?, ?, ?)"
);

db.exec("BEGIN");
try {
  for (const [startupId, detail] of Object.entries(details)) {
    upsertStartup.run(startupId, detail.name ?? null);
    updateCount.run((detail.active_members ?? []).length, startupId);
    for (const id of detail.active_members ?? []) {
      insertMemberStartup.run(startupId, id, "active");
    }
    for (const id of detail.previous_members ?? []) {
      insertMemberStartup.run(startupId, id, "previous");
    }
    for (const id of detail.expired_members ?? []) {
      insertMemberStartup.run(startupId, id, "expired");
    }
  }
  db.exec("COMMIT");
} catch (e) {
  db.exec("ROLLBACK");
  throw e;
}
console.log(`  ✓ ${Object.keys(details).length} startup team records`);

db.close();

const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\nDone in ${elapsed}s — ${DB_PATH}`);
