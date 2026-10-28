#!/usr/bin/env bash
set -euo pipefail

usage() {
  printf '%s\n' "Usage: $0 [--copy]" ""
  printf '%s\n' \
    "Install the enhanced subagent extension, sample agents, and workflow prompts." \
    "" \
    "Options:" \
    "  --copy   Copy files instead of creating symlinks." \
    "  -h, --help" \
    "" \
    "Environment:" \
    "  PI_AGENT_DIR  Pi agent directory (default: \$HOME/.pi/agent)."
}

mode="link"
while (($# > 0)); do
  case "$1" in
    --copy)
      mode="copy"
      ;;
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
  shift
done

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
agent_dir="${PI_AGENT_DIR:-$HOME/.pi/agent}"
backup_suffix="$(date +%Y%m%d-%H%M%S)"

for resource_dir in agents prompts; do
  if [[ ! -d "$script_dir/$resource_dir" ]]; then
    printf 'Missing resource directory: %s\n' "$script_dir/$resource_dir" >&2
    exit 1
  fi
done

install_file() {
  local source="$1"
  local destination_dir="$2"
  local destination="$destination_dir/$(basename "$source")"

  mkdir -p "$destination_dir"

  if [[ -L "$destination" && "$(readlink "$destination")" == "$source" ]]; then
    printf 'Already linked: %s\n' "$destination"
    return
  fi

  if [[ -e "$destination" || -L "$destination" ]]; then
    local backup="$destination.backup.$backup_suffix"
    printf 'Backing up: %s -> %s\n' "$destination" "$backup"
    mv "$destination" "$backup"
  fi

  if [[ "$mode" == "copy" ]]; then
    cp "$source" "$destination"
    printf 'Copied: %s\n' "$destination"
  else
    ln -s "$source" "$destination"
    printf 'Linked: %s -> %s\n' "$destination" "$source"
  fi
}

for source in "$script_dir"/*.ts; do
  [[ -f "$source" ]] || continue
  install_file "$source" "$agent_dir/extensions/subagent_enhanced"
done

for source in "$script_dir"/agents/*.md; do
  [[ -f "$source" ]] || continue
  install_file "$source" "$agent_dir/agents"
done

for source in "$script_dir"/prompts/*.md; do
  [[ -f "$source" ]] || continue
  install_file "$source" "$agent_dir/prompts"
done

printf '\nInstallation complete (%s mode).\n' "$mode"
printf 'Run /reload in an active Pi session, or restart Pi.\n'
printf 'Verify with /subagents.\n'
