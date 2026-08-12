#!/bin/sh

DATA_DIR=${DATA_DIR:-./data}

mkdir -p "$DATA_DIR/API"
curl https://beta.gouv.fr/api/v2.6/authors.json -o "$DATA_DIR/API/members.json"
curl https://beta.gouv.fr/api/v2.6/startups.json -o "$DATA_DIR/API/startups.json"
curl https://beta.gouv.fr/api/v2.6/startups_details.json -o "$DATA_DIR/API/startups_details.json"
curl https://beta.gouv.fr/api/v2.6/incubators.json -o "$DATA_DIR/API/incubators.json"

if [ -d "$DATA_DIR/gitscan" ]; then
  git -C "$DATA_DIR/gitscan" pull
else
  git clone https://github.com/betagouv/gitscan --depth=1 "$DATA_DIR/gitscan"
fi

if [ -d "$DATA_DIR/doc.incubateur.net" ]; then
  git -C "$DATA_DIR/doc.incubateur.net" pull
else
  git clone https://github.com/betagouv/doc.incubateur.net-communaute --depth=500 "$DATA_DIR/doc.incubateur.net"
fi

if [ -d "$DATA_DIR/beta.gouv.fr" ]; then
  git -C "$DATA_DIR/beta.gouv.fr" pull
else
  git clone https://github.com/betagouv/beta.gouv.fr --depth=500 "$DATA_DIR/beta.gouv.fr"
fi
# dont embed internal instructions or noise
rm -r $DATA_DIR/doc.incubateur.net/les-standards/.adrs || true
rm -r $DATA_DIR/doc.incubateur.net/les-standards/*.md || true
rm -r $DATA_DIR/doc.incubateur.net/gerer-son-produit/standards || true
rm -r $DATA_DIR/doc.incubateur.net/gerer-son-produit/les-standards || true
rm -r $DATA_DIR/doc.incubateur.net/gerer-son-produit/readme-doc-incubateur-net || true

npx tsx fetch-docs.ts https://partenaires.proconnect.gouv.fr/docs "$DATA_DIR/docs-proconnect"
npx tsx fetch-docs.ts https://docs.partenaires.franceconnect.gouv.fr "$DATA_DIR/docs-franceconnect"
npx tsx fetch-docs.ts https://www.systeme-de-design.gouv.fr/version-courante/fr/premiers-pas "$DATA_DIR/docs-dsfr/premiers-pas"
npx tsx fetch-docs.ts https://www.systeme-de-design.gouv.fr/version-courante/fr/fondamentaux "$DATA_DIR/docs-dsfr/fondamentaux"
npx tsx fetch-docs.ts https://aide.tchap.numerique.gouv.fr/fr/ "$DATA_DIR/docs-tchap"

mkdir -p "$DATA_DIR/docs-messagerie"
npx tsx fetch-messagerie-docs.ts

mkdir -p "$DATA_DIR/peertube"

# The /feeds/videos.json endpoint silently caps at 20 items per channel, so
# channels with more videos lose their older ones. Page through the REST API
# instead (100 items per page) and reshape into the same {items: [...]} shape
# build-embeddings.ts expects.
fetch_peertube_channel() {
  channel="$1"
  out="$DATA_DIR/peertube/$channel.json"
  page_dir=$(mktemp -d)
  page=0
  count=100
  while true; do
    start=$((page * count))
    curl -s "https://tube.numerique.gouv.fr/api/v1/video-channels/$channel/videos?start=$start&count=$count&sort=-createdAt" -o "$page_dir/page_$page.json"
    got=$(jq '.data | length' "$page_dir/page_$page.json")
    page=$((page + 1))
    if [ "$got" -lt "$count" ]; then
      break
    fi
  done
  jq -s '{items: [.[] | .data[] | {
    id: ("https://tube.numerique.gouv.fr/w/" + .shortUUID),
    url: ("https://tube.numerique.gouv.fr/w/" + .shortUUID),
    title: .name,
    summary: .description,
    date_published: .publishedAt,
    date_modified: .updatedAt
  }]}' "$page_dir"/page_*.json > "$out"
  rm -rf "$page_dir"
}

for channel in animation_beta lasuite_modedemploi bluehats lasuite grist designgouv tchap datagouvfr fabnum.mte ruche_numerique; do
  fetch_peertube_channel "$channel"
done

# public calendar
if [ -n "$CALENDAR_ICS_URL" ]; then
  curl -L "$CALENDAR_ICS_URL" -o "$DATA_DIR/calendar.ics"
else
  echo "CALENDAR_ICS_URL is not set, skipping calendar download"
fi

# startup changelog
curl -L "https://betagouv.github.io/beta.gouv.fr/startups.html" -o "$DATA_DIR/startups-changelog.html"
npx tsx src/parse-startup-changelog.ts "$DATA_DIR/startups-changelog.html" "$DATA_DIR/changelog-startups.json"

# welcome to the jungle offers
npx tsx fetch-wttj.ts

# choisir le service public offers
npx tsx fetch-choisirleservicepublic.ts

mkdir -p "$DATA_DIR/index"

# active members index
TODAY=$(date +%Y-%m-%d)
jq --arg today "$TODAY" '[.[] | select(.missions[]?.end > $today) | {id, fullname, competences, role, domaine}] | unique_by(.id)' "$DATA_DIR/API/members.json" > "$DATA_DIR/index/members.json"

# active startups index
jq --slurpfile details "$DATA_DIR/API/startups_details.json" '
  [.data[]
   | select(.attributes.phases | map(.name) | any(. == "abandon" or . == "abandon-investigation") | not)
   | {
       id: .id,
       name: .attributes.name,
       description: .attributes.pitch,
       active_member_count: (($details[0][.id].active_members // []) | length)
     }
  ]' "$DATA_DIR/API/startups.json" > "$DATA_DIR/index/startups.json"

# incubators index
jq '[to_entries[] | {id: .key, title: .value.title, contact: .value.contact, website: .value.website, github: .value.github, startup_count: (.value.startups | length)}]' "$DATA_DIR/API/incubators.json" > "$DATA_DIR/index/incubators.json"

# phases index
cat > "$DATA_DIR/index/phases.txt" << EOF
 - investigation: En investigation (recherche terrain)
 - construction: En construction (lancement du produit)
 - acceleration: En accélération (déploiement du produit)
 - perennisation: En consolidation. Le service est en cours de sortie d'incubation. L'équipe travaille sur les modalités pour opérer le service sur le long-terme.
 - transfere: Transféré. Le service est sorti du programme beta.gouv.fr et est toujours accessible et utilisable pour ses utilisateurs suite à sa sortie.
 - opere: Opéré au sein du réseau. Le service est mature et n'est plus dans une logique d'incubation. Un incubateur ou un opérateur du réseau continue à être impliqué et à suivre l'impact du service.
 - abandon: Arrêté. Le service a été arrêté pendant le programme d'incubation. Il n'est plus accessible pour ses utilisateurs
 - abandon-investigation: Investigation non concluante. L'investigation n'a pas mené à la création d'un service numérique.
EOF

tree -L 2 "$DATA_DIR"

du -hs "$DATA_DIR"
