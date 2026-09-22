#!/usr/bin/env bash
set -Eeuo pipefail

release_tag=${1:-${GITHUB_REF_NAME:-}}

if [[ ! ${release_tag} =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo 'usage: scripts/build-release.sh vMAJOR.MINOR.PATCH' >&2
  exit 1
fi

project_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
build_root=$(mktemp -d)
trap 'rm -rf "${build_root}"' EXIT

mkdir -p "${build_root}/app" "${project_root}/dist"
cp "${project_root}/package.json" "${project_root}/package-lock.json" "${build_root}/app/"
cp -R "${project_root}/src" "${build_root}/app/src"
npm ci --prefix "${build_root}/app" --omit=dev --ignore-scripts --no-audit --no-fund
printf '{"schema_version":1,"component":"nexus-discord","release":"%s"}\n' "${release_tag}" > "${build_root}/app/nexus-release.json"

if tar --help 2>&1 | grep -q -- '--sort'; then
  tar --sort=name --mtime='UTC 1970-01-01' --owner=0 --group=0 --numeric-owner \
    -czf "${project_root}/dist/nexus-discord.tar.gz" -C "${build_root}/app" .
else
  COPYFILE_DISABLE=1 tar -czf "${project_root}/dist/nexus-discord.tar.gz" -C "${build_root}/app" .
fi

echo "Created dist/nexus-discord.tar.gz for ${release_tag}"
