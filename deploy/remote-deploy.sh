#!/usr/bin/env bash
# Exécuté SUR le serveur par la GitHub Action, après l'envoi de release.tar.gz.
set -euo pipefail
: "${DEPLOY_PATH:?}"
cd "$DEPLOY_PATH"

rm -rf src.new && mkdir src.new
tar -xzf release.tar.gz -C src.new
rm -f release.tar.gz

# Le fichier .env vit à côté du code et survit aux déploiements.
[ -f .env ] || cp src.new/.env.example .env
cp .env src.new/.env

rm -rf src.old
if [ -d src ]; then mv src src.old; fi
mv src.new src

cd src
# Nom de projet fixe : les volumes (transferts, certificats) sont conservés d'un déploiement à l'autre.
docker compose -p convertor up -d --build --remove-orphans
docker image prune -f >/dev/null
echo "Déployé : $(date -u)"
