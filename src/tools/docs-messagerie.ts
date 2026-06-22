import path from "path";
import { config } from "../config.js";
import { makeDocsTool } from "./docs-base.js";

const { tools, handlers, reset } = makeDocsTool({
  dir: path.join(config.dataDir, "docs-messagerie"),
  searchName: "search_docs_messagerie",
  pageName: "get_doc_messagerie_page",
  searchDescription:
    "Recherche dans la documentation messagerie de l'État (docs.numerique.gouv.fr). À utiliser pour toute question sur la configuration email, DNS mail (MX, DKIM, DMARC, SPF), anti-spam, boîtes mail, messagerie professionnelle. Utilise get_doc_messagerie_page pour récupérer le contenu complet d'un résultat.",
  pageDescription:
    "Récupère le contenu complet d'une page de documentation messagerie par son chemin relatif. À utiliser UNIQUEMENT avec les chemins retournés par search_docs_messagerie.",
  searchExample: "configurer DKIM et DMARC pour un domaine",
  pageExample: "fb53bdea-7dce-4a93-9b17-deb81e5779dd.md",
});

export { tools, handlers, reset };
