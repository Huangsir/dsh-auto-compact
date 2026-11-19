import { test } from 'node:test'
import assert from 'node:assert/strict'
import { harness } from './host-harness.mjs'
import { clientHarness, configScope } from './client-harness.mjs'

// Catches bypassing staged settings, accepting fractional/range-invalid percentages, or treating failed Save as success.
test('configuration card stages 1–99 percentages with Save, Discard, Reset and honest save failures', async t => {
  const host = harness(t)
  const scope = configScope({ below300KPercent: 37 })
  const ui = await clientHarness(t, { host, scope })
  assert.equal(await ui.configPage(), true)
  const input = ui.container.querySelector('#ac-config-below300KPercent')
  const button = label => [...ui.container.querySelectorAll('button')].find(item => item.textContent === label)
  assert.ok(input)
  for (const label of ['模型最大 Context 小于 300K', '模型最大 Context 大于 800K', '其余情况']) assert.ok(ui.container.textContent.includes(label))
  await ui.input(input, '23')
  assert.equal(scope.getSnapshot().value.below300KPercent, 37)
  await ui.click(button('Discard'))
  assert.equal(input.value, '37')
  for (const invalid of ['0', '100', '23.5']) {
    await ui.input(input, invalid)
    assert.equal(button('Save').disabled, true)
    assert.equal(input.getAttribute('aria-invalid'), 'true')
  }
  for (const valid of ['1', '99', '23']) {
    await ui.input(input, valid)
    assert.equal(button('Save').disabled, false)
  }
  scope.fail(true)
  await ui.click(button('Save'))
  assert.equal(scope.getSnapshot().value.below300KPercent, 37)
  assert.equal(input.value, '23')
  assert.ok(ui.container.textContent.includes('保存失败'))
  scope.fail(false)
  await ui.click(button('Save'))
  assert.equal(scope.getSnapshot().value.below300KPercent, 23)
  assert.equal(input.value, '23')
  await ui.click(button('Reset'))
  assert.equal(input.value, '80')
  assert.equal(scope.getSnapshot().value.below300KPercent, 23)
  await ui.click(button('Save'))
  assert.equal(Object.hasOwn(scope.getSnapshot().user, 'below300KPercent'), false)
  assert.equal(scope.getSnapshot().value.below300KPercent, 80)
})

// Catches a late write from the previous session invalidating the current session's pending read.
test('a previous session pending write cannot invalidate the newly selected session read', async t => {
  const host = harness(t)
  await host.call('thresholds.set', { sessionId: 's2', ratio: 0.37 })
  let releaseWrite, releaseRead, markWrite, markRead
  const writeStarted = new Promise(resolve => { markWrite = resolve })
  const readStarted = new Promise(resolve => { markRead = resolve })
  const writeGate = new Promise(resolve => { releaseWrite = resolve })
  const readGate = new Promise(resolve => { releaseRead = resolve })
  const ui = await clientHarness(t, { host, fetchResponse: async (method, body) => {
    if (method === 'thresholds.set' && body.sessionId === 's1') { markWrite(); await writeGate }
    if (method === 'thresholds.resolve' && body.sessionId === 's2') { markRead(); await readGate }
    const result = await host.call(method, body)
    return new Response(JSON.stringify(result.json), { status: result.status })
  } })
  await ui.render(); await ui.settle(); await ui.click(ui.container.querySelector('.ac-trigger'))
  await ui.input(ui.container.querySelector('input'), '65')
  await writeStarted
  await ui.session('s2')
  await readStarted
  releaseWrite(); await ui.settle()
  releaseRead(); await ui.settle()
  assert.equal(ui.container.querySelector('.ac-trigger').getAttribute('aria-label'), '自动压缩阈值 37%')
  await ui.click(ui.container.querySelector('.ac-trigger'))
  assert.equal(ui.container.querySelector('input').disabled, false)
})

// Catches a superseded read-back failure polluting the newer successful read with a stale save error.
test('a superseded read-back failure cannot pollute the newer successful state', async t => {
  const host = harness(t, { models: [{ id: 'small', contextWindow: 200_000 }, { id: 'large', contextWindow: 900_000 }], config: { below300KPercent: 23 } })
  let setSeen = false, readbackGated = false
  let releaseReadback, markReadback
  const readbackStarted = new Promise(resolve => { markReadback = resolve })
  const gate = new Promise(resolve => { releaseReadback = resolve })
  const ui = await clientHarness(t, { host, fetchResponse: async (method, body) => {
    if (method === 'thresholds.set' && body.sessionId === 's1') setSeen = true
    if (method === 'thresholds.resolve' && body.sessionId === 's1' && setSeen && !readbackGated) {
      readbackGated = true
      markReadback()
      await gate
      return new Response(JSON.stringify({ ok: false }), { status: 500 })
    }
    const result = await host.call(method, body)
    return new Response(JSON.stringify(result.json), { status: result.status })
  } })
  await ui.render(); await ui.settle(); await ui.click(ui.container.querySelector('.ac-trigger'))
  await ui.input(ui.container.querySelector('input'), '65')
  await readbackStarted
  await ui.model({ provider: 'magpie', model: 'large' })
  await ui.settle()
  releaseReadback(); await ui.settle()
  assert.equal(ui.container.querySelector('strong').textContent, '65%')
  assert.equal(Boolean(ui.container.querySelector('[role="status"]')), false)
  assert.equal((await host.call('thresholds.resolve', { sessionId: 's1' })).json.value.ratio, 0.65)
})

// Catches the saving state disabling the slider mid-drag, which ends a real
// pointer drag (focus loss) after a single 5% step, and drops the final position.
test('dragging stays interactive while a write is in flight and persists the final position', async t => {
  const host = harness(t, { models: [{ id: 'small', contextWindow: 200_000 }] })
  let releaseWrite, markWrite
  const writeStarted = new Promise(resolve => { markWrite = resolve })
  const gate = new Promise(resolve => { releaseWrite = resolve })
  const ratios = []
  const ui = await clientHarness(t, { host, fetchResponse: async (method, body) => {
    if (method === 'thresholds.set') { ratios.push(body.ratio); markWrite(); await gate }
    const result = await host.call(method, body)
    return new Response(JSON.stringify(result.json), { status: result.status })
  } })
  await ui.render(); await ui.settle(); await ui.click(ui.container.querySelector('.ac-trigger'))
  const input = ui.container.querySelector('input[type="range"]')
  input.focus()
  await ui.input(input, '20')
  await writeStarted
  assert.equal(input.disabled, false)
  await ui.input(input, '40')
  releaseWrite(); await ui.settle()
  assert.deepEqual(ratios, [0.2, 0.4])
  assert.equal((await host.call('thresholds.resolve', { sessionId: 's1' })).json.value.ratio, 0.4)
  assert.equal(ui.container.querySelector('strong').textContent, '40%')
  assert.equal(ui.dom.window.document.activeElement, input)
})

// Catches an overlay stealing the underlying click or closing on panel whitespace.
test('outside clicks close the panel and still activate underlying controls; inside blank space stays open', async t => {
  const host = harness(t)
  const ui = await clientHarness(t, { host })
  await ui.render(); await ui.settle()
  await ui.click(ui.container.querySelector('.ac-trigger'))
  const panel = ui.container.querySelector('[role="dialog"]')
  assert.ok(panel)
  await ui.click(panel)
  assert.ok(ui.container.querySelector('[role="dialog"]'))
  let activated = 0
  const underlying = ui.dom.window.document.querySelector('#underlying')
  underlying.addEventListener('click', () => activated++)
  await ui.click(underlying)
  assert.equal(activated, 1)
  assert.equal(Boolean(ui.container.querySelector('[role="dialog"]')), false)
})

// Catches rewriting a historical non-step threshold on mount, or snapping before a user gesture.
test('range uses 10–90 step 5 while displaying 23 and preserves 37 until dragged; restore removes override', async t => {
  const host = harness(t, { models: [{ id: 'small', contextWindow: 200_000 }], config: { below300KPercent: 23 } })
  await host.call('thresholds.set', { sessionId: 's1', ratio: 0.37 })
  const ui = await clientHarness(t, { host })
  await ui.render(); await ui.settle(); await ui.click(ui.container.querySelector('.ac-trigger'))
  const input = ui.container.querySelector('input[type="range"]')
  assert.equal(input.min, '10'); assert.equal(input.max, '90'); assert.equal(input.step, '5')
  assert.equal(ui.container.querySelector('strong').textContent, '37%')
  assert.equal((await host.call('thresholds.resolve', { sessionId: 's1' })).json.value.ratio, 0.37)
  const reset = [...ui.container.querySelectorAll('button')].find(button => button.textContent === '恢复默认')
  assert.ok(reset)
  await ui.click(reset)
  assert.equal(ui.container.querySelector('strong').textContent, '23%')
  assert.deepEqual((await host.call('thresholds.get')).json.value, {})
  await ui.input(input, '25')
  assert.equal(ui.container.querySelector('strong').textContent, '25%')
  assert.equal((await host.call('thresholds.resolve', { sessionId: 's1' })).json.value.ratio, 0.25)
})

// Catches falsely showing a failed save/reset as accepted.
test('failed slider writes and restore keep the accepted ratio and show an error', async t => {
  const host = harness(t, { config: { otherPercent: 23 } })
  await host.call('thresholds.set', { sessionId: 's1', ratio: 0.37 })
  const ui = await clientHarness(t, { host, fetchResponse: async (method, body) => {
    if (method === 'thresholds.set' || method === 'thresholds.reset') return new Response(JSON.stringify({ ok: false }), { status: 500 })
    const value = await host.call(method, body)
    return new Response(JSON.stringify(value.json), { status: value.status })
  } })
  await ui.render(); await ui.settle(); await ui.click(ui.container.querySelector('.ac-trigger'))
  await ui.input(ui.container.querySelector('input'), '65')
  assert.equal(ui.container.querySelector('strong').textContent, '37%')
  assert.ok(ui.container.querySelector('[role="status"]'))
  const reset = [...ui.container.querySelectorAll('button')].find(button => button.textContent === '恢复默认')
  assert.ok(reset)
  await ui.click(reset)
  assert.equal(ui.container.querySelector('strong').textContent, '37%')
  assert.equal((await host.call('thresholds.resolve', { sessionId: 's1' })).json.value.ratio, 0.37)
})

// Catches the startup read treating a persisted-but-not-active session as invalid,
// which left the ring at its zero-arc "loading" state until the panel was opened.
test('a restored session shows its effective ring before opening the panel', async t => {
  const host = harness(t, { models: [{ id: 'small', contextWindow: 200_000 }], config: { below300KPercent: 23 } })
  // Right after a restart the session exists only in persistence, not in memory.
  host.sessions.delete('s1')
  host.cold.set('s1', { header: { id: 's1' }, selection: { provider: 'magpie', model: 'small' } })
  const ui = await clientHarness(t, { host })
  await ui.render(); await ui.settle()
  const trigger = ui.container.querySelector('.ac-trigger')
  // A zero-length arc with round caps is the tiny dot the user reported.
  assert.notEqual(trigger.getAttribute('aria-label'), '自动压缩阈值加载中')
  assert.equal(trigger.getAttribute('aria-label'), '自动压缩阈值 23%')
  assert.equal(ui.container.querySelector('.ac-arc').getAttribute('stroke-dasharray'), '9.39 40.84')
  // Opening the panel (and after the host activates the session) stays consistent.
  await ui.click(trigger)
  assert.equal(ui.container.querySelector('strong').textContent, '23%')
  assert.equal(ui.container.querySelector('input').disabled, false)
})

// Catches a single failed startup read leaving the ring at its zero-arc "loading"
// state until the user switches session or model: the read retries on its own.
test('a failed startup read retries and shows the value without switching session or model', async t => {
  const host = harness(t, { models: [{ id: 'small', contextWindow: 200_000 }], config: { below300KPercent: 23 } })
  let resolveCalls = 0
  const ui = await clientHarness(t, { host, fetchResponse: async (method, body) => {
    if (method === 'thresholds.resolve') {
      resolveCalls++
      if (resolveCalls === 1) return new Response(JSON.stringify({ ok: false }), { status: 500 })
    }
    const result = await host.call(method, body)
    return new Response(JSON.stringify(result.json), { status: result.status })
  } })
  await ui.render(); await ui.settle()
  assert.equal(ui.container.querySelector('.ac-trigger').getAttribute('aria-label'), '自动压缩阈值加载中')
  await ui.wait(500)
  assert.equal(resolveCalls, 2)
  assert.equal(ui.container.querySelector('.ac-trigger').getAttribute('aria-label'), '自动压缩阈值 23%')
  assert.equal(ui.container.querySelector('.ac-arc').getAttribute('stroke-dasharray'), '9.39 40.84')
})

// Catches a retry scheduled for the previous session landing after the switch and
// overwriting the newly selected session's value.
test('a pending retry from the previous session cannot outlive the switch', async t => {
  const host = harness(t, { models: [{ id: 'small', contextWindow: 200_000 }], config: { below300KPercent: 23 } })
  await host.call('thresholds.set', { sessionId: 's2', ratio: 0.37 })
  let firstSessionReads = 0
  const ui = await clientHarness(t, { host, fetchResponse: async (method, body) => {
    if (method === 'thresholds.resolve' && body.sessionId === 's1') {
      firstSessionReads++
      return new Response(JSON.stringify({ ok: false }), { status: 500 })
    }
    const result = await host.call(method, body)
    return new Response(JSON.stringify(result.json), { status: result.status })
  } })
  await ui.render(); await ui.settle()
  assert.equal(ui.container.querySelector('.ac-trigger').getAttribute('aria-label'), '自动压缩阈值加载中')
  await ui.session('s2')
  assert.equal(ui.container.querySelector('.ac-trigger').getAttribute('aria-label'), '自动压缩阈值 37%')
  await ui.wait(600)
  assert.equal(firstSessionReads, 1)
  assert.equal(ui.container.querySelector('.ac-trigger').getAttribute('aria-label'), '自动压缩阈值 37%')
})

// Catches displaying only persisted overrides or retaining the previous session's component state.
test('ring shows the server effective default and changes immediately with model/session selection', async t => {
  const host = harness(t, { models: [{ id: 'small', contextWindow: 200_000 }, { id: 'large', contextWindow: 900_000 }], config: { below300KPercent: 23 } })
  await host.call('thresholds.set', { sessionId: 's2', ratio: 0.37 })
  const ui = await clientHarness(t, { host })
  await ui.render(); await ui.settle()
  assert.equal(ui.container.querySelector('button').getAttribute('aria-label'), '自动压缩阈值 23%')
  host.select({ provider: 'magpie', model: 'large' })
  await ui.model({ provider: 'magpie', model: 'large' })
  assert.equal(ui.container.querySelector('button').getAttribute('aria-label'), '自动压缩阈值 30%')
  await ui.session('s2')
  assert.equal(ui.container.querySelector('button').getAttribute('aria-label'), '自动压缩阈值 37%')
  await ui.session('s1')
  assert.equal(ui.container.querySelector('button').getAttribute('aria-label'), '自动压缩阈值 30%')
})
