# dsh-token-quota

> **DSH 版本兼容**：本插件按 DSH 版本分两条线维护，请按你使用的 DSH 版本选择分支。
>
> | DSH 版本 | 分支 | 说明 |
> |---|---|---|
> | **0.1.5-rc.2**（现行稳定线） | `master` | 默认分支，装它 |
> | **0.1.6-alpha.2+** | `feat/dsh-0.1.6` | strict codec 迁移到 `create` 工厂形式 |
>
> 两分支的 codec 写法互不兼容：`master` 用 `schema`（0.1.6 校验器读 `codec.create`），
> `feat/dsh-0.1.6` 用 `create: () => <zod schema>`（0.1.5 的 loader 校验器要求 `schema` 是 zod 对象）。
> 装错分支会让 `typert-loader` 在校验 strict codec 时抛错，进而使 `dsh web` 启动失败。

DeepSeek Harness (DSH) 插件：**按模型统计每日 Token 用量 + 每日配额提醒**。

- 📊 按模型累计每日 Token 用量（输入 / 输出 / 缓存 / 推理），无需联网
- 🎯 为每个模型设置每日配额（如 2M tokens），超额提醒切换模型
- 🎨 达到阈值时对话框变色提醒，可开系统通知
- 🧮 自动识别当前正在使用的模型（切换模型自动切换统计）
- 🔔 主会话 dock 只显示当前模型 + 额度 ≥90% 的模型，保持页面干净

## 安装

将本仓库作为 vendor 插件放入 DSH profile：

```bash
# 以 web profile 为例
cd ~/.dsh/profiles/web/vendor
git clone https://github.com/<your-name>/token-quota.git dsh-token-quota
# 若 vendor 目录以 npm 链接方式管理,则在 profile node_modules 中链接
```

然后在 DSH 中启用该插件即可（宿主端改动需重启 DSH Web 进程，客户端改动硬刷新浏览器生效）。

## 使用

### 设置配额

打开 **设置 → Token 额度**：

| 列 | 说明 |
|---|---|
| 启用 | 勾选后对该模型启用每日额度提醒；直接填写额度或拖动滑块也会自动启用 |
| 模型 | 模型显示名 |
| 提供商 | provider 路由 id（如 `deepseek-official`、`db`） |
| 今日已用 | 该模型今日累计 tokens（输入+输出+缓存+推理） |
| 每日额度 | 每日配额（tokens 总数），如 `2000000` = 2M |
| 占比 | 已用 / 额度百分比进度条 |
| 提醒阈值 (%) | 滑块（10–100%，默认 80%），使用量到达该百分比开始提醒 |

- 改动自动保存（600ms 防抖），无需手动点击保存
- 不勾选启用 = 只统计用量，不提醒

### 会话页 Dock

对话框下方只显示两类 chip：

1. **当前正在使用的模型**（始终显示，未设额度标注"未设额度"）
2. **额度已用 ≥90% 的模型**（接近超额或已超额，提醒切换）

其余模型不显示，避免杂乱。

### 提醒方式

- **变色提醒**：额度达到阈值时，composer 对话框边框/阴影变色（黄 = warn，红 = over）
- **系统通知**：首次触达阈值时发送系统通知

## 数据存储

- 账本：`$DSH_HOME/storages/token-quota/ledger.json`
  - `days`: 按日期 → `provider:model` → 各 token 桶（input/output/cacheRead/cacheWrite/reasoning/calls）
  - `config`: 各模型配额、变色/通知开关、通知阈值、语言
- 模型发现：从 DSH settings 服务（`llm-deepseek` / `llm-pi-ai` 等命名空间）读取；失败时回退解析 `$DSH_HOME/settings.yaml`

## 工作原理

- **记账**：宿主端包裹 `llm/stream` 事件，从 `usage` 块提取 `inputTokens / outputTokens / cacheReadTokens / cacheWriteTokens / reasoningTokens`，按 `options.provider` + `options.model` 聚合计入账本（`AsyncLocalStorage` 防嵌套重复计数）
- **模型识别**：`options.provider` 即注册路由 key（如 `deepseek-official`），`options.model` 即模型 id，拼接为 `provider:model` 账本键
- **当前模型**：会话投影 `tokenQuotaCurrent` 追踪最近一次请求/usage 携带的 model/provider，客户端 `useProjection('tokenQuotaCurrent')` 读取
- **RPC**：宿主 `ctx.provide('tokenQuota', ...)`，客户端 `remote.tokenQuota.*` 调用（`{ok, value}` 信封解包）

## 项目结构

```
dsh-token-quota/
├── package.json          # 插件元信息(名称/入口/依赖)
├── cordis.patch.yml      # DSH bundle 注入补丁
└── lib/
    ├── index.js          # 宿主端:记账 / 模型发现 / 投影 / RPC 服务
    ├── store.js          # 账本(Ledger):聚合 / 持久化 / 配额状态
    ├── client.js         # 客户端 bundle:设置页 / dock / 变色提醒
    └── typert.host.js    # Host 端 Typert 清单(RPC 类型与编解码)
```

## License

MIT
