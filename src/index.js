'use strict'

const fs = require('node:fs')
const path = require('node:path')
const {
  parseMinAge,
  isSha,
  extractUses,
  parseUsesValue,
  ageInDays,
  allowMatches
} = require('./lib')

// ---- Actions I/O helpers (no @actions/core dependency) ----------------------

function getInput (name, fallback = '', env = process.env) {
  const key = `INPUT_${name.replace(/ /g, '_').toUpperCase()}`
  const v = env[key]
  return v === undefined || v === '' ? fallback : v
}

function getMultiline (name, env = process.env) {
  return getInput(name, '', env)
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function setOutput (name, value, env = process.env) {
  const f = env.GITHUB_OUTPUT
  if (!f) return
  const v = typeof value === 'string' ? value : JSON.stringify(value)
  // multiline-safe heredoc form
  const delim = `ghadelim_${name}`
  fs.appendFileSync(f, `${name}<<${delim}\n${v}\n${delim}\n`)
}

function summary (md, env = process.env) {
  const f = env.GITHUB_STEP_SUMMARY
  if (f) fs.appendFileSync(f, md + '\n')
}

function escapeCommandMessage (msg) {
  return String(msg)
    .replace(/%/g, '%25')
    .replace(/\r/g, '%0D')
    .replace(/\n/g, '%0A')
}

function debug (msg, log = console.log) {
  log(`::debug::${escapeCommandMessage(msg)}`)
}

function annotate (level, file, line, msg, log = console.log) {
  const loc = file ? ` file=${file}${line ? `,line=${line}` : ''}` : ''
  // newlines are not allowed in annotation messages
  log(`::${level}${loc}::${msg.replace(/\n/g, ' ')}`)
}

// ---- GitHub REST client (native fetch) --------------------------------------

class GitHub {
  constructor (token, options = {}) {
    this.base = options.base || process.env.GITHUB_API_URL || 'https://api.github.com'
    this.token = token
    this.fetch = options.fetch || fetch
  }

  async get (pathname) {
    const res = await this.fetch(`${this.base}${pathname}`, {
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'action-age-check',
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {})
      }
    })
    if (res.status === 404) return { status: 404, body: null }
    if (!res.ok) {
      throw new Error(`GitHub API ${res.status} for ${pathname}: ${await res.text()}`)
    }
    return { status: res.status, body: await res.json() }
  }
}

// ---- age resolution ---------------------------------------------------------

// Resolve the "publication date" of a remote use, preferring trustworthy bases.
// Returns { date, basis, note? } | { branch:true } | { notFound:true }
async function resolveAge (gh, use) {
  const { owner, repo, ref } = use

  if (isSha(ref)) {
    const c = await gh.get(`/repos/${owner}/${repo}/commits/${ref}`)
    if (c.status === 404) return { notFound: true }
    return {
      date: c.body.commit.committer.date,
      basis: 'commit',
      note: 'commit date is not the publish date; vulnerable to tag re-pointing'
    }
  }

  // 1) GitHub Release published_at (most trustworthy)
  const rel = await gh.get(`/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(ref)}`)
  if (rel.status !== 404 && rel.body && rel.body.published_at) {
    return { date: rel.body.published_at, basis: 'release' }
  }

  // 2) Annotated tag tagger.date
  const tref = await gh.get(`/repos/${owner}/${repo}/git/ref/tags/${encodeURIComponent(ref)}`)
  if (tref.status !== 404 && tref.body) {
    const obj = tref.body.object
    // commitSha is the commit the tag ultimately points at.
    // For a lightweight tag, obj.sha is already the commit SHA.
    // For an annotated tag, obj.sha is the *tag object* SHA and must be
    // dereferenced via /git/tags to reach the underlying commit SHA.
    let commitSha = obj.sha
    if (obj.type === 'tag') {
      const tag = await gh.get(`/repos/${owner}/${repo}/git/tags/${obj.sha}`)
      if (tag.body && tag.body.tagger && tag.body.tagger.date) {
        return { date: tag.body.tagger.date, basis: 'annotated-tag' }
      }
      if (tag.body && tag.body.object) commitSha = tag.body.object.sha
    }
    // 3) commit committer.date (fallback)
    const c = await gh.get(`/repos/${owner}/${repo}/commits/${commitSha}`)
    if (c.body) {
      return {
        date: c.body.commit.committer.date,
        basis: 'commit',
        note: 'tag resolved to commit date (not publish date)'
      }
    }
  }

  // branch ref -> mutable, age undefined
  const bref = await gh.get(`/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(ref)}`)
  if (bref.status !== 404) return { branch: true }

  return { notFound: true }
}

// ---- workflow file discovery ------------------------------------------------

function collectFiles (paths) {
  const files = new Set()
  const missing = []
  for (const p of paths) {
    let st
    try {
      st = fs.statSync(p)
    } catch {
      missing.push(p)
      continue
    }
    if (st.isDirectory()) {
      for (const f of walk(p)) files.add(f)
    } else if (/\.ya?ml$/i.test(p)) {
      files.add(p)
    }
  }
  return { files: [...files], missing }
}

function walk (dir) {
  const out = []
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name)
    if (ent.isDirectory()) out.push(...walk(full))
    else if (/\.ya?ml$/i.test(ent.name)) out.push(full)
  }
  return out
}

// ---- main -------------------------------------------------------------------

async function main (options = {}) {
  const env = options.env || process.env
  const log = options.log || console.log
  const minAge = parseMinAge(getInput('min-age', '1w', env))
  const paths = getMultiline('paths', env)
  const targetPaths = paths.length ? paths : ['.github/workflows']
  const allow = getMultiline('allow', env)
  const failLevel = getInput('fail-level', 'error', env) // error | warning
  const token = getInput('token', '', env) || env.GITHUB_TOKEN || ''
  const nowMs = options.nowMs || Date.now()

  const gh = options.gh || new GitHub(token, {
    base: env.GITHUB_API_URL || 'https://api.github.com',
    fetch: options.fetch
  })
  const { files, missing } = collectFiles(targetPaths)
  if (missing.length) {
    throw new Error(`scan path not found: ${missing.join(', ')}`)
  }
  if (!files.length) {
    throw new Error(`no workflow YAML files found in paths: ${targetPaths.join(', ')}`)
  }

  const violations = []
  let checked = 0

  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8')
    for (const { value, line } of extractUses(text)) {
      const use = parseUsesValue(value)
      // Only remote (owner/repo) uses have a resolvable age. Local (./) and
      // docker:// uses are out of scope and always skipped (see README).
      if (use.kind !== 'remote') continue
      if (allow.some((a) => allowMatches(a, use))) {
        debug(`detected ${value} at ${file}:${line}: skipped by allowlist`, log)
        continue
      }

      checked++

      // No ref at all = fully unpinned; age (and provenance) cannot be verified.
      if (!use.ref) {
        debug(`detected ${value} at ${file}:${line}: no publication date (unpinned)`, log)
        violations.push({ file, line, value, reason: 'unpinned (no ref; cannot determine age)' })
        continue
      }

      // Fast path: skip the API round-trips for common default-branch pins.
      // This is only an optimization; resolveAge() detects any branch ref via
      // /git/ref/heads and reports it as a violation too.
      if (!isSha(use.ref) && /^(main|master|develop|trunk)$/i.test(use.ref)) {
        debug(`detected ${value} at ${file}:${line}: no publication date (branch pin)`, log)
        violations.push({ file, line, value, reason: 'branch pin (mutable, age undefined)' })
        continue
      }

      let info
      try {
        info = await resolveAge(gh, use)
      } catch (err) {
        // fail-closed: an API error must not silently pass the check
        debug(`detected ${value} at ${file}:${line}: publication date lookup failed (${err.message})`, log)
        violations.push({ file, line, value, reason: `age lookup failed: ${err.message}` })
        continue
      }

      if (info.branch) {
        debug(`detected ${value} at ${file}:${line}: no publication date (branch pin)`, log)
        violations.push({ file, line, value, reason: 'branch pin (mutable, age undefined)' })
        continue
      }
      if (info.notFound) {
        debug(`detected ${value} at ${file}:${line}: no publication date (ref not found)`, log)
        violations.push({ file, line, value, reason: 'ref not found (cannot determine age)' })
        continue
      }

      const age = ageInDays(info.date, nowMs)
      debug(
        `detected ${value} at ${file}:${line}: publication date ${info.date} ` +
        `(basis: ${info.basis}, age: ${age}d, min-age: ${minAge}d)` +
        (info.note ? `; ${info.note}` : ''),
        log
      )
      if (age < minAge) {
        violations.push({
          file,
          line,
          value,
          age,
          basis: info.basis,
          note: info.note,
          reason: `age ${age}d < min-age ${minAge}d (${info.basis})`
        })
      }
    }
  }

  // report
  for (const v of violations) {
    const level = failLevel === 'warning' ? 'warning' : 'error'
    annotate(level, v.file, v.line, `${v.value}: ${v.reason}`, log)
  }

  const rows = violations
    .map((v) => `| \`${v.value}\` | \`${v.file}\`:${v.line} | ${v.reason} |`)
    .join('\n')
  summary(
    `## action-age-check\n\n` +
      `min-age: **${minAge}d** / checked: **${checked}** / violations: **${violations.length}**\n\n` +
      (violations.length
        ? `| uses | location | reason |\n|---|---|---|\n${rows}`
        : 'All checked actions are old enough. ✅'),
    env
  )

  setOutput('checked-count', String(checked), env)
  setOutput('violation-count', String(violations.length), env)
  setOutput('violations', violations, env)

  if (violations.length && failLevel !== 'warning') {
    log(`action-age-check: ${violations.length} violation(s) found`)
    process.exitCode = 1
  } else {
    log(`action-age-check: ${violations.length} violation(s), ${checked} checked (min-age ${minAge}d)`)
  }

  return { checked, violations, files }
}

if (require.main === module) {
  main().catch((err) => {
    console.log(`::error::action-age-check failed: ${escapeCommandMessage(err.message)}`)
    process.exitCode = 1
  })
}

module.exports = {
  GitHub,
  collectFiles,
  escapeCommandMessage,
  main,
  resolveAge
}
