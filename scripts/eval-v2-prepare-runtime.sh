#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo 'usage: sh scripts/eval-v2-prepare-runtime.sh ABSOLUTE_LINUX_DESTINATION' >&2
  exit 2
fi
case "$1" in /*) ;; *) echo 'runtime destination must be absolute' >&2; exit 2 ;; esac
destination=$1
script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
mkdir -p "$destination/debs" "$destination/unpack"

while read -r digest filename; do
  [ -n "$digest" ] || continue
  package=${filename%%_*}
  remainder=${filename#*_}
  version=${remainder%_*}
  version=${version%_*}
  if [ ! -f "$destination/debs/$filename" ]; then
    (cd "$destination/debs" && apt download "$package=$version")
  fi
  (cd "$destination/debs" && printf '%s  %s\n' "$digest" "$filename" | sha256sum -c -)
  dpkg-deb -x "$destination/debs/$filename" "$destination/unpack"
done < "$script_directory/eval-v2-runtime.sha256"

test -x "$destination/unpack/usr/bin/node"
test -f "$destination/unpack/usr/share/nodejs/cjs-module-lexer/lexer.js"
echo "$destination/unpack"
