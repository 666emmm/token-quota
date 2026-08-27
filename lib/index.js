/**
 * dsh-token-quota 宿主插件。
 *
 * 单一 Loader 行(见 cordis.patch.yml)挂载本模块,职责:
 *  1. 打开 / 维护账本 ($DSH_HOME/storages/token-quota/ledger.json);
 *  2. 包裹 llm/stream 瀑布,捕获每次模型调用的 usage 块并按模型计入当日账本;
 *  3. 注册 tokenQuotaCurrent 会话投影(当前模型 + 本会话按模型用量);
 *  4. 提供 tokenQuota 服务(账本快照、模型列表、配置修改、历史清除)。
 *
 * 不导入 cordis/dsh-* 运行时包中的 Service/Context 类:仅用 ctx API 与
 * Node 内建能力,因此与宿主进程共享同一套运行时实例。
 */

import { z } from 'zod'
import { AsyncLocalStorage } from 'node:async_hooks'
import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { Ledger, localDayKey, totalTokens, quotaLevel } from './store.js'

export const name = 'token-quota'

// ── llm/stream 计费包裹(嵌套去重,同 cost-meter 原理) ────────────────────

const llmStreamDepth = new AsyncLocalStorage()

/**
 * 创建 llm/stream 计数监听器。
 * @param {object} deps
 * @param {(buckets: object, model: string, sessionId: string, atMs: number, provider: string) => void} deps.account
 * @returns {(options: object, next: () => AsyncIterable) => AsyncIterable}
 */
function createStreamAccountant({ account }) {
  return (options, next) => {
    const downstream = next()
    if (llmStreamDepth.getStore() !== undefined) return downstream
    return (async function* tokenQuotaStream() {
      let usage = null
      const iterator = downstream[Symbol.asyncIterator]()
      try {
        for (;;) {
          const result = await llmStreamDepth.run(1, () => iterator.next())
          if (result.done) break
          const chunk = result.value
          if (chunk !== null && chunk !== undefined && chunk.type === 'usage' && chunk.usage !== undefined) {
            usage = chunk.usage
          }
          yield chunk
        }
      } finally {
        if (usage !== null) {
          try {
            account(
              {
                input: usage.inputTokens ?? 0,
                output: usage.outputTokens ?? 0,
                cacheRead: usage.cacheReadTokens ?? 0,
                cacheWrite: usage.cacheWriteTokens ?? 0,
                reasoning: usage.reasoningTokens ?? 0,
              },
              options?.model,
              options?.sessionId,
              Date.now(),
              options?.provider,
            )
          } catch (error) {
            console.warn(`[dsh-token-quota] 记账失败: ${String(error)}`)
          }
        }
      }
    })()
  }
}

// ── Session Projection ──────────────────────────────────────────────────────

const projectionStateSchema = z.object({
  provider: z.string(),
  model: z.string(),
  key: z.string(), // provider:model
  totals: z.object({
    input: z.number(),
    output: z.number(),
    cacheRead: z.number(),
    cacheWrite: z.number(),
    reasoning: z.number(),
    calls: z.number(),
  }),
  byModel: z.record(z.string(), z.object({
    input: z.number(),
    output: z.number(),
    cacheRead: z.number(),
    cacheWrite: z.number(),
    reasoning: z.number(),
    calls: z.number(),
  })),
  createdAt: z.number(),
})

const projectionViewSchema = z.object({
  provider: z.string(),
  model: z.string(),
  key: z.string(),
  totals: z.object({
    input: z.number(),
    output: z.number(),
    cacheRead: z.number(),
    cacheWrite: z.number(),
    reasoning: z.number(),
    calls: z.number(),
  }),
  byModel: z.record(z.string(), z.object({
    input: z.number(),
    output: z.number(),
    cacheRead: z.number(),
    cacheWrite: z.number(),
    reasoning: z.number(),
    calls: z.number(),
  })),
})

function zeroBuckets() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, calls: 0 }
}

function projectionView(state) {
  return {
    provider: state.provider,
    model: state.model,
    key: state.key,
    totals: state.totals,
    byModel: state.byModel,
  }
}

/**
 * tokenQuotaCurrent 会话投影工厂。
 * - 追踪当前模型(最近一次 request/header 或 usage 块携带的 model/provider)。
 * - 本会话内按模型累计 token(不依赖账本,事件回放也能重建)。
 */
function makeProjection() {
  const key = 'tokenQuotaCurrent'
  return {
    key,
    schema: projectionViewSchema,
    stateSchema: projectionStateSchema,
    stateVersion: 1,
    init: () => ({
      provider: 'unknown',
      model: 'unknown',
      key: 'unknown:unknown',
      totals: zeroBuckets(),
      byModel: {},
      createdAt: 0,
    }),
    apply(state, event) {
      if (event.type === 'session') {
        const created = Number(event.createdAt)
        if (!Number.isFinite(created) || created <= 0 || created === state.createdAt) return state
        return { ...state, createdAt: created }
      }
      // fork 种子事件(fork 把父会话整段拷贝到子会话):时间 < createdAt 的跳过。
      const eventMs = Number(event.time)
      const isSeed = state.createdAt > 0 && Number.isFinite(eventMs) && eventMs > 0 && eventMs < state.createdAt

      // request/header 事件更新当前模型(切换模型时立即反映)。
      if (event.type === 'request/header') {
        const model = event.data?.header?.config?.model
        const provider = event.data?.header?.config?.provider
        const nextModel = typeof model === 'string' && model.length > 0 ? model : state.model
        const nextProvider = typeof provider === 'string' && provider.length > 0 ? provider : state.provider
        const nextKey = `${nextProvider}:${nextModel}`
        if (nextModel === state.model && nextProvider === state.provider) return state
        return { ...state, model: nextModel, provider: nextProvider, key: nextKey }
      }

      if (isSeed) return state

      let usage = null
      let turn = 0
      let step = 0
      if (event.type === 'assistant/chunk' && event.data?.chunk?.type === 'usage' && event.data.chunk.usage !== undefined) {
        usage = event.data.chunk.usage
        turn = event.data.turn
        step = event.data.step
      } else if (event.type === 'assistant/message' && event.data?.usage !== undefined) {
        usage = event.data.usage
        turn = event.data.turn
        step = event.data.step
      } else {
        return state
      }

      const buckets = {
        input: usage.inputTokens ?? 0,
        output: usage.outputTokens ?? 0,
        cacheRead: usage.cacheReadTokens ?? 0,
        cacheWrite: usage.cacheWriteTokens ?? 0,
        reasoning: usage.reasoningTokens ?? 0,
      }
      const key = `${turn}:${step}`
      const last = state._last && state._last.key === key ? state._last : null
      if (last && last.key === key
          && last.provider === state.provider && last.model === state.model
          && last.buckets.input === buckets.input
          && last.buckets.output === buckets.output
          && last.buckets.cacheRead === buckets.cacheRead
          && last.buckets.cacheWrite === buckets.cacheWrite
          && last.buckets.reasoning === buckets.reasoning) {
        return state
      }

      const totals = { ...state.totals }
      const byModel = { ...state.byModel }
      const shift = (provider, model, bk, sign) => {
        totals.input += sign * bk.input
        totals.output += sign * bk.output
        totals.cacheRead += sign * bk.cacheRead
        totals.cacheWrite += sign * bk.cacheWrite
        totals.reasoning += sign * bk.reasoning
        totals.calls += sign * 1
        const mk = `${provider}:${model}`
        const cur = byModel[mk] ?? zeroBuckets()
        byModel[mk] = {
          input: cur.input + sign * bk.input,
          output: cur.output + sign * bk.output,
          cacheRead: cur.cacheRead + sign * bk.cacheRead,
          cacheWrite: cur.cacheWrite + sign * bk.cacheWrite,
          reasoning: cur.reasoning + sign * bk.reasoning,
          calls: cur.calls + sign,
        }
      }
      if (last) shift(last.provider, last.model, last.buckets, -1)
      shift(state.provider, state.model, buckets, 1)
      return {
        ...state,
        totals,
        byModel,
        createdAt: state.createdAt,
        _last: { key, provider: state.provider, model: state.model, buckets },
      }
    },
    view: projectionView,
    wire: {
      viewSchema: projectionViewSchema,
      view: projectionView,
    },
  }
}

// ── 服务 ────────────────────────────────────────────────────────────────────

/**
 * 从 settings 读取所有已配置模型。三道来源,后一道兜底前一道:
 *   1. settings.describe() 枚举全部注册的 llm-* 命名空间;
 *   2. settings.get('llm-xxx') 显式读取已知命名空间;
 *   3. 直接解析 $DSH_HOME/settings.yaml 文件(js-yaml),保证一定能拿到。
 * 兼容两种段结构:扁平 { models: [...] } 与嵌套 { providers: { pid: { models } } }。
 *
 * provider 名以 llm 服务注册的真实路由为准(listProviders()),
 * 因为 llm/stream 事件里 options.provider 就是该路由 key(如 deepseek-official、db)。
 */
function readModelsFromSettings(ctx) {
  const settings = ctx.get?.('settings')
  const out = []
  const seen = new Set()

  // 真实注册路由:provider 显示名/段名 → 路由 key。
  // 例如 llm-deepseek 段注册为 deepseek-official,llm-pi-ai 的 providers dict key 本身就是路由。
  const registeredRoutes = new Set()
  const routeByName = new Map() // name 小写 → id,如 'deepseek' → 'deepseek-official'
  try {
    const llm = ctx.get?.('llm')
    if (llm && typeof llm.listProviders === 'function') {
      for (const p of llm.listProviders()) {
        if (p && typeof p.id === 'string' && p.id.length > 0) {
          registeredRoutes.add(p.id)
          if (typeof p.name === 'string' && p.name.length > 0) {
            routeByName.set(p.name.toLowerCase(), p.id)
          }
        }
      }
    }
  } catch {
    // llm 服务不可用时忽略。
  }
  const routeOf = (candidate) => {
    if (!candidate) return undefined
    if (registeredRoutes.has(candidate)) return candidate
    return routeByName.get(String(candidate).toLowerCase())
  }

  const addModels = (providerId, models) => {
    if (!Array.isArray(models)) return
    for (const m of models) {
      if (!m || typeof m !== 'object' || !m.id) continue
      const key = `${providerId}:${m.id}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({
        provider: providerId,
        model: m.id,
        key,
        name: m.name || m.id,
      })
    }
  }

  const handleSection = (ns, section) => {
    if (!section || typeof section !== 'object') return
    if (Array.isArray(section.models)) {
      // 扁平结构:provider 优先用注册路由(段名 → 路由),否则用 section.provider ?? 段名。
      const flatProvider = routeOf(section.provider)
        ?? routeOf(ns.slice(4))
        ?? (section.provider || ns.slice(4))
      addModels(flatProvider, section.models)
    }
    if (section.providers && typeof section.providers === 'object') {
      for (const [pid, cfg] of Object.entries(section.providers)) {
        if (cfg && typeof cfg === 'object') {
          // 嵌套结构:dict key 通常就是路由(如 db),但以注册路由为准。
          const nestedProvider = routeOf(cfg.provider)
            ?? routeOf(pid)
            ?? (cfg.provider || pid)
          addModels(nestedProvider, cfg.models)
        }
      }
    }
  }

  // 来源 1:describe() 枚举所有 llm-* 命名空间。
  if (settings && typeof settings.describe === 'function') {
    try {
      const descriptors = settings.describe()
      for (const d of descriptors) {
        if (!d.ns || !String(d.ns).startsWith('llm-')) continue
        handleSection(d.ns, d.value)
      }
    } catch (err) {
      console.warn('[dsh-token-quota] settings.describe() 失败,回退显式读取:', err?.message)
    }
  }

  // 来源 2:显式读取已知命名空间。
  if (settings && typeof settings.get === 'function') {
    for (const ns of ['llm-deepseek', 'llm-pi-ai']) {
      try {
        handleSection(ns, settings.get(ns))
      } catch (err) {
        console.warn(`[dsh-token-quota] settings.get('${ns}') 失败:`, err?.message)
      }
    }
  }

  // 来源 3:直接解析 settings.yaml 文件(最强兜底,settings 服务异常也能读到)。
  try {
    const { readFileSync, existsSync } = fs
    const { join } = path
    const home = resolveDshHome()
    const settingsFile = join(home, 'settings.yaml')
    if (existsSync(settingsFile)) {
      const doc = yaml.load(readFileSync(settingsFile, 'utf-8'))
      if (doc && typeof doc === 'object') {
        for (const [ns, section] of Object.entries(doc)) {
          if (!ns.startsWith('llm-')) continue
          handleSection(ns, section)
        }
      }
    }
  } catch (err) {
    console.warn('[dsh-token-quota] settings.yaml 文件解析失败:', err?.message)
  }

  return out
}

/** 组装服务端状态快照:今日用量 + 模型列表 + 配置 + 元数据。 */
function buildState(ledger, ctx) {
  const dayKey = localDayKey()
  const today = ledger.today()
  const models = readModelsFromSettings(ctx)
  // 诊断:首次调用时输出一次模型发现结果。
  if (!buildState._logged) {
    buildState._logged = true
    console.log(`[dsh-token-quota] 模型发现:${models.length} 个 →`, models.map(m => m.name).join(', '))
  }
  // 合并账本中今日出现的模型(可能 settings 里没显式配置)
  const seen = new Set(models.map(m => m.key))
  for (const key of Object.keys(today)) {
    if (!seen.has(key)) {
      const [provider, ...rest] = key.split(':')
      const model = rest.join(':')
      models.push({ provider, model, key, name: model })
      seen.add(key)
    }
  }
  return {
    dayKey,
    now: Date.now(),
    timezoneOffsetMinutes: -new Date().getTimezoneOffset(),
    today,
    models,
    config: ledger.config,
  }
}

function createService(ctx, ledger) {
  const service = {
    getState() {
      return buildState(ledger, ctx)
    },

    updateConfig(patch) {
      const { config, errors } = ledger.applyConfigPatch(patch)
      if (errors.length > 0) {
        throw new Error('config rejected: ' + errors.join('; '))
      }
      ledger.config = config
      ledger.scheduleWrite()
      return buildState(ledger, ctx)
    },

    resetHistory() {
      ledger.resetHistory()
      return buildState(ledger, ctx)
    },

    /** 手动给某个模型记一笔(测试用)。 */
    _addTokens(key, tokens) {
      const [provider, ...rest] = key.split(':')
      const model = rest.join(':')
      ledger.account({ output: tokens }, model, 'manual', Date.now(), provider)
      return buildState(ledger, ctx)
    },
  }

  // typertRemote 绑定(和 cost-meter 一致):serviceKey + namespace。
  Object.defineProperty(service, 'typertRemote', {
    configurable: false,
    enumerable: false,
    writable: false,
    value: { service, serviceKey: 'tokenQuota', namespace: 'tokenQuota' },
  })
  return service
}

// ── 插件主体 ────────────────────────────────────────────────────────────────

export function apply(ctx) {
  const ledger = Ledger.open()
  console.log(`[dsh-token-quota] 已加载,账本:${ledger.path}`)

  // 卸载 / 退出前最终落盘。
  ctx.effect(() => () => ledger.close(), 'token-quota: ledger close')

  // 包裹 llm/stream:捕获 usage 块,按模型计入当日账本。
  ctx.on('llm/stream', createStreamAccountant({
    account: (buckets, model, sessionId, atMs, provider) => {
      ledger.account(buckets, model, sessionId, atMs, provider)
    },
  }))

  // 注册会话投影(向客户端推送当前模型 + 会话内用量)。
  ctx.inject(['sessionProjections'], (projectionCtx) => {
    projectionCtx.sessionProjections.register(makeProjection())
  })

  // RPC 服务:客户端经 remote.tokenQuota.* 调用。
  ctx.provide('tokenQuota', createService(ctx, ledger))
}
