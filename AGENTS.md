# AGENTS.md

本文件是仓库内所有自动化代理（含 DSH 自身）的工作约定。

## 交流规则

- **始终使用中文回答。** 无论问题是中文、英文还是混合语言，面向用户的每一条回复都用中文：进度说明、结论、错误解释、方案对比、最终总结都是如此。
  - 例外：代码、命令、文件路径、API 名称、类型名、日志原文、以及需要逐字引用的报错文本，保持原样不翻译；技术术语在中文里不通顺时可直接保留英文原词。
- 仓库文档保持中英双份且内容对等：改动 `README.md` 时同步 `README.zh.md`，反之亦然。

## 交付门槛

任何改动在结束前必须四条全绿，不要只跑其中一条：

```sh
npm run typecheck   # tsc -p tsconfig.json --noEmit && tsc -p tsconfig.test.json
npm test            # vitest run
npm run build       # clean && tsc && tsdown && scripts/copy-kernel-bridge.mjs
npm run test:bundle # scripts/smoke-client-bundle.mjs
```

涉及笔记本内核链路时，再加两条端到端验证（需要工作区可访问、且装有 `ipykernel` 的 Python，因此不在 `npm test` 里）：

```sh
npm run test:kernel   # scripts/probe-kernel.mjs：用真实内核驱动构建后的宿主路由
npm run test:example  # scripts/probe-example.mjs：逐格执行 examples 里的笔记本
```

失败就修到失败原因消失，不要用 `expect(true).toBe(true)`、跳过用例或放宽断言来让门禁通过。断言必须落在**被测代码真实的输出面**上：只在自己测试里拼一遍参数再断言那个字面量，等于没有覆盖任何东西。

## 结构与时机

- 插件由两半组成：`src/index.ts` 是 Node 宿主（cordis `apply(ctx, config)` + `ctx.webServer.register`），`src/client/index.ts` 是 React 客户端（注入官方槽位）。两半之间只通过 `src/shared/` 的类型化契约通信，宿主路由只回传工作区相对路径。
- **DSH 加载的是 `lib/`，不是 `src`。** 源码改完必须 `npm run build` 才会生效；已经在运行的宿主不会热加载新宿主代码，需要重载或重启 DSH 才能看到变化（重启会结束这个会话，所以由用户来做）。
- `tsdown` 只能输出 JS。`src/host/kernel/kernel-bridge.py` 靠 `scripts/copy-kernel-bridge.mjs` 复制到 `lib/` 旁边，该脚本同时强制**文件字节必须全 ASCII**。`package.json` 的 `files` 是逐名列举而非 `lib/**` 通配，新增产物要显式加进去。

## 类型与写法

- `tsconfig.json` 开了 `strict`、`exactOptionalPropertyTypes`、`noUncheckedIndexedAccess`、`verbatimModuleSyntax`、`isolatedModules`、`rewriteRelativeImportExtensions`。
- 因此：可选字段缺失时**省略它**（`...(x === undefined ? {} : { x })`），不要赋 `undefined`；索引访问结果先判 `undefined`；类型导入一律 `import type`；相对导入必须带 `.ts` / `.tsx` 扩展名。
- 仓库没有 ESLint / Prettier 配置，风格靠现有代码和上述编译器选项约束，不要引入新的 lint 工具链。
- 新增测试文件后必须把它加进 `tsconfig.test.json` 的 `files` 白名单，否则它不参与类型检查（当前仍有部分历史 spec 未纳入）。

## 依赖红线

- 禁止引入 `ws`、`node-pty`（以及任何需要本地编译的原生模块）；`tests/package-manifest.spec.ts` 会直接断言它们不存在。终端走 DSH 官方 `@deepseek-ai/dsh-api-terminal-controller`，内核通信用纯 Node 实现的 ZMTP + JSON 消息。
- 客户端运行时不得新增依赖：浏览器侧只允许已有的 CodeMirror / xterm / 官方 primitives。
- 每个 `@deepseek-ai/dsh*` peer 的范围都必须包含当前测试的运行时版本（`^0.2.0-rc.2`），DSH 启动时会逐个校验并拒绝不匹配的插件。

## 文案与国际化

- 所有面向用户的字符串走 `src/client/core/locales.ts`，中英两本字典的键必须**完全一致**：`en` 被类型约束为 `Record<keyof typeof zh, string>`，且 `tests/locales.spec.ts` 额外检查值非空、占位符一致。新增文案要同时写两边，并在消费它的那个 labels 对象里补上对应字段。

## 安全与隐私

- 宿主接口只接受官方工作区 id 与工作区相对路径，拒绝越界路径与符号链接；日志与响应里不得出现宿主绝对路径、端口或密钥。
- 内核输出的 HTML 必须先经过 `src/client/notebook/sanitize-html.ts` 才进 DOM；内核签名密钥只留在宿主侧。
- `README.md` / `README.zh.md` 不得包含个人路径、盘符路径或 `localhost`/`127.0.0.1`/`192.168.*` 示例（`tests/package-manifest.spec.ts` 会拦截）。

## 工作方式

- 先用 `read` / `glob` / `grep` 工具看代码，不要用 `cat`、`find`、`grep` shell 命令读文件或搜内容。
- 覆盖已有文件前先读它；优先用 `edit` 做定点修改而不是整文件重写。
- 一次改动只做一件事，并让它的测试同时落地：修 bug 要留下能复现该 bug 的回归用例，说明写在注释里（为什么这个形状重要，而不是它做了什么）。
- 探针脚本分两类，不要混淆：`test:kernel` / `test:example` 是**常驻的端到端门禁**（见上），属于交付物的一部分，改动内核链路时必须重跑；而为定位某一次问题临时写的脚本，用完就删，不要留在 `scripts/` 里，也不要把一次性调试断言混进正式 spec。
- 临时脚本里不要写死个人绝对路径；需要工作区时用参数或临时目录，正式提交的 `scripts/` 会被 `tests/package-manifest.spec.ts` 的隐私检查覆盖。
