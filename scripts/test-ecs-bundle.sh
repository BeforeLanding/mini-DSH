#!/usr/bin/env bash
set -euo pipefail
root="$(mktemp -d)"
script="$(cd "$(dirname "$0")" && pwd)/deploy-ecs-bundle.sh"
base="$root/app"
transfer="$base/incoming/transfer.test"
mkdir -p "$transfer" "$base/shared" "$root/source"
printf 'fixture only\n' > "$base/shared/.env"
git -C "$root/source" init -q
printf 'fixture\n' > "$root/source/example.txt"
git -C "$root/source" add example.txt
git -C "$root/source" -c user.name=Fixture -c user.email=fixture@example.invalid commit -qm fixture
sha="$(git -C "$root/source" rev-parse HEAD)"
git -C "$root/source" bundle create "$transfer/source.bundle" HEAD
export MINI_DSH_DEPLOY_BASE="$base"
# Git Bash lacks flock; the remote Linux workflow exercises the real lock.
if ! command -v flock >/dev/null; then
  flock() { test "$1" = -w && test "$2" = 120 && test "$3" = 9; }
  export -f flock
fi
if "$BASH" "$script" prepare invalid "$transfer"; then exit 1; fi
if "$BASH" "$script" prepare 0000000000000000000000000000000000000000 "$transfer"; then exit 1; fi
test ! -e "$base/current"
release="$base/releases/$sha.test"
mkdir -p "$release"
git -C "$release" init -q
git -C "$release" fetch "$transfer/source.bundle" HEAD
git -C "$release" checkout -q --detach "$sha"
printf '%s\n' "$root/source" > "$transfer/release-path"
if "$BASH" "$script" activate "$sha" "$transfer"; then exit 1; fi
printf '%s\n' "$release" > "$transfer/release-path"
printf 'wrong revision\n' > "$release/REVISION"
if "$BASH" "$script" activate "$sha" "$transfer"; then exit 1; fi
test ! -e "$base/current"
echo 'Bundle import, wrong SHA/path/revision rejection passed.'
case "$(uname -s)" in
  MINGW*|MSYS*) echo 'Linux symlink activation checks deferred to Actions.'; exit 0 ;;
esac
old="$base/releases/bootstrap"
mkdir -p "$old" "$release/dist/src"
printf 'fixture\n' > "$release/dist/src/index.js"
printf '%s\n' "$sha" > "$release/REVISION"
ln -s "$old" "$base/current"
ln -s "$base/shared/.env" "$release/.env"
"$BASH" "$script" activate "$sha" "$transfer"
test "$(readlink -f "$base/current")" = "$release"
test "$(cat "$release/PREVIOUS_RELEASE")" = "$old"
test "$(cat "$base/shared/.env")" = 'fixture only'
echo 'Atomic activation, previous release and shared configuration passed.'
