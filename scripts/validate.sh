#!/usr/bin/env bash
set -euo pipefail

repo=${1:?usage: validate.sh <git-url> <package> [why-kept args...]}
query=${2:?usage: validate.sh <git-url> <package> [why-kept args...]}
shift 2

cli=$(cd "$(dirname "$0")/.." && pwd)/packages/why-kept/dist/cli.js
dir=$(mktemp -d)/app

git clone --depth 1 "$repo" "$dir"
cd "$dir"
if [ -f pnpm-lock.yaml ]; then pnpm install --ignore-scripts
elif [ -f yarn.lock ]; then yarn install --ignore-scripts
else npm install --ignore-scripts; fi

node "$cli" "$query" --root . "$@"
