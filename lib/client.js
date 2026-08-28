/**
 * dsh-token-quota 浏览器端 bundle。
 *
 * 功能:
 *  - settings.section「Token 额度」:列出所有已配置模型,逐个设置每日额度 / 提醒阈值;
 *  - conversation.composer.dock:显示当前模型今日已用 / 额度 / 百分比 chips;
 *  - 达到 warn 或 over 阈值时,在 [data-composer-card] 上加彩色边框/阴影(对话框变色);
 *  - 首次触达阈值时发系统通知(如果浏览器允许);
 *  - 数据通道:
 *     - tokenQuotaCurrent 会话投影(useProjection) → 当前模型;
 *     - remote.tokenQuota.* RPC → 今日用量 / 模型列表 / 配置更新。
 */

window.__ModuleLoader__.load({
  id: 'dsh-token-quota',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { Tooltip } = require('@deepseek-ai/dsh-client-ui-primitives')

    // ── 多语言 ──────────────────────────────────────────────────────────

    const MESSAGES = {
      zh: {
        sectionLabel: 'Token 额度',
        title: '每日模型 Token 额度',
        subtitle: '按模型统计今日用量,到达阈值时对话框变色提醒切换模型',
        colModel: '模型',
        colProvider: '提供商',
        colUsed: '今日已用',
        colQuota: '每日额度',
        colPct: '占比',
        colWarn: '提醒阈值',
        colEnabled: '启用',
        enabledHint: '勾选后对该模型启用每日额度提醒;直接填写额度或拖动滑块也会自动启用',
        resetHistory: '清除统计',
        resetConfirm: '确认清空所有历史用量统计吗?',
        resetDone: '历史已清除',
        colorReminder: '变色提醒(超额时对话框变色)',
        dockChip: '{name} {used}/{quota} ({pct}%)',
        dockNoQuota: '{name} {used} (未设额度)',
        noModels: '未检测到已配置的模型,请先在「模型」设置页添加模型',
        total: '合计',
        refresh: '刷新',
        quotaHint: '额度单位:总 tokens(输入+输出+缓存+推理);填写每日额度并启用后,达到阈值会提醒',
        warnHint: '使用量到达该百分比时开始提醒',
        saved: '已保存',
      },
      en: {
        sectionLabel: 'Token Quota',
        title: 'Daily Model Token Quota',
        subtitle: 'Track today\'s usage per model; the composer changes color when threshold is hit to remind you to switch.',
        colModel: 'Model',
        colProvider: 'Provider',
        colUsed: 'Used Today',
        colQuota: 'Daily Quota',
        colPct: 'Pct',
        colWarn: 'Warn at',
        colEnabled: 'On',
        resetHistory: 'Reset stats',
        resetConfirm: 'Clear all historical usage statistics?',
        resetDone: 'History cleared',
        colorReminder: 'Color reminder (composer border changes when over)',
        dockChip: '{name} {used}/{quota} ({pct}%)',
        dockNoQuota: '{name} {used} (no quota set)',
        noModels: 'No models configured. Add models in the Models settings page first.',
        total: 'Total',
        refresh: 'Refresh',
        quotaHint: 'Quota unit: total tokens (input + output + cache + reasoning)',
        warnHint: 'Remind when usage reaches this percent',
        saved: 'Saved',
      },
    }

    function makeT(locale) {
      const dict = locale === 'en' ? MESSAGES.en : MESSAGES.zh
      return function t(key, vars) {
        let text = dict[key] ?? key
        if (vars) for (const k of Object.keys(vars)) {
          text = text.split('{' + k + '}').join(String(vars[k]))
        }
        return text
      }
    }

    function resolveLocale(state) {
      return state?.config?.locale === 'en' ? 'en' : 'zh'
    }

    // ── 工具函数 ────────────────────────────────────────────────────────

    function totalTokens(bucket) {
      if (!bucket) return 0
      return (bucket.input ?? 0) + (bucket.output ?? 0)
        + (bucket.cacheRead ?? 0) + (bucket.cacheWrite ?? 0) + (bucket.reasoning ?? 0)
    }

    function formatTokens(n) {
      n = Number(n) || 0
      if (n >= 1_000_000) return (n / 1_000_000).toFixed(n >= 10_000_000 ? 1 : 2) + 'M'
      if (n >= 1_000) return (n / 1_000).toFixed(n >= 10_000 ? 0 : 1) + 'K'
      return String(n)
    }

    function quotaLevelFor(key, today, config) {
      const bucket = today[key]
      const q = config?.quotas?.[key]
      if (!q || q.enabled !== true || !q.quota || q.quota <= 0) return { level: 'none', used: totalTokens(bucket), quota: 0, pct: 0 }
      const used = totalTokens(bucket)
      const pct = used / q.quota
      let level = 'ok'
      if (pct >= 1) level = 'over'
      else if (pct >= (q.warnPct ?? 80) / 100) level = 'warn'
      return { level, used, quota: q.quota, pct, warnPct: q.warnPct ?? 80 }
    }

    // ── 极简 store (getSnapshot / subscribe / set, 参考 cost-meter) ────

    function makeStore(initial) {
      let snapshot = initial
      const listeners = new Set()
      return {
        getSnapshot() { return snapshot },
        subscribe(fn) {
          listeners.add(fn)
          return () => listeners.delete(fn)
        },
        set(next) {
          snapshot = next
          listeners.forEach(fn => { try { fn() } catch (e) { /* ignore */ } })
        },
      }
    }

    // ── CSS ─────────────────────────────────────────────────────────────

    const css = [
      '/* dsh-token-quota */',
      '.tq-root{display:block;text-align:center;max-width:var(--dsh-chat-content-width,720px);width:100%;margin:0 auto;box-sizing:border-box;padding:4px calc(var(--dsh-composer-side-clearance,0px) + 16px) 0;display:flex;gap:6px;flex-wrap:wrap;justify-content:center;font-size:12px;line-height:20px}',
      '.tq-chip{display:inline-flex;align-items:center;gap:4px;max-width:260px;padding:0 8px;height:22px;border-radius:6px;background:var(--dsw-alias-bg-layer-2);font-size:12px;line-height:22px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums;cursor:default}',
      '.tq-chip.warn{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 16%,var(--dsw-alias-bg-layer-2));color:var(--dsw-alias-state-warn-primary)}',
      '.tq-chip.over{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 20%,var(--dsw-alias-bg-layer-2));color:var(--dsw-alias-state-error-primary);font-weight:600}',
      '.tq-num{font-variant-numeric:tabular-nums}',
      // composer 变色:通过 body 上的 data-tq-level 属性,给 [data-composer-card] 加边框/阴影。
      'body[data-tq-level="warn"] [data-composer-card]{border-color:var(--dsw-alias-state-warn-primary)!important;box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-state-warn-primary) 28%,transparent),var(--dsw-shadow-lv2)!important;transition:border-color .2s,box-shadow .2s}',
      'body[data-tq-level="over"] [data-composer-card]{border-color:var(--dsw-alias-state-error-primary)!important;box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-error-primary) 30%,transparent),var(--dsw-shadow-lv2)!important;transition:border-color .2s,box-shadow .2s}',
      // 设置页
      '.tq-section{display:flex;flex-direction:column;gap:16px;padding:4px 2px 24px;font-size:13px;color:var(--dsw-alias-label-primary)}',
      '.tq-h{font-size:13px;font-weight:600;margin:0 0 4px}',
      '.tq-sub{font-size:12px;color:var(--dsw-alias-label-tertiary);margin:0 0 8px;line-height:1.6}',
      '.tq-group{display:table-row-group}',
      '.tq-group-head{display:flex;align-items:center;gap:8px;padding:6px 8px;cursor:pointer;border-radius:6px;font-size:13px;font-weight:500;user-select:none}',
      '.tq-group-head:hover{background:var(--dsw-alias-bg-ghost-hover)}',
      '.tq-group-arrow{width:12px;height:12px;transition:transform .2s;color:var(--dsw-alias-label-tertiary)}',
      '.tq-group-arrow.open{transform:rotate(90deg)}',
      '.tq-group-summary{flex:1;display:flex;align-items:center;gap:12px;font-size:12px;color:var(--dsw-alias-label-tertiary);font-weight:400}',
      '.tq-group-name{color:var(--dsw-alias-label-primary);font-weight:500;font-size:13px}',
      '.tq-table{width:100%;border-collapse:collapse;font-size:12px;margin-bottom:8px}',
      '.tq-table th,.tq-table td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);white-space:nowrap}',
      '.tq-table th{color:var(--dsw-alias-label-tertiary);font-weight:500}',
      '.tq-table td.num,.tq-table th.num{text-align:right;font-variant-numeric:tabular-nums}',
      '.tq-table tr:last-child td{border-bottom:none}',
      '.tq-input{font:inherit;font-size:12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:4px 8px;outline:none;width:100px;box-sizing:border-box}',
      '.tq-input:focus{border-color:var(--dsw-alias-state-business-primary)}',
      '.tq-input.narrow{width:70px}',
      '.tq-range{width:110px;accent-color:var(--dsw-alias-state-business-primary);cursor:pointer;vertical-align:middle}',
      '.tq-range:disabled{opacity:.4;cursor:default}',
      '.tq-pct-label{display:inline-block;min-width:34px;text-align:right;font-variant-numeric:tabular-nums;font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.tq-save-state{font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}',
      '.tq-check{display:inline-flex;align-items:center;gap:6px;cursor:pointer}',
      '.tq-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}',
      '.tq-btn{font:inherit;font-size:12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-button-elevated-fill);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:5px 12px;cursor:pointer}',
      '.tq-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.tq-btn.danger{color:var(--dsw-alias-state-error-primary)}',
      '.tq-bar{width:100px;height:6px;border-radius:3px;background:var(--dsw-alias-bg-layer-3);overflow:hidden;display:inline-block;vertical-align:middle}',
      '.tq-bar-fill{height:100%;border-radius:3px;background:var(--dsw-alias-state-business-primary);transition:width .3s}',
      '.tq-bar-fill.warn{background:var(--dsw-alias-state-warn-primary)}',
      '.tq-bar-fill.over{background:var(--dsw-alias-state-error-primary)}',
      '.tq-msg{font-size:12px;line-height:18px;padding:6px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1)}',
      '.tq-msg.ok{color:var(--dsw-alias-state-success-primary)}',
      '.tq-msg.err{color:var(--dsw-alias-state-error-primary)}',
      '.tq-toggle{background:none;border:none;font-size:12px;color:var(--dsw-alias-label-tertiary);cursor:pointer}',
      '.tq-name{max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}',
      '.tq-provider{font-size:11px;color:var(--dsw-alias-label-tertiary);font-family:ui-monospace,Consolas,monospace}',
      '.tq-summary{font-size:12px;color:var(--dsw-alias-label-secondary);display:flex;gap:16px;flex-wrap:wrap;align-items:center}',
      '.tq-summary span{font-variant-numeric:tabular-nums}',
      '@media (max-width:640px){.tq-table{font-size:11px}.tq-input{width:80px}}',
    ].join('\n')

    const cssTagId = 'dsh-token-quota/client.css'
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(cssTagId) + ']') === null) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-token-quota'
      tag.dataset.pluginCss = cssTagId
      tag.textContent = css
      document.head.appendChild(tag)
    }

    const { createElement: el, Fragment, useState, useEffect, useMemo, useCallback, useRef } = React

    // 稳定的空对象引用,避免每次渲染重建导致 useMemo 重算。
    const EMPTY_CONFIG = { quotas: {} }

    // ── Dock chips:输入框下方,显示当前模型 + 其他模型额度进度 ────────

    function QuotaDock(props) {
      const current = props.useProjection ? props.useProjection('tokenQuotaCurrent') : undefined
      const store = props.useQuota ? props.useQuota(s => s) : undefined
      if (!store) return null
      const t = makeT(resolveLocale(store.state))
      const today = store.state?.today ?? {}
      const models = store.state?.models ?? []
      const config = store.state?.config
      if (!models.length) return null

      const currentKey = current?.key
      // 只显示两类:①当前正在使用的模型;②额度已用 ≥ warnPct 的模型,提醒切换。
      // 其余已启用但用量正常的模型不显示,保持页面干净。
      const chipKeys = new Set()
      const ordered = []
      if (currentKey) {
        const m = models.find(x => x.key === currentKey)
        if (m) {
          ordered.push(m); chipKeys.add(m.key)
        } else {
          // 当前模型不在 settings 列表里(可能已删除但仍在用),兜底构造一个仅用于 dock 显示。
          const [provider, ...rest] = currentKey.split(':')
          const model = rest.join(':')
          ordered.push({
            key: currentKey,
            provider, model,
            name: current.model || model,
            providerName: current.provider || provider,
          })
          chipKeys.add(currentKey)
        }
      }
      // 超过各自滑块阈值的模型也显示(提醒切换模型)。
      const warnChips = models
        .filter(m => !chipKeys.has(m.key))
        .map(m => ({ m, info: quotaLevelFor(m.key, today, config) }))
        .filter(x => x.info.quota > 0 && x.info.pct >= (x.info.warnPct ?? 80) / 100)
        .sort((a, b) => b.info.pct - a.info.pct)
      for (const { m } of warnChips) { ordered.push(m); chipKeys.add(m.key) }

      if (ordered.length === 0) return null

      return el('div', { className: 'tq-root' },
        ordered.map(m => {
          const info = quotaLevelFor(m.key, today, config)
          const cls = 'tq-chip' + (info.level === 'warn' ? ' warn' : info.level === 'over' ? ' over' : '')
          const tooltip = m.provider + ':' + m.model
          let label
          if (info.quota > 0) {
            label = t('dockChip', {
              name: m.name,
              used: formatTokens(info.used),
              quota: formatTokens(info.quota),
              pct: Math.floor(info.pct * 100),
            })
          } else {
            label = t('dockNoQuota', { name: m.name, used: formatTokens(info.used) })
          }
          return el(Tooltip, { key: m.key, label: tooltip, side: 'top', delayMs: 500 },
            el('div', { className: cls }, label))
        })
      )
    }

    // ── 设置页:Token 额度分节 ──────────────────────────────────────────
    // 注意:所有 hooks 必须无条件在顶部调用(React Rules of Hooks),再条件渲染。

    function SettingsSection(props) {
      const store = props.useQuota ? props.useQuota(s => s) : undefined
      const api = props.api
      const snap = store?.state ?? null

      const [draftColor, setDraftColor] = useState(snap?.config?.colorReminder ?? false)
      const [msg, setMsg] = useState(null)
      const [busy, setBusy] = useState(false)
      // 自动保存状态: 'idle' | 'saving' | 'saved' | 'error'
      const [saveState, setSaveState] = useState('idle')
      const lastSavedRef = useRef(null)
      const saveTimerRef = useRef(null)
      // provider 分组折叠状态:默认全部展开。
      const [collapsedGroups, setCollapsedGroups] = useState({})

      const models = snap?.models ?? []
      const today = snap?.today ?? {}
      const config = snap?.config ?? EMPTY_CONFIG
      const t = makeT(resolveLocale(snap))

      // 初始化每行额度草稿。
      const perModel = useMemo(() => {
        const out = {}
        for (const m of models) {
          const q = config.quotas?.[m.key]
          out[m.key] = {
            enabled: q?.enabled ?? false,
            quota: q ? String(q.quota) : '2000000',
            warnPct: q ? String(q.warnPct) : '80',
          }
        }
        return out
      }, [models, config])

      // 用 state 维护 editable 行(因为 useMemo 在外部刷新时会重置)。
      const [rows, setRows] = useState({})
      useEffect(() => {
        // 新模型追加,旧模型保留编辑值。
        setRows(prev => {
          const next = { ...prev }
          for (const m of models) {
            if (!next[m.key]) next[m.key] = perModel[m.key]
          }
          return next
        })
      }, [perModel, models])

      // snapshot 变化时同步草稿(外部刷新时)。
      useEffect(() => {
        setDraftColor(snap?.config?.colorReminder ?? false)
      }, [snap?.config?.colorReminder])

      // 构建提交用的 patch(与已保存内容比较,避免空保存)。
      const buildPatch = useCallback(() => {
        const quotas = {}
        for (const m of models) {
          const r = rows[m.key] ?? perModel[m.key]
          if (!r) continue
          if (r.enabled) {
            const q = Math.max(0, parseInt(String(r.quota).replace(/[^0-9]/g, ''), 10) || 0)
            const w = Math.min(100, Math.max(1, parseInt(String(r.warnPct), 10) || 80))
            quotas[m.key] = { enabled: true, quota: q, warnPct: w }
          } else {
            // 未启用:显式传 null 让宿主删除该模型条目(避免旧配置残留)。
            quotas[m.key] = null
          }
        }
        return { quotas, colorReminder: draftColor }
      }, [models, rows, perModel, draftColor])

      // 自动保存:任何草稿变化 600ms 防抖后自动提交(滑块拖动即生效)。
      useEffect(() => {
        if (!snap) return
        const patch = buildPatch()
        const json = JSON.stringify(patch)
        // 首次:记录服务端当前配置作为基线,未修改不保存。
        if (lastSavedRef.current === null) {
          lastSavedRef.current = json
          return
        }
        if (json === lastSavedRef.current) return
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
        saveTimerRef.current = setTimeout(async () => {
          setSaveState('saving')
          try {
            await api.updateConfig(patch)
            lastSavedRef.current = json
            setSaveState('saved')
            setTimeout(() => setSaveState('idle'), 1600)
          } catch (e) {
            setSaveState('error')
          }
        }, 600)
        return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current) }
      }, [buildPatch, snap, api])

      if (!snap) {
        return el('div', { className: 'tq-section' }, el('div', { className: 'tq-msg' }, 'loading…'))
      }

      const updateRow = (key, field, val) => {
        setRows(prev => {
          const cur = prev[key] ?? perModel[key] ?? { enabled: false, quota: '2000000', warnPct: '80' }
          const next = { ...cur, [field]: val }
          // 编辑额度/滑块时自动启用该模型,避免"必须先勾选启用才能改"的困惑。
          if (field === 'quota' || field === 'warnPct') next.enabled = true
          return { ...prev, [key]: next }
        })
      }

      const totalUsed = Object.values(today).reduce((s, b) => s + totalTokens(b), 0)
      const totalQuota = Object.values(config.quotas ?? {})
        .filter(q => q.enabled)
        .reduce((s, q) => s + (q.quota || 0), 0)

      const doReset = async () => {
        if (!window.confirm(t('resetConfirm'))) return
        setBusy(true); setMsg(null)
        try {
          await api.resetHistory()
          setMsg({ ok: true, text: t('resetDone') })
          setTimeout(() => setMsg(null), 2000)
        } catch (e) {
          setMsg({ ok: false, text: e?.message ?? String(e) })
        } finally { setBusy(false) }
      }

      const doRefresh = () => api.reload()

      return el('div', { className: 'tq-section' },
        el('h3', { className: 'tq-h' }, t('title')),
        el('p', { className: 'tq-sub' }, t('subtitle')),

        el('div', { className: 'tq-summary' },
          el('span', null, t('total') + ': ' + formatTokens(totalUsed)
            + (totalQuota > 0 ? ' / ' + formatTokens(totalQuota) + ' (' + Math.floor(totalUsed / totalQuota * 100) + '%)' : '')),
          el('button', { className: 'tq-btn', onClick: doRefresh }, t('refresh')),
          el('button', { className: 'tq-btn danger', onClick: doReset, disabled: busy }, t('resetHistory')),
        ),

        msg ? el('div', { className: 'tq-msg ' + (msg.ok ? 'ok' : 'err') }, msg.text) : null,

        models.length === 0
          ? el('div', { className: 'tq-msg' }, t('noModels'))
          : el('table', { className: 'tq-table' },
            el('thead', null,
              el('tr', null,
                el('th', { title: t('enabledHint') }, t('colEnabled')),
                el('th', null, t('colModel')),
                el('th', { className: 'num' }, t('colUsed')),
                el('th', null, ''),
                el('th', null, t('colQuota')),
                el('th', { className: 'num' }, t('colPct')),
                el('th', { className: 'num' }, t('colWarn') + ' (%)'),
              )
            ),
            (() => {
              // 按 providerName 分组(保留首次出现顺序)。
              const order = []
              const map = {}
              for (const m of models) {
                const pn = m.providerName || m.provider
                if (!map[pn]) { map[pn] = []; order.push(pn) }
                map[pn].push(m)
              }
              return order.map(pn => {
                const ms = map[pn]
                const gUsed = ms.reduce((s, m) => s + quotaLevelFor(m.key, today, config).used, 0)
                const collapsed = collapsedGroups[pn]
                return el('tbody', { key: pn, className: 'tq-group' },
                  el('tr', null,
                    el('td', { colSpan: 7, style: { padding: '0' } },
                      el('div', {
                        className: 'tq-group-head',
                        onClick: () => setCollapsedGroups(prev => ({ ...prev, [pn]: !prev[pn] })),
                      },
                        el('span', { className: 'tq-group-arrow' + (collapsed ? '' : ' open') }, '\u25B6'),
                        el('span', { className: 'tq-group-name' }, pn),
                        el('span', { className: 'tq-group-summary' },
                          ms.length + ' \u4E2A\u6A21\u578B \u00B7 \u4ECA\u65E5\u5DF2\u7528 ' + formatTokens(gUsed)),
                      ),
                    ),
                  ),
                  ...(!collapsed ? ms.map(m => {
                    const r = rows[m.key] ?? perModel[m.key]
                    const info = quotaLevelFor(m.key, today, config)
                    const fillCls = 'tq-bar-fill' + (info.level === 'warn' ? ' warn' : info.level === 'over' ? ' over' : '')
                    const pct = info.quota > 0 ? Math.min(100, Math.floor(info.pct * 100)) : 0
                    return el('tr', { key: m.key },
                      el('td', null,
                        el('label', { className: 'tq-check' },
                          el('input', {
                            type: 'checkbox',
                            checked: r?.enabled ?? false,
                            onChange: e => updateRow(m.key, 'enabled', e.target.checked),
                          }),
                        )
                      ),
                      el('td', null, el('div', { className: 'tq-name', title: m.name }, m.name)),
                      el('td', { className: 'num' }, el('span', { className: 'tq-num' }, formatTokens(info.used))),
                      el('td', null,
                        el('span', { className: 'tq-bar' },
                          el('span', { className: fillCls, style: { width: pct + '%' } }),
                        ),
                      ),
                      el('td', { className: 'num' },
                        el('input', {
                          className: 'tq-input',
                          type: 'text',
                          value: r?.quota ?? '',
                          placeholder: 'e.g. 2000000',
                          onChange: e => updateRow(m.key, 'quota', e.target.value),
                        }),
                      ),
                      el('td', { className: 'num' },
                        el('span', { className: 'tq-num' }, info.quota > 0 ? pct + '%' : '\u2014'),
                      ),
                      el('td', { className: 'num' },
                        el('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end' } },
                          el('input', {
                            className: 'tq-range',
                            type: 'range',
                            min: 10, max: 100, step: 5,
                            value: r?.warnPct ?? '80',
                            title: t('warnHint'),
                            onChange: e => updateRow(m.key, 'warnPct', e.target.value),
                          }),
                          el('span', { className: 'tq-pct-label' }, (r?.warnPct ?? '80') + '%'),
                        ),
                      ),
                    )
                  }) : []),
                )
              })
            })()
          ),

        el('p', { className: 'tq-sub' }, t('quotaHint')),

        el('div', { className: 'tq-row' },
          el('label', { className: 'tq-check' },
            el('input', {
              type: 'checkbox',
              checked: draftColor,
              onChange: e => setDraftColor(e.target.checked),
            }),
            t('colorReminder'),
          ),
        ),

        el('div', { className: 'tq-row' },
          el('span', { className: 'tq-save-state' },
            saveState === 'saving' ? '保存中…' :
            saveState === 'saved' ? '✓ ' + t('saved') :
            saveState === 'error' ? '✗ 保存失败' : '自动保存已开启'),
        ),
      )
    }

    // ── 插件主体 ────────────────────────────────────────────────────────

    const inject = ['remote']

    async function apply(ctx) {
      const remote = ctx.remote
      if (remote === undefined || typeof remote.$mount !== 'function') return

      // ── RPC 贡献(与服务端 typert 清单一一对应) ──────────────────────
      // 客户端 codec 只做透传(服务端 zod 校验),schema 需提供 parse() 方法(与 dsh-cost-meter 的 codecOf 一致)。
      function codecOf(parse) { return { parse } }
      const passThrough = (v) => v
      const stateCodec = { mode: 'strict', typeSymbol: 'dsh-token-quota#State', schema: codecOf(passThrough) }
      const patchCodec = { mode: 'strict', typeSymbol: 'dsh-token-quota#ConfigPatch', schema: codecOf(passThrough) }

      const CONTRIBUTION = {
        package: 'dsh-token-quota',
        descriptors: [
          {
            id: 'dsh-token-quota#tokenQuota/getState', service: 'tokenQuota', namespace: 'tokenQuota', method: 'getState',
            invocation: { kind: 'direct' }, parameters: [], result: stateCodec,
          },
          {
            id: 'dsh-token-quota#tokenQuota/updateConfig', service: 'tokenQuota', namespace: 'tokenQuota', method: 'updateConfig',
            invocation: { kind: 'direct' },
            parameters: [{ name: 'patch', wire: 'patch', source: 'json', codec: patchCodec }],
            result: stateCodec,
          },
          {
            id: 'dsh-token-quota#tokenQuota/resetHistory', service: 'tokenQuota', namespace: 'tokenQuota', method: 'resetHistory',
            invocation: { kind: 'direct' }, parameters: [], result: stateCodec,
          },
        ],
      }

      const unmount = await remote.$mount(CONTRIBUTION)
      ctx.effect(() => () => { unmount() }, 'token-quota: remote contribution')
      const tokenQuota = ctx.get('remote.tokenQuota')
      if (tokenQuota === undefined) return

      const store = makeStore({ status: 'loading', error: null, state: null })

      // RPC 结果信封解包:typert 返回 { ok, value },成功时取 value(与 cost-meter 的 call() 一致)。
      const call = async (method, args) => {
        const result = await tokenQuota[method](...(args ?? []))
        if (result === null || typeof result !== 'object' || result.ok !== true) {
          throw new Error(result?.error?.message ?? `tokenQuota.${method} failed`)
        }
        return result.value
      }

      let reloading = false
      const reload = async () => {
        if (reloading) return
        reloading = true
        const prev = store.getSnapshot()
        try {
          const state = await call('getState')
          store.set({ status: 'ready', error: null, state })
        } catch (error) {
          store.set({ status: 'error', error: error?.message ?? String(error), state: prev.state })
        } finally { reloading = false }
      }

      ctx.effect(() => ctx.on('connection/reset', () => { void reload() }), 'token-quota: reconnect')
      const pollTimer = setInterval(() => { if (!document.hidden) void reload() }, 5000)
      ctx.effect(() => () => clearInterval(pollTimer), 'token-quota: poll')
      const onVisible = () => { if (document.visibilityState === 'visible') void reload() }
      document.addEventListener('visibilitychange', onVisible)
      ctx.effect(() => () => document.removeEventListener('visibilitychange', onVisible), 'token-quota: visibility')

      const api = {
        reload,
        updateConfig: async (patch) => {
          const state = await call('updateConfig', [patch])
          store.set({ status: 'ready', error: null, state })
          return state
        },
        resetHistory: async () => {
          const state = await call('resetHistory')
          store.set({ status: 'ready', error: null, state })
          return state
        },
      }

      void reload()

      const slots = ctx.get('slots')
      if (slots === undefined) return

      const injected = () => ({ hooks: { quota: store }, api })

      // ── Dock:输入框下方显示当前模型 + 超额 chips ─────────────────
      slots.inject('conversation.composer.dock', () => {
        const dispose = slots.register(
          { name: 'conversation.composer.dock', id: 'token-quota-dock', order: 4, inject: injected },
          QuotaDock,
        )
        return dispose
      })

      // ── Settings 分节 ──────────────────────────────────────────────
      slots.inject('settings.section', () => {
        const dispose = slots.register({
          name: 'settings.section',
          id: 'token-quota-section',
          order: 28,
          label: MESSAGES.zh.sectionLabel,
          inject: injected,
        }, SettingsSection)
        return dispose
      })

      // ── 变色 + 通知副作用:挂在会话作用域的 composer.dock(拿得到 useProjection) ─
      function QuotaSideEffect(props) {
        const current = props.useProjection ? props.useProjection('tokenQuotaCurrent') : undefined
        const snap = props.useQuota ? props.useQuota(s => s) : undefined

        useEffect(() => {
          const state = snap?.state
          if (!state) return
          const today = state.today ?? {}
          const config = state.config

          // 1) 变色等级:只根据"当前正在使用的模型"评估(沿用之前设计——
          //    当前模型超额才让对话框变色;其他模型超额不干扰正在进行的对话)。
          //    当前模型没配额度 → 不变色。
          const models = state.models ?? []
          let bodyLevel = 'ok'
          if (current?.key) {
            const info = quotaLevelFor(current.key, today, config)
            if (info.level === 'warn' || info.level === 'over') bodyLevel = info.level
          }

          // 2) 设置 body 属性驱动 CSS 变色(仅当前模型)。
          if (config.colorReminder !== false) {
            if (bodyLevel === 'warn' || bodyLevel === 'over') {
              document.body.setAttribute('data-tq-level', bodyLevel)
            } else {
              document.body.removeAttribute('data-tq-level')
            }
          } else {
            document.body.removeAttribute('data-tq-level')
          }
        }, [current?.key, current?.model, snap?.state, snap?.state?.today, snap?.state?.config, snap?.state?.models])

        // 卸载时清 body 属性。
        useEffect(() => () => {
          document.body.removeAttribute('data-tq-level')
        }, [])

        return null
      }

      slots.inject('conversation.composer.dock', () => {
        const dispose = slots.register(
          { name: 'conversation.composer.dock', id: 'token-quota-side-effect', order: 100, inject: injected },
          QuotaSideEffect,
        )
        return dispose
      })

      return () => {}
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
