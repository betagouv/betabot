import fs from "fs";
import path from "path";

const DATA_DIR = process.env["DATA_DIR"] ?? "./data";
const OUT_DIR = path.join(DATA_DIR, "docs-messagerie");

const DOCUMENT_IDS = [
  "fb53bdea-7dce-4a93-9b17-deb81e5779dd",
  "e882f4ba-e296-408a-957d-7d3ff50273ed",
  "72d85e99-1925-4d3e-ac83-b50b45197784",
  "35db167f-a944-4f03-8e6b-eea42a188e32",
  "18098492-d5a0-498c-80dd-600e7027318c",
  "b9e67f89-5a11-478d-8a4c-e997f7a273b6",
  "05e3c8a9-ac89-4d42-9844-9af9515408a8",
  "90a388b5-9ecc-416c-bef5-e9a3585e9ada",
  "3905063b-079a-4572-830a-f6d2321fb2b7",
  "262935a4-c39b-4245-8cf8-f3df5f3fae7b",
  "d0b64f8b-b844-45d5-aeb1-fc21e282944e",
];

interface DocResponse {
  id: string;
  title: string;
  content: string;
}

async function fetchDoc(id: string): Promise<void> {
  const apiUrl = `https://docs.numerique.gouv.fr/api/v1.0/documents/${id}/formatted-content/?content_format=markdown`;
  const docUrl = `https://docs.numerique.gouv.fr/docs/${id}/`;

  let doc: DocResponse;
  try {
    const res = await fetch(apiUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    doc = (await res.json()) as DocResponse;
  } catch (err) {
    console.error(`  ✗ ${id}: ${err}`);
    return;
  }

  const title = doc.title ?? id;
  const frontmatter = `---\ntitle: ${JSON.stringify(title)}\nurl: "${docUrl}"\n---\n\n`;
  const output = frontmatter + (doc.content ?? "");

  const outPath = path.join(OUT_DIR, `${id}.md`);
  fs.writeFileSync(outPath, output, "utf-8");
  console.log(`  ✓ ${id}: ${title}`);
}

async function main() {
  console.log("fetch-messagerie-docs");
  console.log("=====================");
  fs.mkdirSync(OUT_DIR, { recursive: true });

  for (const id of DOCUMENT_IDS) {
    await fetchDoc(id);
  }

  console.log(
    `\nDone — ${DOCUMENT_IDS.length} documents fetched to ${OUT_DIR}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
