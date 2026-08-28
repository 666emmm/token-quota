/**
 * dsh-token-quota Host 端 Typert 清单(由 typert-loader 自动扫描注册)。
 */

import { z } from 'zod'

const num = z.number()
const str = z.string()

const bucketSchema = z.object({
  input: num,
  output: num,
  cacheRead: num,
  cacheWrite: num,
  reasoning: num,
  calls: num,
})

const modelInfoSchema = z.object({
  provider: str,
  providerName: str.optional(),
  model: str,
  key: str,
  name: str,
})

const quotaSchema = z.object({
  enabled: z.boolean(),
  quota: num,
  warnPct: num,
})

const configSchema = z.object({
  quotas: z.record(str, quotaSchema),
  colorReminder: z.boolean(),
  notify: z.boolean(),
  notifyThreshold: z.enum(['warn', 'over']),
  locale: z.enum(['zh', 'en']),
})

const stateSchema = z.object({
  dayKey: str,
  now: num,
  timezoneOffsetMinutes: num,
  today: z.record(str, bucketSchema),
  models: z.array(modelInfoSchema),
  config: configSchema,
})

const patchSchema = z.record(str, z.unknown())

const _state$codec = { mode: 'strict', typeSymbol: 'dsh-token-quota#State', schema: stateSchema }
const _patch$codec = { mode: 'strict', typeSymbol: 'dsh-token-quota#ConfigPatch', schema: patchSchema }
const _key$codec = { mode: 'strict', typeSymbol: 'dsh-token-quota#ModelKey', schema: str }
const _tokens$codec = { mode: 'strict', typeSymbol: 'dsh-token-quota#TokenCount', schema: num }

export const TYPERT = {
  package: 'dsh-token-quota',
  face: 'host',
  schemas: [],
  invocations: [
    {
      id: 'dsh-token-quota#tokenQuota/getState',
      service: 'tokenQuota',
      namespace: 'tokenQuota',
      method: 'getState',
      invocation: { kind: 'direct' },
      parameters: [],
      result: _state$codec,
    },
    {
      id: 'dsh-token-quota#tokenQuota/updateConfig',
      service: 'tokenQuota',
      namespace: 'tokenQuota',
      method: 'updateConfig',
      invocation: { kind: 'direct' },
      parameters: [
        { name: 'patch', wire: 'patch', source: 'json', codec: _patch$codec },
      ],
      result: _state$codec,
    },
    {
      id: 'dsh-token-quota#tokenQuota/resetHistory',
      service: 'tokenQuota',
      namespace: 'tokenQuota',
      method: 'resetHistory',
      invocation: { kind: 'direct' },
      parameters: [],
      result: _state$codec,
    },
    {
      id: 'dsh-token-quota#tokenQuota/_addTokens',
      service: 'tokenQuota',
      namespace: 'tokenQuota',
      method: '_addTokens',
      invocation: { kind: 'direct' },
      parameters: [
        { name: 'key', wire: 'key', source: 'json', codec: _key$codec },
        { name: 'tokens', wire: 'tokens', source: 'json', codec: _tokens$codec },
      ],
      result: _state$codec,
    },
  ],
  model: {
    services: [
      {
        description: 'dsh-token-quota 账本与额度服务(ctx.tokenQuota),聚合每日模型 token 用量与配额提醒。',
        summary: 'dsh-token-quota 每日 token 额度与提醒服务',
        tags: [],
        jsDoc: '/** dsh-token-quota 每日 token 额度服务。*/',
        key: 'tokenQuota',
        exportName: 'TokenQuotaService',
        members: [
          {
            kind: 'method',
            name: 'getState',
            signature: 'getState(): State',
            summary: '读取今日按模型用量、模型列表与当前配置',
            jsDoc: '/** 读取今日按模型用量、模型列表与配置 */',
          },
          {
            kind: 'method',
            name: 'updateConfig',
            signature: 'updateConfig(patch: ConfigPatch): State',
            summary: '深合并一份配置补丁并持久化',
            jsDoc: '/** @param patch 配置补丁 */',
          },
          {
            kind: 'method',
            name: 'resetHistory',
            signature: 'resetHistory(): State',
            summary: '清空全部历史用量',
            jsDoc: '/** 清空全部历史用量 */',
          },
        ],
        types: [],
      },
    ],
    events: [],
    objects: [],
  },
}

export default TYPERT
