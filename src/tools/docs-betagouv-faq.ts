import path from "path";
import { config } from "../config.js";
import { makeDocsTool } from "./docs-base.js";

const { tools, handlers, reset } = makeDocsTool({
  dir: path.join(config.dataDir, "faq-betagouv"),
  searchName: "search_docs_betagouv_faq",
  pageName: "get_doc_betagouv_faq_page",
  searchDescription:
    "Recherche dans la FAQ beta.gouv.fr (faq-betagouv.crisp.help), les questions/réponses classiques de la communauté beta.gouv.fr. À utiliser pour toute question sur le programme, l'espace membre, les accès aux outils (Mattermost, Brevo, Matomo/Sentry, Welcome to the Jungle), les emails @beta.gouv.fr, les fiches produits, l'onboarding ou l'accès aux services numériques. Utilise get_doc_betagouv_faq_page pour récupérer le contenu complet d'un résultat.",
  pageDescription:
    "Récupère le contenu complet d'une page de la FAQ beta.gouv.fr par son chemin relatif. À utiliser UNIQUEMENT avec les chemins retournés par search_docs_betagouv_faq.",
  searchExample: "je n'arrive pas à accéder à mon espace membre",
  pageExample: "fr-article-quest-ce-que-lespace-membre-rdo6jb.md",
});

export { tools, handlers, reset };
