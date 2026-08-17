# TRAE 活动余票监测器设计

日期：2026-08-17  
状态：已确认

## 1. 目标

构建一个运行在 Cloudflare Workers 免费计划上的余票监测器。它定期读取 TRAE AI 创造力大赛小程序使用的公开时段接口，在用户关注的时段从无票变为有票时，通过 Bark 向 iPhone 推送通知。用户点击通知后打开微信，再从最近使用的小程序进入活动页面完成手动预约。

系统只读取公开余票数据，不自动占位、预约或提交订单，也不绕过验证码、排队、风控或其他安全机制。

## 2. 已确认的数据源

公开接口：

```text
GET https://trae-party-2026.siliconpear.cn/api/v1/time-slots
```

该接口无需 Cookie、登录令牌、查询参数或请求体。监测器只使用下列字段：

- `code`
- `starts_at`
- `ends_at`
- `is_active`
- `is_available`
- `remaining`
- `unavailable_reason`
- `display_time`
- `updated_at`

初始默认关注：

- `D1-1200`：2026-08-21 12:00–14:00（北京时间）
- `D1-1400`：2026-08-21 14:00–16:00（北京时间）

关注范围可在部署后的手机管理页面中修改，不局限于这两个默认时段。

## 3. 架构

系统由三个边界清晰的部分组成：

### 3.1 Worker 入口层

职责：

- 接收 Cloudflare Cron 的每分钟触发。
- 提供手机管理页面及受保护的管理 API。
- 把定时检查和管理操作转发给唯一的 Durable Object 实例。
- 拒绝未授权的管理请求，不在日志中记录凭据。

Worker 不自行保存业务状态，从而避免定时触发和手机操作并发时产生重复通知。

### 3.2 Monitor Durable Object

职责：

- 串行处理所有检查与配置变更。
- 持久化关注配置、各时段状态和监测健康状态。
- 请求公开余票接口并验证响应结构。
- 执行状态转换和推送判定。
- 调用 Bark 推送接口。

使用 SQLite 后端的 Durable Object，以获得单实例串行执行和强一致状态。数据量极小，免费额度足够本次活动使用。

### 3.3 手机管理页面

职责：

- 在 iPhone Safari 中列出所有 `is_active=true` 且尚未开始的时段。
- 显示时段、当前状态、剩余数量和最后检测时间。
- 允许多选关注时段并保存。
- 提供“立即检查”和“发送测试通知”操作。
- 显示最近一次错误，但不显示任何 Secret。

管理页面保持单页、移动端优先，不引入前端框架。

## 4. 管理接口与鉴权

Worker 提供以下路由：

- `GET /`：返回管理页面外壳，不包含监测数据或 Secret。
- `GET /api/status`：返回候选时段、关注配置、最后检测结果和健康状态。
- `PUT /api/config`：保存 `{ "watchedCodes": string[] }`。
- `POST /api/check`：立即执行一次真实余票检查。
- `POST /api/test-notification`：发送一次 Bark 测试通知。

所有 `/api/*` 路由必须携带：

```text
Authorization: Bearer <ADMIN_TOKEN>
```

管理页面要求用户输入 `ADMIN_TOKEN`，并只将其保存在当前浏览器标签页的 `sessionStorage` 中。页面关闭后需重新输入。API 响应统一设置 `Cache-Control: no-store`，并仅允许同源请求。

鉴权失败返回 `401`。`ADMIN_TOKEN` 和 `BARK_DEVICE_KEY` 均通过 Cloudflare Secret 注入，不写入代码、持久化状态、响应或日志。

## 5. 持久化状态

Durable Object 保存以下逻辑结构：

```text
config:
  watchedCodes: string[]
  normalIntervalMinutes: 5
  fastWindowHours: 24

slots[code]:
  observedState: unknown | sold_out | available | ended
  lastRemaining: number | null
  lastCheckedAt: ISO timestamp | null
  lastNotifiedAt: ISO timestamp | null
  notificationPending: boolean

health:
  consecutiveSourceFailures: number
  sourceFailureNotificationPending: boolean
  sourceFailureNotified: boolean
  recoveryNotificationPending: boolean
  lastSuccessAt: ISO timestamp | null
  lastErrorAt: ISO timestamp | null
  lastErrorSummary: string | null
```

不保存官方接口的完整响应。错误摘要必须去除 URL 查询、请求头、响应正文和堆栈中的潜在凭据。

## 6. 调度规则

Cloudflare Cron 使用：

```cron
* * * * *
```

Cron 按 UTC 触发，但所有活动时间通过接口中带时区偏移的 ISO 时间戳转换为 epoch 后比较，避免服务器时区差异。

每次触发时：

1. 读取关注配置。
2. 排除已经到达 `starts_at` 的时段，并把它们标记为 `ended`。
3. 如果没有尚未开始的受关注时段，直接结束，不请求官方接口。
4. 如果任一受关注时段距离开始不超过 24 小时，则本分钟执行查询。
5. 否则仅在北京时间分钟数能被 5 整除时执行查询。

因此，默认配置下：

- 2026-08-20 12:00 前，每 5 分钟实际查询一次。
- 2026-08-20 12:00 起，每分钟实际查询一次。
- `D1-1200` 到 2026-08-21 12:00 停止。
- `D1-1400` 到 2026-08-21 14:00 停止。
- 之后若没有其他未来的受关注时段，系统保持部署但不再访问官方接口。

## 7. 配置变更规则

- 管理页面只允许选择最近一次成功响应中存在、处于活动状态且尚未开始的时段。
- 保存空数组表示暂停全部监测。
- 新增关注时段时，将其初始状态设为 `unknown`，保存成功后立即执行一次检查。
- 取消关注时段后立即停止对其进行状态转换和通知，但保留最近状态供页面显示。
- 重新关注已取消且尚未开始的时段时，将其重置为 `unknown`，以便当前已有票时立即提醒。
- 配置写入和立即检查由同一 Durable Object 串行执行。

## 8. 余票状态机

对每个仍受关注且尚未开始的时段，使用以下判定：

```text
available = is_active === true
            AND (is_available === true OR remaining > 0)
```

状态转换：

- 首次成功查询且 `available=true`：`unknown → available`，立即创建待推送通知。
- 首次成功查询且无票：`unknown → sold_out`，不推送。
- `sold_out → available`：立即创建待推送通知。
- `available → available`：更新剩余数量和检查时间，不重复推送。
- `available → sold_out`：重新布防；以后再次变为有票时重新推送。
- 到达 `starts_at`：转为 `ended`，不再恢复。

当接口字段出现矛盾，例如 `is_available=false` 但 `remaining>0`，采用“任一字段表示有票即提醒”的保守策略，以降低漏报风险。通知会展示接口返回的剩余数量，用户仍需在小程序中确认。

## 9. Bark 推送

余票通知包含：

- 标题：`TRAE 有票：<display_time>`
- 正文：时段日期、剩余数量、北京时间检测时间，以及“请打开微信手动预约”。
- 分组：`trae-ticket-monitor`
- 醒目提示音。
- 点击动作：打开 `weixin://`；若 iOS 或 Bark 不允许该 Scheme，则保留通知正文中的手动打开提示。

只有 Bark 返回成功后，才清除 `notificationPending` 并写入 `lastNotifiedAt`。推送失败时保留待推送状态，在下一次实际检查时重试，不把失败误记为已通知。

## 10. 异常与恢复

单轮源接口异常包括：

- 网络或 8 秒超时。
- HTTP 状态不是 `200`。
- 响应不是合法 JSON 数组。
- 受关注时段缺少必要字段。

异常处理：

- 不改变任一时段的 `observedState`。
- 增加 `consecutiveSourceFailures`。
- 下一次符合频率规则的触发继续检查，不在同一轮额外重试，避免放大接口负载。
- 连续 3 轮失败后，发送一次“监测异常”Bark 通知。
- 异常持续期间不重复发送健康告警。
- 如果异常通知尚未成功发送而源接口已经恢复，则取消这条过时的待发送异常通知，不再补发。
- 恢复成功后清零失败计数；只有此前已经成功发送过异常通知时，才发送一次“监测已恢复”。

Bark 自身失败不计入源接口失败次数。失败的余票通知会保持待发送状态；异常和恢复通知则按照上面的时序规则决定重试或取消，避免发送已经失效的健康状态。

## 11. 日志与隐私

允许记录：

- 触发时间和是否因频率规则跳过。
- 关注时段代码。
- HTTP 状态、耗时和响应结构验证结果。
- 状态转换和 Bark 成功/失败布尔值。

禁止记录：

- `ADMIN_TOKEN`。
- `BARK_DEVICE_KEY` 或完整 Bark URL。
- `Authorization` 请求头。
- 官方接口完整响应。
- 用户从 HAR 中提供的任何其他请求或个人资料。

用于接口分析的 HAR 不进入项目文件或版本控制。

## 12. 测试策略

### 12.1 单元测试

- 北京时间普通频率与活动前 24 小时快速频率的边界。
- 每个时段在其 `starts_at` 独立停止。
- `unknown`、`sold_out`、`available`、`ended` 的全部有效转换。
- 字段矛盾时的保守有票判定。
- 取消、重新关注和空关注列表。
- 连续失败、单次异常通知和恢复通知。
- Bark 失败时保留待发送状态。

### 12.2 Worker 与 Durable Object 集成测试

- 未授权、错误 Token 和正确 Token。
- 配置校验与持久化。
- Cron 与手动检查并发时不产生重复通知。
- 模拟源接口响应和模拟 Bark 响应，不对官方接口进行高频测试。
- API 响应设置 `Cache-Control: no-store` 且不泄露 Secret。

### 12.3 部署验证

- 保存默认两个时段并确认状态页显示当前无票。
- 只执行一次真实接口检查。
- 只执行一次 Bark 测试推送，并验证点击后能否打开微信。
- 验证 Cloudflare Cron 已注册并能更新最后检查时间。

## 13. 部署与交付

项目交付内容：

- TypeScript Worker 源码。
- Durable Object 与管理页面源码。
- Cloudflare Wrangler 配置和 Cron 配置。
- 自动化测试。
- 从 iPhone 完成 Cloudflare Secret 配置、部署验证和 Bark 测试的说明。

Cloudflare Worker 免费计划每天 100,000 次请求；每分钟一次 Cron 约为每天 1,440 次，远低于该限制。SQLite 后端 Durable Objects 也可用于免费计划。参考：

- [Cloudflare Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [Bark push API](https://github.com/Finb/Bark/blob/master/docs/en-us/tutorial.md)

## 14. 非目标

本项目不包含：

- 自动预约、自动提交订单或自动占位。
- 模拟点击微信小程序界面。
- 绕过验证码、登录、排队、风控、证书固定或其他安全机制。
- 多用户账号系统、付费功能或通用票务平台。
- 保存微信 Cookie、Token、手机号或报名资料。
