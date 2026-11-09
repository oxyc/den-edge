#!/usr/bin/env bash
# Public environment examples must describe the current reset gate, not the retired Owner-split controls.
set -euo pipefail

if git grep -n -E \
    '^[[:space:]]*#?[[:space:]]*(PROFILE_MIGRATION_ENABLED|PROFILE_PREPARE_HOUSEHOLDS)=' \
    -- '*env.example'; then
    echo 'retired profile migration variables must not appear in public environment examples' >&2
    exit 1
fi

if ! grep -Fqx '# PROFILE_RESET_ENABLED=0' .env.example; then
    echo 'the root environment example must keep PROFILE_RESET_ENABLED explicitly default-off' >&2
    exit 1
fi
