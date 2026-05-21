import fs from "fs";
import path from "path";
import { embedBatch, saveBin } from "./src/embed.js";
import { buildBM25Index, saveBM25Index } from "./src/search.js";
import { parseFrontmatter, extractSections } from "./src/markdown.js";

const DATA_DIR = process.env["DATA_DIR"] ?? "./data";
const FORCE = process.argv.includes("--force");

function shouldSkip(binPath: string): boolean {
  if (FORCE) return false;
  if (fs.existsSync(binPath)) {
    console.log(`  ↩ Already exists, skipping (use --force to rebuild)`);
    return true;
  }
  return false;
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface MemberEntry {
  id: string;
  fullname: string;
  role: string;
  domaine: string;
  competences: string[];
}

interface StartupEntry {
  id: string;
  name: string;
  description: string;
  active_member_count: number;
}

interface RepoEntry {
  org: string;
  repo: string;
  name: string;
  description: string;
  language: string;
  tags: string[];
}

interface DocChunk {
  path: string;
  title: string;
  breadcrumb: string;
  excerpt: string;
}

interface StartupChunk {
  slug: string;
  title: string;
  breadcrumb: string;
  excerpt: string;
  isFrontmatter: boolean;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function excerpt(text: string, maxLen = 200): string {
  return text.length > maxLen ? text.slice(0, maxLen) + "…" : text;
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
}

function writeJson(filePath: string, data: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// ─── Job 1: Members ───────────────────────────────────────────────────────────

async function buildMembersEmbeddings() {
  console.log("\n[1/5] Building members embeddings…");
  if (shouldSkip(path.join(DATA_DIR, "index/members.embeddings.bin"))) return;
  const members = readJson<MemberEntry[]>(
    path.join(DATA_DIR, "index/members.json")
  );

  const texts = members.map(
    (m) =>
      `${m.fullname}, ${m.role}, domaine ${m.domaine}. Compétences: ${
        (m.competences ?? []).join(", ") || "non renseignées"
      }`
  );

  const vecs = await embedBatch(texts);
  saveBin(vecs, path.join(DATA_DIR, "index/members.embeddings.bin"));

  const bm25 = await buildBM25Index(texts);
  saveBM25Index(bm25, path.join(DATA_DIR, "index/members.bm25.json"));

  console.log(`  ✓ ${members.length} members embedded`);
}

// ─── Job 2: Startups index ───────────────────────────────────────────────────

async function buildStartupsEmbeddings() {
  console.log("\n[2/5] Building startups index embeddings…");
  if (shouldSkip(path.join(DATA_DIR, "index/startups.embeddings.bin"))) return;
  const startups = readJson<StartupEntry[]>(
    path.join(DATA_DIR, "index/startups.json")
  );

  const texts = startups.map((s) => `${s.name}: ${s.description}`);
  const vecs = await embedBatch(texts);
  saveBin(vecs, path.join(DATA_DIR, "index/startups.embeddings.bin"));

  const bm25 = await buildBM25Index(texts);
  saveBM25Index(bm25, path.join(DATA_DIR, "index/startups.bm25.json"));

  console.log(`  ✓ ${startups.length} startups embedded`);
}

// ─── Job 3: Gitscan repos ────────────────────────────────────────────────────

async function buildReposEmbeddings() {
  console.log("\n[3/5] Building gitscan repos embeddings…");
  if (shouldSkip(path.join(DATA_DIR, "gitscan/repos.embeddings.bin"))) return;
  const reposDir = path.join(DATA_DIR, "gitscan/repos");
  const entries: RepoEntry[] = [];
  const texts: string[] = [];

  const orgs = fs.readdirSync(reposDir).filter((f) => {
    try {
      return fs.statSync(path.join(reposDir, f)).isDirectory();
    } catch {
      return false;
    }
  });

  for (const org of orgs) {
    const orgDir = path.join(reposDir, org);
    const repos = fs.readdirSync(orgDir).filter((f) => {
      try {
        return fs.statSync(path.join(orgDir, f)).isDirectory();
      } catch {
        return false;
      }
    });

    for (const repo of repos) {
      const overviewPath = path.join(orgDir, repo, "overview.json");
      if (!fs.existsSync(overviewPath)) continue;

      try {
        const ov = readJson<{
          name: string;
          description: string;
          language: string;
          tags: string[];
          features: string[];
          audience: string;
        }>(overviewPath);

        const text =
          `${ov.name} (${org}): ${ov.description ?? ""}. ` +
          `Language: ${ov.language ?? ""}. ` +
          `Tags: ${(ov.tags ?? []).join(", ")}. ` +
          `Features: ${(ov.features ?? []).join(", ")}. ` +
          `Audience: ${ov.audience ?? ""}`;

        entries.push({
          org,
          repo,
          name: ov.name,
          description: ov.description ?? "",
          language: ov.language ?? "",
          tags: ov.tags ?? [],
        });
        texts.push(text);
      } catch {
        // Skip repos with broken overview.json
      }
    }
  }

  const vecs = await embedBatch(texts);
  saveBin(vecs, path.join(DATA_DIR, "gitscan/repos.embeddings.bin"));

  const bm25 = await buildBM25Index(texts);
  saveBM25Index(bm25, path.join(DATA_DIR, "gitscan/repos.bm25.json"));
  writeJson(path.join(DATA_DIR, "gitscan/repos.index.json"), entries);

  console.log(`  ✓ ${entries.length} repos embedded`);
}

// ─── Job 4: Docs ─────────────────────────────────────────────────────────────

async function buildDocsEmbeddings() {
  console.log("\n[4/5] Building docs embeddings…");
  if (shouldSkip(path.join(DATA_DIR, "doc.incubateur.net/docs.embeddings.bin"))) return;
  const docsDir = path.join(DATA_DIR, "doc.incubateur.net");
  const chunks: DocChunk[] = [];
  const texts: string[] = [];

  function walkDir(dir: string) {
    for (const entry of fs.readdirSync(dir)) {
      const fullPath = path.join(dir, entry);
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        walkDir(fullPath);
      } else if (entry.endsWith(".md")) {
        processDocFile(fullPath);
      }
    }
  }

  function processDocFile(filePath: string) {
    const relativePath = path.relative(docsDir, filePath);
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      return;
    }

    const { data: fm } = parseFrontmatter(content);
    const pageTitle =
      (fm["title"] as string | undefined) ??
      path.basename(filePath, ".md");

    // Intro chunk from front matter description
    if (fm["description"]) {
      const desc = String(fm["description"]);
      chunks.push({
        path: relativePath,
        title: pageTitle,
        breadcrumb: pageTitle,
        excerpt: excerpt(desc),
      });
      texts.push(`[${pageTitle}]\n${desc}`);
    }

    // Section chunks
    const sections = extractSections(content);
    for (const section of sections) {
      if (section.content.length < 30) continue;
      chunks.push({
        path: relativePath,
        title: pageTitle,
        breadcrumb: section.breadcrumb,
        excerpt: excerpt(section.content),
      });
      texts.push(`[${section.breadcrumb}]\n${section.content}`);
    }
  }

  walkDir(docsDir);

  if (texts.length === 0) {
    console.log("  ⚠ No doc files found, skipping");
    return;
  }

  const vecs = await embedBatch(texts);
  saveBin(vecs, path.join(docsDir, "docs.embeddings.bin"));

  const bm25 = await buildBM25Index(texts);
  saveBM25Index(bm25, path.join(docsDir, "docs.bm25.json"));
  writeJson(path.join(docsDir, "docs.index.json"), chunks);

  console.log(`  ✓ ${chunks.length} doc chunks embedded`);
}

// ─── Job 5: Startup pages ────────────────────────────────────────────────────

async function buildStartupPagesEmbeddings() {
  console.log("\n[5/5] Building startup pages embeddings…");
  if (shouldSkip(path.join(DATA_DIR, "beta.gouv.fr/startups.embeddings.bin"))) return;
  const startupsDir = path.join(
    DATA_DIR,
    "beta.gouv.fr/content/_startups"
  );
  const chunks: StartupChunk[] = [];
  const texts: string[] = [];

  const files = fs
    .readdirSync(startupsDir)
    .filter((f) => f.endsWith(".md"));

  for (const file of files) {
    const slug = path.basename(file, ".md");
    const content = fs.readFileSync(
      path.join(startupsDir, file),
      "utf-8"
    );

    const { data: fm } = parseFrontmatter(content);
    const title = (fm["title"] as string | undefined) ?? slug;
    const mission = (fm["mission"] as string | undefined) ?? "";
    const incubator = (fm["incubator"] as string | undefined) ?? "";
    const phases = (
      fm["phases"] as Array<{ name: string }> | undefined ?? []
    )
      .map((p) => p.name)
      .join(" → ");

    // Front matter chunk
    const fmText =
      `[${slug}] ${title} — mission: ${mission}. ` +
      `incubateur: ${incubator}. phases: ${phases}`;
    chunks.push({
      slug,
      title,
      breadcrumb: slug,
      excerpt: excerpt(fmText),
      isFrontmatter: true,
    });
    texts.push(fmText);

    // Body section chunks
    const sections = extractSections(content);
    for (const section of sections) {
      if (section.content.length < 30) continue;
      chunks.push({
        slug,
        title,
        breadcrumb: `${slug} > ${section.breadcrumb}`,
        excerpt: excerpt(section.content),
        isFrontmatter: false,
      });
      texts.push(`[${slug} > ${section.breadcrumb}]\n${section.content}`);
    }
  }

  if (texts.length === 0) {
    console.log("  ⚠ No startup files found, skipping");
    return;
  }

  const vecs = await embedBatch(texts);
  saveBin(
    vecs,
    path.join(DATA_DIR, "beta.gouv.fr/startups.embeddings.bin")
  );

  const bm25 = await buildBM25Index(texts);
  saveBM25Index(
    bm25,
    path.join(DATA_DIR, "beta.gouv.fr/startups.bm25.json")
  );
  writeJson(
    path.join(DATA_DIR, "beta.gouv.fr/startups.index.json"),
    chunks
  );

  console.log(`  ✓ ${chunks.length} startup page chunks embedded`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("betabot — build-embeddings");
  console.log("===========================");
  const t0 = Date.now();

  await buildMembersEmbeddings();
  await buildStartupsEmbeddings();
  await buildReposEmbeddings();
  await buildDocsEmbeddings();
  await buildStartupPagesEmbeddings();

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\nDone in ${elapsed}s`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
