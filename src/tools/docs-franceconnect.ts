import path from "path";
import { config } from "../config.js";
import { makeDocsTool } from "./docs-base.js";

const { tools, handlers, reset } = makeDocsTool({
  dir: path.join(config.dataDir, "docs-franceconnect"),
  searchName: "search_docs_franceconnect",
  pageName: "get_doc_franceconnect_page",
  searchDescription:
    "Recherche dans la documentation FranceConnect (docs.partenaires.franceconnect.gouv.fr). À utiliser pour toute question sur FranceConnect, l'intégration SSO, la fédération d'identité, l'authentification des citoyens. Utilise get_doc_franceconnect_page pour récupérer le contenu complet d'un résultat.",
  pageDescription:
    "Récupère le contenu complet d'une page de documentation FranceConnect par son chemin relatif. À utiliser UNIQUEMENT avec les chemins retournés par search_docs_franceconnect.",
  searchExample: "comment intégrer FranceConnect sur mon service",
  pageExample: "integration-fc.md",
});

export { tools, handlers, reset };
