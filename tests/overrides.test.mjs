import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { harness } from './host-harness.mjs'

// Catches resetting by writing the default number, losing the manual ratio on model/config change, or persisting auto defaults.
test('restore default removes the manual override across reload and resumes model/config tracking', async t => {
  const config = { below300KPercent: 23 }
  const h = harness(t, { models: [{ id: 'small', contextWindow: 200_000 }, { id: 'large', contextWindow: 1_000_000 }], config })
  assert.equal((await h.call('thresholds.set', { sessionId: 's1', ratio: 0.37 })).status, 200)
  h.select({ provider: 'magpie', model: 'large' })
  assert.equal((await h.call('thresholds.resolve', { sessionId: 's1' })).json.value.ratio, 0.37)
  config.above800KPercent = 61
  assert.equal((await h.call('thresholds.resolve', { sessionId: 's1' })).json.value.ratio, 0.37)
  const reset = await h.call('thresholds.reset', { sessionId: 's1' })
  assert.equal(reset.status, 200)
  assert.deepEqual(reset.json.value, { ratio: 0.61, defaultRatio: 0.61, overridden: false })
  assert.deepEqual((await h.call('thresholds.get')).json.value, {})
  h.reload()
  assert.equal((await h.call('thresholds.resolve', { sessionId: 's1' })).json.value.ratio, 0.61)
  h.select({ provider: 'magpie', model: 'small' })
  assert.equal((await h.call('thresholds.resolve', { sessionId: 's1' })).json.value.ratio, 0.23)
  assert.equal(h.compactions.length, 0)
})

// Catches treating a persisted-but-not-active session (right after a restart) as
// nonexistent: the ring must resolve, accept and reset overrides without the
// session ever being activated in this process.
test('cold sessions resolve from persistence and accept overrides before activation', async t => {
  const h = harness(t, { models: [{ id: 'small', contextWindow: 200_000 }], config: { below300KPercent: 23 } })
  h.cold.set('s-cold', { header: { id: 's-cold' }, selection: { provider: 'magpie', model: 'small' } })
  assert.deepEqual(
    (await h.call('thresholds.resolve', { sessionId: 's-cold' })).json.value,
    { ratio: 0.23, defaultRatio: 0.23, overridden: false },
  )
  assert.equal((await h.call('thresholds.set', { sessionId: 's-cold', ratio: 0.65 })).status, 200)
  assert.deepEqual((await h.call('thresholds.resolve', { sessionId: 's-cold' })).json.value, { ratio: 0.65, defaultRatio: 0.23, overridden: true })
  assert.deepEqual((await h.call('thresholds.get')).json.value, { 's-cold': 0.65 })
  const reset = await h.call('thresholds.reset', { sessionId: 's-cold' })
  assert.deepEqual(reset.json.value, { ratio: 0.23, defaultRatio: 0.23, overridden: false })
  assert.deepEqual((await h.call('thresholds.get')).json.value, {})
  // Once the host activates the session the live path takes over with the same result.
  h.sessions.set('s-cold', { id: 's-cold', requestHeader: () => undefined })
  assert.equal((await h.call('thresholds.resolve', { sessionId: 's-cold' })).json.value.ratio, 0.23)
})

// Catches modifying the accepted in-memory threshold before a durable write succeeds.
test('a failed set or reset preserves the accepted override', async t => {
  const h = harness(t)
  await h.call('thresholds.set', { sessionId: 's1', ratio: 0.37 })
  // The final rename must reject when its target is a directory; no fs mock is needed.
  const { realpathSync, rmSync } = await import('node:fs')
  const target = realpathSync(join(h.home, 'dsh-auto-compact.json'))
  assert.equal(target, join(realpathSync(h.home), 'dsh-auto-compact.json'))
  rmSync(target)
  mkdirSync(target)
  assert.equal((await h.call('thresholds.set', { sessionId: 's1', ratio: 0.65 })).status, 500)
  assert.equal((await h.call('thresholds.resolve', { sessionId: 's1' })).json.value.ratio, 0.37)
  assert.equal((await h.call('thresholds.reset', { sessionId: 's1' })).status, 500)
  assert.deepEqual((await h.call('thresholds.get')).json.value, { s1: 0.37 })
})

// Catches accepting an arbitrary client id or forged model data on mutation.
test('threshold routes reject nonexistent sessions and retain independent overrides', async t => {
  const h = harness(t)
  for (const method of ['thresholds.resolve', 'thresholds.set', 'thresholds.reset']) {
    assert.equal((await h.call(method, { sessionId: 'missing', ratio: 0.7 })).status, 400)
  }
  await h.call('thresholds.set', { sessionId: 's1', ratio: 0.37 })
  await h.call('thresholds.set', { sessionId: 's2', ratio: 0.45 })
  await h.call('thresholds.reset', { sessionId: 's1' })
  assert.deepEqual((await h.call('thresholds.get')).json.value, { s2: 0.45 })
})
