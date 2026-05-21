# betabot

Self-hosted conversational bot that answers natural language questions (in French) about the [beta.gouv.fr](https://beta.gouv.fr) community — members, startups, code repositories, documentation, calendar, and videos.

Runs fully on a private [Ollama](https://ollama.com) instance. No external API calls.

---

## What it can answer

- _Qui sait faire du PostgreSQL ?_
- _Quelles startups travaillent sur la santé ?_
- _Dans quelle phase est la startup recosanté ?_
- _Qui est dans l'équipe de demarches-simplifiees ?_
- _Comment organiser une visio selon la doc ?_
- _Quels sont les prochains événements de la communauté ?_
- _Quelles vidéos récentes sur les BlueHats ?_

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
  ├── search_docs / get_doc_page
  ├── get_calendar
  ├── search_videos
  └── get_videos
```

Search tools use **hybrid retrieval**: dense cosine similarity on `Float32Array` `.bin` embedding matrices + BM25 sparse search, fused with Reciprocal Rank Fusion (RRF).

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
MATRIX_ACCESS_TOKEN=syt_...
```

### 3. Fetch data

```sh
./get-data.sh
```

This downloads the API snapshots, calendar, and PeerTube feeds into `data/`.

### 4. Build embeddings

```sh
npm run embed
```

Embeds chunks across 6 sources. Each job skips automatically if its `.bin` already exists — safe to restart after an interruption. Use `--force` to rebuild everything:

```sh
npm run embed -- --force
```

**Outputs:**

```
data/index/members.embeddings.bin
data/index/members.bm25.json
data/index/startups.embeddings.bin
data/index/startups.bm25.json
data/gitscan/repos.embeddings.bin
data/gitscan/repos.bm25.json
data/gitscan/repos.index.json
data/doc.incubateur.net/docs.embeddings.bin
data/doc.incubateur.net/docs.bm25.json
data/doc.incubateur.net/docs.index.json
data/peertube/videos.embeddings.bin
data/peertube/videos.bm25.json
data/peertube/videos.index.json
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

Then restart the bot (it loads embeddings into memory at startup).

---

## Project structure

```
betabot/
├── get-data.sh              # fetches all raw data
├── build-embeddings.ts      # embedding pipeline (6 jobs: members, startups, repos, docs, videos, incubators)
├── src/
│   ├── config.ts            # env var loading
│   ├── embed.ts             # OpenAI embeddings client + .bin I/O
│   ├── search.ts            # hybrid search: cosine + BM25 + RRF
│   ├── markdown.ts          # remark parser: front matter + section chunking
│   ├── orchestrator.ts      # LLM conversation loop + tool dispatch
│   ├── cli.ts               # local readline client
│   ├── index.ts             # Matrix bot entry point
│   ├── tools/
│   │   ├── members.ts
│   │   ├── startups.ts
│   │   ├── repos.ts
│   │   ├── docs.ts
│   │   ├── calendar.ts
│   │   └── videos.ts
│   └── connectors/
│       └── matrix.ts
├── evals/
│   ├── fixtures.json        # committed baseline fixtures
│   ├── generate.ts          # generates fixtures from data/
│   ├── results/             # gitignored — timestamped run snapshots
│   └── run.ts               # eval runner with --compare support
├── .env.example
├── package.json
└── tsconfig.json
```

---

## Tools reference

| Tool                  | Description                                                                        |
| --------------------- | ---------------------------------------------------------------------------------- |
| `search_members`      | Hybrid search over members by skill, role, or domain                               |
| `get_member_detail`   | Full profile by id (e.g. `julien.bouquillon`)                                      |
| `get_member_startups` | Startups a member is/was active on                                                 |
| `search_startups`     | Hybrid search over startups by theme or phase                                      |
| `get_startup_detail`  | Full startup record (phases, repo, contact…)                                       |
| `get_startup_members` | Active (and optionally previous) members of a startup                              |
| `search_repos`        | Hybrid search over gitscan repos by tech or feature                                |
| `get_repo_detail`     | Overview + recent commits for a repo                                               |
| `search_docs`         | Hybrid search over doc.incubateur.net                                              |
| `get_doc_page`        | Full content of a documentation page                                               |
| `get_calendar`        | Upcoming community events (default: next 14 days)                                  |
| `search_videos`       | Hybrid search over PeerTube video titles by topic or keyword                       |
| `get_videos`          | Recent PeerTube videos by channel or all channels                                  |

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

| Secret | Example |
|:--|:--|
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` |
| `OPENAI_API_KEY` | `sk-...` |
| `OPENAI_MODEL` | `gpt-4o-mini` |

---

## Building for production

```sh
npm run build   # outputs to dist/
npm run start
```

