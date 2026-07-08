# betabot

Self-hosted conversational bot that answers natural language questions (in French) about the [beta.gouv.fr](https://beta.gouv.fr) community — members, startups, code repositories, documentation, calendar, videos, web-crawled documentation for ProConnect, FranceConnect, the Design Système de l'État (DSFR), Tchap (messagerie sécurisée de l'État), email management documentation from docs.numerique.gouv.fr, job offers from WelcomeKit (WTTJ), and public-service job offers from Choisir le service public.

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
- _Comment créer un salon sur Tchap ?_
- _Est-ce que Tchap chiffre les messages de bout en bout ?_
- _Quelles offres d'emploi sont disponibles sur WelcomeKit ?_
- _Y a-t-il des postes de développeur en télétravail ?_
- _Quelles offres d'emploi de la fonction publique sont disponibles sur Choisir le service public ?_

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
```

Search tools use **hybrid retrieval**: dense cosine similarity on `Float32Array` `.bin` embedding matrices + BM25 sparse search, fused with Reciprocal Rank Fusion (RRF).

Every bot response ends with a discrete link to [open a feedback issue](https://github.com/betagouv/betabot/issues/new).
The bot can also pick up feedback directly in conversation: when a user reacts to a response (positive or negative),
the LLM calls the `submit_feedback` tool, thanks the user, and the query, feedback, and full conversation are posted
to an n8n webhook (`FEEDBACK_WEBHOOK_URL`) — see [Feedback](#feedback) below.

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

### 3. Fetch data

```sh
./get-data.sh
```

See [./specs/data.md](./specs/data.md)

### 4. Build embeddings

```sh
npm run embed
```

Embeds chunks across 12 sources in 12 sequential jobs. Each job skips automatically if its `.bin` already exists — safe to restart after an interruption. Use `--force` to rebuild everything:

```sh
npm run embed -- --force
```

### 5. Build the SQLite database

```sh
npm run build-db
```

Reads the fetched JSON data and creates `data/betabot.db` — a relational index of members, startups, incubators, phases, competences, and thematiques used by several tools. Must be re-run after each data fetch.

### 6. Run

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
./get-data.sh && npm run embed -- --force && npm run build-db
```

---

## Feedback

Set `FEEDBACK_WEBHOOK_URL` to an n8n (or any HTTP) webhook to collect in-conversation feedback.
When a user explicitly reacts to a bot response — positive or negative — the LLM calls the
`submit_feedback` tool (`src/tools/feedback.ts`), replies with empathy (acknowledging the feedback,
apologizing if it's negative, mentioning the team may follow up), and the following payload is
POSTed to the webhook:

```json
{
  "query": "the initial user query",
  "feedback": "the user feedback",
  "positive": true,
  "userId": "@user:matrix.example.org",
  "conversation": [{ "role": "user", "content": "..." }]
}
```

`positive` classifies the feedback as positive or negative (set by the LLM). `userId` is the sender's Matrix ID,
included so the team can follow up with the user directly.

If `FEEDBACK_WEBHOOK_URL` is unset, or the webhook call fails, nothing is sent and the conversation
continues unaffected.

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
