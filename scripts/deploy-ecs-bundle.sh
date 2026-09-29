#!/usr/bin/env bash
set -euo pipefail
umask 077

mode="${1:?prepare or activate required}"
sha="${2:?commit SHA required}"
transfer="${3:?transfer directory required}"
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo 'Invalid commit SHA'; exit 2; }
base="${MINI_DSH_DEPLOY_BASE:-$HOME/apps/mini-DSH}"
base="$(readlink -f "$base")"
transfer="$(readlink -f "$transfer")"
[[ "$transfer" == "$base"/incoming/transfer.* && -d "$transfer" ]] || { echo 'Invalid transfer directory'; exit 2; }
test -f "$base/shared/.env"
if [[ -e "$base/current" || -L "$base/current" ]]; then
  test -L "$base/current"
  test -d "$base/current"
fi
exec 9>"$base/deploy.lock"
flock -w 120 9

case "$mode" in
  prepare)
    mkdir -p "$base/releases"
    release="$(mktemp -d "$base/releases/${sha}.XXXXXX")"
    git -C "$release" init -q
    git -C "$release" bundle verify "$transfer/source.bundle"
    test "$(git bundle list-heads "$transfer/source.bundle" HEAD | cut -d' ' -f1)" = "$sha"
    git -C "$release" fetch "$transfer/source.bundle" HEAD
    git -C "$release" checkout --detach "$sha"
    test "$(git -C "$release" rev-parse HEAD)" = "$sha"
    set +u
    source "$HOME/.nvm/nvm.sh"
    nvm use 24 >/dev/null
    set -u
    test "$(pnpm --version)" = 11.22.0
    cd "$release"
    pnpm install --frozen-lockfile
    pnpm check
    pnpm test
    test -f dist/src/index.js
    test ! -e .env && test ! -L .env
    ln -s "$base/shared/.env" .env
    printf '%s\n' "$sha" > REVISION
    printf '%s\n' "$release" > "$transfer/release-path"
    echo 'Release prepared; current unchanged.'
    ;;
  activate)
    release="$(readlink -f "$(cat "$transfer/release-path")")"
    [[ "$release" == "$base/releases/${sha}."* && -d "$release" ]] || { echo 'Invalid release path'; exit 2; }
    test "$(cat "$release/REVISION")" = "$sha"
    test "$(git -C "$release" rev-parse HEAD)" = "$sha"
    test -f "$release/dist/src/index.js"
    test "$(readlink -f "$release/.env")" = "$base/shared/.env"
    readlink -f "$base/current" > "$release/PREVIOUS_RELEASE"
    next="$base/current.${sha}.$$.next"
    test ! -e "$next" && test ! -L "$next"
    trap 'rm -f -- "$next"' EXIT
    ln -s "$release" "$next"
    mv -Tf "$next" "$base/current"
    test "$(readlink -f "$base/current")" = "$release"
    printf 'Published commit: %s\n' "$sha"
    printf 'Current release: %s\n' "$release"
    ;;
  *) echo 'Invalid deployment mode'; exit 2 ;;
esac
