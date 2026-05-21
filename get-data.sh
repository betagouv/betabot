#!/bin/sh


mkdir -p data/API
curl https://beta.gouv.fr/api/v2.6/authors.json -o data/API/members.json
curl https://beta.gouv.fr/api/v2.6/startups.json -o data/API/startups.json
curl https://beta.gouv.fr/api/v2.6/startups_details.json -o data/API/startups_details.json
curl https://beta.gouv.fr/api/v2.6/incubators.json -o data/API/incubators.json

if [ -d data/gitscan ]; then
  git -C data/gitscan pull
else
  git clone https://github.com/betagouv/gitscan --depth=1 data/gitscan
fi

if [ -d data/doc.incubateur.net ]; then
  git -C data/doc.incubateur.net pull
else
  git clone https://github.com/betagouv/doc.incubateur.net-communaute --depth=500 data/doc.incubateur.net
fi


mkdir -p data/peertube
curl "https://tube.numerique.gouv.fr/feeds/videos.json?videoChannelName=animation_beta&sort=-createdAt" -o data/peertube/animation_beta.json
curl "https://tube.numerique.gouv.fr/feeds/videos.json?videoChannelName=lasuite_modedemploi&sort=-createdAt" -o data/peertube/lasuite_modedemploi.json
curl "https://tube.numerique.gouv.fr/feeds/videos.json?videoChannelName=bluehats&sort=-createdAt" -o data/peertube/bluehats.json
curl "https://tube.numerique.gouv.fr/feeds/videos.json?videoChannelName=lasuite&sort=-createdAt" -o data/peertube/lasuite.json
curl "https://tube.numerique.gouv.fr/feeds/videos.json?videoChannelName=grist&sort=-createdAt" -o data/peertube/grist.json
curl "https://tube.numerique.gouv.fr/feeds/videos.json?videoChannelName=designgouv&sort=-createdAt" -o data/peertube/designgouv.json
curl "https://tube.numerique.gouv.fr/feeds/videos.json?videoChannelName=tchap&sort=-createdAt" -o data/peertube/tchap.json
curl "https://tube.numerique.gouv.fr/feeds/videos.json?videoChannelName=datagouvfr&sort=-createdAt" -o data/peertube/datagouvfr.json
curl "https://tube.numerique.gouv.fr/feeds/videos.json?videoChannelName=fabnum.mte&sort=-createdAt" -o data/peertube/fabnum.mte.json

curl "https://calendar.google.com/calendar/ical/0ieonqap1r5jeal5ugeuhoovlg%40group.calendar.google.com/public/basic.ics" -o data/calendar.ics

mkdir -p data/index

TODAY=$(date +%Y-%m-%d)
jq --arg today "$TODAY" '[.[] | select(.missions[]?.end > $today) | {id, fullname, competences, role, domaine}] | unique_by(.id)' ./data/API/members.json > data/index/members.json

jq --slurpfile details data/API/startups_details.json '
  [.data[]
   | select(.attributes.phases | map(.name) | any(. == "abandon" or . == "abandon-investigation") | not)
   | {
       id: .id,
       name: .attributes.name,
       description: .attributes.pitch,
       active_member_count: (($details[0][.id].active_members // []) | length)
     }
  ]' ./data/API/startups.json > data/index/startups.json

jq '[to_entries[] | {id: .key, title: .value.title, contact: .value.contact, website: .value.website, github: .value.github, startup_count: (.value.startups | length)}]' data/API/incubators.json > data/index/incubators.json


cat > data/index/phases.txt << EOF
 - investigation: En investigation (recherche terrain)
 - construction: En construction (lancement du produit)
 - acceleration: En accélération (déploiement du produit)
 - perennisation: En consolidation. Le service est en cours de sortie d’incubation. L’équipe travaille sur les modalités pour opérer le service sur le long-terme. 
 - transfere: Transféré. Le service est sorti du programme beta.gouv.fr et est toujours accessible et utilisable pour ses utilisateurs suite à sa sortie. 
 - opere: Opéré au sein du réseau. Le service est mature et n'est plus dans une logique d'incubation. Un incubateur ou un opérateur du réseau continue à être impliqué et à suivre l'impact du service.
 - abandon: Arrêté. Le service a été arrêté pendant le programme d’incubation. Il n’est plus accessible pour ses utilisateurs
 - abandon-investigation: Investigation non concluante. L’investigation n’a pas mené à la création d’un service numérique.
EOF

tree -L 2 data

du -hs data