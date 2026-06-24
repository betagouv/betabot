import path from "path";
import { config } from "../config.js";
import { makeDocsTool } from "./docs-base.js";

const { tools, handlers, reset } = makeDocsTool({
  dir: path.join(config.dataDir, "docs-tchap"),
  searchName: "search_docs_tchap",
  pageName: "get_doc_tchap_page",
  searchDescription:
    "Recherche dans la documentation Tchap (aide.tchap.numerique.gouv.fr). À utiliser pour toute question sur Tchap, la messagerie sécurisée de l'État, le protocole Matrix, les salons, le chiffrement, les comptes Tchap. Utilise get_doc_tchap_page pour récupérer le contenu complet d'un résultat.",
  pageDescription:
    "Récupère le contenu complet d'une page de documentation Tchap par son chemin relatif. À utiliser UNIQUEMENT avec les chemins retournés par search_docs_tchap.",
  searchExample: "comment créer un salon privé sur Tchap",
  pageExample: "creer-un-salon.md",
});

export { tools, handlers, reset };
