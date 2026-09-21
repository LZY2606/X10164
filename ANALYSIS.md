# 符号可见性分析：从 didOpen 到 definition / references / completion / rename

本文基于 commit `f08c9ef`（加上本次新增的 `testing/fixtures/scope-visibility/` 与
`server/src/__tests__/scope-visibility.test.ts`）梳理 bash-language-server 如何决定
“同名变量或函数在函数体、子 shell、source 文件和动态 source 路径中谁可见”。
结论先行：**可见性由四层共同决定**——

1. 语法树层（tree-sitter 节点类型与 `parentScope` 判定）；
2. 符号抽取层（`util/declarations.ts` 的全局/局部声明规则）；
3. 索引层（`Analyzer.uriToAnalyzedDocument` 缓存 + source 有向图）；
4. 请求层（`server.ts` 各 handler 对同一套 analyzer 查询的不同消费方式）。

前三个层是共享的；第四个层存在已知分歧（见“已知分歧与风险”），在任何一个
handler 里单独修作用域规则都会让四种能力给出不同答案。

## 1. 文档载入与 parse tree

- 客户端 `didOpen`/`didChange` 由 `TextDocuments` 管理器接收，统一触发
  `onDidChangeContent`（`server/src/server.ts:159`），初始化完成后调用
  `analyzeAndLintDocument`（`server/src/server.ts:348`），其中第一步就是
  `this.analyzer.analyze({ uri, document })`（`server/src/server.ts:353`）。
  若文档在 `initialize`/`initialized` 之前已打开，则在 `onInitialized` 里补做
  （`server/src/server.ts:250`）。
- `Analyzer.analyze`（`server/src/analyser.ts:72`）用 web-tree-sitter 解析全文
  （parser 由 `server/src/parser.ts:4` 从打包的 `tree-sitter-bash.wasm` 加载）。
  解析失败直接抛错且**不覆盖旧缓存**（`server/src/analyser.ts:91`）；符号或
  source 抽取抛错时先 `tree.delete()` 再重抛（`server/src/analyser.ts:102`），
  保证 WASM 树的所有权始终显式。
- 分析结果写入缓存 `uriToAnalyzedDocument[uri]`（`server/src/analyser.ts:115`），
  包含 `document`、`globalDeclarations`、`sourcedUris`、无错误的
  `sourceCommands` 和 `tree`；被替换的旧树立即 `delete()`
  （`server/src/analyser.ts:114`），因为 AST 住在 WASM 内存里。

## 2. 符号抽取：局部/全局与遮蔽规则

- **全局声明** `getGlobalDeclarations`（`server/src/util/declarations.ts:42`）：
  每个名字只保留**最后一次定义**（与 bash 行为一致），不进入
  `if_statement`/`function_definition` 子树（`GLOBAL_DECLARATION_LEAF_NODE_TYPES`，
  `server/src/util/declarations.ts:24`），跳过子 shell 里的输入重定向声明。
  这份表是 sourced 文件对“外部世界”可见的全部符号。
- **当前文件可见声明** `getLocalDeclarations`（`server/src/util/declarations.ts:113`）：
  从光标节点自底向上走父链，收集 `declaration_command` 的 `local/declare/typeset`
  （`server/src/util/variable-declarations.ts:13`）、`for` 循环变量、输入重定向
  声明（`server/src/util/input-declarations.ts:107`）和普通赋值；再自顶向下补
  函数体内的全局赋值，但用 `getUnconditionalLocals`
  （`server/src/util/variable-declarations.ts:62`）把已被 `local` 遮蔽的名字排除。
- **同名取舍** 在 `Analyzer.getAllDeclarations`（`server/src/analyser.ts:1086`）：
  当前文件按位置取“最近的前置定义”，函数名允许取“之后的函数定义”兜底
  （函数体可以调用后面声明的函数，`server/src/analyser.ts:1113-1153`）；
  其他文件只贡献各自的 `globalDeclarations`。也就是说 **sourced 全局与当前文件
  局部同名时，局部排在前面，但全局仍在结果里**（见风险 3）。
- completion 侧再做一次去重：`deduplicateSymbols` 按 `name+kind` 去重并优先
  当前文件（`server/src/server.ts:900`）。

## 3. workspace 索引与缓存失效

- 后台索引：`onInitialized` 触发 `startBackgroundAnalysis`
  （`server/src/server.ts:254` → `server/src/analyser.ts:166`），用
  `getFilePaths`（`server/src/util/fs.ts:173`）按 `globPattern`
  （默认 `**/*@(.sh|.inc|.bash|.command)`，`server/src/config.ts:65`）发现文件，
  受 `backgroundAnalysisMaxFiles`、目录数/时间预算和符号链接环保护
  （`server/src/util/fs.ts:36`）约束。每个文件以
  `url.pathToFileURL(filePath).href` 为键分析（`server/src/analyser.ts:253`）。
- **失效时机**：
  - 打开/编辑文档：`analyze` 整体替换该 URI 的缓存项并释放旧树
    （`server/src/analyser.ts:114-121`）；非后台分析会把 URI 移出
    `backgroundAnalyzedUris`（`server/src/analyser.ts:83`），后续后台扫描不会
    用磁盘旧内容覆盖打开中的文档（`server/src/analyser.ts:254`）。
  - 后台重扫：`evictBackgroundDocuments`（`server/src/analyser.ts:316`）淘汰
    不再命中的后台条目，但保留打开文档及其 source 依赖。
  - 配置变化：重新分析所有打开的文档并重启后台索引
    （`server/src/server.ts:258-267`）。
  - `didClose` 只清诊断和 code action（`server/src/server.ts:168-175`），
    **不**清 analyzer 缓存——已分析条目继续参与跨文件结果。
- 未覆盖的文件按需补分析：`ensureUrisAreAnalyzed`
  （`server/src/analyser.ts:1057`）用 `fs.readFileSync(new URL(uri))` 读盘并
  即时 `analyze`，失败则从可达集合中剔除。

## 4. URI 与 shell 路径的规范化

- 缓存键始终是 **file URI 字符串**：客户端 URI 原样使用；后台索引用
  `pathToFileURL`（`server/src/analyser.ts:253`）；source 决议用
  `pathToFileURL(candidate).href`（`server/src/util/sourcing.ts:217,230`）。
- source 决议 `getSourceCommands`（`server/src/util/sourcing.ts:32`）先把
  `file://` URI 转回路径（`fileURLToPath`，`server/src/util/sourcing.ts:41-44`），
  候选根为 **当前文件所在目录 + workspace 根**；`~` 经 `untildify`
  （`server/src/util/fs.ts:13`）展开；相对路径用 `path.join` 归一化（因此
  `./lib.sh` 与 `sub/../lib.sh` 归一到同一 URI，见风险 2）。**不做 realpath**：
  符号链接的两条路径会得到两个不同 URI。
- ShellCheck 指令优先于字面参数：`source=`、`source-path=`、`/dev/null`、
  `disable=SC1091`（`server/src/util/sourcing.ts:101-138`）。

## 5. source 图与动态 source 的降级

- 每个文档的 `sourcedUris` 是静态可达的 URI 集合（`server/src/analyser.ts:106-111`），
  传递闭包由 `findAllSourcedUris`（`server/src/analyser.ts:1163`，visited-set
  防环）计算；`getReachableUris`/`getOrderedReachableUris`
  （`server/src/analyser.ts:1000,1026`）决定跨文件搜索范围与顺序（被 source 的
  文件在前，当前文件最后）。`includeAllWorkspaceSymbols=true` 时退化为整个
  workspace（`server/src/config.ts:77`）。
- 参数解析顺序：ShellCheck 指令 → `resolveStaticString`
  （`server/src/util/tree-sitter.ts:83`，支持 word/string/raw_string/concatenation）
  → **剥掉一个前导动态段**：`"$VAR/rest"` 或等价拼接按 `./rest` 相对于脚本目录
  与 workspace 根解析（`server/src/util/sourcing.ts:147-158` 与
  `resolveSourceFromConcatenation`，`server/src/util/sourcing.ts:243`）。
- 仍无法静态确定时：记录 `non-constant source not supported`
  （`server/src/util/sourcing.ts:177`）或 `failed to resolve path`，`uri=null`，
  该文件**不进入** source 图；只产生日志，或在 `enableSourceErrorDiagnostics`
  下产生一条说明性诊断（`server/src/analyser.ts:127-152`）。**不会读取任何
  环境变量、不会扫描变量指向的目录**——决议只做候选路径的 `fs.existsSync`
  （`server/src/util/sourcing.ts:196-237`）。这就是“可解释的保守结果”。

## 6. 四种请求如何消费同一套可见性

- **definition**（`server/src/server.ts:657`）→ `findDeclarationLocations`
  （`server/src/analyser.ts:335`）：光标在 source 命令上时直接跳到被 source
  文件；否则 `findDeclarationsMatchingWord`（`server/src/analyser.ts:374`）在
  可达 URI 的声明里精确匹配。
- **references**（`server/src/server.ts:773`）→ `findReferences`
  （`server/src/analyser.ts:496`）：**不做作用域区分**，对所有已分析 URI 做
  文本级 `findOccurrences`（`server/src/analyser.ts:511`），同名的不可见符号
  也会混入——这是四种能力中最宽松的一个。
- **completion**（`server/src/server.ts:472`）→ `findDeclarationsMatchingWord`
  前缀匹配或 `getAllVariables`（`server/src/analyser.ts:689`），再走
  `deduplicateSymbols`（`server/src/server.ts:900`）。
- **rename**（`server/src/server.ts:809`）：
  1. `onPrepareRename`（`server/src/server.ts:794`）先确认符号种类与合法名字；
  2. `findOriginalDeclaration`（`server/src/analyser.ts:398`）沿 `parentScope`
     （`server/src/analyser.ts:1192`：函数体为 `compound_statement` 的
     `function_definition` 或 `subshell`）逐层向外找原始声明——函数体内用局部
     语义（`server/src/util/declarations.ts:483`），子 shell 用全局语义
     （`server/src/util/declarations.ts:363`），并随层级上移推进 `boundary`；
     都没找到再按 `getOrderedReachableUris` 跨文件找全局声明；
  3. 找到局部声明或外层作用域 → **file-wide rename**：
     `findOccurrencesWithin`（`server/src/analyser.ts:556`）把改写限制在
     `parent.range` 内（`server/src/server.ts:835-850`），因此函数局部的
     `SHADOWED_VALUE` 不会改到 sourced 全局；
  4. 只有全局声明且无外层作用域 → **workspace-wide rename**：声明文件 +
     `findAllLinkedUris`（`server/src/analyser.ts:960`，沿 source 边双向可达）
     内逐文件改写（`server/src/server.ts:852-871`）。
  rename 是唯一用 `findOccurrencesWithin` 做作用域过滤的能力，这就是它
  “不改到不可见同名符号”的机制。

## 7. 已知分歧与具体风险

### 风险 1：source 环

- fixture：`a.sh` 含 `source ./b.sh`，`b.sh` 含 `source ./a.sh`。
- 请求：对 `a.sh` 中引用的 `b.sh` 符号发 `textDocument/definition`。
- 预期：正常返回 `b.sh` 中的声明位置，不递归死循环。保证来自
  `findAllSourcedUris` 的 visited-set（`server/src/analyser.ts:1171-1177`）和
  `findAllLinkedUris` 的 `uris.includes` 去重（`server/src/analyser.ts:973-991`）。
  注意环上每个文件仍是各自独立的缓存项，rename 对每个 URI 只产生一组编辑。

### 风险 2：同一文件经不同路径重复索引

- fixture：`main.sh` 同时 `source ./lib.sh` 与 `source ./sub/../lib.sh`；
  或一条相对路径、一条 `~/...` 路径指向同一文件。
- 请求：`textDocument/references` 查 `lib.sh` 中的符号。
- 预期：`path.join` 归一化后 URI 相同的写法只索引一次（`sourcedUris` 是
  `Set`，`server/src/analyser.ts:106`）；但经符号链接或 tilde 与相对路径混用
  时 URI 字符串不同，文件会被分析两次，`findOccurrences` 只在单 URI 内去重
  （`server/src/analyser.ts:533-543`），references 会出现跨 URI 的重复位置，
  workspace-wide rename 也会对同一物理文件发两组编辑。这是当前已接受的
  限制：不做 realpath 归一（见第 4 节）。

### 风险 3：函数局部变量遮蔽 sourced 全局

- fixture：`testing/fixtures/scope-visibility/main.sh`（`local SHADOWED_VALUE`
  遮蔽 `lib.sh` 的全局 `SHADOWED_VALUE`）。
- 请求：在 `main.sh` 第 8 行（0-based 7）`echo "$SHADOWED_VALUE"` 上分别发
  definition 与 rename。
- 预期：definition 的首个结果是 `main.sh` 第 7 行（0-based 6）的局部声明
  （`getAllDeclarations` 的“最近前置定义”规则），但结果里**仍会附带** lib.sh
  的全局声明（`server/src/analyser.ts:1090-1156` 把两者都列出来）；
  rename 必须只改写函数体范围内（file-wide 分支），`lib.sh` 不出现在
  `WorkspaceEdit.changes` 里。回归测试：
  `server/src/__tests__/scope-visibility.test.ts` 的
  `a function-local variable shadows the sourced global for definition and rename`。

### 风险 4：动态 source 路径

- fixture：`testing/fixtures/scope-visibility/dynamic-source` 中
  `source "$DYNAMIC_FIXTURE_DIR/extra.sh"`，且环境变量指向一个真实存在、
  内含 `DYNAMIC_ONLY_SYMBOL` 的临时目录。
- 请求：对 `echo "$DYNAMIC_ONLY_SYMBOL"` 发 definition / completion。
- 预期：definition 返回空、completion 不含该符号；开启
  `enableSourceErrorDiagnostics` 时收到 “Source command could not be
  analyzed” 诊断。服务器不解析环境变量、不扫描其指向的目录（第 5 节）。
  另一个隐患是“剥前导动态段”启发式（`server/src/util/sourcing.ts:147`）在
  脚本目录恰好存在同名文件时会**静默链到错误的文件**，属于有意的近似而非
  精确语义。

### 风险 5（次要）：同一符号的 range 口径不一致

definition 经 `nodeToSymbolInformation` 取整个 `variable_assignment` 节点的
range（`server/src/util/declarations.ts:264-289`），而 references/rename 用
`variableNameRange`（`server/src/util/input-declarations.ts:116`）只覆盖变量名
token。比较四种结果时应按“符号（URI+行）”而非精确 range 对齐——回归测试中的
`definition, references, completion and rename agree on a sourced global`
就是按此断言的。

## 8. 回归测试

`server/src/__tests__/scope-visibility.test.ts` 从真实 handler 入口
（mock connection 上注册的 `onDidOpenTextDocument`/`onDidChangeTextDocument`/
`onDefinition`/`onReferences`/`onCompletion`/`onRenameRequest`/
`onWorkspaceSymbol`）驱动，覆盖：

1. 同一光标位置（`main.sh` 中 `$SHARED_TOKEN`）上 definition、references、
   completion、rename 四者基于同一可见符号集合，且 rename 编辑集与
   references 位置集完全相等；
2. 函数局部变量遮蔽 sourced 全局时 rename 不越界；
3. 编辑 sourced 文件（didChange `lib.sh`）后索引失效：definition 立即落空、
   新符号出现在 workspace symbol 中；
4. 动态 source 路径返回可解释的保守结果（诊断 + 空定义），不扫描环境变量
   指向的目录。
