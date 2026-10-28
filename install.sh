#!/usr/bin/env bash
# claude-tier installer (macOS / Linux)
# https://github.com/thephenyl02-creator/claude-codex-tier
#
#   curl -fsSL https://raw.githubusercontent.com/thephenyl02-creator/claude-codex-tier/main/install.sh | bash
#
# Handles the common blockers for new users: missing Claude Code CLI, PATH not
# set, unwritable shell profile, and SSH-to-GitHub failures. If the plugin
# route still fails, falls back to a direct skill copy that needs no git.

set -u

if [ -z "${HOME:-}" ]; then
  printf 'HOME is not set; re-run from a normal login shell.\n' >&2
  exit 1
fi

REPO="thephenyl02-creator/claude-codex-tier"
MARKETPLACE="claude-tier"
# Raw-URL marketplace add needs no git at all (verified: the CLI downloads
# and caches the manifest over HTTPS, and `marketplace update` re-fetches it).
MARKETPLACE_URL="https://raw.githubusercontent.com/$REPO/main/.claude-plugin/marketplace.json"
PLUGIN="tier"
# The Tier mod (enforcement + footer button / strip / pane), from the same
# marketplace. Optional: a failure here is a warning, never an install failure.
MOD_PLUGIN="tier-mod"
# The mod is built against this Claude Code release (no lower bound is
# documented by the plugin API, so older CLIs are skipped rather than risked).
MOD_MIN_CLAUDE="2.1.308"
TARBALL_URL="https://github.com/$REPO/archive/refs/heads/main.tar.gz"
# Marks a skills-dir copy as written by this installer, so a later successful
# plugin install may safely replace it (and never a hand-authored skill).
MARKER=".installed-by-claude-tier-installer"

info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m  +\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m  !\033[0m %s\n' "$*"; }
err()  { printf '\033[1;31m  x\033[0m %s\n' "$*" >&2; }

if ! command -v curl >/dev/null 2>&1; then
  err "curl is required but not found. Install curl and re-run."
  exit 1
fi

# ---- 1. Find the claude CLI, installing it if missing -----------------------

find_claude() {
  if command -v claude >/dev/null 2>&1; then
    command -v claude
    return 0
  fi
  for c in "$HOME/.local/bin/claude" "$HOME/.claude/local/claude" \
           /usr/local/bin/claude /opt/homebrew/bin/claude; do
    if [ -x "$c" ]; then
      printf '%s\n' "$c"
      return 0
    fi
  done
  return 1
}

CLAUDE_BIN="$(find_claude || true)"
if [ -z "$CLAUDE_BIN" ]; then
  info "Claude Code CLI not found - installing it (official installer)..."
  CC_TMP="$(mktemp)" || {
    err "Could not create a temporary file (check TMPDIR and free disk space)."
    exit 1
  }
  # Download and run as separate steps so a curl failure is reported as a
  # download problem, not misdiagnosed later as a missing binary.
  if ! curl -fsSL https://claude.ai/install.sh -o "$CC_TMP"; then
    rm -f "$CC_TMP"
    err "Could not download the Claude Code installer - check your network connection."
    exit 1
  fi
  if ! bash "$CC_TMP" </dev/null; then
    rm -f "$CC_TMP"
    err "Claude Code install failed. Install it manually, then re-run this script:"
    err "  curl -fsSL https://claude.ai/install.sh | bash"
    exit 1
  fi
  rm -f "$CC_TMP"
  CLAUDE_BIN="$(find_claude || true)"
  if [ -z "$CLAUDE_BIN" ]; then
    err "Claude Code installed, but its binary was not found in the usual places."
    err "Open a NEW terminal and re-run this script."
    exit 1
  fi
fi
ok "Claude Code CLI: $CLAUDE_BIN"

# ---- 2. Make `claude` work by name in future terminals ----------------------
# The script itself always uses the absolute path, so nothing below can block
# the install - this step is a best-effort convenience.

if ! command -v claude >/dev/null 2>&1; then
  BIN_DIR="$(dirname "$CLAUDE_BIN")"
  PATH_LINE="export PATH=\"$BIN_DIR:\$PATH\""
  case "${SHELL:-}" in
    */zsh)  RC="$HOME/.zshrc" ;;
    */bash) RC="$HOME/.bashrc" ;;
    *)      RC="" ;;
  esac
  if [ -n "$RC" ] && { [ -w "$RC" ] || { [ ! -e "$RC" ] && [ -w "$HOME" ]; }; }; then
    if grep -qsF "$BIN_DIR" "$RC"; then
      ok "$BIN_DIR is already in $RC (open a new terminal to pick it up)"
    elif printf '\n%s\n' "$PATH_LINE" >> "$RC"; then
      ok "Added $BIN_DIR to PATH in $RC (takes effect in new terminals)"
    else
      warn "Could not write to $RC. To use 'claude' by name, add this line to it yourself:"
      warn "  $PATH_LINE"
    fi
  else
    warn "Could not update your shell profile automatically."
    warn "To use 'claude' by name, add this line to it yourself:"
    warn "  $PATH_LINE"
    if [ -n "$RC" ] && [ -e "$RC" ] && [ ! -w "$RC" ]; then
      warn "($RC is not writable - fix with: sudo chown \$(whoami) $RC)"
    fi
  fi
fi

# ---- 3. Force HTTPS for GitHub during this install --------------------------
# Sidesteps every SSH failure mode (missing ~/.ssh, unknown host key, no key
# registered with GitHub). Env-only: affects processes started by this script,
# never the user's git config. Requires git >= 2.31 to take effect; older git
# simply ignores these and the fallback below still covers a failure.

export GIT_TERMINAL_PROMPT=0
export GIT_CONFIG_COUNT=2
export GIT_CONFIG_KEY_0="url.https://github.com/.insteadOf"
export GIT_CONFIG_VALUE_0="git@github.com:"
export GIT_CONFIG_KEY_1="url.https://github.com/.insteadOf"
export GIT_CONFIG_VALUE_1="ssh://git@github.com/"

# ---- 4. Primary route: marketplace + plugin install -------------------------
# </dev/null on every claude call: under `curl | bash` this script's stdin IS
# the script itself - a child that reads stdin would silently eat the rest of
# the script.

plugin_route() {
  "$CLAUDE_BIN" plugin marketplace add "$MARKETPLACE_URL" >/dev/null 2>&1 </dev/null || true
  # Refresh + update run UNCONDITIONALLY: "already added" / "already
  # installed" both exit 0 without fetching anything, so update is the only
  # call that actually pulls a newer version on a re-run.
  "$CLAUDE_BIN" plugin marketplace update "$MARKETPLACE" >/dev/null 2>&1 </dev/null || true
  INSTALL_OK=0
  "$CLAUDE_BIN" plugin install "$PLUGIN@$MARKETPLACE" >/dev/null 2>&1 </dev/null && INSTALL_OK=1
  UPDATE_OK=0
  "$CLAUDE_BIN" plugin update "$PLUGIN@$MARKETPLACE" >/dev/null 2>&1 </dev/null && UPDATE_OK=1
  # update exits 1 when the plugin isn't installed, so it can't mask a
  # genuine install failure.
  [ "$INSTALL_OK" -eq 1 ] || [ "$UPDATE_OK" -eq 1 ]
}

# Prints 0 when $1 >= $2 (dotted numeric versions), 1 otherwise.
version_ge() {
  _a="$1"; _b="$2"
  for _i in 1 2 3; do
    _x="$(printf '%s' "$_a" | cut -d. -f"$_i")"; _y="$(printf '%s' "$_b" | cut -d. -f"$_i")"
    _x="${_x:-0}"; _y="${_y:-0}"
    if [ "$_x" -gt "$_y" ] 2>/dev/null; then return 0; fi
    if [ "$_x" -lt "$_y" ] 2>/dev/null; then return 1; fi
  done
  return 0
}

# Optional second plugin. Never exits, never touches the skill fallback; every
# outcome is a message. Sets MOD_STATE=installed|skipped|old|failed
# (old = the terminal claude failed the version gate).
MOD_STATE="skipped"
install_mod() {
  CC_VER="$("$CLAUDE_BIN" --version </dev/null 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n 1)"
  if [ -n "$CC_VER" ] && ! version_ge "$CC_VER" "$MOD_MIN_CLAUDE"; then
    MOD_STATE="old"
    warn "Skipping the Tier mod: the terminal 'claude' on your PATH is version $CC_VER, and the mod needs $MOD_MIN_CLAUDE or newer."
    warn "Update it with:  claude update  (or reinstall), then run:  claude plugin install $MOD_PLUGIN@$MARKETPLACE"
    warn "If you use the desktop app, you can add the mod from the app's plugin menu instead."
    return 0
  fi
  M_OK=0
  "$CLAUDE_BIN" plugin install "$MOD_PLUGIN@$MARKETPLACE" >/dev/null 2>&1 </dev/null && M_OK=1
  "$CLAUDE_BIN" plugin update "$MOD_PLUGIN@$MARKETPLACE" >/dev/null 2>&1 </dev/null && M_OK=1
  if [ "$M_OK" -eq 1 ]; then
    MOD_STATE="installed"
    ok "Plugin installed: $MOD_PLUGIN@$MARKETPLACE (enforcement + footer button)"
  else
    MOD_STATE="failed"
    warn "Could not install the Tier mod ($MOD_PLUGIN@$MARKETPLACE). The tier skill works without it."
    warn "To add it later, run:  claude plugin install $MOD_PLUGIN@$MARKETPLACE"
  fi
  return 0
}

PLUGIN_OK=0
info "Installing the tier plugin..."
if plugin_route; then
  PLUGIN_OK=1
  ok "Plugin installed: $PLUGIN@$MARKETPLACE"
  # A previous run may have used the fallback; the plugin copy supersedes it.
  # Only remove a copy carrying our marker - never a hand-authored skill.
  # Contents first, marker last: if a locked file blocks full removal, the
  # marker survives and a later run can still recognize and finish this.
  FB="$HOME/.claude/skills/$PLUGIN"
  if [ -f "$FB/$MARKER" ]; then
    find "$FB" -mindepth 1 ! -name "$MARKER" -exec rm -rf {} + 2>/dev/null
    if [ -n "$(find "$FB" -mindepth 1 ! -name "$MARKER" 2>/dev/null | head -n 1)" ]; then
      warn "Could not fully remove the fallback copy at ~/.claude/skills/$PLUGIN (a file may be in use)."
      warn "Close Claude Code and re-run this installer, or the skill will load twice."
    elif rm -rf "$FB" && [ ! -e "$FB" ]; then
      ok "Removed the standalone fallback copy at ~/.claude/skills/$PLUGIN (the plugin supersedes it)"
    else
      : > "$FB/$MARKER" 2>/dev/null || true
      warn "Could not fully remove the fallback copy at ~/.claude/skills/$PLUGIN - close Claude Code and re-run this installer."
    fi
  fi
elif "$CLAUDE_BIN" plugin list </dev/null 2>/dev/null | grep -A3 -F "$PLUGIN@$MARKETPLACE" | grep -q 'enabled'; then
  # The route failed transiently, but a working plugin install already
  # exists - do not shadow it with a frozen skills-dir copy.
  PLUGIN_OK=1
  warn "Plugin route failed, but $PLUGIN@$MARKETPLACE is already installed - keeping it and skipping the fallback copy."
else
  # ---- 5. Fallback: direct skill copy, no git involved at all ---------------
  warn "Plugin route failed - falling back to a direct skill copy (no git needed)."
  TMP="$(mktemp -d)" || {
    err "Could not create a temporary directory (check TMPDIR and free disk space)."
    exit 1
  }
  trap 'rm -rf "$TMP"' EXIT
  if ! curl -fsSL "$TARBALL_URL" -o "$TMP/src.tar.gz"; then
    err "Could not download $TARBALL_URL - check your network connection."
    exit 1
  fi
  if ! tar -xzf "$TMP/src.tar.gz" -C "$TMP"; then
    err "Could not extract the downloaded archive."
    exit 1
  fi
  # GitHub names the archive's top-level folder <repo>-<branch>. Locate the
  # folder that holds the skill instead of assuming the repo name, so renaming
  # the repository can never break this path.
  SRC="$TMP/.not-found/skills/$PLUGIN"
  for d in "$TMP"/*/; do
    if [ -f "${d}skills/$PLUGIN/SKILL.md" ]; then
      SRC="${d}skills/$PLUGIN"
      break
    fi
  done
  if [ ! -f "$SRC/SKILL.md" ]; then
    err "The downloaded archive did not contain skills/$PLUGIN - the repo layout may have changed."
    err "Please report this: https://github.com/$REPO/issues"
    exit 1
  fi
  if ! mkdir -p "$HOME/.claude/skills"; then
    err "Could not create ~/.claude/skills."
    exit 1
  fi
  DEST="$HOME/.claude/skills/$PLUGIN"
  if [ -e "$DEST" ] && [ ! -f "$DEST/$MARKER" ]; then
    # Not ours - never destroy a hand-authored skill; move it aside instead.
    # The backup must live OUTSIDE ~/.claude/skills, or it would still be
    # discovered and load as a duplicate `tier` skill.
    BAK="$HOME/.claude/tier-backup.$(date +%s)"
    if mv "$DEST" "$BAK"; then
      warn "Existing $DEST was not created by this installer - moved it to $BAK"
    else
      err "Could not move the existing $DEST aside. Move it manually and re-run."
      exit 1
    fi
  elif [ -e "$DEST" ] && ! rm -rf "$DEST"; then
    err "Could not remove the existing $DEST (a file may be in use). Close Claude Code and re-run."
    exit 1
  fi
  if cp -R "$SRC" "$DEST" && [ -f "$DEST/SKILL.md" ]; then
    ok "Skill installed at ~/.claude/skills/$PLUGIN (loads as $PLUGIN@skills-dir)"
    if ! : > "$DEST/$MARKER"; then
      warn "Could not write the installer marker at $DEST/$MARKER - a future run will treat this copy as hand-authored and move it aside instead of replacing it."
    fi
  else
    err "Could not copy the skill into ~/.claude/skills (verification failed)."
    exit 1
  fi
fi

if [ "$PLUGIN_OK" -eq 1 ]; then
  info "Installing the tier-mod plugin (optional)..."
  install_mod || true
else
  warn "Skipping the Tier mod (the plugin route failed). Once it works, run:  claude plugin install $MOD_PLUGIN@$MARKETPLACE"
fi

printf '\n'
if [ "$MOD_STATE" = "installed" ]; then
  ok "Done! Restart Claude Code, then run /tier in a project. The Tier button appears in the footer."
elif [ "$MOD_STATE" = "old" ] || [ "$MOD_STATE" = "skipped" ]; then
  ok "Done! The Tier mod was skipped (see above). Restart Claude Code (or start a new session), then run /tier in a project."
else
  ok "Done! Restart Claude Code (or start a new session), then run /tier in a project."
fi
