import type { ChatCompletionTool } from "openai/resources/chat/completions.js";
import { config } from "../config.js";

export function buildHelp(): string {
  const cmdLabel = config.matrix.commandRoomsLabel || "le salon admin du bot";
  const cmdRooms = config.matrix.commandRooms;
  const cmdWhere = config.matrix.commandRoomsLabel
    ? `\`${config.matrix.commandRoomsLabel}\``
    : cmdRooms.length > 0
      ? cmdRooms.map((r) => `\`${r}\``).join(", ")
      : "(aucune restriction, partout)";

  const dimailRooms = config.matrix.dimailRooms;
  const dimailWhere =
    dimailRooms.length > 0
      ? config.matrix.commandRoomsLabel &&
        dimailRooms.length === cmdRooms.length &&
        dimailRooms.every((r) => cmdRooms.includes(r))
        ? `\`${config.matrix.commandRoomsLabel}\``
        : dimailRooms.map((r) => `\`${r}\``).join(", ")
      : "(désactivés — aucune room listée dans MATRIX_DIMAIL_ROOMS)";

  const dimailDomain =
    config.dimail.domain || "(non configuré, DIMAIL_DOMAIN vide)";

  const managedSpace =
    config.matrix.managedSpace || "(désactivé — MATRIX_MANAGED_SPACE vide)";

  return `# Aide betabot

## Comment me solliciter

- **En MP / DM** : je réponds à tout message.
- **Dans un salon** : il faut soit me \`@mentionner\`, soit utiliser une commande qui commence par \`/\`.
- Sans \`@\` ni \`/\` dans un salon, je reste silencieux.

## Commandes slash

### \`/test\`
- **Où** : ${cmdWhere}
- **Effet** : envoie un pong de validation (vérifie que le bot écoute dans la room).

### \`/historique\` *(admin uniquement)*
- **Où** : ${cmdWhere}
- **Effet** : affiche les 20 dernières interactions (commandes slash + mentions LLM).
- **Argument optionnel** : \`/historique <filtre>\` pour filtrer par mot-clé (matche dans le texte, l'utilisateur, le statut ou le type).
- **Exemples** :
  - \`/historique emails\` → toutes les commandes /emails
  - \`/historique error\` → toutes les interactions en erreur
  - \`/historique mention\` → uniquement les @mentions LLM

### \`/emails\` — gestion des mailing lists
- **Où** : ${dimailWhere}
- **Domaine par défaut** : ${dimailDomain}

| Sous-commande | Description |
|---|---|
| \`/emails\` ou \`/emails help\` | Affiche cette aide /emails |
| \`/emails create <liste> <email>\` | Crée une nouvelle liste avec un propriétaire |
| \`/emails list\` | Affiche toutes les listes du domaine par défaut |
| \`/emails list <liste>\` | Affiche les membres d'une liste |
| \`/emails join <liste> <email>\` | Ajoute un membre à une liste |
| \`/emails leave <liste> <email>\` | Retire un membre d'une liste |

**Format \`<liste>\`** :
- Nom simple (\`cartobio\`) → résolu en \`cartobio@<domaine par défaut>\`
- Adresse complète (\`contact@covoiturage.beta.gouv.fr\`) → sous-domaine

**Exemples** :
- \`/emails join cartobio jean.louis@beta.gouv.fr\`
- \`/emails join contact@covoiturage.beta.gouv.fr jean.louis@beta.gouv.fr\`

### \`/salon\` — gestion des salons d'un espace
- **Où** : ${cmdWhere}
- **Espace géré** : ${managedSpace}

| Sous-commande | Qui | Description |
|---|---|---|
| \`/salon list\` | tout le monde | Liste les salons de l'espace géré |
| \`/salon create <nom>\` | tout le monde | Crée un salon chiffré, t'y invite, et le rattache à l'espace |
| \`/salon delete <nom>\` | modérateur+ du salon ciblé | Ferme le salon : détache de l'espace + expulse les membres + le bot quitte |
| \`/salon role <nom> <@user> <niveau>\` | admin (\`MATRIX_ADMIN_USERS\`) | Change le niveau d'une personne dans le salon (membre/moderateur/admin ou 0–100) |

## Capacités en langage naturel

Quand tu me poses une question naturelle (avec \`@mention\` en salon ou direct en MP), je peux :
- 👥 chercher des membres beta.gouv.fr
- 🚀 te renseigner sur les startups d'État et leurs équipes
- 🏛 lister les incubateurs
- 📚 chercher dans la documentation communautaire
- 💻 explorer les repos GitHub et leurs changelogs
- 🎥 trouver des vidéos PeerTube
- 📅 consulter le calendrier d'animation
- 📬 (uniquement dans ${dimailWhere}) gérer les mailing lists DiMail

## Si quelque chose ne marche pas

- Commande refusée dans un salon → utilise-la dans ${cmdWhere}
- Réponse "permission denied" sur \`/emails\` → mon compte DiMail n'a pas les droits, contacte l'admin
- Pas de réponse du tout → vérifie que tu m'as bien \`@mentionné\` ou que ton message commence par \`/\``;
}

const helpTool: ChatCompletionTool = {
  type: "function",
  function: {
    name: "get_bot_help",
    description:
      "Retourne la documentation à jour du bot betabot : comment l'utiliser, les commandes slash disponibles, dans quels salons elles fonctionnent, et les capacités en langage naturel. À appeler dès que l'utilisateur demande comment t'utiliser, quelles sont tes commandes, ou comment faire une action particulière.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
};

export const tools: ChatCompletionTool[] = [helpTool];

export const handlers: Record<
  string,
  (args: Record<string, unknown>) => Promise<unknown>
> = {
  get_bot_help: async () => ({ help: buildHelp() }),
};
