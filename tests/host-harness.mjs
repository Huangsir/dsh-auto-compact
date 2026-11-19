import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { stringify } from 'yaml'
import { apply } from '../lib/index.js'

// Host services are the external boundary; profile and threshold files stay real.
export function harness(t, { models = [], config = {}, selection, profile = true, profileEnv = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ac-behavior-'))
  const env = ['DSH_HOME', 'DSH_PROFILE_DIR', 'DSH_PROFILE']
  const previous = env.map(key => [key, process.env[key]])
  process.env.DSH_HOME = home
  process.env.DSH_PROFILE = 'test-profile'
  const profileDir = join(home, 'profiles', 'test-profile')
  if (profileEnv) process.env.DSH_PROFILE_DIR = profileDir
  else delete process.env.DSH_PROFILE_DIR
  t.after(async () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    // Only delete the exact temporary directory created by this helper.
    const { realpathSync, rmSync } = await import('node:fs')
    const resolved = realpathSync(home)
    if (!resolved.startsWith(join(realpathSync(tmpdir()), 'ac-behavior-'))) throw new Error('unexpected temporary path')
    rmSync(resolved, { recursive: true, force: true })
  })
  const writeProfile = document => {
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(join(profileDir, 'cordis.patch.yml'), typeof document === 'string' ? document : stringify(document))
  }
  if (profile) writeProfile([{ id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config: { providers: { magpie: { apiKey: 'secret-not-for-client', models } } } }])
  let selected = selection ?? { provider: 'magpie', model: models[0]?.id ?? 'unknown/model' }
  const session = { id: 's1', requestHeader: () => ({ config: { provider: 'magpie', model: 'stale/model' } }) }
  const sessions = new Map([['s1', session], ['s2', { id: 's2', requestHeader: () => undefined }]])
  // Persisted sessions that are not live in this process (e.g. right after a restart).
  // Value: { header, selection } — the projection block the query service would hydrate.
  const cold = new Map()
  const routes = [], hooks = new Map(), agentHooks = new Map(), compactions = [], presentations = []
  let pressure = { contextWindow: 1_000_000, projectedTokens: 600_000 }
  let tokens = 600_000
  const agent = { id: 'a1', session, options: { provider: 'stale', model: 'stale' }, ctx: { on(event, listener) { agentHooks.set(event, listener); return () => {} } } }
  const services = {
    webServer: { register(route) { routes.push(route); return () => {} } },
    sessions: { get: id => sessions.get(id) },
    sessionQuery: {
      async observeSession(sessionId, options = {}) {
        const record = cold.get(sessionId)
        if (!record) {
          const error = new Error(`session "${sessionId}" not found`)
          error.code = 'SESSION_QUERY_SESSION_NOT_FOUND'
          throw error
        }
        return {
          source: 'prepared',
          header: record.header,
          projections: { values: { modelSelection: { next: record.selection ?? null, lastUsed: null } } },
          [Symbol.dispose]() {},
        }
      },
    },
    agents: { list: () => [agent] },
    agentDefaultModel: { currentSelection: () => selected },
    sessionProjections: { snapshot: () => ({ values: { modelSelection: { next: selected, lastUsed: { provider: 'magpie', model: 'stale/model' } }, contextPressure: pressure } }) },
    tokenMeter: { measure: () => ({ totalTokens: tokens }) },
    agentPresets: { serviceFor: () => ({ async compactIfNeeded(received, reason, signal) { compactions.push({ sessionId: received.session.id, reason, aborted: signal.aborted }); return null } }) },
    timer: { interval: () => () => {} },
    settings: { configure: value => { presentations.push(value); return () => {} } },
  }
  // The plugin's declared inject list: a loaded cordis fiber exposes exactly these
  // services as context properties.
  const DECLARED = ['webServer', 'agents', 'agentPresets', 'tokenMeter', 'sessionProjections', 'sessions', 'agentDefaultModel', 'settings', 'timer']
  // Cordis refuses property access to a service the fiber did not declare
  // ("cannot get property ... without inject") — reading one that way throws instead
  // of yielding undefined, so `ctx.sessionQuery ?? ctx.get(...)` never reaches `ctx.get`.
  // Child fibers from ctx.inject(deps, callback) do get their declared services.
  const contextFor = names => {
    const context = {
      effect: fn => { fn(); return () => {} },
      on(event, listener) { hooks.set(event, listener); return () => {} },
      fiber: {},
      get: name => services[name],
      inject: (deps, callback) => {
        const ready = deps.filter(name => name in services)
        if (ready.length === deps.length) callback(contextFor(ready))
        return { dispose() {} }
      },
    }
    for (const name of names) context[name] = services[name]
    return new Proxy(context, {
      get(target, prop, receiver) {
        if (typeof prop === 'symbol' || Reflect.has(target, prop)) return Reflect.get(target, prop, receiver)
        if (prop in services) throw new Error('cannot get property "' + String(prop) + '" without inject')
        return undefined
      },
    })
  }
  const context = contextFor(DECLARED)
  const mount = () => { apply(context, config); return routes.at(-1) }
  let route = mount()
  return {
    home, profileDir, writeProfile, config, context, session, sessions, cold, compactions, presentations,
    select: value => { selected = value },
    usage: (value, window) => { tokens = value; pressure = { contextWindow: window, projectedTokens: value } },
    reload: () => { route = mount() },
    async call(method, body = {}) {
      const req = Readable.from([JSON.stringify(body)])
      req.method = 'POST'; req.url = '/dsh-auto-compact/api/' + method; req.headers = { host: '127.0.0.1:3080' }
      let status, raw
      await route.handler(req, { writeHead: value => { status = value }, end: value => { raw = value } })
      return { status, json: JSON.parse(raw) }
    },
    async preStep() { return hooks.get('agent/pre-step')({ agent, signal: new AbortController().signal }, () => 'continued') },
    async stop() { return agentHooks.get('agent/turn-stopping')({ signal: new AbortController().signal }) },
  }
}
