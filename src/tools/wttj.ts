import path from "path";
import { config } from "../config.js";
import { makeDocsTool } from "./docs-base.js";

const { tools, handlers, reset } = makeDocsTool({
  dir: path.join(config.dataDir, "wttj"),
  searchName: "search_wttj_jobs",
  pageName: "get_wttj_job_page",
  searchDescription:
    "Recherche des offres d'emploi WelcomeKit (WTTJ) par intitulé de poste, compétences, localisation ou type de contrat. Utilise get_wttj_job_page pour récupérer le détail complet d'une offre.",
  pageDescription:
    "Récupère le contenu complet d'une offre d'emploi WelcomeKit par son chemin relatif. À utiliser UNIQUEMENT avec les chemins retournés par search_wttj_jobs.",
  searchExample: "développeur Python full remote",
  pageExample: "ci7AvS/senior-backend-engineer-abc123.md",
});

export { tools, handlers, reset };
