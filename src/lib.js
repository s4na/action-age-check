'use strict'

// Pure, side-effect-free helpers. Network / filesystem / Actions I/O live in index.js
// so that this module stays unit-testable with `node --test`.

const SHA_RE = /^[0-9a-f]{40}$/i

/**
 * Parse a min-age input like "1w", "7d", "2", "3D" into a number of days.
 * - unit `d` (or no unit) => days
 * - unit `w` => weeks (x7)
 * Throws on invalid input (we never silently fall back to a default).
 * @param {string} input
 * @returns {number} days (> 0)
 */
function parseMinAge (input) {
  if (input == null) throw new Error('min-age is required')
  const m = String(input).trim().toLowerCase().match(/^(\d+)\s*([dw]?)$/)
  if (!m) throw new Error(`invalid min-age: "${input}" (expected e.g. 1d, 2d, 7d, 1w, 2w)`)
  const n = Number(m[1])
  if (n <= 0) throw new Error(`invalid min-age: "${input}" (must be > 0)`)
  return m[2] === 'w' ? n * 7 : n
}

/**
 * @param {string} ref
 * @returns {boolean} true if ref looks like a full 40-hex commit SHA
 */
function isSha (ref) {
  return SHA_RE.test(ref)
}

/**
 * Extract every `uses:` occurrence from a workflow YAML text.
 * Returns the raw value plus its 1-based line number for annotations.
 * Inline comments and surrounding quotes are stripped.
 * @param {string} yamlText
 * @returns {{ value: string, line: number }[]}
 */
function extractUses (yamlText) {
  const out = []
  const lines = String(yamlText).split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    // matches: `uses: x`, `- uses: x`, `uses: "x"`, `uses: 'x'`, with optional trailing comment
    const m = lines[i].match(/^\s*-?\s*uses:\s*(['"]?)([^'"#\s]+)\1\s*(?:#.*)?$/)
    if (m) out.push({ value: m[2], line: i + 1 })
  }
  return out
}

/**
 * Classify a `uses:` value.
 * @param {string} value
 * @returns {{kind:'local'}|{kind:'docker'}|{kind:'remote', owner:string, repo:string, subpath:string, ref:string|null}}
 */
function parseUsesValue (value) {
  if (value.startsWith('./') || value.startsWith('../')) return { kind: 'local' }
  if (value.startsWith('docker://')) return { kind: 'docker' }

  const at = value.lastIndexOf('@')
  const path = at === -1 ? value : value.slice(0, at)
  const ref = at === -1 ? null : value.slice(at + 1)
  const segs = path.split('/')
  const owner = segs[0] || ''
  const repo = segs[1] || ''
  const subpath = segs.slice(2).join('/')
  return { kind: 'remote', owner, repo, subpath, ref }
}

/**
 * Whole-day age between an ISO timestamp and `nowMs`.
 * @param {string} iso
 * @param {number} nowMs
 * @returns {number} age in days (floored, can be negative if clock skew)
 */
function ageInDays (iso, nowMs) {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) throw new Error(`invalid date: "${iso}"`)
  return Math.floor((nowMs - t) / 86_400_000)
}

/**
 * Does an allow entry match a parsed remote use?
 * Entry forms: "owner/repo", "owner/repo@ref", "owner/repo/sub", "owner/repo/sub@ref".
 * @param {string} entry
 * @param {{owner:string, repo:string, subpath:string, ref:string|null}} use
 * @returns {boolean}
 */
function allowMatches (entry, use) {
  const e = entry.trim()
  if (!e) return false
  const at = e.lastIndexOf('@')
  const ePath = at === -1 ? e : e.slice(0, at)
  const eRef = at === -1 ? null : e.slice(at + 1)
  const usePath = [use.owner, use.repo, use.subpath].filter(Boolean).join('/')
  const useRepo = `${use.owner}/${use.repo}`
  if (ePath !== usePath && ePath !== useRepo) return false
  if (eRef && eRef !== use.ref) return false
  return true
}

module.exports = {
  parseMinAge,
  isSha,
  extractUses,
  parseUsesValue,
  ageInDays,
  allowMatches
}
