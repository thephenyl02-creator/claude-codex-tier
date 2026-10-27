// Release check: hooks/version.ts's TIER_MOD_VERSION must equal .claude-plugin/plugin.json's version.
// The plugin test engine has no fs, so this runs under node: node scripts/check-version.mjs (exit 1 on a mismatch).
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const json = JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8')).version
const ts = /TIER_MOD_VERSION\s*=\s*'([^']+)'/.exec(readFileSync(join(root, 'hooks', 'version.ts'), 'utf8'))?.[1]
if (ts !== json) { console.error(`version mismatch: hooks/version.ts ${ts} vs plugin.json ${json}`); process.exit(1) }
console.log(`version ok: ${ts}`)
