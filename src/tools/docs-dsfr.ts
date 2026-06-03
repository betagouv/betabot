import path from "path";
import { config } from "../config.js";
import { makeDocsTool } from "./docs-base.js";

const { tools, handlers, reset } = makeDocsTool({
  dir: path.join(config.dataDir, "docs-dsfr"),
  searchName: "search_docs_dsfr",
  pageName: "get_doc_dsfr_page",
  searchDescription:
    "Recherche dans la documentation du Design Système de l'État (DSFR) sur systeme-de-design.gouv.fr. À utiliser pour toute question sur le DSFR, les composants UI, l'accessibilité, les guidelines de design, les fondamentaux graphiques, les premiers pas avec le système de design. Utilise get_doc_dsfr_page pour récupérer le contenu complet d'un résultat.",
  pageDescription:
    "Récupère le contenu complet d'une page de documentation DSFR par son chemin relatif. À utiliser UNIQUEMENT avec les chemins retournés par search_docs_dsfr.",
  searchExample: "comment utiliser les boutons du DSFR",
  pageExample: "premiers-pas/installation.md",
});

export { tools, handlers, reset };
