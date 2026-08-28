/**
 * dsh-token-quota 账本:按天 / 按模型聚合 token 用量与额度配置。
 *
 * 数据存放在 $DSH_HOME/storages/token-quota/ledger.json,
 * 结构:
 *   {
 *     version: 1,
 *     days: {
 *       "YYYY-MM-DD": {
 *         "provider:modelId": { input, output, cacheRead, cacheWrite, reasoning, calls },
 *         ...
 *       },
 *       ...
 *     },
 *     config: {
 *       quotas: { "provider:modelId": { enabled, quota, warnPct } },
 *       colorReminder: true,
 *       locale: "zh",
 *     },
 *     migrations: [ "v1" ],
 *   }
 */

import fs from 'node:fs'
import path from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { z } from 'zod'

// ── Schema ──────────────────────────────────────────────────────────────────

const bucketSchema = z.object({
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  reasoning: z.number(),
  calls: z.number(),
})

const quotaSchema = z.object({
  enabled: z.boolean(),
  quota: z.number(),       // 每日额度(tokens 总数)
  warnPct: z.number(),     // 提醒阈值百分比 0-100
})

const configSchema = z.object({
  quotas: z.record(z.string(), quotaSchema),
  colorReminder: z.boolean(),
  locale: z.enum(['zh', 'en']),
})

const daySchema = z.record(z.string(), bucketSchema)

const ledgerSchema = z.object({
  version: z.literal(1),
  days: z.record(z.string(), daySchema),
  config: configSchema,
  migrations: z.array(z.string()),
})

const DEFAULT_CONFIG = {
  quotas: {},
  colorReminder: true,
  locale: 'zh',
}

function zeroBucket() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, calls: 0 }
}

// ── 时间 ────────────────────────────────────────────────────────────────────

/**
 * 本地时区日 key(YYYY-MM-DD),和 cost-meter 口径一致。
 * @param ms - 时间戳(ms)。
 */
export function localDayKey(ms = Date.now()) {
  const d = new Date(ms)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// ── Ledger ──────────────────────────────────────────────────────────────────

export class Ledger {
  constructor(path) {
    this.path = path
    this.days = {}
    this.config = { ...DEFAULT_CONFIG }
    this.migrations = []
    this._dirty = false
    this._writeTimer = null
    this._closed = false
  }

  static open() {
    const home = resolveDshHome()
    const dir = path.join(home, 'storages', 'token-quota')
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const filePath = path.join(dir, 'ledger.json')
    const ledger = new Ledger(filePath)
    if (fs.existsSync(filePath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
        const parsed = ledgerSchema.safeParse(raw)
        if (parsed.success) {
          ledger.days = parsed.data.days
          ledger.config = parsed.data.config
          ledger.migrations = parsed.data.migrations ?? []
        } else {
          console.warn('[dsh-token-quota] 账本 schema 校验失败,以空账本启动:', parsed.error.issues.slice(0, 3))
        }
      } catch (err) {
        console.warn('[dsh-token-quota] 账本读取失败,以空账本启动:', err?.message)
      }
    }
    return ledger
  }

  /** 模型 key = "provider:modelId"。 */
  static key(provider, model) {
    return `${provider ?? 'unknown'}:${model ?? 'unknown'}`
  }

  /** 确保 day 与 bucket 存在,返回 bucket 引用(可写)。 */
  _ensure(dayKey, key) {
    if (!this.days[dayKey]) this.days[dayKey] = {}
    if (!this.days[dayKey][key]) this.days[dayKey][key] = zeroBucket()
    return this.days[dayKey][key]
  }

  /**
   * 记账:把一次模型调用的 token 加入对应日期 + 模型桶。
   * @param buckets - 五桶 + calls。
   * @param model - 模型 id。
   * @param sessionId - 会话 id。
   * @param atMs - 调用时间(ms)。
   * @param provider - provider id。
   */
  account(buckets, model, sessionId, atMs, provider) {
    const dayKey = localDayKey(atMs)
    const key = Ledger.key(provider, model)
    const b = this._ensure(dayKey, key)
    b.input += buckets.input ?? 0
    b.output += buckets.output ?? 0
    b.cacheRead += buckets.cacheRead ?? 0
    b.cacheWrite += buckets.cacheWrite ?? 0
    b.reasoning += buckets.reasoning ?? 0
    b.calls += 1
    this.scheduleWrite()
  }

  /**
   * 读取指定天,不存在则返回空 day。
   */
  day(dateKey) {
    const d = this.days[dateKey]
    if (d === undefined) return {}
    // 返回深拷贝,防止外部污染。
    const out = {}
    for (const [k, v] of Object.entries(d)) out[k] = { ...v }
    return out
  }

  /** 今日账本拷贝。 */
  today() {
    return this.day(localDayKey())
  }

  /** 按日/按月 / 累计聚合。datePrefix = 'YYYY-MM' 为月度,undefined 为累计。 */
  sumDays(datePrefix) {
    const total = zeroBucket()
    for (const [dayKey, day] of Object.entries(this.days)) {
      if (datePrefix !== undefined && !dayKey.startsWith(datePrefix)) continue
      for (const bucket of Object.values(day)) {
        total.input += bucket.input
        total.output += bucket.output
        total.cacheRead += bucket.cacheRead
        total.cacheWrite += bucket.cacheWrite
        total.reasoning += bucket.reasoning
        total.calls += bucket.calls
      }
    }
    return total
  }

  /** 前 N 天列表(按日期倒序)。 */
  history(limit = 30) {
    const keys = Object.keys(this.days).sort().reverse().slice(0, limit)
    return keys.map(date => ({ date, models: this.day(date) }))
  }

  /** 清空历史(保留配置)。 */
  resetHistory() {
    this.days = {}
    this.scheduleWrite()
  }

  /** 应用配置补丁(深合并)。返回 {config, errors}。 */
  applyConfigPatch(patch) {
    const errors = []
    const current = this.config
    const next = { ...current }
    for (const [key, val] of Object.entries(patch ?? {})) {
      if (key === 'quotas') {
        if (val !== null && typeof val === 'object') {
          next.quotas = { ...current.quotas }
          for (const [mKey, qp] of Object.entries(val)) {
            if (qp === null || qp === undefined) {
              delete next.quotas[mKey]
            } else {
              const parsed = quotaSchema.safeParse({
                enabled: qp.enabled !== false,
                quota: Math.max(0, Number(qp.quota) || 0),
                warnPct: Math.min(100, Math.max(0, Number(qp.warnPct) || 80)),
              })
              if (parsed.success) next.quotas[mKey] = parsed.data
              else errors.push(`quota ${mKey}: ${parsed.error.issues.map(i => i.message).join('; ')}`)
            }
          }
        } else {
          errors.push('quotas: invalid')
        }
      } else if (key === 'colorReminder') {
        next.colorReminder = val === true
      } else if (key === 'locale') {
        if (val === 'zh' || val === 'en') next.locale = val
        else errors.push('locale: must be zh or en')
      } else {
        // 忽略未知字段,不报错(兼容版本差异)。
      }
    }
    // schema 二次校验,保证最终 config 始终有效。
    const parsed = configSchema.safeParse(next)
    if (!parsed.success) {
      for (const issue of parsed.error.issues) errors.push(issue.message)
      return { config: current, errors }
    }
    return { config: parsed.data, errors }
  }

  /** 标记脏并调度写盘(节流 500ms)。 */
  scheduleWrite() {
    if (this._closed) return
    this._dirty = true
    if (this._writeTimer !== null) return
    this._writeTimer = setTimeout(() => {
      this._writeTimer = null
      if (!this._dirty) return
      this._flush()
    }, 500)
    if (typeof this._writeTimer.unref === 'function') this._writeTimer.unref()
  }

  /** 立即写盘。 */
  _flush() {
    if (!this._dirty) return
    const data = { version: 1, days: this.days, config: this.config, migrations: this.migrations }
    try {
      const tmp = this.path + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8')
      fs.renameSync(tmp, this.path)
      this._dirty = false
    } catch (err) {
      console.warn('[dsh-token-quota] 账本写盘失败:', err?.message)
    }
  }

  /** 关闭:立即写盘 + 停止调度。 */
  close() {
    this._closed = true
    if (this._writeTimer !== null) {
      clearTimeout(this._writeTimer)
      this._writeTimer = null
    }
    if (this._dirty) this._flush()
  }
}

// ── 助手 ────────────────────────────────────────────────────────────────────

/** 计算一个桶的总 token 数(输入 + 缓存读 + 缓存写 + 推理 + 输出)。 */
export function totalTokens(bucket) {
  if (!bucket) return 0
  return (bucket.input ?? 0) + (bucket.output ?? 0)
    + (bucket.cacheRead ?? 0) + (bucket.cacheWrite ?? 0) + (bucket.reasoning ?? 0)
}

/**
 * 计算模型配额状态。
 * @returns 'ok' | 'warn' | 'over' | 'none'
 */
export function quotaLevel(bucket, quotaCfg) {
  if (!quotaCfg || quotaCfg.enabled !== true || !quotaCfg.quota || quotaCfg.quota <= 0) return 'none'
  const used = totalTokens(bucket)
  const pct = used / quotaCfg.quota
  if (pct >= 1) return 'over'
  if (pct >= (quotaCfg.warnPct ?? 80) / 100) return 'warn'
  return 'ok'
}
