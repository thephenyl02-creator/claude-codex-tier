# claude-tier installer (Windows PowerShell 5.1+ / pwsh)
# https://github.com/thephenyl02-creator/claude-codex-tier
#
#   irm https://raw.githubusercontent.com/thephenyl02-creator/claude-codex-tier/main/install.ps1 | iex
#
# Handles the common blockers for new users: missing Claude Code CLI and
# SSH-to-GitHub failures. If the plugin route still fails, falls back to a
# direct skill copy that needs no git.
#
# NOTE: `irm | iex` runs this in the CALLER'S session. The whole body runs
# inside `& { }` so variables/functions stay in a private scope, and every
# process-wide change (preferences, env vars) is restored in the finally.
# When run as a file (-File / .\install.ps1) a failure exits nonzero; under
# `irm | iex` it never calls exit, so the caller's session survives.

& {
    $Repo = 'thephenyl02-creator/claude-codex-tier'
    $Marketplace = 'claude-tier'
    # Raw-URL marketplace add needs no git at all (verified: the CLI
    # downloads and caches the manifest over HTTPS; update re-fetches it).
    $MarketplaceUrl = "https://raw.githubusercontent.com/$Repo/main/.claude-plugin/marketplace.json"
    $Plugin = 'tier'
    # The Tier mod (enforcement + footer button / strip / pane), from the same
    # marketplace. Optional: a failure here is a warning, never an install failure.
    $ModPlugin = 'tier-mod'
    # The mod is built against this Claude Code release (no lower bound is
    # documented by the plugin API, so older CLIs are skipped rather than risked).
    $ModMinClaude = [version]'2.1.308'
    $ModState = 'skipped'
    $PluginOk = $false
    $ZipUrl = "https://github.com/$Repo/archive/refs/heads/main.zip"
    # Marks a skills-dir copy as written by this installer, so a later
    # successful plugin install may safely replace it (and never a
    # hand-authored skill).
    $Marker = '.installed-by-claude-tier-installer'
    $Failed = $false

    function Write-Info($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
    function Write-Ok($msg)   { Write-Host "  + $msg" -ForegroundColor Green }
    function Write-Warn2($msg){ Write-Host "  ! $msg" -ForegroundColor Yellow }
    function Write-Err($msg)  { Write-Host "  x $msg" -ForegroundColor Red }

    function Find-Claude {
        # -CommandType Application: only .exe/.cmd/.bat - never a profile
        # alias, function, or .ps1 shim (a .ps1 would drag execution policy
        # into play).
        $cmd = Get-Command claude -CommandType Application -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if ($cmd -and $cmd.Source -and (Test-Path $cmd.Source)) { return $cmd.Source }
        $candidates = @(
            (Join-Path $env:USERPROFILE '.local\bin\claude.exe'),
            (Join-Path $env:USERPROFILE '.claude\local\claude.exe'),
            (Join-Path $env:APPDATA 'npm\claude.cmd')
        )
        foreach ($c in $candidates) {
            if (Test-Path $c) { return $c }
        }
        return $null
    }

    function Invoke-Claude([string]$Bin, [string[]]$CliArgs) {
        # $LASTEXITCODE survives from earlier commands when a launch fails,
        # so reset it first: a failed launch then leaves $null, which is not 0.
        $global:LASTEXITCODE = $null
        try {
            & $Bin @CliArgs *> $null
        } catch {
            return $false
        }
        return ($LASTEXITCODE -eq 0)
    }

    function Invoke-PluginRoute([string]$Bin) {
        [void](Invoke-Claude $Bin @('plugin', 'marketplace', 'add', $MarketplaceUrl))
        # Refresh + update run UNCONDITIONALLY: "already added" / "already
        # installed" both exit 0 without fetching anything, so update is the
        # only call that actually pulls a newer version on a re-run.
        [void](Invoke-Claude $Bin @('plugin', 'marketplace', 'update', $Marketplace))
        $installOk = Invoke-Claude $Bin @('plugin', 'install', "$Plugin@$Marketplace")
        # plugin update exits 1 when the plugin isn't installed, so it can't
        # mask a genuine install failure.
        $updateOk = Invoke-Claude $Bin @('plugin', 'update', "$Plugin@$Marketplace")
        return ($installOk -or $updateOk)
    }

    # Optional second plugin. Never throws and never touches the skill
    # fallback; every outcome is a message. Returns 'installed', 'failed' or 'skipped'.
    function Install-Mod([string]$Bin) {
        $ccVer = $null
        try {
            $raw = (& $Bin --version 2>$null | Select-Object -First 1)
            if ("$raw" -match '(\d+\.\d+\.\d+)') { $ccVer = [version]$Matches[1] }
        } catch {}
        if ($ccVer -and $ccVer -lt $ModMinClaude) {
            Write-Warn2 "Skipping the Tier mod: it needs Claude Code $ModMinClaude or newer (you have $ccVer)."
            Write-Warn2 "Update Claude Code, then run:  claude plugin install $ModPlugin@$Marketplace"
            return 'skipped'
        }
        $ok = Invoke-Claude $Bin @('plugin', 'install', "$ModPlugin@$Marketplace")
        if (Invoke-Claude $Bin @('plugin', 'update', "$ModPlugin@$Marketplace")) { $ok = $true }
        if ($ok) {
            Write-Ok "Plugin installed: $ModPlugin@$Marketplace (enforcement + footer button)"
            return 'installed'
        } else {
            Write-Warn2 "Could not install the Tier mod ($ModPlugin@$Marketplace). The tier skill works without it."
            Write-Warn2 "To add it later, run:  claude plugin install $ModPlugin@$Marketplace"
            return 'failed'
        }
    }

    # Snapshot every process-wide piece of state we touch; restored in finally.
    $PrevEAP = $ErrorActionPreference
    $GitEnvNames = @('GIT_TERMINAL_PROMPT', 'GIT_CONFIG_COUNT',
        'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_CONFIG_KEY_1', 'GIT_CONFIG_VALUE_1')
    $PrevGitEnv = @{}
    foreach ($n in $GitEnvNames) {
        $PrevGitEnv[$n] = [Environment]::GetEnvironmentVariable($n)
    }

    try {
        $ErrorActionPreference = 'Continue'

        # ---- 1. Find the claude CLI, installing it if missing ---------------

        $ClaudeBin = Find-Claude
        if (-not $ClaudeBin) {
            Write-Info 'Claude Code CLI not found - installing it (official installer)...'
            # Child process, not in-scope iex: the official installer sets
            # StrictMode + ErrorActionPreference=Stop and may call `exit`;
            # in a child, none of that can leak into or kill this script.
            & powershell -NoProfile -ExecutionPolicy Bypass -Command 'irm https://claude.ai/install.ps1 | iex'
            if ($LASTEXITCODE -ne 0) {
                Write-Err 'Claude Code install failed. Install it manually, then re-run this script:'
                Write-Err '  irm https://claude.ai/install.ps1 | iex'
                $Failed = $true
                return
            }
            $ClaudeBin = Find-Claude
            if (-not $ClaudeBin) {
                Write-Err 'Claude Code installed, but its binary was not found in the usual places.'
                Write-Err 'Open a NEW terminal and re-run this script.'
                $Failed = $true
                return
            }
        }
        Write-Ok "Claude Code CLI: $ClaudeBin"

        # ---- 2. Force HTTPS for GitHub during this install ------------------
        # Sidesteps every SSH failure mode (missing ~/.ssh, unknown host key,
        # no key registered with GitHub). Env-only and restored in the
        # finally below, so neither the user's git config nor their session
        # is left changed. Requires git >= 2.31 to take effect.

        $env:GIT_TERMINAL_PROMPT = '0'
        $env:GIT_CONFIG_COUNT = '2'
        $env:GIT_CONFIG_KEY_0 = 'url.https://github.com/.insteadOf'
        $env:GIT_CONFIG_VALUE_0 = 'git@github.com:'
        $env:GIT_CONFIG_KEY_1 = 'url.https://github.com/.insteadOf'
        $env:GIT_CONFIG_VALUE_1 = 'ssh://git@github.com/'

        # ---- 3. Primary route: marketplace + plugin install -----------------

        Write-Info 'Installing the tier plugin...'
        $fallbackCopy = Join-Path $env:USERPROFILE ".claude\skills\$Plugin"
        if (Invoke-PluginRoute $ClaudeBin) {
            $PluginOk = $true
            Write-Ok "Plugin installed: $Plugin@$Marketplace"
            # A previous run may have used the fallback; the plugin copy
            # supersedes it. Only remove a copy carrying our marker - never
            # a hand-authored skill. Delete the marker LAST: if a locked
            # file blocks full removal, the marker survives and a later run
            # can still recognize and finish this cleanup.
            if (Test-Path (Join-Path $fallbackCopy $Marker)) {
                Get-ChildItem -Path $fallbackCopy -Force |
                    Where-Object { $_.Name -ne $Marker } |
                    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
                $leftover = @(Get-ChildItem -Path $fallbackCopy -Force |
                    Where-Object { $_.Name -ne $Marker })
                if ($leftover.Count -gt 0) {
                    Write-Warn2 "Could not fully remove the old standalone copy at ~\.claude\skills\$Plugin (a file may be in use by a running Claude Code session)."
                    Write-Warn2 'Close Claude Code and re-run this installer, or the skill will load twice.'
                } else {
                    Remove-Item -Recurse -Force $fallbackCopy -ErrorAction SilentlyContinue
                    if (Test-Path $fallbackCopy) {
                        Write-Warn2 "Could not fully remove ~\.claude\skills\$Plugin - close Claude Code and re-run this installer."
                    } else {
                        Write-Ok "Removed the standalone fallback copy at ~\.claude\skills\$Plugin (the plugin supersedes it)"
                    }
                }
            }
        } else {
            # Route failed - but if a working plugin install already exists,
            # do not shadow it with a frozen skills-dir copy.
            $alreadyInstalled = $false
            try {
                # A plugin can be listed yet broken ("failed to load") or
                # disabled - only a healthy entry justifies skipping the
                # fallback. Find the id line, then the first Status: line
                # after it (ASCII-only matching: the CLI's bullet glyph
                # varies by codepage, the Status: field does not).
                $lines = @(& $ClaudeBin plugin list 2>$null)
                for ($i = 0; $i -lt $lines.Count; $i++) {
                    if ("$($lines[$i])" -match [regex]::Escape("$Plugin@$Marketplace")) {
                        $stop = [Math]::Min($i + 6, $lines.Count)
                        for ($j = $i + 1; $j -lt $stop; $j++) {
                            if ("$($lines[$j])" -match 'Status:') {
                                if ("$($lines[$j])" -match 'enabled') { $alreadyInstalled = $true }
                                break
                            }
                        }
                        if ($alreadyInstalled) { break }
                    }
                }
            } catch {}
            if ($alreadyInstalled) {
                $PluginOk = $true
                Write-Warn2 "Plugin route failed, but $Plugin@$Marketplace is already installed - keeping it and skipping the fallback copy."
            } else {
                # ---- 4. Fallback: direct skill copy, no git involved --------
                Write-Warn2 'Plugin route failed - falling back to a direct skill copy (no git needed).'
                $tmp = Join-Path $env:TEMP ('claude-tier-' + [System.IO.Path]::GetRandomFileName())
                $stage = 'download'
                try {
                    New-Item -ItemType Directory -Path $tmp -Force -ErrorAction Stop | Out-Null
                    $zip = Join-Path $tmp 'claude-tier.zip'
                    Invoke-WebRequest -Uri $ZipUrl -OutFile $zip -UseBasicParsing -ErrorAction Stop
                    $stage = 'extract'
                    Expand-Archive -Path $zip -DestinationPath $tmp -Force -ErrorAction Stop
                    # GitHub names the archive's top-level folder <repo>-<branch>.
                    # Locate the folder that holds the skill instead of assuming
                    # the repo name, so renaming the repository can never break
                    # this path.
                    $src = $null
                    foreach ($top in (Get-ChildItem -Path $tmp -Directory -ErrorAction Stop)) {
                        $candidate = Join-Path $top.FullName "skills\$Plugin"
                        if (Test-Path (Join-Path $candidate 'SKILL.md')) { $src = $candidate; break }
                    }
                    if (-not $src) {
                        throw "the downloaded archive did not contain skills/$Plugin - the repo layout may have changed. Please report this: https://github.com/$Repo/issues"
                    }
                    $stage = 'copy'
                    $skillsDir = Join-Path $env:USERPROFILE '.claude\skills'
                    New-Item -ItemType Directory -Path $skillsDir -Force -ErrorAction Stop | Out-Null
                    $dest = Join-Path $skillsDir $Plugin
                    if (Test-Path $dest) {
                        if (-not (Test-Path (Join-Path $dest $Marker))) {
                            # Not ours - never destroy a hand-authored skill.
                            # The backup must live OUTSIDE ~\.claude\skills,
                            # or it would still be discovered and load as a
                            # duplicate `tier` skill.
                            $bak = Join-Path $env:USERPROFILE ".claude\tier-backup.$((Get-Date).ToString('yyyyMMddHHmmss'))"
                            Move-Item -Path $dest -Destination $bak -ErrorAction Stop
                            Write-Warn2 "Existing ~\.claude\skills\$Plugin was not created by this installer - moved it to $bak"
                        } else {
                            Remove-Item -Recurse -Force $dest -ErrorAction Stop
                        }
                    }
                    Copy-Item -Recurse -Path $src -Destination $dest -ErrorAction Stop
                    if (-not (Test-Path (Join-Path $dest 'SKILL.md'))) {
                        throw 'copy verification failed - SKILL.md missing at the destination'
                    }
                    Write-Ok "Skill installed at ~\.claude\skills\$Plugin (loads as $Plugin@skills-dir)"
                    # Marker failure must not fail a verified install - warn only.
                    try {
                        New-Item -ItemType File -Path (Join-Path $dest $Marker) -Force -ErrorAction Stop | Out-Null
                    } catch {
                        Write-Warn2 "Could not write the installer marker at $dest\$Marker - a future run will treat this copy as hand-authored and move it aside instead of replacing it."
                    }
                } catch {
                    Write-Err "Fallback failed during $stage : $($_.Exception.Message)"
                    if ($stage -eq 'download') { Write-Err 'Check your network connection.' }
                    $Failed = $true
                    return
                } finally {
                    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
                }
            }
        }

        # ---- 5. Optional: the Tier mod --------------------------------------
        # Only after the skill is settled, and only when the marketplace is
        # reachable (the plugin route worked). A failure here changes nothing
        # above.

        if ($PluginOk) {
            Write-Info 'Installing the tier-mod plugin (optional)...'
            try { $ModState = Install-Mod $ClaudeBin } catch {
                Write-Warn2 "Could not install the Tier mod ($ModPlugin@$Marketplace). The tier skill works without it."
                Write-Warn2 "To add it later, run:  claude plugin install $ModPlugin@$Marketplace"
            }
        } else {
            Write-Warn2 "Skipping the Tier mod (the plugin route failed). Once it works, run:  claude plugin install $ModPlugin@$Marketplace"
        }

        Write-Host ''
        if ($ModState -eq 'installed') {
            Write-Ok 'Done! Restart Claude Code, then run /tier in a project. The Tier button appears in the footer.'
        } else {
            Write-Ok 'Done! Restart Claude Code (or start a new session), then run /tier in a project.'
        }
    } finally {
        # Leave the caller's session exactly as we found it.
        $ErrorActionPreference = $PrevEAP
        foreach ($n in $GitEnvNames) {
            if ($null -eq $PrevGitEnv[$n]) {
                Remove-Item "Env:$n" -ErrorAction SilentlyContinue
            } else {
                [Environment]::SetEnvironmentVariable($n, $PrevGitEnv[$n])
            }
        }
        # As a file (-File / .\install.ps1) report failure via exit code;
        # under `irm | iex` $PSCommandPath is empty and we must never exit
        # the caller's session.
        if ($Failed -and $PSCommandPath) { exit 1 }
    }
}
