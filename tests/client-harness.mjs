import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'
import clsx from 'clsx'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'

const require = createRequire(import.meta.url)
const source = readFileSync(require.resolve('@deepseek-ai/dsh-client-ui-primitives'), 'utf8')
// Execute the installed official components/model without loading unrelated markdown/highlighter modules.
// CSS-module names are presentation only; the React controls and staging model remain unmodified.
function region(name) {
  const start = source.indexOf('//#region lib/types/' + name)
  if (start < 0) throw new Error('official UI region missing: ' + name)
  return source.slice(start, source.indexOf('//#endregion', start))
}
const css = new Proxy({}, { get: (_, name) => String(name) })
// The official bundle renames its CSS-module bindings between lines
// (css$24 in 0.2.0-rc.2, css$25/26 in 0.2.1-alpha.2); bind every name the
// extracted regions actually reference so both versions run unchanged.
const regions = region('Tag.js') + region('settings-form/SettingsForm.js') + region('settings-form/fields.js') + region('settings-form/form-model.js')
const sandbox = { ...React, jsx, jsxs, clsx, createSnapshotStore }
for (const name of new Set(regions.matchAll(/css\$\d+/g).map(match => match[0]))) sandbox[name] = css
const primitives = vm.runInNewContext(regions + '\n({ SettingsFormModel, SettingsForm, SettingsValueField, settingsNumberField })', sandbox)

export function configScope(initial = {}) {
  const base = { below300KPercent: 80, above800KPercent: 30, otherPercent: 50 }
  let user = { ...initial }, revision = 1, fail = false
  const listeners = new Set()
  let snapshot
  const publish = () => {
    snapshot = { status: 'ready', writable: true, revision, base, user, value: { ...base, ...user } }
    for (const listener of listeners) listener()
  }
  publish()
  return {
    snapshot: () => snapshot,
    observe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    getSnapshot() { return this.snapshot() },
    subscribe(listener) { return this.observe(listener) },
    fail: value => { fail = value },
    async mutate(ops, expected) {
      if (fail || expected !== revision) return false
      const next = { ...user }
      for (const op of ops) {
        if (op.op === 'unset') delete next[op.path[0]]
        else next[op.path[0]] = op.value
      }
      user = next; revision++; publish(); return true
    },
  }
}

export async function clientHarness(t, { host, scope = configScope(), fetchResponse } = {}) {
  const dom = new JSDOM('<!doctype html><html><head></head><body><main></main><button id="underlying">底层按钮</button></body></html>', { url: 'http://localhost:3080' })
  const previous = new Map()
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  }
  const { createRoot } = await import('react-dom/client')
  const registrations = [], disposers = []
  const slots = {
    inject: (_, register) => { const off = register(); if (typeof off === 'function') disposers.push(off); return off },
    register: (options, component) => { registrations.push({ options, component }); return () => {} },
  }
  const fetch = async (url, options) => {
    const method = url.split('/').at(-1), body = JSON.parse(options.body)
    if (fetchResponse) return fetchResponse(method, body)
    const response = await host.call(method, body)
    return new Response(JSON.stringify(response.json), { status: response.status, headers: { 'content-type': 'application/json' } })
  }
  let plugin
  dom.window.__ModuleLoader__ = { load: entry => {
    plugin = entry.factory(name => {
      if (name === 'react') return React
      if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives
      throw new Error('unexpected client dependency: ' + name)
    })
  } }
  vm.runInNewContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), { window: dom.window, document: dom.window.document, fetch, console, AbortController, setTimeout, clearTimeout })
  plugin.apply({ slots, get: name => name === 'slots' ? slots : name === 'configForms' ? { get: () => scope } : undefined, configForms: { get: () => scope }, effect: fn => { const off = fn(); if (typeof off === 'function') disposers.push(off) } })
  const container = dom.window.document.querySelector('main')
  const root = createRoot(container)
  const projectionListeners = new Set()
  let projection = { modelSelection: { next: { provider: 'magpie', model: 'small' }, lastUsed: null }, contextPressure: { contextWindow: 1_000_000, projectedTokens: 600_000 } }
  let props = { sessionId: 's1', useProjection: name => React.useSyncExternalStore(listener => { projectionListeners.add(listener); return () => projectionListeners.delete(listener) }, () => projection[name]) }
  const render = async () => {
    const component = registrations.find(entry => entry.options.name === 'conversation.input.right')?.component
    await act(async () => { root.render(React.createElement(component, props)) })
  }
  const settle = async () => { await act(async () => { await new Promise(resolve => setImmediate(resolve)) }) }
  // Real-timer wait inside act so work scheduled by the component (read retries) runs
  // without React's "update outside act" warnings.
  const wait = async ms => { await act(async () => { await new Promise(resolve => setTimeout(resolve, ms)) }) }
  t.after(async () => {
    await act(async () => root.unmount())
    for (const dispose of disposers.reverse()) dispose()
    dom.window.close()
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
    }
  })
  return {
    dom, scope, registrations, container, render, settle, wait,
    async click(element) { await act(async () => { element.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true })); element.click() }); await settle() },
    async input(element, value) {
      await act(async () => {
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(element, value)
        element.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
        element.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
      })
      await settle()
    },
    async session(id) { props = { ...props, sessionId: id }; await render(); await settle() },
    async model(next) {
      projection = { ...projection, modelSelection: { next, lastUsed: null } }
      await act(async () => { for (const listener of projectionListeners) listener() }); await settle()
    },
    async configPage() {
      const entry = registrations.find(row => row.options.name === 'plugins.bundle.config')
      if (!entry) return false
      const face = entry.options.inject()
      const store = face.hooks.compactSettings
      const useCompactSettings = selector => selector(React.useSyncExternalStore(store.subscribe, store.getSnapshot))
      await act(async () => root.render(React.createElement(entry.component, { view: 'page', ...face, useCompactSettings })))
      return true
    },
  }
}
