import path from "path";
import { config } from "../config.js";
import { makeDocsTool } from "./docs-base.js";

function postProcess(content: string): string {
  return content
    .replace(/\{%.*?%\}/gs, "")
    .replace(/\s*<a\s[^>]*><\/a>/g, "")
    .trim();
}

const { tools, handlers, reset } = makeDocsTool({
  dir: path.join(config.dataDir, "doc.incubateur.net"),
  searchName: "search_docs",
  pageName: "get_doc_page",
  searchDescription:
    "Recherche dans la documentation de la communauté beta.gouv.fr (doc.incubateur.net). Utilise get_doc_page pour récupérer le contenu complet d'un résultat. Methodologie, Culture, Processes, Marchés, Services et outils, Standards, Contacts, Messagerie, Tchap, contacts utiles, équipes de références de la communauté...",
  pageDescription:
    "Récupère le contenu complet d'une page de documentation doc.incubateur.net par son chemin relatif. À utiliser UNIQUEMENT avec les chemins retournés par search_docs.",
  searchExample: "comment recruter un développeur",
  pageExample: "gerer-son-produit/README.md",
  postProcess,
});

export { tools, handlers, reset };
