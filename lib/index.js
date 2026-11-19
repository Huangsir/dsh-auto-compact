// Auto Compact Threshold — host half (formal public plugin)
// 会话级自动压缩：回合中每步之前 + 回合结束都检查用量，超过会话阈值时自动 compact。
//
// 阈值持久化：DSH 0.1.7-alpha.2 移除了 ctx.settings 的 register/get 命名空间 API
// （settings.yaml 也一并移除），这里改用插件自己的 JSON 文件，路径与 DSH 的 home
// 解析一致（$DSH_HOME 或 ~/.dsh）。client 仍走自定义 webServer 路由读写，前端契约不变。
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { parse } from 'yaml'
import z from '@deepseek-ai/schemastery'

export const Config = z.object({
  below300KPercent: z.number().step(1).min(1).max(99).default(80).volatile(),
  above800KPercent: z.number().step(1).min(1).max(99).default(30).volatile(),
  otherPercent: z.number().step(1).min(1).max(99).default(50).volatile(),
})

export const name = 'dsh-auto-compact'
// webServer 必须声明在 inject 里：0.1.7 起 apply 在未声明依赖就绪前就会运行，
// 用 ctx.get('webServer') 会拿到 undefined，路由会静默地不注册。
export const inject = ['webServer', 'agents', 'agentPresets', 'tokenMeter', 'sessionProjections', 'sessions', 'agentDefaultModel', 'settings', 'timer']

/** GUI hosts load plugins without exporting profile env vars. The one profile
 *  whose manifest declares this plugin is the profile running it; ambiguity or
 *  none keeps the fallback tier instead of guessing. */
function declaringProfileDirectory(home) {
  try {
    const matches = []
    for (const entry of readdirSync(join(home, 'profiles'), { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'node_modules') continue
      try {
        const manifest = JSON.parse(readFileSync(join(home, 'profiles', entry.name, 'package.json'), 'utf8'))
        if (manifest && typeof manifest === 'object' && Object.hasOwn(manifest.dependencies ?? {}, 'dsh-auto-compact')) matches.push(join(home, 'profiles', entry.name))
      } catch { /* an unreadable manifest cannot identify its profile */ }
    }
    return matches.length === 1 ? matches[0] : null
  } catch { return null }
}

/** Read only explicit capacity declarations; unfamiliar patch operations fail to the other tier. */
function profileContextWindow(selection) {
  if (!selection || typeof selection.provider !== 'string' || typeof selection.model !== 'string') return null
  const explicit = process.env.DSH_PROFILE_DIR?.trim()
  const profile = process.env.DSH_PROFILE?.trim()
  const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  const directory = explicit
    || (profile && !profile.includes('/') && !profile.includes('\\') && profile !== '.' && profile !== '..' ? join(home, 'profiles', profile) : null)
    || declaringProfileDirectory(home)
  if (!directory || !isAbsolute(directory)) return null
  try {
    const document = parse(readFileSync(join(directory, 'cordis.patch.yml'), 'utf8'), {
      customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: text => ({ __jsExpr: text }) }],
    })
    const rows = Array.isArray(document) ? document : document?.patch
    if (!Array.isArray(rows)) return null
    let config, disabled = false, explicitRow = false
    for (const patch of rows) {
      if (!patch || typeof patch !== 'object') return null
      let row = patch
      if (patch.insert !== undefined) {
        if (!Array.isArray(patch.insert)) return null
        const matches = patch.insert.filter(entry => entry?.id === 'llm-pi-ai')
        if (!matches.length) continue
        // Group insertion and duplicate mounts cannot be resolved from this explicit row alone.
        if (patch.id || matches.length !== 1 || explicitRow) return null
        row = matches[0]
      }
      if (row.id !== 'llm-pi-ai') continue
      if (row.name && row.name !== '@deepseek-ai/dsh-llm-pi-ai') continue
      // A second explicit mount (top-level duplicate, or top-level after insert) is
      // ambiguous — group insertion would mount both — so fall back to the other tier.
      if (explicitRow) return null
      explicitRow = true
      // Official include patches replace top-level config as a whole, never deep-merge it.
      if (Object.hasOwn(row, 'config')) config = row.config
      if (Object.hasOwn(row, 'disabled')) disabled = row.disabled
    }
    if (!explicitRow || disabled !== false) return null
    const models = config?.providers?.[selection.provider]?.models
    if (!Array.isArray(models)) return null
    const modelMatches = models.filter(model => model?.id === selection.model)
    const value = modelMatches.length === 1 ? modelMatches[0].contextWindow : null
    return Number.isSafeInteger(value) && value > 0 ? value : null
  } catch { return null }
}

/** Parse a persisted store document, keeping only sane ratios in (0, 1]. */
export function readThresholds(raw) {
  const out = {}
  let parsed
  try { parsed = JSON.parse(raw) } catch (error) { return out }
  const source = parsed && typeof parsed === 'object' && parsed.thresholds && typeof parsed.thresholds === 'object'
    ? parsed.thresholds
    : {}
  for (const key of Object.keys(source)) {
    const value = Number(source[key])
    if (Number.isFinite(value) && value > 0 && value <= 1) out[key] = value
  }
  return out
}

/** DSH home resolution: $DSH_HOME when set, otherwise ~/.dsh. */
function resolveStorePath() {
  const configured = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  return join(configured !== '' ? configured : join(homedir(), '.dsh'), 'dsh-auto-compact.json')
}

export function apply(ctx, config = {}) {
  const log = (...args) => console.log('[ac]', ...args)
  const logErr = (...args) => console.error('[ac]', ...args)

  const disposers = []
  if (ctx.settings && typeof ctx.settings.configure === 'function') {
    ctx.effect(() => ctx.settings.configure({ auto: false }, ctx.fiber))
  }

  // ---- 1. 阈值存储（插件自己的 JSON 文件，跨重启持久） ----
  const storeFile = resolveStorePath()
  let thresholds = {}
  try {
    thresholds = readThresholds(readFileSync(storeFile, 'utf8'))
  } catch (error) {
    if (!error || error.code !== 'ENOENT') {
      logErr('threshold store load failed', error && error.message ? error.message : String(error))
    }
  }

  const persist = (nextThresholds) => {
    try {
      mkdirSync(dirname(storeFile), { recursive: true })
      const tmp = storeFile + '.tmp-' + process.pid
      writeFileSync(tmp, JSON.stringify({ thresholds: nextThresholds }, null, 2) + '\n', { mode: 0o600 })
      renameSync(tmp, storeFile)
      return true
    } catch (error) {
      logErr('threshold store write failed', error && error.message ? error.message : String(error))
      return false
    }
  }

  const selectionFor = (session) => {
    try {
      const next = ctx.sessionProjections.snapshot(session)?.values?.modelSelection?.next
      if (next) return next
    } catch { /* fall through to the durable request header */ }
    try {
      const config = session.requestHeader()?.config
      if (config) return config
    } catch { /* fresh sessions use the live host default */ }
    try { return ctx.agentDefaultModel.currentSelection() } catch { return null }
  }
  const configuredPercent = (field, fallback) => {
    try {
      const ref = config[field]
      const value = ref && typeof ref.get === 'function' ? ref.get() : ref
      return Number.isInteger(value) && value >= 1 && value <= 99 ? value : fallback
    } catch { return fallback }
  }
  const defaultRatioFor = (selection) => {
    const contextWindow = profileContextWindow(selection)
    return (contextWindow !== null && contextWindow < 300000
      ? configuredPercent('below300KPercent', 80)
      : contextWindow !== null && contextWindow > 800000
        ? configuredPercent('above800KPercent', 30)
        : configuredPercent('otherPercent', 50)) / 100
  }
  const thresholdFor = (sessionId, selection) => {
    const defaultRatio = defaultRatioFor(selection)
    const overridden = Object.hasOwn(thresholds, sessionId)
    return { ratio: overridden ? thresholds[sessionId] : defaultRatio, defaultRatio, overridden }
  }
  const effectiveThreshold = (session) => thresholdFor(session.id, selectionFor(session))
  /** 冷会话（重启后尚未激活的持久化会话）的模型选择：只读投影，回退宿主默认。 */
  const observedSelection = (observation) => {
    try {
      const next = observation?.projections?.values?.modelSelection?.next
      if (next) return next
    } catch { /* fall through to the host default */ }
    try { return ctx.agentDefaultModel.currentSelection() } catch { return null }
  }
  // 只读会话查询服务（冷会话解析用）。cordis 只把 inject 声明的服务暴露成 ctx 属性：
  // 未声明的名字做 ctx.sessionQuery 会抛 "cannot get property ... without inject"，
  // 所以同一个 try 里的 `ctx.sessionQuery ?? ctx.get(...)` 永远走不到兜底分支，冷路径
  // 会一直拿到 null（重启后圆环停在加载态、切会话/切模型才恢复正是这个原因）。
  // 这里按 DSH 官方对可选服务的写法用子 fiber 声明：服务缺席时子 fiber 保持 pending，
  // 本插件照常加载；服务就绪后回调把实现挂上来，服务消失时子 fiber effect 清掉绑定。
  let sessionQuery = null
  try {
    if (typeof ctx.inject === 'function') {
      const fiber = ctx.inject(['sessionQuery'], (child) => {
        const service = child.sessionQuery
        if (!service || typeof service.observeSession !== 'function') return
        sessionQuery = service
        child.effect(() => () => { if (sessionQuery === service) sessionQuery = null })
      })
      if (fiber && typeof fiber.dispose === 'function') ctx.effect(() => () => fiber.dispose())
    }
  } catch (error) {
    logErr('sessionQuery binding unavailable', error && error.message ? error.message : String(error))
  }
  /** 当前可用的会话查询服务：优先 inject 绑定，其次 ctx.get（不需要 inject 的读取）。 */
  const sessionQueryOf = () => {
    if (sessionQuery) return sessionQuery
    try {
      const service = typeof ctx.get === 'function' ? ctx.get('sessionQuery', false) : null
      return service && typeof service.observeSession === 'function' ? service : null
    } catch { return null }
  }
  /** 只读观察一个持久化但尚未进入内存的会话；不存在或查询不可用时返回 null。 */
  const coldObservation = async (sessionId) => {
    const query = sessionQueryOf()
    if (!query) return null
    try {
      const observation = await query.observeSession(sessionId, { projectionMode: 'all' })
      if (observation?.header?.id !== sessionId) {
        observation?.[Symbol.dispose]?.()
        return null
      }
      return observation
    } catch { return null }
  }

  // ---- 2. client 配置通道：自定义 webServer 路由 ----
  // DSH 的 api.settings 只对官方硬编码白名单开放，第三方插件的 namespace 无法
  // 通过它读写；这里注册自己的 HTTP 路由，host 侧直接读写上面的阈值存储。
  const webServer = ctx.webServer ?? ctx.get('webServer')
  if (webServer && typeof webServer.register === 'function') {
    try {
      const isTrusted = (request) => {
        try {
          const host = request.headers && request.headers.host
          if (typeof host !== 'string' || host === '') return false
          const hostUrl = new URL('http://' + host)
          const hostname = hostUrl.hostname
          const loopback = hostname === 'localhost' || hostname === '[::1]' ||
            (hostname.split('.').length === 4 && hostname.split('.')[0] === '127' &&
              hostname.split('.').every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255))
          if (!loopback) return false
          if (request.headers['sec-fetch-site'] === 'cross-site') return false
          const origin = request.headers.origin
          if (origin === undefined) return true
          return new URL(origin).host === hostUrl.host
        } catch (e) { return false }
      }
      const readBody = (req) => new Promise((resolve, reject) => {
        let data = ''
        req.setEncoding('utf8')
        req.on('data', (chunk) => { data += chunk; if (data.length > 65536) { reject(new Error('body too large')); req.destroy() } })
        req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}) } catch (e) { reject(e) } })
        req.on('error', reject)
      })
      const writeJson = (res, status, obj) => {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(obj))
      }
      const off = webServer.register({
        kind: 'prefix',
        path: '/dsh-auto-compact/api',
        handler: async (req, res) => {
          if (!isTrusted(req)) return writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
          if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } })
          let method = ''
          try { method = new URL(req.url || '/', 'http://dsh.internal').pathname.slice('/dsh-auto-compact/api/'.length) } catch (e) { method = '' }
          if (!method || method.includes('/')) return writeJson(res, 404, { ok: false, error: { code: 'not-found', message: 'unknown method' } })
          try {
            if (method === 'thresholds.get') {
              return writeJson(res, 200, { ok: true, value: thresholds })
            }
            if (method === 'thresholds.resolve') {
              const payload = await readBody(req)
              const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : ''
              const live = sessionId ? ctx.sessions.get(sessionId) : null
              if (live) return writeJson(res, 200, { ok: true, value: effectiveThreshold(live) })
              // 重启后旧会话尚未激活：经只读会话查询取持久化投影，不把会话拉进内存。
              const observation = sessionId ? await coldObservation(sessionId) : null
              if (!observation) return writeJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'invalid sessionId' } })
              try {
                return writeJson(res, 200, { ok: true, value: thresholdFor(sessionId, observedSelection(observation)) })
              } finally { observation[Symbol.dispose]?.() }
            }
            if (method === 'thresholds.set' || method === 'thresholds.reset') {
              const payload = await readBody(req)
              const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : ''
              const ratio = Number(payload?.ratio)
              if (!sessionId || (method === 'thresholds.set' && !(Number.isFinite(ratio) && ratio > 0 && ratio <= 1))) return writeJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'invalid sessionId or ratio' } })
              // 会话必须真实存在（live 或持久化），但允许尚未激活时写入 override。
              const live = ctx.sessions.get(sessionId)
              const observation = live ? null : await coldObservation(sessionId)
              if (!live && !observation) return writeJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'invalid sessionId' } })
              const nextThresholds = { ...thresholds }
              if (method === 'thresholds.reset') delete nextThresholds[sessionId]
              else Object.defineProperty(nextThresholds, sessionId, { value: ratio, enumerable: true, writable: true, configurable: true })
              if (!persist(nextThresholds)) return writeJson(res, 500, { ok: false, error: { code: 'rejected', message: 'failed to persist thresholds' } })
              thresholds = nextThresholds
              if (method === 'thresholds.set') return writeJson(res, 200, { ok: true, value: thresholds })
              const nowLive = ctx.sessions.get(sessionId)
              const value = nowLive
                ? effectiveThreshold(nowLive)
                : thresholdFor(sessionId, observedSelection(observation))
              observation?.[Symbol.dispose]?.()
              return writeJson(res, 200, { ok: true, value })
            }
            return writeJson(res, 404, { ok: false, error: { code: 'not-found', message: 'unknown method' } })
          } catch (error) {
            return writeJson(res, 500, { ok: false, error: { code: 'rejected', message: error && error.message ? error.message : String(error) } })
          }
        }
      })
      if (typeof off === 'function') disposers.push(off)
      log('web route registered /dsh-auto-compact/api')
    } catch (error) {
      logErr('web route register failed', error && error.message ? error.message : String(error))
    }
  } else {
    logErr('webServer service unavailable; threshold API disabled')
  }

  // ---- 3. 阈值 / 用量读取 ----
  const readRatio = (session) => effectiveThreshold(session).ratio
  const contextWindowOf = (session) => {
    try {
      const snap = ctx.sessionProjections.snapshot(session)
      const cp = snap && snap.values ? snap.values.contextPressure : null
      if (cp && typeof cp.contextWindow === 'number' && cp.contextWindow > 0) return cp.contextWindow
    } catch (e) { /* ignore */ }
    return null
  }
  const measureUsage = (session) => {
    try {
      const m = ctx.tokenMeter.measure(session)
      const window = contextWindowOf(session)
      return { total: m.totalTokens, window, percent: window && window > 0 ? m.totalTokens / window : null }
    } catch (e) { return null }
  }

  // ---- 4. 压缩检查（压缩摘要注入上下文，回合自然结束，不发送继续消息） ----
  const maybeCompact = async (agent, signal) => {
    if (!agent || !agent.session) return
    const session = agent.session
    const sessionId = session.id
    const ratio = readRatio(session)
    if (!(ratio > 0) || ratio >= 1) return
    if (!signal || signal.aborted) return
    const engine = ctx.agentPresets.serviceFor(agent, 'compaction')
    if (!engine || typeof engine.compactIfNeeded !== 'function') return
    const usage = measureUsage(session)
    if (!usage || !usage.window || !usage.percent) return
    log('check ' + sessionId + ': ratio=' + ratio + ' percent=' + Math.round(usage.percent * 100) + '% total=' + usage.total + ' window=' + usage.window)
    if (usage.percent <= ratio) return
    try {
      const result = await engine.compactIfNeeded(agent, 'context-overflow', signal)
      log('compact ' + sessionId + ': ' + (result ? 'ok summarySeq=' + result.summarySeq + ' shadowed=' + result.shadowedRange.start + '-' + result.shadowedRange.end : 'no-op'))
    } catch (error) {
      logErr('compact ' + sessionId + ' error:', error && error.message ? error.message : String(error))
    }
  }

  // ---- 5. 回合中途：每步之前也检查（waterfall 前置压缩，压完继续这一步） ----
  try {
    const offPre = ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
      if (!signal || signal.aborted) return next()
      try {
        await maybeCompact(agent, signal)
      } catch (error) {
        logErr('pre-step check error', error && error.message ? error.message : String(error))
      }
      return next()
    })
    if (typeof offPre === 'function') disposers.push(offPre)
    log('pre-step hook registered')
  } catch (error) {
    logErr('pre-step hook failed', error && error.message ? error.message : String(error))
  }

  // ---- 6. 挂接所有 agent ----
  const hooked = new Set()
  const hookAgent = (agent) => {
    if (!agent || !agent.ctx || hooked.has(agent)) return
    hooked.add(agent)
    try {
      const off = agent.ctx.on('agent/turn-stopping', (payload) => {
        const signal = payload && payload.signal
        log('turn-stopping: ' + agent.id)
        try {
          return maybeCompact(agent, signal)
        } catch (error) {
          logErr('listener error', error && error.message ? error.message : String(error))
        }
      })
      disposers.push(off)
      log('hooked: ' + agent.id)
    } catch (error) {
      logErr('hook failed', agent.id, error && error.message ? error.message : String(error))
    }
  }
  const scan = () => {
    try {
      for (const agent of ctx.agents.list()) hookAgent(agent)
    } catch (e) { /* ignore */ }
  }

  // ---- 7. 初始扫描 + 定时补挂 ----
  scan()
  try {
    disposers.push(ctx.timer.interval(scan, 3000))
  } catch (e) { /* ignore */ }

  // ---- 8. 清理 ----
  ctx.effect(() => () => {
    for (const dispose of disposers) {
      try { dispose() } catch (e) { /* ignore */ }
    }
    disposers.length = 0
    hooked.clear()
  })
}
