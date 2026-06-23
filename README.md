# betabot

Self-hosted conversational bot that answers natural language questions (in French) about the [beta.gouv.fr](https://beta.gouv.fr) community — members, startups, code repositories, documentation, calendar, videos, web-crawled documentation for ProConnect, FranceConnect, the Design Système de l'État (DSFR), email management documentation from docs.numerique.gouv.fr, and job offers from WelcomeKit (WTTJ).

Runs fully on a private [Ollama](https://ollama.com) instance. No external API calls. Public data only.

Detailed specs : [./specs](./specs)

---

## What it can answer

- _Qui sait faire du PostgreSQL ?_
- _Quelles startups travaillent sur la santé ?_
- _Dans quelle phase est la startup recosanté ?_
- _Qui est dans l'équipe de demarches-simplifiees ?_
- _Comment organiser une visio selon la doc ?_
- _Quels sont les prochains événements de la communauté ?_
- _Quelles vidéos récentes sur les BlueHats ?_
- _Comment intégrer ProConnect avec OIDC ?_
- _Quelle est la différence entre FranceConnect et AgentConnect ?_
- _Comment utiliser les boutons du DSFR ?_
- _Comment configurer DKIM et DMARC pour mon domaine ?_
- _Comment accéder à la messagerie numerique.gouv.fr ?_
- _Quelles offres d'emploi sont disponibles sur WelcomeKit ?_
- _Y a-t-il des postes de développeur en télétravail ?_

---

## Architecture

```
User (Matrix)
  │
  ▼
MatrixConnector       (DM or @mention)
  │
  ▼
Orchestrator          (conversation loop, per-room history)
  │  OpenAI-compatible API → Ollama
  ▼
LLM with tool calling (qwen2.5, mistral-nemo…)
  │
  ▼
Tool dispatcher
  ├── search_members / get_member_detail / get_member_startups
  ├── search_startups / get_startup_detail / get_startup_members
  ├── search_repos / get_repo_detail
  ├── search_incubators / get_incubator_detail
  ├── search_docs / get_doc_page            (doc.incubateur.net)
  ├── search_docs_proconnect / get_doc_proconnect_page
  ├── search_docs_franceconnect / get_doc_franceconnect_page
  ├── search_docs_dsfr / get_doc_dsfr_page
  ├── search_docs_messagerie / get_doc_messagerie_page
  ├── search_wttj_jobs / get_wttj_job_page
  ├── get_startup_updates
  ├── get_calendar
  ├── search_videos
  └── get_videos
```

Search tools use **hybrid retrieval**: dense cosine similarity on `Float32Array` `.bin` embedding matrices + BM25 sparse search, fused with Reciprocal Rank Fusion (RRF).

Every bot response ends with a discrete link to [open a feedback issue](https://github.com/betagouv/betabot/issues/new).

---

## Requirements

- Node.js 20.6+
- An [Ollama](https://ollama.com) instance (or any OpenAI-compatible API)
- Recommended models:
  | Purpose | Model |
  |---|---|
  | LLM (tool calling) | `qwen2.5:14b` or `mistral-nemo:12b` |
  | Embeddings | `nomic-embed-text` (768 dims) or `bge-m3` (1024 dims) |

---

## Setup

### 1. Install dependencies

```sh
npm install
```

### 2. Configure environment

```sh
cp .env.example .env
# edit .env
```

```env
OPENAI_BASE_URL=http://localhost:11434/v1
OPENAI_API_KEY=ollama
OPENAI_MODEL=qwen2.5:14b
OPENAI_EMBED_MODEL=nomic-embed-text
EMBED_DIMS=768

DATA_DIR=./data

MATRIX_HOMESERVER=https://matrix.example.org
MATRIX_USER=@betabot:example.org
MATRIX_ACCESS_TOKEN=syt_...       # or use MATRIX_PASSWORD instead
# MATRIX_DEVICE_ID=ABCDEFGH      # optional — only needed before first start; ignored once credentials.json exists
```

### 3. Fetch data

```sh
./get-data.sh
```

This downloads the API snapshots, calendar, and PeerTube feeds into `data/`, crawls web-based documentation sources into `data/docs-*`, and fetches WelcomeKit job offers into `data/wttj/`.

Web-crawled sources use `fetch-docs.ts` — a generic crawler built on [crawlee](https://crawlee.dev) with [Readability](https://github.com/mozilla/readability) and [Turndown](https://github.com/mixmark-io/turndown):

| Source                      | URL                                                    | Output                         |
| --------------------------- | ------------------------------------------------------ | ------------------------------ |
| beta.gouv.fr community docs | pre-fetched via GitBook export                         | `data/doc.incubateur.net/`     |
| ProConnect                  | `https://partenaires.proconnect.gouv.fr/docs`          | `data/docs-proconnect/`        |
| FranceConnect               | `https://docs.partenaires.franceconnect.gouv.fr`       | `data/docs-franceconnect/`     |
| DSFR (premiers pas)         | `https://www.systeme-de-design.gouv.fr/…/premiers-pas` | `data/docs-dsfr/premiers-pas/` |
| DSFR (fondamentaux)         | `https://www.systeme-de-design.gouv.fr/…/fondamentaux` | `data/docs-dsfr/fondamentaux/` |

The email management documentation uses `fetch-messagerie-docs.ts` — fetches 11 documents from the `docs.numerique.gouv.fr` REST API (`/formatted-content/?content_format=markdown`), reads `title` and `content` from the JSON response, and writes one markdown file per document with YAML frontmatter.

| Source                  | API                                                               | Output                  |
| ----------------------- | ----------------------------------------------------------------- | ----------------------- |
| Messagerie (email) docs | `https://docs.numerique.gouv.fr/api/v1.0/documents/{id}/content/` | `data/docs-messagerie/` |

The startup changelog is fetched from the GitHub Pages-rendered diff page and parsed by `src/parse-startup-changelog.ts` into `data/changelog-startups.json` — a map of startup slug → raw git diff. This powers the `get_startup_updates` tool.

| Source                  | URL                                                     | Output                         |
| ----------------------- | ------------------------------------------------------- | ------------------------------ |
| Startup changelog diffs | `https://betagouv.github.io/beta.gouv.fr/startups.html` | `data/changelog-startups.json` |

WelcomeKit job offers use `fetch-wttj.ts` — fetches published jobs from the WelcomeKit API and writes one markdown file per offer. Requires `WELCOMEKIT_TOKEN` to be set. Orgs are hardcoded in the script; to add one extend the `orgs` array in `fetch-wttj.ts`.

| Source          | API                                      | Output             |
| --------------- | ---------------------------------------- | ------------------ |
| WelcomeKit jobs | `www.welcomekit.co/api/v1/external/jobs` | `data/wttj/{org}/` |

To crawl a new documentation site manually:

```sh
npx tsx fetch-docs.ts https://example.com/docs ./data/docs-example
```

### 4. Build embeddings

```sh
npm run embed
```

Embeds chunks across 11 sources. Each job skips automatically if its `.bin` already exists — safe to restart after an interruption. Use `--force` to rebuild everything:

```sh
npm run embed -- --force
```

### 5. Run

**Matrix bot:**

```sh
npm run dev      # development (tsx, hot reload)
npm run start    # production (compiled JS)
```

**Local CLI** (no Matrix needed — useful for testing):

```sh
npm run cli
```

```
betabot CLI — tapez votre question (Ctrl+C pour quitter)

vous > qui sait faire du PostgreSQL dans la santé ?
betabot > Voici les membres…
```

---

## Data refresh

Run nightly or on demand:

```sh
./get-data.sh && npm run embed -- --force
```

---

## Evals

Test tool routing — which tool(s) the LLM calls for a given question — against a fixture set.
Uses canned responses so runs are fast and data-independent.

Each fixture declares `expect_tools`: the full set of tools that must appear in the call log.
An empty array asserts no tool is called.

```sh
# Run against the committed fixtures
npm run eval

# Compare with a previous run to catch regressions
npm run eval -- --compare evals/results/2026-05-21T10-00-00-000Z.json
npm run eval -- --compare latest

# Generate a markdown report from two result files
node --import tsx evals/report.ts evals/results/result.json [base.json]

# Regenerate fixtures from your actual datasets (after ./get-data.sh)
npm run eval:generate

# Show pass-rate trend across all saved runs
npm run eval:trend
```

Results are saved to `evals/results/` (gitignored) as timestamped JSON files.
`fixtures.json` is committed — the static set covers all tools and includes multi-tool
sequences (e.g. `search_startups` → `get_startup_members`). `eval:generate` refreshes it
with real names and topics sampled from `data/`.

### CI

The workflow `.github/workflows/eval.yml` runs automatically on pull requests that touch
tool definitions, the orchestrator, or the fixture set. It posts a sticky comment with:

- Pass rate and badge (🟢 / 🟡 / 🔴)
- Failing cases with expected vs actual tool chains
- Regression / improvement diff vs the last `main` run (when a base artifact is available)
- Collapsible table of all passing cases

**Required secrets** (`Settings → Secrets → Actions`):

| Secret            | Example                     |
| :---------------- | :-------------------------- |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` |
| `OPENAI_API_KEY`  | `sk-...`                    |
| `OPENAI_MODEL`    | `gpt-4o-mini`               |

---

## Building for production

```sh
npm run build   # outputs to dist/
npm run start
```

## Todo

- data: formations
-
