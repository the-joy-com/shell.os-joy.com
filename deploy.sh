#!/usr/bin/env bash
set -euo pipefail

# Build the static site from the current checkout and publish it into nginx's document root. Run from the repo on the server: `./deploy.sh`.
DOCROOT=/var/www/shell.os-joy.com/html

git pull --ff-only
yarn install --frozen-lockfile
yarn build
# --delete mirrors dist/ exactly, so Vite's hashed bundles don't pile up across deploys. The trailing slash copies the *contents* of dist/, not the folder.
sudo rsync -a --delete dist/ "$DOCROOT"/
sudo chown -R www-data:www-data "$DOCROOT"
echo "deployed → https://shell.os-joy.com"
