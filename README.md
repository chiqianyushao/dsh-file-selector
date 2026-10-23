# dsh-file-selector

[![ci](https://github.com/chiqianyushao/dsh-file-selector/actions/workflows/ci.yml/badge.svg)](https://github.com/chiqianyushao/dsh-file-selector/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/dsh-file-selector.svg)](https://www.npmjs.com/package/dsh-file-selector)
[![license](https://img.shields.io/npm/l/dsh-file-selector.svg)](LICENSE)

给 DSH（DeepSeek Harness）**自带**的文件浏览器和文档预览补上「选择」这一半：把文件路径，或预览里
划选出的行范围，追加进输入框草稿。**永远不会自动发送** —— 代码里没有任何一处调用 `submit`。

> **English** — adds the missing *selection* half to the harness's built-in file browser and document
> preview: right-click a tree row, or a text selection inside a preview, to append that path (or line
> range) into the composer draft. It never sends anything.

## 安装

```bash
dsh plugin add dsh-file-selector                     # 从 npm
dsh plugin add chiqianyushao/dsh-file-selector       # 或直接从 GitHub
```

DSH Desktop：侧栏 **插件** → **添加插件** → 粘贴 `https://github.com/chiqianyushao/dsh-file-selector`
→ 安装 → **重启 DeepSeek Harness**。桌面端的 profile 由 Electron 独占，所以不要用
`dsh plugin --profile desktop …` 装。

仓库里已提交 `lib/`，因此从 GitHub 安装时**不需要构建、也不需要授权构建脚本**。零运行时依赖 ——
客户端 bundle 只 `require('react')`。

围绕 harness 0.1.5 重写过一次，又跟着 0.1.7 修过一次 API 漂移（见下方「这个接缝动过一次」）。
0.1.5 起 harness 自己带了工作区文件树（`@deepseek-ai/dsh-client-ui-sidebar-files`）和文档预览
（`@deepseek-ai/dsh-client-ui-sidebar-documentpreview`），所以更早那套「自己画一棵树 + 自己写两条
host 路由 + 自己读文件」的实现全部删掉了：**不再有任何 host 面**（无路由、无 fs、无鉴权代码），
客户端 bundle 只 `require('react')` 一个模块。

当前适配：**DSH Desktop 0.12.0 / harness 0.2.0-rc.2**（作者本地运行版本）；最初围绕 0.1.5–0.1.7
写成，0.1.7 上验证过。插件版本 0.2.1。

---

## 一、用起来是什么样

| 你在哪 | 手势 | 结果 |
|---|---|---|
| 右侧栏文件树里的某一行 | 右键 | 菜单两行：`添加到对话` / `复制路径` |
| 预览里划选一段后右键 | 右键 | `添加到对话（第 5-7 行）` / `复制路径` |
| 预览标签页本身 | 右键（dockkit 的标签菜单） | 末尾多一行 `添加到对话（…）` |

追加进草稿的**只有引用文本**，一行一条，永远不搬文件内容：

```
src/main.ts
src/client/index.ts:5-7
README.md:12
```

路径会尽量缩成相对工作区的写法：文件树用它 DOM 上自己的 `data-files-root` 当根，预览用地址里
已经相对的路径。二进制、超大文件、markdown、图片都能引用 —— 因为根本不读内容。

草稿是**追加**（读当前 draft → 拼一行 → 整体写回），因为 `inputActions.setDraft` 是整体替换语义、
没有 append。写完之后还会**回读确认**（见下）。

---

## 二、为什么是这三个面、两个机制

不是选出来的，是把 harness 的扩展点翻完之后剩下的：

1. **`sidebar.right.tab.menu.item`（官方 slot，主力）**。这是官方 slot 契约表里右侧栏唯一的 `list` 槽，
   原话是「Extra items at the end of one tab's actions menu」。owner 交过来的是 `{ tab, dismiss }`，
   加上 session 作用域的标准 prop `inputActions` / `useInput` / `useSessions` / `sessionId` ——
   于是写草稿这件事**完全走公开接口**。`tab.contentId` 就是
   `dsh-resource://file/session/<sid>/<path>`，解出路径即可；不是文件地址的标签页（文件树自己、guide）
   就渲染 `null`。
2. **两个委托式 `contextmenu`**，补官方没给菜单的地方：文件树的**行**（选中一个文件而不必先打开它），
   以及预览里的**文字选区**（行范围）。两者都读官方自己的 DOM 钩子 —— `data-files-entry` /
   `data-files-path` / `data-files-root` / `data-textpreview-body` / `data-textpreview-url` /
   `data-textpreview-line`，也就是 harness 自己的 `scrollToLine` 导航时用的那批属性。

为什么不是别的：

- **行级动作没有 slot**。`sidebar.right.pane.tab` 和 `sidebar.right.tab.document` 都是 `keyed`
  （一个 key 一个 occupant），文件树的行上也没有任何注入点。要「在自带的行上右键」就只剩 DOM 委托。
- **`slash/input-insert-text` / `-reference` 用不了**。这两个事件看着像官方插入通道，但
  `insertText(text, span)` 第一行就是 `if (span.draftRev !== this.rev) return false` ——
  span 是触发器 picker 的「pick 时刻快照」，从外部伪造就是和一个我读不到的 revision 做 CAS。
  所以仍然是 `inputActions.setDraft`。
- **不用 `@path` 原生引用语法**。那会把内容重新拉进来（host 的 `fileReferences` seam 会展开），
  与「只要路径」相悖。引用文本里没有 `@`，因此不会被当成引用语法解析。

### 委托式右键的草稿能力是从哪来的

两条委托式手势跑在 React 之外，拿不到 slot 的 prop。它们问框架自己要：拿到**当前 session 的
standard-source binding**（`{ key, ctx, hooks, keyedHooks, props }`，就是框架发给 slot occupant 的那一份），
其中 `props.inputActions` 是写草稿的动作面、`hooks.input` 的 `getSnapshot().draft` 是当前草稿。
**每次手势现解**，不缓存、不经过任何组件。

这两个服务刻意走 `ctx.get` 而不是 `ctx.sessions` 属性读取：属性读取要求 `inject` 声明，
而声明了 `inject: ['sessions','uiSession']` 的插件在缺少它们的组合里**根本不会激活**；
`get` 是「无需 inject 的读取」那条官方通道，于是缺服务只会退化成一行说明，而不是手势中途抛错、
也不是整块功能消失。

早先这里还用过「在 `conversation.composer.dock` 里塞一个隐形组件，把 `inputActions` 发布到模块级变量」——
错了两次：composer 只在有 extension zone 时才渲染那个 slot，所以 zone 不在时菜单直接变死；
而且「最后一个渲染的 occupant」未必是读者正在指的那个 session。

#### 这个接缝动过一次，第二次就靠它自己报出来了

| harness | 当前 binding 怎么拿 | session id 从哪来 |
|---|---|---|
| 0.1.5-rc.2 | `uiSession.resolve(sessionId)` | `sessions.list.getSnapshot().current` |
| **0.1.7-rc.2** | `uiSession.adapter.current.getSnapshot()` | **binding 自己的 `key`** —— 列表不再发布 `current` |

升到 0.1.7 后本插件直接退化成了「添加到对话不可用」：它查的 `list.current` 已经没了。
两个教训都写进代码了：

1. **session 身份取 binding 的 `key`，不取列表的投影**。列表 `current` 和 binding 的 `key` 是同一个
   事实的两种投影，我挑了错的那个；而 app 自己的右侧栏读的正是 `adapter.current.getSnapshot().key`。
2. **兼容阶梯 + 指名道姓的失败原因**。`currentBinding()` 先试新形状再试旧形状，全都失败时那行菜单会写
   `uiSession exposed no current-session binding` —— 正是这行字把「升级后坏了」变成一句话的诊断，
   而不是又一次「点了没反应」。测试台会**双向**演练这个阶梯（两种形状各跑一遍），
   并断言第三种未知形状必须报出接缝名。

### 行号是怎么算出来的

预览按文件类型换 body：纯文本走 `[data-textpreview-line="N"]` 一行一个属性；高亮代码把活交给
primitives 的 `CodeBlock`，画的是 `pre .line`。两条路都读，规则和 harness 自己的 `scrollToLine`
一致（`pre .line` 取全局序号 +1）。另外：拖到某行**行首 offset 0** 收尾时，那一行其实一个字都没选中，
行尾要退一行。

### 为什么要有「记住选区」

行范围最自然的入口是标签菜单，而**右键标签会把预览里的 DOM 选区清掉** —— 手势本身毁掉了它想引用的
东西。所以有一个 `selectionchange` 监听把最后一次落在预览里的选区连同它所属的文档地址记下来，
标签菜单再用。带地址校验，所以 A 文件的选区不会串到 B 文件。预览内的右键则只用**实时**选区：
右键落在选区内 Chromium 不会清选区，落在别处就说明用户要的是整个文件，这时用记忆值反而是错的。

### 为什么菜单点了没反应（两次）

菜单是手写的 body 级元素，所以「点一下」这件事必须自己保证。踩过两个都只在真实浏览器里成立的坑：

1. **`blur` 用了捕获阶段**。`blur` 不冒泡，只有捕获态的 window 监听器能听到后代的 blur ——
   而**点一行本身就是一次焦点转移**：composer 的编辑器失焦 → 这个监听器把菜单拆了 →
   行从文档里消失 → `mouseup` 落空 → 那个本该执行动作的 `click` **根本没被派发**。
   两行同时失效，就是这个原因。现在这个监听器是普通（非捕获）的：window 自己的 blur 仍然会关菜单，
   后代的不再会。
2. **写草稿没有回读确认**。`setDraft` 接受了却没落到草稿上，和「点击根本没发生」在外部完全一样。
   现在写完会回读同一个 store 确认，不匹配就**在屏幕上**报出来（不是只打 console ——
   浏览器 console 不进 harness 日志，只打日志的失败等于没人看得见）。

同样的原则也用在剪贴板上：异步 `writeText` 被拒时回退到 selection + `execCommand('copy')`，
两条都失败才报出来；以前那个 `.catch(() => {})` 把拒绝吞掉了，所以「复制路径没反应」看起来和
「添加到对话没反应」一模一样。

---

## 三、布局

```
src/index.ts           host 半 —— 故意是空的（无服务/无路由），只为让 bundle row 合法
src/client/index.ts    全部功能：地址解析 / 选区与行号 / 兼容阶梯 / tab 菜单行 / 委托式右键菜单
cordis.patch.yml       bundle patch：插入一行，按包名解析，无 config
scripts/build.mjs      零依赖构建：stripTypeScriptTypes + 包成 module-loader 工厂
scripts/verify.mjs     98 项校验，含假 DOM + 假 React + 假 sessions/uiSession 的行为测试台
```

```bash
node scripts/build.mjs     # -> lib/index.js, lib/client.js
node scripts/verify.mjs    # 98 checks
pnpm test                  # 两个都跑
```

typescript 只用 Node 自带的 `stripTypeScriptTypes` 擦除，没有打包器、没有网络安装。

### verify 是真的在跑插件

每一轮 bug（读未 inject 的 Cordis 服务 → HTTP 400、z-index 压住菜单、React 身份不稳导致树被重置、
草稿写入依赖一个条件渲染的 slot、捕获态 blur 让 click 根本没发生、`uiSession` API 漂移）
**全都是客户端运行时问题**，源码级检查一个都看不见。所以 `scripts/verify.mjs` 会把真的
`lib/client.js` 物化在一个假 DOM + 假 React + 假 `sessions`/`uiSession` 上，然后**驱动它**：
右键一个树行、点弹出的那一行、在预览里造一个选区、渲染 slot occupant，最后断言
**真正到达 `setDraft` 的字符串**，以及**到达的是哪个 session 的 `setDraft`**。

三个让它有牙的设计：

- **假 DOM 模拟事件三阶段**（捕获 / 目标 / 冒泡 + `blur` 这类不冒泡的类型），
  而且每次点一行都按真实序列派发 `pointerdown` → 焦点转移的 `blur` → `click`。
  上一个 bug 就藏在这条序列里，而更早的套件只发一个孤立的 `click` —— 所以它在浏览器里死了、
  在测试里全绿。
- **假 `uiSession` 可以在两种形状之间切换**，所以兼容阶梯是双向演练的，而不是只在当前 harness
  恰好指向的那一支上跑。
- **假 context 用 Proxy 模拟 Cordis 的两条规则**：属性读取未声明的服务就抛（历史上正是这个把每个请求
  变成裸 HTTP 400），`ctx.get` 才是允许的通道；并断言插件从头到尾只碰过 `effect`/`get`/`slots`。

变异测试（改坏实现必须变红）最近一轮 11 个全部让套件变红，其中两个正是**复现了你看到的现象**：

| 变异 | 套件反应 |
|---|---|
| 去掉 0.1.7 的 `adapter.current` 那一支 | ✗ 菜单行变成 `添加到对话不可用` |
| session id 改回读 `list.current` | ✗ 菜单行变成 `添加到对话不可用` |
| 去掉 0.1.5 的 `resolve()` 那一支 | ✗ 旧形状那条断言 |
| blur 改回捕获阶段 | ✗ 两处（阶段断言 + 点击序列守卫） |
| 去掉写入回读确认 | ✗ 屏幕提示断言 |
| 剪贴板拒绝被吞掉 / 去掉回退 | ✗ 两条 |
| 预览右键也允许用记忆选区 | ✗ |
| 标签菜单不再 `dismiss()` | ✗ |
| 能力缺失时不标注原因 | ✗ |
| contextmenu 不再用捕获阶段 | ✗ |

---

## 四、安装（DSH Desktop / profile `web`）

Desktop 的应用市场装不了本地/未发布的包（只接受 `name@exact.version`），必须走终端 CLI，
且 **`DSH_HOME` 必须指向 Desktop 的 harness**，否则会装进另一个 `dsh` 安装：

```powershell
$env:DSH_HOME = "$env:APPDATA\dsh-desktop\harness"
dsh plugin --profile web add link:E:\dsh-plugiun
```

装完之后：profile 的 `dependencies` 里出现 `dsh-file-selector: link:E:/dsh-plugiun`，
`dsh.profile.bundles` 里出现 `dsh-file-selector`，
`profiles/web/node_modules/dsh-file-selector` 是指向本仓库的 Junction。

**改完代码要重启 DSH Desktop**：host 半是 `patchReload: live` 热加载的，但客户端 bundle 图是在
激活时组装的，重启才会重新拉 `/plugins`。重启会杀掉当前会话。

出问题的退路：Desktop 有恢复界面 —— 「进入安全模式」（`profiles/desktop-safe-mode`）、
「卸载插件」、「升级插件并重启」。

---

## 五、验证到什么程度

**已验证**

- host 半：无服务、无路由、不读文件（断言出来的，不是声称）。
- 客户端 bundle：classic script、模块 id 等于包名、只 `require('react')`、`apply` 能在
  「只声明了 slots」的严格 context 上跑完（任何未声明的服务读取都会抛）。
- 注册项只有一个（`sidebar.right.tab.menu.item`），只带 `name`/`id`/`order`，slot 名逐字符断言；
  且不注册 composer dock 锚点。
- 草稿能力解析：0.1.7 与 0.1.5 两种 binding 形状、未知形状必须报出接缝名、
  session 身份取自 binding 的 `key`、写入落在**当前** session 而不是第一个 session。
- 能力缺失时菜单显示一行 `添加到对话不可用 · 原因`（inert + 原因入 title），复制路径仍可用。
- 追加语义：空草稿、非空草稿、连续两次追加；写完回读确认；写不进去时屏幕提示。
- 剪贴板：异步接口成功 / 被拒后回退 / 两条都失败则报出。
- 路径归一化：树用自己的 `data-files-root` 作根；工作区内绝对路径 → 相对；工作区外保留绝对。
- 行范围：多行、单行、`offset 0` 收尾、无选区、跨文档不串。
- 菜单：位置夹取到视口内、点外部/Escape/窗口失焦关闭、动作后关闭、监听器回收、
  **后代失焦不关闭**。
- 全程没有 `submit`。

**没验证**（如实说）

- **真实浏览器里的层叠顺序**。菜单是 `position: fixed; z-index: 1200`（官方 Menu 卡片的 portal 用 1100，
  右侧栏面板用 10），比它们高，但没有在真实浏览器里量过。
- **Chromium 在右键时是否真的保留预览选区**。「实时优先、记忆兜底」的分工就是为它写的，
  两种行为都能工作，但「落在选区内不清选区」这条假设本身是照 Chromium 常规行为推的。
- **dockkit 标签菜单的实际渲染**。行样式是按 harness `Menu.module.css` 的 menu cell 规格写的
  （min-height 40 / r10 / pad 10-8 / 14-22 / hover fill），但没在真实菜单里比对过像素。
- markdown / 图片 / PDF 预览里没有行号（本来就没有行），只有路径。

---

## 六、下一步可以做的

1. 真实浏览器里量一次层叠与菜单外观（profile 的 node_modules 里就有 Puppeteer）。
2. 如果 `sidebar.right.tab.menu.item` 将来变成行级 slot，把文件树那个委托式右键换掉。
3. `uiSession` 这个接缝是半公开的，已经动过一次；下次升级如果又变，菜单里的原因会直接告诉你。

## 授权

MIT
