# Reasoning Effort 最终集成验收

本次验收以 `integration/my-inkos` 的 `c2bfbd0e` 为基点，包含阶段 1–4 已有实现及阶段 5 的必要修复。依赖清单和 `pnpm-lock.yaml` 未修改；pi-ai 与 pi-agent-core 均保持 0.67.1，无新增 slider 依赖。最终检查使用仓库声明的 pnpm 9.15.9（通过 `pnpm dlx pnpm@9.15.9` 调用）。

## 最终行为

- Chat/Play 的 Composer 仅有 `none | low | medium | high | xhigh | max` 六态，新加载的 session 默认 Medium；状态仅保存在 session 内存中。
- `low/medium/high/xhigh` 交给 pi-ai 0.67.1 生成 payload，保留模型能力判断、xhigh 映射、Anthropic adaptive/budget/non-reasoning 分支。
- `none/max` 不传入 pi-ai ThinkingLevel，在最终 payload 按已解析的 authoritative API 原值写入：chat 的 `reasoning_effort`、responses 的 `reasoning.effort`、anthropic 的 `output_config.effort`。None 不删除字段，也不强制 Anthropic adaptive thinking。
- 用户显式配置的 apiFormat 优先于 preset；自动填充的默认值不覆盖 preset。payload 字段位置从实际 adapter API 反向解析，不根据 provider/model 名称猜测。
- 旧 onPayload 的原地修改、返回替换对象与异步修改均保留。None/Max 的受控字段由 InkOS 最后覆盖；四档继续沿用 pi-ai/旧 callback 的策略，不强制回写原始档位。
- ChatPage 在附件 FileReader 等待前捕获 effort；sendMessage 在草稿落盘的首次 await 前建立 snapshot。显式 options 优先，失败重试复用失败 snapshot；发送中改 slider 仅影响下一轮。
- cached Agent 不把 effort 放入模型身份或 cache key。同一轮的工具后续模型调用沿用同一 snapshot；排队、并行 session、取消、provider 失败及 callback 失败均有真实 stream 回归测试。
- 未传 effort 的旧调用方保留原行为。Chat 的 snapshot 不传给 native pipeline、后台生产任务或 sub_agent 的共享 client。

## 阶段 5 修复与补验

修复 sendMessage 的时间戳碰撞：用户消息恰好与 streamTs 相同，曾被误判为已有流式回复，导致实际回复丢失。两个 hasStream 判断现在同时要求 assistant role。新增确定性时间戳回归测试，没有放宽断言。

新增 Studio `src/api/reasoning-effort-wire.test.ts`：贯通 `/agent → runAgentSession → guardedPiStream → pi-ai adapter → SDK 序列化 → 本地 HTTP`，覆盖三协议六态、无 effort、显式协议覆盖 preset、non-reasoning 模型及 None/Max 拒绝后返回应用错误且只有一次 HTTP 请求。真实 adapter 与 reasoning boundary 均未 mock；内置服务测试只在 fetch 传输处改写 host 至 localhost，保留实际路径、headers 和 body。

Core `chat-reasoning-wire.test.ts` 还覆盖 cached Agent 历史、多轮 effort、工具后的第二次模型调用、会话排队与并发、取消后旧调用以及 callback error event。callback 故障测试只给真实 adapter 增加抛错 callback，仍执行 guardedPiStream 的 reasoning 组合；断言 Agent 应用结果含错误、收到 error assistant message，且 HTTP 请求数为零。

Playwright 使用正式 `packages/studio/playwright.config.ts`。附件用真实 FileReader 的可控释放验证等待期间改 slider；增加失败重试测试与实际 container 宽度/grid area 断言。Chat 的 28rem、Play 的 38rem 两侧均覆盖；视窗 768/1024/1280px 和 Composer 最大宽度 240/300/360/440/520/600/640/760px 下检查溢出、交叠、标签/值裁切及 slider 宽度，同时验证查看世界和自动配图按钮。连续键盘、fill、拖动无 React #185 或 Maximum update depth 错误。

## 最终 provider 请求体证据

以下表格来自本地 HTTP 服务器对最终 JSON request body 的解析断言，不是 `/agent` 入参或 SimpleStreamOptions。Chat/Responses 使用 reasoning-capable `gpt-5.4`，Anthropic 使用 `claude-opus-4-6`。

| 输入 snapshot | Chat `reasoning_effort` | Responses `reasoning.effort` | Anthropic `output_config.effort` | Anthropic `thinking.type` |
| --- | --- | --- | --- | --- |
| none | none | none | none | disabled |
| low | low | low | low | adaptive |
| medium | medium | medium | medium | adaptive |
| high | high | high | high | adaptive |
| xhigh | xhigh | xhigh | max（pi-ai 映射） | adaptive |
| max | max | max | max | disabled |

例如 Max 的最终 body 投影为：

```json
{"model":"gpt-5.4","reasoning_effort":"max"}
{"model":"gpt-5.4","reasoning":{"effort":"max"}}
{"model":"claude-opus-4-6","thinking":{"type":"disabled"},"output_config":{"effort":"max"}}
```

另有真实 wire 断言：普通 reasoning 模型 xhigh 被 pi-ai clamp 为 high；Anthropic Sonnet 4.6 xhigh 映射 high；Claude 3.7 Medium 使用 `{ "type": "enabled", "budget_tokens": 8192 }` 而非 output_config；non-reasoning 模型不因四档被强制生成 effort。无 effort 时 Chat 不生成 reasoning_effort、Responses 保留 pi-ai 的 none 默认、Anthropic 保留 disabled 且无 output_config。

## 检查命令与结果

从仓库根目录运行。表中 `pnpm` 指 9.15.9；本次实际入口为 `pnpm dlx pnpm@9.15.9` 加相同参数。

| 检查 | 命令 | 最终结果 |
| --- | --- | --- |
| Core targeted | `pnpm --filter @actalk/inkos-core test -- src/__tests__/reasoning-effort.test.ts src/__tests__/reasoning-wire.test.ts src/__tests__/chat-reasoning-wire.test.ts src/__tests__/api-format-authority.test.ts src/__tests__/agent-session.test.ts src/__tests__/service-resolver.test.ts` | 6 文件，167 项通过 |
| Studio targeted | `pnpm --filter @actalk/inkos-studio test -- src/api/reasoning-effort-wire.test.ts src/api/server.test.ts src/store/chat/slices/message/action.test.ts src/components/chat/__tests__/ReasoningEffortControl.test.ts` | 4 文件，296 项通过 |
| Core full | `pnpm --filter @actalk/inkos-core test` | 199 文件，1,982 项通过 |
| Studio full | `pnpm --filter @actalk/inkos-studio test` | 64 文件，730 项通过 |
| Core typecheck | `pnpm --filter @actalk/inkos-core typecheck` | 通过 |
| Studio typecheck | `pnpm --filter @actalk/inkos-studio typecheck` | 客户端与 API server 通过 |
| CLI typecheck | `pnpm --filter @actalk/inkos typecheck` | 通过 |
| Core build | `pnpm --filter @actalk/inkos-core build` | 通过 |
| Studio production build | `pnpm --filter @actalk/inkos-studio build` | Vite 与 API server 构建通过 |
| CLI build | `pnpm --filter @actalk/inkos build` | 通过 |
| Playwright spec | `pnpm --filter @actalk/inkos-studio exec playwright test e2e/reasoning-effort.spec.ts` | 16 项通过 |
| Diff | `git diff --check` 和最终逐文件审查 | 通过 |

浏览器可复现安装/运行命令：

```sh
pnpm dlx pnpm@9.15.9 --filter @actalk/inkos-studio exec playwright install chromium
pnpm dlx pnpm@9.15.9 --filter @actalk/inkos-studio exec playwright test e2e/reasoning-effort.spec.ts
```

正式配置的 globalSetup 会重建 Core，并启动专用 4580/4581 E2E 服务。没有独立/临时配置，没有指定浏览器 executablePath、机器路径或缓存版本。截图及外层布局 JSON 附件生成在忽略的 test-results 下。

### 验收期间失败的归类

- **实现缺陷**：时间戳碰撞导致回复丢失，已最小修复并通过定向及 Studio 全量复验。
- **fixture 错误**：新配置最初缺 provider/baseUrl 必填字段；stub 环境变量用 `"0"` 时被现有 Boolean 开关视为启用；HTTP 路径预期未计入 preset 的 `/v1` 前缀；provider 错误的状态码预期与既有 AGENT_ERROR 分类不符。均修正 fixture，再执行完整断言。
- **早期 fixture 路由错误**：内置 MiniMax Chat 的旧 baseUrl 解析使用 preset host，初次 fixture 未截获 fetch，向真实 host 发出假 test-key 请求，收到 401/404；未使用真实凭证，这些响应不计入 provider 能力验收。最终通过的 wire suite 均强制传输至 localhost。
- **环境**：初始机器 pnpm 为 9.15.0，corepack 不存在；最终采用显式 pnpm 9.15.9。匹配 Playwright 的 Chromium 用项目 CLI 安装成功。错误 CLI filter `@actalk/inkos-cli` 返回无匹配，已按 package.json 的实际名字 `@actalk/inkos` 重跑。
- **命令选择**：`test:e2e -- <spec>` 的 literal `--` 曾使 Playwright选择全部 spec，已中止该误选运行，改用上述准确 exec 命令；该运行不计为通过。
- **非失败输出**：现有 SQLite experimental warning、Vite 大 chunk 提示及 npm 环境配置 warning 仍出现；所有最终必需命令退出码为 0，无未解决失败。

## 遗留限制与未验证事项

| 限制描述 | 影响范围 | 验证边界/未验证原因 | 后续任务 | 阻塞当前交付 |
| --- | --- | --- | --- | --- |
| 真实 provider 是否支持 None/Max 或特定四档，未做有效能力验收 | 各真实 endpoint/model 的成功率与协议兼容性 | 使用本地 mock HTTP 和假凭证；早期 401/404 只反映无效 fixture 路由/认证，不证明 effort 支持。真实拒绝应返回应用错误，不改档、不降级重发 | 有真实 endpoint/凭证后可另做能力矩阵；不要求本阶段执行 | 否 |
| 内置服务的 preset baseUrl 必须与显式 apiFormat 的 provider 路由匹配；覆盖 format 不会自动重写 host/path | 显式选择与 preset 不同协议的内置服务；例如带 `/v1` base 的 Anthropic adapter 会再追加 `/v1/messages` | 本地已证明实际 adapter、路径与字段；没有验证该内置真实 endpoint 提供相应路由。旧 baseUrl 选择逻辑不在本阶段重构 | 使用符合所选协议 baseUrl 的 custom 服务；若要统一内置 baseUrl 配置，另立任务 | 否，协议选择和 raw effort 的本地契约已通过 |
| 固定侧栏挤压极窄窗口的 Chat 外层布局 | 360/600px 视窗；不是 Composer container query 的支持宽度测试 | 已测得侧栏 260px、footer 左边界 288px、右边界 604px，隐藏 effort 控件后右边界仍相同。HEAD 中 Sidebar、App 外层与 Composer 输入行的既有布局一致；本阶段不做外层响应式重构 | 需要独立 App shell 响应式布局任务 | 否，属于已确认既有限制 |
| 浏览器交互只在项目默认 Chromium 验收 | Firefox、WebKit、移动端浏览器与真实辅助技术 | 仓库正式配置仅使用默认 Chromium；本阶段覆盖原生 range 的键盘及 aria DOM 契约，未做跨浏览器/屏幕阅读器专项 | 若产品需要这些平台，另做兼容性验收 | 否 |
