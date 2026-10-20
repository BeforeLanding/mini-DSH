#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo 'usage: sh scripts/eval-v2-prepare-runtime.sh ABSOLUTE_LINUX_DESTINATION' >&2
  exit 2
fi
case "$1" in /*) ;; *) echo 'runtime destination must be absolute' >&2; exit 2 ;; esac
destination=$1
script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
mkdir -p "$destination/archive" "$destination/unpack/usr"

# R08：不再从发行版仓库抓版本各异的 .deb（ubuntu-latest 上会直接找不到包）。
# 固定官方 Node tarball 与其 SHA-256；解包后仍是 usr/bin/node，隔离后端的路径约定不变。
while read -r digest filename; do
  [ -n "$digest" ] || continue
  if [ ! -f "$destination/archive/$filename" ]; then
    (cd "$destination/archive" && curl -fsSL --retry 3 -O "https://nodejs.org/dist/v22.22.1/$filename")
  fi
  (cd "$destination/archive" && printf '%s  %s\n' "$digest" "$filename" | sha256sum -c -)
  tar -xJf "$destination/archive/$filename" --strip-components=1 -C "$destination/unpack/usr"
done < "$script_directory/eval-v2-runtime.sha256"

# 旧 .deb runtime 在这里放 ESM 辅助模块；官方 tarball 自带，保留空目录让绑定路径一致。
mkdir -p "$destination/unpack/usr/share/nodejs"
test -x "$destination/unpack/usr/bin/node"
"$destination/unpack/usr/bin/node" --version | grep -qx 'v22.22.1'
echo "$destination/unpack"
