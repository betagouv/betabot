# Data acquisition spec

`get-data.sh`, `build-embeddings.ts`, `src/markdown.ts`

## Overview

Three-phase pipeline: **fetch** raw data (`get-data.sh`), **embed** into search indices (`build-embeddings.ts`), and **build** the SQLite database (`build-db.ts`). Run nightly or on demand; restart the bot afterwards.

```sh
./get-data.sh && npm run embed -- --force && npm run build-db
```

---

## Phase 1 — Data fetch (`get-data.sh`)

`DATA_DIR` defaults to `./data`. All outputs are gitignored.

### API snapshots (curl)

| Output                           | Source URL                                            |
| -------------------------------- | ----------------------------------------------------- |
| `data/API/members.json`          | `https://beta.gouv.fr/api/v2.6/authors.json`          |
| `data/API/startups.json`         | `https://beta.gouv.fr/api/v2.6/startups.json`         |
| `data/API/startups_details.json` | `https://beta.gouv.fr/api/v2.6/startups_details.json` |
| `data/API/incubators.json`       | `https://beta.gouv.fr/api/v2.6/incubators.json`       |

### Git repos (shallow clone / pull)

| Output                        | Source                                                                   |
| ----------------------------- | ------------------------------------------------------------------------ |
| `data/gitscan/`               | `github.com/betagouv/gitscan` — `--depth=1`                              |
| `data/doc.incubateur.net/`    | `github.com/betagouv/doc.incubateur.net-communaute` — `--depth=500`      |
On subsequent runs, `git pull` updates each repo in-place.

### Web crawl (fetch-docs.ts)

Generic TypeScript crawler using **crawlee** + **@mozilla/readability** + **turndown**. Run via `npx tsx fetch-docs.ts <start-url> <output-dir>`. Requires no API key. Crawls up to 100 pages per run within the same URL path prefix, extracts article content via Readability, converts to markdown with Turndown.

| Output                                    | Source                                                                      |
| ----------------------------------------- | --------------------------------------------------------------------------- |
| `data/docs-proconnect/*.md`               | `https://partenaires.proconnect.gouv.fr/docs` (crawled)                     |
| `data/docs-franceconnect/*.md`            | `https://docs.partenaires.franceconnect.gouv.fr` (crawled)                  |
| `data/docs-dsfr/premiers-pas/*.md`        | `https://www.systeme-de-design.gouv.fr/…/premiers-pas` (crawled)            |
| `data/docs-dsfr/fondamentaux/*.md`        | `https://www.systeme-de-design.gouv.fr/…/fondamentaux` (crawled)            |

To add future web-crawled sources, add another `npx tsx fetch-docs.ts <url> <output-dir>` call to `get-data.sh` and a matching embedding job + tool.

### Email management docs (fetch-messagerie-docs.ts)

Fetches 11 documents from the `docs.numerique.gouv.fr` REST API. No API key required (documents are public). For each document ID, calls:

```
GET /api/v1.0/documents/{id}/formatted-content/?content_format=markdown
```

Response is JSON `{ id, title, content, … }`. Writes one file per document:

```
data/docs-messagerie/{id}.md
```

Each file has YAML frontmatter (`title` from the JSON response, `url` pointing to the public docs page) followed by the `content` field as the body.

Document IDs are hardcoded in the script. To add more, extend the `DOCUMENT_IDS` array.

### WelcomeKit job offers (fetch-wttj.ts)

TypeScript script that fetches published job offers from the WelcomeKit API. Requires one env var:

| Env var            | Description                        |
| ------------------ | ---------------------------------- |
| `WELCOMEKIT_TOKEN` | API bearer token (`Bearer` scheme) |

Orgs are hardcoded in the script as `{ id, slug }` pairs (e.g. `{ id: "ci7AvS", slug: "communaute-beta-gouv" }`). To add an org, extend the `orgs` array.

For each org, calls `GET /api/v1/external/jobs?status=published&organization_reference={id}&per_page=50` and writes one markdown file per offer:

```
data/wttj/{org.id}/{job.reference}.md
```

Each file has YAML frontmatter (`title`, `organization`, `location`, `contract`, `remote`, `apply_url`, `published_at`, `url`) and a plain-text body (HTML stripped from `description` + `profile` fields). The `url` field points to the company page on welcometothejungle.com using the org slug.

Existing `.md` files in each org directory are removed before rewriting so deleted offers are pruned.

### Choisir le service public job offers (fetch-choisirleservicepublic.ts)

TypeScript script that fetches public-service job offers as RSS from the Talentsoft-powered `place-ep-recrute.talent-soft.com` feed used by [choisirleservicepublic.gouv.fr](https://choisirleservicepublic.gouv.fr). Requires one env var:

| Env var                       | Description                                          |
| ------------------------------ | ----------------------------------------------------- |
| `CHOISIRLESERVICEPUBLIC_IDS`  | Comma-separated list of `Rss_Entity` ids, e.g. `1,2,3` |

If unset, the script logs a message and exits without writing anything.

For each `Rss_Entity` id, calls:

```
GET https://place-ep-recrute.talent-soft.com/handlers/offerRss.ashx?LCID=1036&Rss_Entity={id}
```

The response is an RSS 2.0 XML feed, parsed with `jsdom` (`text/xml` mode). The feed's `<channel><title>` (e.g. `"Export RSS des offres - Seulement les offres à la une : Non / Organisme de rattachement : Ministère de la Culture"`) carries the organisme as the trailing part after `Organisme de rattachement :`; extracted once per feed and attached to every item as `organisme` (`""` when the channel title has no such suffix). Each `<item>` is converted to a plain object (`title`, `link`, `description` — raw HTML, `categories` — array from repeated `<category>` tags, `pubDate`, `organisme`) and the full array is written as JSON to:

```
data/choisirleservicepublic/{Rss_Entity}.json
```

Each run overwrites the file for that `Rss_Entity` with the current feed contents.

### PeerTube videos (`fetch_peertube_channel`, curl + jq)

All channels from `tube.numerique.gouv.fr`, sorted by `-createdAt`:

| Output file                | Channel               |
| -------------------------- | --------------------- |
| `animation_beta.json`      | `animation_beta`      |
| `lasuite_modedemploi.json` | `lasuite_modedemploi` |
| `bluehats.json`            | `bluehats`            |
| `lasuite.json`             | `lasuite`             |
| `grist.json`               | `grist`               |
| `designgouv.json`          | `designgouv`          |
| `tchap.json`               | `tchap`               |
| `datagouvfr.json`          | `datagouvfr`          |
| `fabnum.mte.json`          | `fabnum.mte`          |
| `ruche_numerique.json`     | `ruche_numerique`     |

Fetched from the REST API (`/api/v1/video-channels/{channel}/videos?start=…&count=100&sort=-createdAt`), paginated 100 at a time until a page returns fewer than 100 items. **Not** the `/feeds/videos.json` endpoint — that one silently caps at 20 items per channel, so any channel with more than 20 videos loses its older ones (a Feb 2025 video was missing from search for this reason until this was fixed).

Each channel's pages are merged and reshaped with `jq` into the same `{items: [...]}` shape `build-embeddings.ts` Job 5 expects:

```ts
{
  id: string; // https://tube.numerique.gouv.fr/w/{shortUUID}
  url: string; // same
  title: string; // .name
  summary: string; // .description — PeerTube's list endpoint truncates this to ~250 chars; full text requires a per-video GET
  date_published: string; // .publishedAt
  date_modified: string; // .updatedAt
}
```

`content_html` is not populated by this fetch path; Job 5 falls back to `summary` when it's absent.

### Calendar

`data/calendar.ics` — beta.gouv.fr community Google Calendar, public ICS feed.

### Index derivation (jq, inline)

Run at the end of `get-data.sh` before the bot can embed.

**`data/index/members.json`** — active members only (at least one mission with `end > today`), fields: `id, fullname, competences, role, domaine`. Deduped by `id`.

**`data/index/startups.json`** — non-abandoned startups (phases must not include `abandon` or `abandon-investigation`), fields: `id, name, description, active_member_count`. `active_member_count` is derived from `startups_details.json[id].active_members`.

**`data/index/incubators.json`** — flat list from `incubators.json`, fields: `id, title, contact, website, github, startup_count`.

**`data/index/phases.txt`** — human-readable phase descriptions (static, written inline by the script). Used as LLM context.

---

## Phase 2 — Embedding pipeline (`build-embeddings.ts`)

```sh
npm run embed            # skip jobs whose .bin already exists
npm run embed -- --force # rebuild everything
```

Thirteen sequential jobs. Each job:

1. Checks if the output `.bin` exists — skips unless `--force`.
2. Builds embedding texts from source data.
3. Calls `embedBatch` → `saveBin` to write the dense matrix.
4. Calls `buildBM25Index` → `saveBM25Index` to write the sparse index.
5. Writes `*.index.json` (metadata aligned with embedding rows) where needed.

### Job 1 — Members

Source: `data/index/members.json`

Embedding text per member:

```
"{fullname}, {role}, domaine {domaine}. Compétences: {competences joined by ', '}"
```

Missing `competences` → `"non renseignées"`.

Outputs: `data/index/members.embeddings.bin`, `data/index/members.bm25.json`

### Job 2 — Startups

Source: `data/index/startups.json`

Embedding text: `"{name}: {description}"`

Outputs: `data/index/startups.embeddings.bin`, `data/index/startups.bm25.json`

### Job 3 — Git repos (gitscan)

Source: `data/gitscan/repos/{ORG}/{REPO}/overview.json` — walks the full tree, skips repos with missing or broken `overview.json`.

Embedding text per repo:

```
"{name} ({org}): {description}. Language: {language}. Tags: {tags}. Features: {features}. Audience: {audience}"
```

Outputs: `data/gitscan/repos.embeddings.bin`, `data/gitscan/repos.bm25.json`, `data/gitscan/repos.index.json`

Index entry type:

```ts
{ org: string; repo: string; name: string; description: string; language: string; tags: string[] }
```

### Job 4 — Documentation

Source: all `.md` files under `data/doc.incubateur.net/` (recursive walk).

Per file, two chunk types are produced (see **Markdown parsing** below):

- **Front matter intro chunk** — from `description` field if present; breadcrumb = page title.
- **Section chunks** — one per heading section from `extractSections`.

Sections with `content.length < 30` are skipped (shorter than that are noise).

Embedding text per chunk: `"[{breadcrumb}]\n{content}"` — `content` is truncated to 6000 chars before embedding to stay within model token limits.

Outputs: `data/doc.incubateur.net/docs.embeddings.bin`, `data/doc.incubateur.net/docs.bm25.json`, `data/doc.incubateur.net/docs.index.json`

Index entry type:

```ts
{
  path: string;
  title: string;
  breadcrumb: string;
  excerpt: string;
}
```

`excerpt` is truncated to 200 chars.

### Job 5 — PeerTube videos

Source: all `data/peertube/*.json` files except `videos.index.json`.

Embedding text per video: `"[{channelName}] {title}\n{description}"` (omits the `\n{description}` part when description is empty).

`description` = `content_html` stripped of HTML tags, falling back to `summary`, then `""`.

Fields taken from feed items: `title`, `url` (falls back to `id`), `date_published` (falls back to `date_modified`), `content_html`, `summary`.

Outputs: `data/peertube/videos.embeddings.bin`, `data/peertube/videos.bm25.json`, `data/peertube/videos.index.json`

Index entry type:

```ts
{
  title: string;
  channel: string;
  url: string;
  date: string;
  description: string;
}
```

### Job 6 — Incubators

Source: `data/API/incubators.json` (dict keyed by slug).

Embedding text per incubator: `"{title} — startups: {top-10 startup names}"`
If more than 10 startups: appends `"… (N startups)"`.

Outputs: `data/API/incubators.embeddings.bin`, `data/API/incubators.bm25.json`, `data/API/incubators.index.json`

Index entry type:

```ts
{
  id: string;
  title: string;
  contact: string;
  website: string | null;
  github: string | null;
  startup_count: number;
  startups_summary: string;
}
```

### Job 7 — ProConnect docs

Source: all `.md` files under `data/docs-proconnect/` (written by `fetch-docs.ts`).

Per file, same two chunk types as Job 4: front matter intro chunk (from `description`) and section chunks from `extractSections`. Sections with `content.length < 30` are skipped.

Embedding text per chunk: `"[{breadcrumb}]\n{content}"` — `content` truncated to 6000 chars.

Outputs: `data/docs-proconnect/docs.embeddings.bin`, `data/docs-proconnect/docs.bm25.json`, `data/docs-proconnect/docs.index.json`

Index entry type: same `DocChunk` as Job 4 (`{ path, title, breadcrumb, excerpt, url? }`).

### Job 8 — FranceConnect docs

Source: all `.md` files under `data/docs-franceconnect/` (written by `fetch-docs.ts`).

Same chunking and embedding strategy as Job 7.

Outputs: `data/docs-franceconnect/docs.embeddings.bin`, `data/docs-franceconnect/docs.bm25.json`, `data/docs-franceconnect/docs.index.json`

### Job 9 — DSFR docs

Source: all `.md` files under `data/docs-dsfr/premiers-pas/` and `data/docs-dsfr/fondamentaux/` (both subdirs written by `fetch-docs.ts`). Both are passed as source dirs; output lands in `data/docs-dsfr/`.

Same chunking and embedding strategy as Job 7.

Outputs: `data/docs-dsfr/docs.embeddings.bin`, `data/docs-dsfr/docs.bm25.json`, `data/docs-dsfr/docs.index.json`

### Job 10 — WTTJ job offers

Source: all `.md` files under `data/wttj/{org}/` for each org directory found.

Per file, same two chunk types as Job 4: front matter intro chunk (from `description` if present) and section chunks from `extractSections`.

Embedding text per chunk: `"[{breadcrumb}]\n{content}"` — `content` truncated to 6000 chars.

Skipped entirely if `data/wttj/` directory does not exist.

Outputs: `data/wttj/docs.embeddings.bin`, `data/wttj/docs.bm25.json`, `data/wttj/docs.index.json`

Index entry type: `DocChunk` — `{ path, title, breadcrumb, excerpt }` with `path` relative to `data/wttj/` (e.g., `ci7AvS/senior-backend-engineer-abc123.md`).

### Job 11 — Choisir le service public job offers

Source: all `*.json` files under `data/choisirleservicepublic/` (one per `Rss_Entity`, written by `fetch-choisirleservicepublic.ts`), except `jobs.index.json`. Skipped entirely if directory does not exist or no items are found.

Embedding text per job: `"{title}\n{organisme}\n{categories joined by ', '}\n{description}"` — `description` is `description` (raw HTML from the RSS item) stripped of HTML tags and truncated to 6000 chars.

Outputs: `data/choisirleservicepublic/jobs.embeddings.bin`, `data/choisirleservicepublic/jobs.bm25.json`, `data/choisirleservicepublic/jobs.index.json`

Index entry type:

```ts
{
  title: string;
  link: string;
  categories: string[];
  pubDate: string;
  organisme: string; // extracted from the RSS channel title, "" if none
  excerpt: string; // stripped description, truncated to 200 chars
}
```

### Job 12 — Messagerie docs

Source: all `.md` files under `data/docs-messagerie/` (written by `fetch-messagerie-docs.ts`). Skipped entirely if directory does not exist.

Same chunking and embedding strategy as Job 4: front matter intro chunk (from `description` if present) and section chunks from `extractSections`.

Outputs: `data/docs-messagerie/docs.embeddings.bin`, `data/docs-messagerie/docs.bm25.json`, `data/docs-messagerie/docs.index.json`

Index entry type: `DocChunk` — `{ path, title, breadcrumb, excerpt, url }` with `url` pointing to `https://docs.numerique.gouv.fr/docs/{id}/`.

### Job 13 — Tchap docs

Source: all `.md` files under `data/docs-tchap/` (written by `fetch-docs.ts`). Skipped entirely if directory does not exist.

Same chunking and embedding strategy as Job 4: front matter intro chunk (from `description` if present) and section chunks from `extractSections`.

Outputs: `data/docs-tchap/docs.embeddings.bin`, `data/docs-tchap/docs.bm25.json`, `data/docs-tchap/docs.index.json`

Index entry type: same `DocChunk` as Job 4 (`{ path, title, breadcrumb, excerpt, url? }`).

---

## Phase 3 — SQLite database (`build-db.ts`)

```sh
npm run build-db
```

Reads JSON data files and creates `data/betabot.db`. Overwrites any existing DB. Uses `node:sqlite` built-in (Node 24 — no extra dependency). Four sequential jobs, each wrapped in a transaction.

### Schema

```sql
CREATE TABLE members (id TEXT PRIMARY KEY, fullname TEXT, domaine TEXT, role TEXT, created_at TEXT);
  -- created_at: min(missions[].start) from API/members.json — date of first mission (YYYY-MM-DD)
CREATE TABLE member_competences (member_id TEXT, competence TEXT);

CREATE TABLE incubators (id TEXT PRIMARY KEY, title TEXT, contact TEXT, website TEXT);

CREATE TABLE startups (
  id TEXT PRIMARY KEY, name TEXT, pitch TEXT,
  incubator_id TEXT,           -- from JSONAPI relationships.incubator.data.id
  incubator TEXT,              -- denormalized: incubators[incubator_id].title
  active_member_count INTEGER DEFAULT 0,
  current_phase TEXT,          -- denormalized: name of the phase with the latest start date
  accessibility_status TEXT,
  created_at TEXT              -- denormalized: min(phases[].start) — date of first phase (YYYY-MM-DD)
);
CREATE TABLE startup_phases (startup_id TEXT, name TEXT, start_date TEXT, end_date TEXT);
CREATE TABLE startup_members (startup_id TEXT, member_id TEXT, status TEXT);
  -- status: 'active' | 'previous' | 'expired'
CREATE TABLE startup_thematiques (startup_id TEXT, thematique TEXT);
CREATE TABLE startup_technos (startup_id TEXT, techno TEXT);
```

### Job 1 — Members

Source: `data/index/members.json`

Inserts one row per member into `members`; one row per competence string into `member_competences`.

### Job 2 — Incubators

Source: `data/API/incubators.json` (dict keyed by slug)

Inserts one row per incubator into `incubators`.

### Job 3 — Startups

Source: `data/API/startups.json` (JSONAPI — `data[].attributes` + `data[].relationships.incubator.data.id`)

- `current_phase` = name of the phase entry with the latest `start` date (computed at build time).
- Also populates `startup_phases`, `startup_thematiques`, `startup_technos`.

### Job 4 — Startup members

Source: `data/API/startups_details.json` (dict keyed by startup slug, fields: `active_members[]`, `previous_members[]`, `expired_members[]`)

Inserts rows into `startup_members` with status `active`, `previous`, or `expired`. Updates `startups.active_member_count`.

---

## Markdown parsing (`src/markdown.ts`)

Used by Job 4. Two exported functions.

### `parseFrontmatter(content)`

Wraps `gray-matter`. Returns `{ data: Record<string, unknown>, body: string }`.

### `extractSections(rawContent): Section[]`

1. **Strip GitBook syntax**: removes `{% ... %}` blocks and empty `<a>` anchor tags.
2. **Strip front matter** via `parseFrontmatter`.
3. **Parse** with `unified` + `remark-parse` + `remark-frontmatter` → MDAST.
4. **Walk** top-level nodes:
   - On a `heading` node: flush current section buffer, update heading stack (pop headings at same or greater depth, push new heading).
   - On any other node: extract text recursively (`nodeText`), append to buffer.
5. **Flush** final buffer.
6. **Merge short sections**: any section with `content.length < 50` is merged into the preceding section.

`Section` type:

```ts
{
  breadcrumb: string;
  depth: number;
  content: string;
}
```

`breadcrumb` = heading stack joined with `>`, e.g. `"Notre solution > Qu'est-ce que la Maison de l'autisme ?"`. Falls back to `"Introduction"` if no heading precedes the content.

---

## npm scripts

| Script                     | Command                                               |
| -------------------------- | ----------------------------------------------------- |
| `npm run embed`            | `node --import tsx build-embeddings.ts`               |
| `npm run embed -- --force` | rebuilds all jobs regardless of existing `.bin` files |
| `npm run build-db`         | `node --import tsx build-db.ts`                       |
| `npm run get-data`         | `sh get-data.sh`                                      |
