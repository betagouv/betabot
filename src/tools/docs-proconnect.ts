import path from "path";
import { config } from "../config.js";
import { makeDocsTool } from "./docs-base.js";

const { tools, handlers, reset } = makeDocsTool({
  dir: path.join(config.dataDir, "docs-proconnect"),
  searchName: "search_docs_proconnect",
  pageName: "get_doc_proconnect_page",
  searchDescription:
    "Recherche dans la documentation ProConnect (partenaires.proconnect.gouv.fr/docs). À utiliser pour toute question sur ProConnect, AgentConnect, MonComptePro. l'intégration SSO, la fédération d'identité. Utilise get_doc_proconnect_page pour récupérer le contenu complet d'un résultat.",
  pageDescription:
    "Récupère le contenu complet d'une page de documentation ProConnect par son chemin relatif. À utiliser UNIQUEMENT avec les chemins retournés par search_docs_proconnect.",
  searchExample: "comment intégrer ProConnect avec OIDC",
  pageExample: "integration/oidc.md",
});

export { tools, handlers, reset };
