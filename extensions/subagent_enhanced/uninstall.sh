#!/usr/bin/env bash
set -euo pipefail

usage() {
  printf '%s\n' "Usage: $0" "" \
    "Remove subagent_enhanced files installed by install.sh." \
    "Modified files are left untouched. The latest installer backup is restored when possible." \
    "" \
    "Environment:" \
    "  PI_AGENT_DIR  Pi agent directory (default: \$HOME/.pi/agent)."
}

if (($# > 0)); then
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown option: %s\n\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
fi

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
agent_dir="${PI_AGENT_DIR:-$HOME/.pi/agent}"

restore_latest_backup() {
  local destination="$1"
  local backups=("$destination.backup."*)
  if [[ ! -e "${backups[0]}" && ! -L "${backups[0]}" ]]; then
    return
  fi
  local latest="${backups[${#backups[@]}-1]}"
  mv "$latest" "$destination"
  printf 'Restored backup: %s\n' "$latest"
}

uninstall_file() {
  local source="$1"
  local destination_dir="$2"
  local destination="$destination_dir/$(basename "$source")"

  if [[ -L "$destination" && "$(readlink "$destination")" == "$source" ]]; then
    rm "$destination"
    printf 'Removed link: %s\n' "$destination"
  elif [[ -f "$destination" && ! -L "$destination" ]] && cmp -s "$source" "$destination"; then
    rm "$destination"
    printf 'Removed copy: %s\n' "$destination"
  elif [[ -e "$destination" || -L "$destination" ]]; then
    printf 'Skipped modified or unrelated file: %s\n' "$destination" >&2
    return
  else
    printf 'Not installed: %s\n' "$destination"
    return
  fi

  restore_latest_backup "$destination"
}

for source in "$script_dir"/*.ts; do
  [[ -f "$source" ]] || continue
  uninstall_file "$source" "$agent_dir/extensions/subagent_enhanced"
done

for source in "$script_dir"/agents/*.md; do
  [[ -f "$source" ]] || continue
  uninstall_file "$source" "$agent_dir/agents"
done

for source in "$script_dir"/prompts/*.md; do
  [[ -f "$source" ]] || continue
  uninstall_file "$source" "$agent_dir/prompts"
done

rmdir "$agent_dir/extensions/subagent_enhanced" 2>/dev/null || true

printf '\nUninstall complete.\n'
printf 'Run /reload in an active Pi session, or restart Pi.\n'
