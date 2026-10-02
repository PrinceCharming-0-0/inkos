# Reasoning Effort 分段滑轨呈现验收

## 范围与方案

基于 `feat/reasoning-effort` / `12af3dcca62210c79ef34573d96e31864fc1bfac`；开始时工作区干净。本轮不 commit、不 push。

- 保留原生受控 `input[type=range]`、六档顺序、原有显示名称、中文/英文可访问名称、键盘处理和同值写入保护。
- 使用主题 `--primary` 同时绘制进度和上方居中的当前档位。浅色主题为酒红色，深色主题为琥珀色；无随机配色或模型依赖。
- 中性胶囊轨道高 12px，节点直径 4px，白色滑块直径 20px，带细边框和轻微阴影。选中区间节点为白色，未选节点使用主题灰色。
- 节点与填充共享原生滑块的中心行程，左右各内缩 10px；胶囊端帽延伸 6px，让端点节点位于轨道内部，滑块仍完整处于输入区域。
- 桌面滑轨交互区高 32px，粗指针触摸区高 44px；档位文字行高 18px。没有位置动画，拖动及 reduced-motion 下立即同步。
- 根据后续要求，轨道左侧显示关联 label：中文“思考强度：”、英文“Effort:”。两列 grid 为标签保留自然宽度，滑轨占剩余宽度；当前档位仍在滑轨上方居中。冒号仅作视觉标点，不加入可访问名称。滑块保留原生 slider 语义、当前数值及 `aria-valuetext`，沿用项目 `:focus-visible` 焦点描边。
- Composer 的 28rem/38rem container query、ChatPage、模型同步、发送 snapshot、retry、SessionRuntime、Agent、后端协议及依赖均未修改。pi-ai 保持 0.67.1；无新增浏览器运行时 core import 或 slider 依赖。

## 修改文件

- `src/components/chat/ReasoningEffortControl.tsx`：居中档位、装饰轨道及六节点；原生输入保持行为不变。
- `src/index.css`：限定于 reasoning-effort 类名的轨道、节点、原生滑块及触摸样式。
- `e2e/reasoning-effort.spec.ts`：新增明暗主题几何、点击、双向逐档拖动、填充/文字同步、焦点、reduced-motion 和触摸测试；补充发送/附件/Skill/配图按钮不与控件交叠的断言。
- 本文：复现命令、证据与限制。

## 原有断言与截图

第一轮曾将标签隐藏并把裁切断言改为可访问名称检查；根据后续要求恢复可见标题后，现已恢复 `labelClipped === false`，并增加标签位于滑轨左侧的断言。中文 label 关联单测的文案由“推理强度”更新为用户指定的“思考强度”；关联与 disabled 行为断言保持。中英文可访问名称均有浏览器检查，新增 Chat/Play 中文标题在各 Composer 宽度下的布局验证。

档位顺序、初始 Medium、切模型不重置、附件 FileReader 等待期间调整、发送 snapshot、retry 原值、显式 options 优先、session 隔离及连续调整无 React #185 的行为覆盖未删改。无 skip/only 或 fallback。

没有更新 golden snapshot。测试重新生成忽略目录 `test-results/` 下的截图；已人工查看两主题 None/Max 端点和焦点、窄 Composer、Play 断点两侧及完整 Play 页面。视觉变化均来自本次方案：描述标签置于轨道左侧，当前档位在轨道上方居中，浏览器默认细线换成胶囊进度和六圆点，白色滑块及完整焦点轮廓。截图中两端滑块完整，节点间距均匀，明暗主题可辨；查看世界、发送、附件和配图按钮布局正常。

## 最终验证

最终使用仓库声明的 pnpm 9.15.9（机器默认 9.15.0，仅用于初轮检查）。从仓库根目录运行：

```sh
pnpm dlx pnpm@9.15.9 --filter @actalk/inkos-studio test -- \
  src/components/chat/__tests__/ReasoningEffortControl.test.ts \
  src/store/chat/slices/message/action.test.ts \
  src/store/chat/slices/message/runtime.test.ts \
  src/pages/chat-selection-sync.test.ts \
  src/pages/chat-page-service-scoping.test.ts \
  src/api/reasoning-effort-wire.test.ts
pnpm dlx pnpm@9.15.9 --filter @actalk/inkos-studio typecheck
pnpm dlx pnpm@9.15.9 --filter @actalk/inkos-studio build
pnpm dlx pnpm@9.15.9 --filter @actalk/inkos-studio exec playwright test e2e/reasoning-effort.spec.ts
git diff --check
```

| 检查 | 结果 |
| --- | --- |
| Studio 定向测试 | 6 文件、120 项通过 |
| Studio typecheck | 客户端及 server 均通过 |
| Studio production build | Vite 及 server 均通过 |
| 正式 Playwright 配置 | 最终 21 项通过，包含中英文标题布局 |
| 最终 diff 审查及空白检查 | 通过；依赖清单、锁文件、core、ChatPage、Playwright 配置无 diff |

Playwright 使用正式配置及其 globalSetup，重建 Core 并启动 4580/4581 专用服务。已有匹配 Chromium 可用，未修改浏览器路径、缓存版本或依赖。若复现环境缺浏览器，可执行：

```sh
pnpm dlx pnpm@9.15.9 --filter @actalk/inkos-studio exec playwright install chromium
```

检查覆盖视窗 768/1024/1280px，以及 Composer max-width 设置 240/300/360/440/520/600/640/760px；断点判断使用实际测量的 container 内容宽度，而不是视窗宽度或设置值。现有输入行会限制最小实际布局宽度，因此这些 max-width 设置不等于承诺 Composer 能实际缩至 240px。

初轮新增两项主题测试失败于 Chromium 伪元素尺寸读取：`getComputedStyle(input, '::-webkit-slider-thumb').width` 返回整个 input 的 264px，而非滑块尺寸。改为读取共享的 20px CSS token，并结合真实指针行程、六点几何与端点截图校验；未降低任何原有行为断言。后续 19 项全部通过，端帽修整后再次完整通过。无未解决测试失败。构建仍有 Vite 大 chunk、npm 环境配置及 SQLite experimental 提示。

## 左侧标题补验

在已完成的滑轨上显示中文“思考强度：”和英文“Effort:”，不改交互及数据流。复用上述命令重跑控件单测（12 项通过）、Studio typecheck、production build；浏览器完整 spec 增加两项中文布局检查。标题补验中发现两处几何测量时序问题：外部字体加载改变标签宽度，以及打开世界面板时跨动画帧读取控件与按钮的位置。测试现在等待 `document.fonts.ready`，并在同一帧收集控件与按钮的全部矩形，保留原有几何精度、不交叠及行为断言。最终正式 Playwright 完整 spec 21/21 通过；中英文、明暗主题及窄布局截图已复核。`git diff --check` 通过。

## 验证边界

- 360/600px 极窄视窗仍受既有固定侧栏和输入行最小宽度影响：footer 右边界 604px，隐藏本控件后仍相同。本轮按范围不重构 App shell。
- 浏览器验收为正式配置的 Chromium，含触摸模拟；没有验证真实手机、Firefox/WebKit 或真实屏幕阅读器。CSS 包含 Gecko 原生滑块样式，但不据此声称跨浏览器已验收。
- 沿用已验收的数据流。本轮未重跑 Core 全套 cached Agent/真实 stream 测试，亦未访问真实模型服务；相关实现与测试无修改。Studio 状态、snapshot、retry 与本地协议 wire 回归及浏览器契约已通过。
