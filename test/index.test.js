'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { main, resolveAge, resolveTagCreatedAt } = require('../src/index')

function fakeGh (routes) {
  const calls = []
  return {
    calls,
    async get (pathname) {
      calls.push(pathname)
      const result = routes[pathname]
      if (result instanceof Error) throw result
      return result || { status: 404, body: null }
    }
  }
}

function makeTempDir () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'action-age-check-'))
}

function parseOutputs (text) {
  const outputs = {}
  const re = /^([^<\n]+)<<([^\n]+)\n([\s\S]*?)\n\2$/gm
  for (const match of text.matchAll(re)) outputs[match[1]] = match[3]
  return outputs
}

test('resolveAge prefers GitHub release published_at for tag refs', async () => {
  const gh = fakeGh({
    '/repos/actions/checkout/releases/tags/v4': {
      status: 200,
      body: { published_at: '2026-01-02T03:04:05Z' }
    }
  })

  const got = await resolveAge(gh, {
    owner: 'actions',
    repo: 'checkout',
    ref: 'v4'
  })

  assert.deepEqual(got, {
    date: '2026-01-02T03:04:05Z',
    basis: 'release'
  })
})

test('resolveAge uses commit date for SHA refs', async () => {
  const sha = '0123456789abcdef0123456789abcdef01234567'
  const gh = fakeGh({
    [`/repos/octo/demo/commits/${sha}`]: {
      status: 200,
      body: { commit: { committer: { date: '2026-01-04T00:00:00Z' } } }
    }
  })

  const got = await resolveAge(gh, {
    owner: 'octo',
    repo: 'demo',
    ref: sha
  })

  assert.deepEqual(got, {
    date: '2026-01-04T00:00:00Z',
    basis: 'commit',
    note: 'commit date is not the publish date; vulnerable to tag re-pointing'
  })
})

test('resolveAge uses annotated tagger date when release is absent', async () => {
  const gh = fakeGh({
    '/repos/octo/demo/releases/tags/v1': { status: 404, body: null },
    '/repos/octo/demo/git/ref/tags/v1': {
      status: 200,
      body: { object: { type: 'tag', sha: 'tag-object-sha' } }
    },
    '/repos/octo/demo/git/tags/tag-object-sha': {
      status: 200,
      body: {
        tagger: { date: '2026-01-02T00:00:00Z' },
        object: { sha: 'commit-sha' }
      }
    }
  })

  const got = await resolveAge(gh, {
    owner: 'octo',
    repo: 'demo',
    ref: 'v1'
  })

  assert.deepEqual(got, {
    date: '2026-01-02T00:00:00Z',
    basis: 'annotated-tag'
  })
  assert.ok(gh.calls.includes('/repos/octo/demo/events?per_page=100&page=1'))
  assert.ok(gh.calls.includes('/repos/octo/demo/git/tags/tag-object-sha'))
  assert.equal(gh.calls.some((call) => call.includes('/commits/')), false)
})

test('resolveAge dereferences annotated tags before commit fallback', async () => {
  const gh = fakeGh({
    '/repos/octo/demo/releases/tags/v1': { status: 404, body: null },
    '/repos/octo/demo/git/ref/tags/v1': {
      status: 200,
      body: { object: { type: 'tag', sha: 'tag-object-sha' } }
    },
    '/repos/octo/demo/git/tags/tag-object-sha': {
      status: 200,
      body: { object: { sha: 'commit-sha' } }
    },
    '/repos/octo/demo/commits/commit-sha': {
      status: 200,
      body: { commit: { committer: { date: '2026-01-03T00:00:00Z' } } }
    }
  })

  const got = await resolveAge(gh, {
    owner: 'octo',
    repo: 'demo',
    ref: 'v1'
  })

  assert.equal(got.date, '2026-01-03T00:00:00Z')
  assert.equal(got.basis, 'commit')
  assert.deepEqual(gh.calls, [
    '/repos/octo/demo/releases/tags/v1',
    '/repos/octo/demo/events?per_page=100&page=1',
    '/repos/octo/demo/git/ref/tags/v1',
    '/repos/octo/demo/git/tags/tag-object-sha',
    '/repos/octo/demo/commits/commit-sha'
  ])
})

test('resolveAge reports branch refs and missing refs as unresolved', async () => {
  const branchGh = fakeGh({
    '/repos/octo/demo/releases/tags/release%2Fnext': { status: 404, body: null },
    '/repos/octo/demo/git/ref/tags/release%2Fnext': { status: 404, body: null },
    '/repos/octo/demo/git/ref/heads/release%2Fnext': {
      status: 200,
      body: { object: { sha: 'branch-head' } }
    }
  })
  const missingGh = fakeGh({
    '/repos/octo/demo/releases/tags/does-not-exist': { status: 404, body: null },
    '/repos/octo/demo/git/ref/tags/does-not-exist': { status: 404, body: null },
    '/repos/octo/demo/git/ref/heads/does-not-exist': { status: 404, body: null }
  })

  assert.deepEqual(
    await resolveAge(branchGh, { owner: 'octo', repo: 'demo', ref: 'release/next' }),
    { branch: true }
  )
  assert.ok(branchGh.calls.includes('/repos/octo/demo/events?per_page=100&page=1'))

  assert.deepEqual(
    await resolveAge(missingGh, { owner: 'octo', repo: 'demo', ref: 'does-not-exist' }),
    { notFound: true }
  )
  assert.ok(missingGh.calls.includes('/repos/octo/demo/events?per_page=100&page=1'))
})

test('resolveTagCreatedAt returns server-side created_at from Events API', async () => {
  const gh = fakeGh({
    '/repos/octo/demo/events?per_page=100&page=1': {
      status: 200,
      body: [
        { type: 'PushEvent', payload: {} },
        { type: 'CreateEvent', payload: { ref_type: 'tag', ref: 'v2' }, created_at: '2026-05-01T12:00:00Z' }
      ]
    }
  })

  const got = await resolveTagCreatedAt(gh, 'octo', 'demo', 'v2')

  assert.equal(got, '2026-05-01T12:00:00Z')
})

test('resolveTagCreatedAt paginates up to 3 pages', async () => {
  const fullPage = Array.from({ length: 100 }, () => ({ type: 'PushEvent', payload: {} }))
  const gh = fakeGh({
    '/repos/octo/demo/events?per_page=100&page=1': { status: 200, body: fullPage },
    '/repos/octo/demo/events?per_page=100&page=2': { status: 200, body: fullPage },
    '/repos/octo/demo/events?per_page=100&page=3': {
      status: 200,
      body: [{ type: 'CreateEvent', payload: { ref_type: 'tag', ref: 'v3' }, created_at: '2026-04-01T00:00:00Z' }]
    }
  })

  assert.equal(await resolveTagCreatedAt(gh, 'octo', 'demo', 'v3'), '2026-04-01T00:00:00Z')
  assert.equal(gh.calls.length, 3)
})

test('resolveTagCreatedAt returns null after 3 pages without a match', async () => {
  const fullPage = Array.from({ length: 100 }, () => ({ type: 'PushEvent', payload: {} }))
  const gh = fakeGh({
    '/repos/octo/demo/events?per_page=100&page=1': { status: 200, body: fullPage },
    '/repos/octo/demo/events?per_page=100&page=2': { status: 200, body: fullPage },
    '/repos/octo/demo/events?per_page=100&page=3': { status: 200, body: fullPage }
  })

  assert.equal(await resolveTagCreatedAt(gh, 'octo', 'demo', 'v-missing'), null)
  assert.equal(gh.calls.length, 3)
})

test('resolveAge uses Events API created_at when release is absent', async () => {
  const gh = fakeGh({
    '/repos/octo/demo/releases/tags/v1': { status: 404, body: null },
    '/repos/octo/demo/events?per_page=100&page=1': {
      status: 200,
      body: [
        { type: 'PushEvent', payload: {} },
        { type: 'CreateEvent', payload: { ref_type: 'tag', ref: 'v1' }, created_at: '2026-05-10T09:00:00Z' }
      ]
    }
  })

  const got = await resolveAge(gh, { owner: 'octo', repo: 'demo', ref: 'v1' })

  assert.deepEqual(got, { date: '2026-05-10T09:00:00Z', basis: 'event' })
  assert.ok(!gh.calls.some((c) => c.includes('/git/ref/tags')))
})

test('resolveAge falls back to annotated-tag when event not in Events API history', async () => {
  const fullPage = Array.from({ length: 100 }, () => ({ type: 'PushEvent', payload: {} }))
  const gh = fakeGh({
    '/repos/octo/demo/releases/tags/v1': { status: 404, body: null },
    '/repos/octo/demo/events?per_page=100&page=1': { status: 200, body: fullPage },
    '/repos/octo/demo/events?per_page=100&page=2': { status: 200, body: fullPage },
    '/repos/octo/demo/events?per_page=100&page=3': { status: 200, body: fullPage },
    '/repos/octo/demo/git/ref/tags/v1': {
      status: 200,
      body: { object: { type: 'tag', sha: 'tag-sha' } }
    },
    '/repos/octo/demo/git/tags/tag-sha': {
      status: 200,
      body: { tagger: { date: '2025-01-01T00:00:00Z' }, object: { sha: 'commit-sha' } }
    }
  })

  const got = await resolveAge(gh, { owner: 'octo', repo: 'demo', ref: 'v1' })

  assert.deepEqual(got, { date: '2025-01-01T00:00:00Z', basis: 'annotated-tag' })
  assert.ok(gh.calls.includes('/repos/octo/demo/events?per_page=100&page=3'))
})

test('main fails when configured paths are missing or contain no workflow YAML', async () => {
  const tmp = makeTempDir()
  const emptyDir = path.join(tmp, 'empty')
  fs.mkdirSync(emptyDir)

  await assert.rejects(
    () => main({ env: { INPUT_PATHS: path.join(tmp, 'typo') }, log: () => {} }),
    /scan path not found/
  )
  await assert.rejects(
    () => main({ env: { INPUT_PATHS: emptyDir }, log: () => {} }),
    /no workflow YAML files found/
  )
})

test('main scans workflow files passed directly in paths', async () => {
  const tmp = makeTempDir()
  const workflowFile = path.join(tmp, 'ci.yml')
  fs.writeFileSync(
    workflowFile,
    ['jobs:', '  test:', '    steps:', '      - uses: octo/demo@v1'].join('\n')
  )
  const gh = fakeGh({
    '/repos/octo/demo/releases/tags/v1': {
      status: 200,
      body: { published_at: '2026-01-01T00:00:00Z' }
    }
  })

  const got = await main({
    env: {
      'INPUT_MIN-AGE': '7d',
      INPUT_PATHS: workflowFile
    },
    gh,
    log: () => {},
    nowMs: Date.parse('2026-01-10T00:00:00Z')
  })

  assert.equal(got.checked, 1)
  assert.deepEqual(got.files, [workflowFile])
  assert.equal(got.violations.length, 0)
})

test('CLI reports missing scan paths as an error and exits non-zero', () => {
  const tmp = makeTempDir()
  const missing = path.join(tmp, 'typo%path')
  const escapedMissing = path.join(tmp, 'typo%25path')
  const child = spawnSync(process.execPath, [path.join(__dirname, '..', 'src', 'index.js')], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    env: { INPUT_PATHS: missing }
  })

  assert.equal(child.status, 1)
  assert.ok(child.stdout.includes(`::error::action-age-check failed: scan path not found: ${escapedMissing}`))
  assert.equal(child.stderr, '')
})

test('CLI exits non-zero when main returns violations', () => {
  const tmp = makeTempDir()
  const workflowFile = path.join(tmp, 'ci.yml')
  fs.writeFileSync(
    workflowFile,
    ['jobs:', '  test:', '    steps:', '      - uses: octo/demo@main'].join('\n')
  )
  const child = spawnSync(process.execPath, [path.join(__dirname, '..', 'src', 'index.js')], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    env: { INPUT_PATHS: workflowFile }
  })

  assert.equal(child.status, 1)
  assert.match(child.stdout, /action-age-check: 1 violation\(s\) found/)
  assert.equal(child.stderr, '')
})

test('main writes outputs and debug logs with resolved publication dates', async () => {
  const tmp = makeTempDir()
  const workflowDir = path.join(tmp, '.github', 'workflows')
  fs.mkdirSync(workflowDir, { recursive: true })
  fs.writeFileSync(
    path.join(workflowDir, 'ci.yml'),
    ['jobs:', '  test:', '    steps:', '      - uses: octo/demo@v1'].join('\n')
  )
  const outputFile = path.join(tmp, 'output')
  const summaryFile = path.join(tmp, 'summary')
  const logs = []
  const gh = fakeGh({
    '/repos/octo/demo/releases/tags/v1': {
      status: 200,
      body: { published_at: '2026-01-01T00:00:00Z' }
    }
  })

  const got = await main({
    env: {
      'INPUT_MIN-AGE': '7d',
      INPUT_PATHS: workflowDir,
      GITHUB_OUTPUT: outputFile,
      GITHUB_STEP_SUMMARY: summaryFile
    },
    gh,
    log: (line) => logs.push(line),
    nowMs: Date.parse('2026-01-10T00:00:00Z')
  })

  assert.equal(got.checked, 1)
  assert.equal(got.exitCode, 0)
  assert.equal(got.violations.length, 0)
  assert.match(logs.join('\n'), /publication date 2026-01-01T00:00:00Z/)
  assert.match(logs.join('\n'), /basis: release, age: 9d, min-age: 7d/)
  const outputs = parseOutputs(fs.readFileSync(outputFile, 'utf8'))
  assert.equal(outputs['checked-count'], '1')
  assert.equal(outputs['violation-count'], '0')
  assert.equal(outputs.violations, '[]')
  assert.match(fs.readFileSync(summaryFile, 'utf8'), /All checked actions are old enough/)
})

test('main resolves multiple actions in parallel and isolates partial failures', async () => {
  const tmp = makeTempDir()
  const workflowFile = path.join(tmp, 'ci.yml')
  fs.writeFileSync(
    workflowFile,
    [
      'jobs:',
      '  test:',
      '    steps:',
      '      - uses: octo/good@v1',
      '      - uses: octo/bad@v2',
      '      - uses: octo/old@v3'
    ].join('\n')
  )
  const gh = fakeGh({
    '/repos/octo/good/releases/tags/v1': {
      status: 200,
      body: { published_at: '2026-01-01T00:00:00Z' }
    },
    '/repos/octo/bad/releases/tags/v2': new Error('rate limited'),
    '/repos/octo/old/releases/tags/v3': {
      status: 200,
      body: { published_at: '2026-01-08T00:00:00Z' }
    }
  })

  const got = await main({
    env: {
      'INPUT_MIN-AGE': '7d',
      INPUT_PATHS: workflowFile
    },
    gh,
    log: () => {},
    nowMs: Date.parse('2026-01-10T00:00:00Z')
  })

  assert.equal(got.checked, 3)
  assert.equal(got.violations.length, 2)
  const reasons = got.violations.map((v) => v.value)
  assert.ok(reasons.includes('octo/bad@v2'), 'API failure should be a violation')
  assert.ok(reasons.includes('octo/old@v3'), 'too-young action should be a violation')
  assert.ok(!reasons.includes('octo/good@v1'), 'old-enough action should pass')
})

test('main treats GitHub API failures as violations', async () => {
  const originalExitCode = process.exitCode
  process.exitCode = undefined
  const tmp = makeTempDir()
  const workflowDir = path.join(tmp, 'workflow%,dir')
  fs.mkdirSync(workflowDir, { recursive: true })
  const workflowFile = path.join(workflowDir, 'ci.yml')
  fs.writeFileSync(
    workflowFile,
    ['jobs:', '  test:', '    steps:', '      - uses: octo/demo@v1'].join('\n')
  )
  const outputFile = path.join(tmp, 'output')
  const logs = []
  const gh = fakeGh({
    '/repos/octo/demo/releases/tags/v1': new Error('rate% limited\nagain')
  })

  try {
    const got = await main({
      env: {
        INPUT_PATHS: workflowDir,
        GITHUB_OUTPUT: outputFile
      },
      gh,
      log: (line) => logs.push(line),
      nowMs: Date.parse('2026-01-10T00:00:00Z')
    })

    assert.equal(got.checked, 1)
    assert.equal(got.exitCode, 1)
    assert.equal(got.violations.length, 1)
    assert.match(got.violations[0].reason, /age lookup failed: rate% limited\nagain/)
    assert.equal(process.exitCode, undefined)
    assert.ok(logs.includes(
      `::error file=${path.join(tmp, 'workflow%25%2Cdir', 'ci.yml')},line=4::` +
      'octo/demo@v1: age lookup failed: rate%25 limited%0Aagain'
    ))
    const outputs = parseOutputs(fs.readFileSync(outputFile, 'utf8'))
    assert.equal(outputs['checked-count'], '1')
    assert.equal(outputs['violation-count'], '1')
    assert.deepEqual(JSON.parse(outputs.violations), [{
      file: workflowFile,
      line: 4,
      value: 'octo/demo@v1',
      reason: 'age lookup failed: rate% limited\nagain'
    }])
  } finally {
    process.exitCode = originalExitCode
  }
})
