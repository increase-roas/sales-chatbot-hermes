// Spend guard for TS scripts and the local demo (wraps scripts/fw_guard.py; config/spend.json holds the cap and threshold).
// Not used by the production bot route: a testing budget must never stop replies to real leads.
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'fw_guard.py')
let cached: { at: number; ok: boolean; why: string } | null = null

export function spendGuard(maxAgeMs = 10 * 60_000): { ok: boolean; why: string } {
  if (process.env.FW_GUARD_OVERRIDE) return { ok: true, why: 'override' }
  if (cached && Date.now() - cached.at < maxAgeMs) return cached
  try {
    const out = execFileSync('python3', [SCRIPT], { encoding: 'utf8', timeout: 120_000 })
    cached = { at: Date.now(), ok: true, why: out.trim() }
  } catch (error) {
    const out = (error as { stdout?: string }).stdout ?? ''
    cached = { at: Date.now(), ok: false, why: out.trim() || 'fw_guard failed (fail closed)' }
  }
  return cached
}

// maxAgeMs 0 = re-read billing now (startup); call again per paid step with the default to re-check every 10 min.
export function requireSpend(maxAgeMs = 0): void {
  const g = spendGuard(maxAgeMs)
  if (!g.ok) {
    console.error(g.why)
    process.exit(2)
  }
}
