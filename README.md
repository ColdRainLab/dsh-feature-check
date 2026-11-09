# dsh-feature-check（DSH 启动自检）

> 每次 DSH 启动（尤其是升级后）自动对比「上次健康启动」的基线，检查之前的功能有没有缺失：
> 哪些 Loader 条目没了、哪些客户端模块没进 `/plugins` 启动图、哪些插件包被宿主的兼容性检查整包跳过。
> 结果放在「设置 → 内置插件 → 启动自检」页里（不再占用侧栏底部）。

## 为什么需要它

DSH 升级后，宿主会按插件的 `engines.dsh` 做兼容性准入；不满足的插件会被**静默跳过**（日志里只有一行
`skipping profile bundle "<name>"`），表现就是菜单/面板/工具凭空消失。本插件把「升级后功能变少」变成
一次可见的启动自检，而不是等用户自己发现。

## 检查什么

| 检查项 | 说明 | 失败示例 |
|---|---|---|
| 客户端模块 | `/plugins` 启动图（`clientModules.graph()`）里的模块 id 与基线对比 | UI 插件被跳过 / 客户端 bundle 构建失败 |
| Loader 条目 | 当前活跃 Loader 条目名与基线对比 | 宿主侧插件没有启动 |
| 插件包诊断 | `pluginManager.listBundles()` 中「已启用但带 error」的 bundle | `incompatible-version`（升级后 engines 不匹配） |
| 升级识别 | 运行时版本与基线版本不同 | `0.2.1-rc.2 → 0.2.1-rc.3` |

仅当**本次启动健康**（无缺失）时才更新基线；发现问题时保留旧基线，后续启动会继续报告同一批缺失，直到修复。
被用户在插件页**主动禁用**的插件不算缺失（记为提示，不算问题）。

## 使用

- 打开 **设置 → 内置插件**，顶部标签栏里有一项 **「启动自检」**（与「插件列表」并列）。
- 页面内容：DSH 版本、本次是否升级、总体结论（通过 / N 项功能缺失）、缺失项（插件包 / 客户端模块 /
  宿主条目，每条带处理建议）、检查时间与报告路径；底部有「重新检查」按钮。
- 检测到问题时不弹窗打扰，只在该页显示红色结论；进入页面会自动刷新一次最新报告。
- 页面上同时说明：只读组合与模块清单，不读取会话内容。

## 文件位置

```
<DSH_HOME>/feature-check/
├─ baseline.json   # 上次健康启动的基线（Loader 条目 / 客户端模块 / 运行时版本）
├─ report.json     # 最近一次自检报告（面板展示的同一份数据）
└─ expect.json     # 可选：手工追加必须存在的条目（不会被自动改写）
```

`expect.json` 示例（用于固定某些「基线建立之后才装上、但必须一直在」的功能）：

```json
{
  "clientModules": ["dsh-session-delete", "dsh-worktable"],
  "entries": ["dsh-session-delete"]
}
```

## 路由

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/feature-check/health` | `{ ok, version }` |
| GET | `/api/feature-check/status` | `{ ok, report, pending }`（设置页读取） |
| POST | `/api/feature-check/run` | 立即重新检查并返回新报告 |

桌面端 `/api` 需要登录态，设置页通过宿主的 `__DSH_TRANSPORT__.fetch` 请求；网页端同源直接请求。

## 安装

```powershell
& "D:\Program Files\Deepseek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add "C:/Users/ROG-STRIX/.dsh/plugin-archives/dsh-feature-check/v0.1.2/dsh-feature-check-0.1.2.tgz"
```

安装后宿主热加载（无需重启），刷新页面 → 设置 → 内置插件里多出「启动自检」标签；首次启动只记录基线（页面显示「已建立功能基线」）。

卸载：

```powershell
& "D:\Program Files\Deepseek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop remove dsh-feature-check
```

卸载不会删除 `~/.dsh/feature-check/` 下的基线/报告，需要时手动删除。

## 兼容性

- `engines.dsh` 声明为 **`>=0.2.1-rc.2`（开放上界）**：补丁/小版本升级后自检插件本身也会继续加载，才能报告问题。
- 宿主服务全部通过 `ctx.get()` 防御式读取（`loader` / `clientModules` / `pluginManager`），缺失时降级为部分报告
  而不是崩溃；插件导入不依赖任何 `@deepseek-ai/*` 包。
- 已在本机 DSH `0.2.1-rc.3` 验证：自动建立基线（桌面实例 205 个 Loader 条目、79 个客户端模块）、报告生成、
  面板数据、模拟「升级后插件被兼容性跳过」时正确报出 `bundle / incompatible-version` 并保留旧基线。

## 版本记录

**0.1.2**

- 入口整合进设置：侧栏底部的「自检」状态图标与浮层面板移除，改为 **设置 → 内置插件 →「启动自检」标签页**
  （`settings.plugins.tab`，id `feature-check`，order 20），与内置「插件列表」并列。
- 页面内直接展示版本/升级情况/缺失项/建议/检查时间/报告路径与「重新检查」；进入页面自动刷新一次。
- 不再自动弹窗；侧栏 footer 只剩「垃圾箱」等其它入口（不再需要并排/分隔线样式，相关 CSS 已删除）。
- 测试：客户端 12 项（注册、标签、内容、请求、样式）全绿。

**0.1.1**

- 修复面板一直显示「未知版本 / 等待宿主完成组合」并报 `Failed to execute 'fetch' on 'Window': Illegal invocation`：
  直接取出的 `window.fetch` 被当作普通对象方法调用丢了接收者；现在始终以页面全局为 receiver 调用
  （与 dsh-session-delete 0.2.1 的同类修复一致）。
- 「自检」与「垃圾箱」两个侧栏入口并排成一行、中间一条细竖线：通过 `:has()` 只在这两个入口同时存在时把
  footer 由主题的竖排改成行排，两个入口各占一半；其它 footer 条目（工作台/二游日历/电力储备）保持整行。

**0.1.0**

- 首版：启动后自动对比基线，检查客户端模块、Loader 条目与插件包诊断；侧栏状态图标 + 启动自检面板。

## 已知限制

1. 如果 DSH 未来出现破坏性接口变化，自检插件自身也可能加载失败——那时没有自动告警，需查看 DSH 日志或手动重装新版自检插件。
2. 基线是「上次健康启动」的状态：如果功能在**第一次**启动时就已经缺失，自检不会知道它曾经存在；可在 `expect.json` 中手工固定。
3. 只能检测「宿主组合 / 启动图」层面的缺失；单个插件内部功能失效（例如自己的路由报错）不在检查范围内。
4. 不联网、无遥测；只读宿主服务并写 `~/.dsh/feature-check/` 下的两个 JSON 文件。

## 测试

```powershell
& "C:\Users\ROG-STRIX\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" plugins\dsh-feature-check\tests\host.test.mjs
& "C:\Users\ROG-STRIX\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" plugins\dsh-feature-check\tests\client.test.mjs
```

宿主 20 项、客户端 12 项，覆盖基线与报告、升级检测、缺失检测、禁用豁免、expect.json、待定状态、写入失败降级、HTTP 契约与设置页标签/内容/请求逻辑（含 fetch 接收者）。

## License

MIT
