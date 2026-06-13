'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  parseMinAge,
  isSha,
  extractUses,
  parseUsesValue,
  ageInDays,
  allowMatches
} = require('../src/lib')

test('parseMinAge: days and weeks', () => {
  assert.equal(parseMinAge('1w'), 7)
  assert.equal(parseMinAge('2w'), 14)
  assert.equal(parseMinAge('1d'), 1)
  assert.equal(parseMinAge('2d'), 2)
  assert.equal(parseMinAge('7d'), 7)
  assert.equal(parseMinAge('7'), 7) // bare number = days
  assert.equal(parseMinAge('3D'), 3) // case-insensitive
  assert.equal(parseMinAge(' 2w '), 14) // trims
})

test('parseMinAge: invalid input throws', () => {
  assert.throws(() => parseMinAge('abc'))
  assert.throws(() => parseMinAge('0'))
  assert.throws(() => parseMinAge('1m'))
  assert.throws(() => parseMinAge(''))
  assert.throws(() => parseMinAge(null))
})

test('isSha', () => {
  assert.equal(isSha('de0fac2e4500dabe0009e67214ff5f5447ce83dd'), true)
  assert.equal(isSha('DE0FAC2E4500DABE0009E67214FF5F5447CE83DD'), true)
  assert.equal(isSha('v4.3.1'), false)
  assert.equal(isSha('de0fac2'), false) // short SHA rejected
})

test('extractUses: various forms with line numbers', () => {
  const yaml = [
    'jobs:',
    '  build:',
    '    steps:',
    '      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2',
    '      - name: x',
    "        uses: 'docker/setup-buildx-action@v4.1.0'",
    '      - uses: "actions/setup-node@v6.4.0"',
    '      - uses: ./local-action',
    '      - run: echo uses: not-a-real-one'
  ].join('\n')
  const got = extractUses(yaml)
  assert.deepEqual(got, [
    { value: 'actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd', line: 4 },
    { value: 'docker/setup-buildx-action@v4.1.0', line: 6 },
    { value: 'actions/setup-node@v6.4.0', line: 7 },
    { value: './local-action', line: 8 }
  ])
})

test('parseUsesValue: remote/local/docker', () => {
  assert.deepEqual(parseUsesValue('actions/checkout@abc'), {
    kind: 'remote', owner: 'actions', repo: 'checkout', subpath: '', ref: 'abc'
  })
  assert.deepEqual(parseUsesValue('owner/repo/sub/dir@v1'), {
    kind: 'remote', owner: 'owner', repo: 'repo', subpath: 'sub/dir', ref: 'v1'
  })
  assert.equal(parseUsesValue('./local').kind, 'local')
  assert.equal(parseUsesValue('docker://alpine:3').kind, 'docker')
  assert.equal(parseUsesValue('owner/repo').ref, null)
})

test('ageInDays', () => {
  const now = Date.parse('2026-01-10T00:00:00Z')
  assert.equal(ageInDays('2026-01-01T00:00:00Z', now), 9)
  assert.equal(ageInDays('2026-01-10T00:00:00Z', now), 0)
})

test('allowMatches', () => {
  const use = { owner: 'actions', repo: 'checkout', subpath: '', ref: 'abc' }
  assert.equal(allowMatches('actions/checkout', use), true)
  assert.equal(allowMatches('actions/checkout@abc', use), true)
  assert.equal(allowMatches('actions/checkout@xyz', use), false)
  assert.equal(allowMatches('actions/setup-node', use), false)
  assert.equal(allowMatches('', use), false)

  const sub = { owner: 'o', repo: 'r', subpath: 'sub', ref: 'v1' }
  assert.equal(allowMatches('o/r/sub', sub), true)
  assert.equal(allowMatches('o/r', sub), true)
})
