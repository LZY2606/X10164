# 符号可见性分层分析：tree-sitter、workspace 索引与 source 决议

适用 commit：`f08c9ef` (`Initial environment snapshot (X10164)`)。所有路径与行号均对应该提交的工作树；行号为 1-based。

本文追踪的问题：同名变量/函数在**函数体、子 shell、source 文件、动态 source 路径**中的可见性分别由哪一层决定，以及 definition / references / completion / rename 为什么可能对同一光标给出不同答案。结论先放在前面：**四条能力并不共用一个“可见符号集合”函数**——definition/completion 走 `Analyzer.getAllDeclarations`（有位置、有 source 闭包、有局部遮蔽），rename 走 `findOriginalDeclaration` + `findOccurrencesWithin`（真正按局部/全局作用域），references 走 `findReferences`（按词全文扫描，明确“不做作用域分析”）。任何只修单一 handler 的改动都必须同时检查另外三条路径。

---

## 1. 主干一：didOpen / 文档载入 → parse tree → 符号抽取

### 1.1 文档同步入口（Full sync）

- 服务声明 `TextDocumentSyncKind.Full`：`server/src/server.ts:124`。
- `TextDocuments.listen(connection)` 接管 `onDidOpenTextDocument` / `onDidChangeTextDocument` / `onDidCloseTextDocument`（`vscode-languageserver` 的 textDocuments.js 实现）；打开或变更都会触发 `onDidChangeContent`：`server/src/server.ts:159-166`。
- 回调里调用 `analyzeAndLintDocument`：`server/src/server.ts:348-381`。它先 `this.analyzer.analyze({ uri, document })`（353 行）把语法树与全局符号放进缓存，再可选跑 ShellCheck，最后 `connection.sendDiagnostics`（380 行）。
- 初始化完成前（`initialized` 为 false）的打开事件只记录 `currentDocument`，等 `onInitialized`（202-255 行）拿到客户端配置后再补一次分析：`server/src/server.ts:159-166` 与 `246-251`。
- 关闭文档不删除 analyzer 缓存（只清空诊断/code actions、取消 lint）：`server/src/server.ts:168-175`。后台索引对“按需文档”有保留策略（见 2.3）。

### 1.2 解析器

- 单例 WASM：`server/src/parser.ts:4-18`，加载 `server/tree-sitter-bash.wasm`（14 行）。`Parser.init()` 是全局状态，测试中共享一个 parser。
- 每次分析都执行同步 `this.parser.parse(fileContent)`：`server/src/analyser.ts:87`。解析返回 null 直接抛错（88-90 行）；符号/source 抽取抛错时会 `tree.delete()` 再抛出：`analyser.ts:101-104`。
- 文档缓存结构：`AnalyzedDocument { document, globalDeclarations, sourcedUris, sourceCommands, tree }`，定义于 `analyser.ts:30-36`，存在 `uriToAnalyzedDocument: Record<string, AnalyzedDocument | undefined>`（48 行）。

### 1.3 全局符号抽取（“source 本文件后可见的符号”）

- 入口 `getGlobalDeclarations({ tree, uri })`：`server/src/util/declarations.ts:42-70`。
- 遍历规则：`if_statement` 与 `function_definition` 是“叶子”，**不进入其子树**（`GLOBAL_DECLARATION_LEAF_NODE_TYPES`，declarations.ts:24-27，followChildren 判定在 51-52 行）。因此函数体内与 if 分支内的赋值不会被当作 sourced 后的全局符号——不做流分析（注释见 29-41 行）。
- 识别的定义节点：`variable_assignment`、`function_definition`、`environment_variable_assignment`（declarations.ts:14-19），另有 `: "${VAR:=default}"` 特判（309-325 行）与 `read/readarray/mapfile` 输入目的地（299-306 行，具体规则在 `util/input-declarations.ts`）。
- **同名只保留最后一个**：`globalDeclarations[word] = symbol`（declarations.ts:62-63），与 bash 运行时“后定义覆盖先定义”一致（注释 35-37 行）。
- subshell 中的 read 输入不计入全局（declarations.ts:54-58）；命令替换/进程替换/管道内的赋值由 `getAllGlobalVariableDeclarations` 排除（declarations.ts:230-239）。

### 1.4 局部符号抽取（光标所在位置的作用域）

- 入口 `getLocalDeclarations({ node, rootNode, uri })`：`server/src/util/declarations.ts:113-208`。
- 自光标节点向**上**走，逐父节点收集：`read` 目的地（129-137 行）、`local/declare/typeset` 声明（141-154 行，名字解析在 `util/variable-declarations.ts:13-56`）、`for` 循环变量（167-176 行）、其它定义（177-186 行）。
- 再做一次**自顶向下**补全：函数体内未被证明为 local 的全局变量也加入，但若该函数体中存在无条件的 `local X`，则 local 生效位置之后的同名赋值不算全局（`getAllGlobalVariableDeclarations`，declarations.ts:210-262，遮蔽判定 240-249；`getUnconditionalLocals` 见 `variable-declarations.ts:62-73`）。
- 局部声明建立作用域的条件较严格：`declare` 带 `-g` 不建 local；选项不可静态解析时放弃（`variable-declarations.ts:30-45`）。

---

## 2. 主干二：workspace 索引与缓存失效

### 2.1 后台发现

- `onInitialized` 末尾不阻塞地启动：`server/src/server.ts:253-254` → `startBackgroundAnalysis`（276-287）→ `Analyzer.initiateBackgroundAnalysis`：`analyser.ts:166-314`。
- 文件发现 `getFilePaths`：`server/src/util/fs.ts:173-267`，使用 fast-glob，`absolute: true`、`followSymbolicLinks: true`（243 行），默认 glob 与忽略项来自配置：`globPattern = **/*@(.sh|.inc|.bash|.command)`（`config.ts:65`），忽略 `**/node_modules/**`、`**/.git/**`（`config.ts:57-59`）。
- 预算：文件数 `backgroundAnalysisMaxFiles`（默认 500，`config.ts:54`）、目录数 10000、总时长 10s（`analyser.ts:28`，`fs.ts:9-10`）。超时/取消后“符号可能不完整”只记日志。
- 符号链接环导致的目录死循环由自定义 FS adapter 防护：`fs.ts:36-166`（`realpathSync.native` 判祖先，56 行；`linksBackToAncestor` 67-81 行）。注意它只防**目录 walk 环**，不去重最终命中的文件路径（见风险 2）。
- 方言过滤：只有 shebang/扩展名/`# shellcheck shell=` 能识别为 shell 的文件才入索引：`analyser.ts:278-286` + `util/shebang.ts:76-95`。

### 2.2 URI ↔ shell 路径规范化

- 磁盘路径 → URI 一律用 `url.pathToFileURL(...).href`：后台发现 `analyser.ts:242`、252 行；source 决议 `util/sourcing.ts:217`、230 行。因此空格/`#`/中文/`%` 都按 RFC 3986 百分号编码，`fileURLToPath` 能无损还原（对应回归测试见 `server/src/__tests__/server.test.ts:975-1023` 的 percent-encode 用例）。
- URI → 磁盘路径：`fileURLToPath`（`sourcing.ts:43-46`、`analyser.ts:1064` 用 `new URL(uri)` 直接 readFile）。
- 客户端传入的 `rootUri/rootPath` 原样作为 `workspaceFolder`（`server.ts:89`），不做 realpath；source 决议时同时接受 URI 与裸路径两种形态（`sourcing.ts:44-46`）。
- **规范化只做词法级别**：`path.join` 消除 `.`/`..`（`sourcing.ts:226`），`pathToFileURL` 统一编码；**不做 `fs.realpath`**，所以符号链接、大小写不敏感卷、bind mount 会产生指向同一 inode 的多个键（风险 2）。

### 2.3 缓存失效

- **打开/编辑文档**：每次 Full-sync 都重新 parse；成功后显式释放旧树再替换缓存：`analyser.ts:112-121`（114 行 `this.uriToAnalyzedDocument[uri]?.tree.delete()`）。非后台分析会先把 URI 移出 `backgroundAnalyzedUris`（83 行），防止随后完成的后台扫描覆盖未保存内容。
- 竞态防护：后台循环在 I/O 前后两次 `isOnDemand()` 检查（`analyser.ts:253-256`、277 行），按需/打开文档永不被磁盘副本覆盖；分析失败时旧缓存保留（101-104 行只删新树，不覆盖 map）。
- **重新扫描淘汰**：`evictBackgroundDocuments`（`analyser.ts:316-330`）。保留集合 = 本轮 glob 命中（241-243、301-305 行）+ 所有非后台文档（即打开/按需文档）经 source 图可达的 URI（319-323 行）。被淘汰项 `tree.delete()` 并删除键（324-329 行）。取消时不做清理，避免新依赖图被旧扫描误删（299-305 行注释）。
- **关闭文档**不立即失效（`server.ts:168-175`）：它会在下一轮后台扫描时随依赖保留规则存活或被淘汰。
- **配置变化**：重启后台扫描并对所有打开文档重新分析：`server.ts:258-267`。
- **shutdown**：取消后台分析、释放 linter：`server.ts:190-193`。WASM 树的释放责任分散在上述各点（另见 analyzer-lifecycle 测试）。
- **按需补分析**：source 指向但后台未覆盖的文件，在请求到来时同步读盘分析：`ensureUrisAreAnalyzed`，`analyser.ts:1057-1077`（读失败返回 false 并记日志，不影响其它文件）。

### 2.4 source 图（URI 之间的边）

- 每文档缓存两个结构：`sourcedUris: Set<string>`（成功解析的去重目标，`analyser.ts:106-110`）和 `sourceCommands`（仅无 error 的，119 行；带 error 的原始列表只用于诊断，124-152 行）。
- 闭包：`findAllSourcedUris` 用 DFS + visited Set 递归（**环安全**）：`analyser.ts:1163-1184`。
- 反向闭包（谁 source 了我，rename 用）：`findAllLinkedUris`：`analyser.ts:960-991`，while 循环到不动点，同样天然防环。
- 有序可达列表（声明查找用，模拟 source 顺序）：`getOrderedReachableUris`：`analyser.ts:1026-1051`。它对“source 了我 source 的文件”做“移到末尾再插回”的重排（1029-1036 行），再 `reverse()` 并把当前文件放最后（1038-1040 行），从而**越早 source 的文件排在越前面**，与 bash“先 source 者先定义、后 source 可覆盖”一致。

---

## 3. 主干三：source 路径决议与动态 source 降级

核心在 `server/src/util/sourcing.ts`。

### 3.1 识别 source 命令

- 关键字 `source` / `.`（`sourcing.ts:13`）；`.bats` 文件额外识别 `load`（20-21、79-81 行），且 `load` 自动追加 `.bash` 后缀重试（209-212 行）。
- 只处理 `command` 节点的第一、第二个 named child 分别为 `command_name` 与参数的情形（83-88 行）。

### 3.2 候选根目录（相对路径相对谁）

- `rootPaths = [当前文件所在目录, workspaceFolder]`（`sourcing.ts:43-47`），按此顺序 `path.join` 后 `fs.existsSync` 探测（224-233 行）。即**先相对脚本目录，再相对 workspace 根**。绝对路径与 `~`（`untildify`，205-207 行）直接探测，不走 rootPaths（214-221 行）。
- 命中后 `pathToFileURL(candidate).href` 返回（217、230 行）。注意“无斜杠的文件名按 PATH 查找”的 bash 语义**未实现**（192-194 行注释）。
- 命中探测只有词法路径（静态后缀）落在上述两个根之下；不存在读取/展开环境变量值再拼路径的代码路径。

### 3.3 ShellCheck 指令优先

`getSourcedPathInfoFromNode`（sourcing.ts:72-183）在解析参数前先看前置注释：

1. `# shellcheck source=/path`：直接采用；`/dev/null` 表示显式忽略（109-121 行）。
2. `# shellcheck disable=SC1091`：不产生错误也不解析（123-130 行）。
3. `# shellcheck source-path=DIR`（且不是 `SCRIPTDIR`）：`path.join(DIR, 实参)`（132-137 行）。
`&&`/`||` 包裹时向上找到 list 首命令再取注释（94-102 行）。

### 3.4 静态字符串与“去一个动态前缀”的降级

- 参数可静态求值（word/string/raw_string/concatenation）→ 直接用：`resolveStaticString`（`util/tree-sitter.ts:83-101`），调用点 `sourcing.ts:140-145`。
- 形如 `"$VAR/static/suffix"`（恰好一个**前导**展开，其余全是 string_content）→ 剥掉变量，把 `/static/suffix` 映射为相对路径 `./static/suffix`：`sourcing.ts:147-162`。concatenation 版本在 164-172 行与 `resolveSourceFromConcatenation`（243-286 行）：只有一个前导动态段、其余全部静态、且静态结果以 `/` 开头时，降级为 `.` + 后缀（281-285 行）。
  - 这是“解释得清楚的保守结果”：它表达的是“无论变量取什么值，只要运行时布局是 `<某目录>/static/suffix`，静态后缀部分相对已知根是可解析的”。
- 其余动态形态（多于一个变量、变量不在开头、命令替换 `$(...)` 等）→ 返回 `{ uri: null, error: 'non-constant source not supported' }`：`sourcing.ts:174-178`。
  - analyzer 侧该 source 不进入 `sourcedUris`（边不存在），即不贡献任何跨文件符号；默认只 `logger.warn`（`analyser.ts:124-131`），开启 `enableSourceErrorDiagnostics` 时发 Information 级诊断并给出 `source=` / `source-path=` / `/dev/null` 的修复指引（132-151 行）。
  - **不会**把环境变量值展开成绝对路径去探测，因此不会扫描“任意环境变量指向的系统目录”。回归测试 `server/src/__tests__/cross-file-visibility.test.ts` 的 “dynamic source paths” 用 `existsSync` spy 固化了这一点。

---

## 4. 主干四：四种 LSP 请求分别问了什么

所有 handler 在 `server.register` 注册：`server/src/server.ts:178-189`。

### 4.1 Definition —— `onDefinition`（server.ts:657-668）

1. 光标在某个 source 命令的 range 内（`isPositionIncludedInRange`）→ 直接返回目标文件 URI 的 `(0,0)-(0,0)`：`analyser.findDeclarationLocations`，`analyser.ts:335-359`。
2. 否则 `findDeclarationsMatchingWord({ exactMatch: true, uri, position, word })`（`analyser.ts:374-392`）→ `getAllDeclarations({ uri, position })`（1086-1161）：
   - 文件集合 = `getAnalyzedReachableUris`（1053-1055）= **当前文件 + 传递 source 闭包**（`getReachableUris`，1000-1017；`includeAllWorkspaceSymbols=true` 时再并上所有已索引文件，1010-1013 行）。
   - 其它文件只取 `globalDeclarations`（1094-1098 行）；**当前文件**按光标做局部作用域解析（1101-1156 行）：取 `getLocalDeclarations`，同名只保留“光标前最近的一个”，并允许函数内调用后文定义的函数作为回退（1119-1151 行）。
   - **不去重同名符号**：当前文件的局部符号与 sourced 文件的全局符号可以同时返回（风险 3）。

### 4.2 References —— `onReferences`（server.ts:773-787）

- `analyzer.findReferences(word)`（`analyser.ts:496-499`）遍历 **`uriToAnalyzedDocument` 的全部键**（即所有已索引文件，不受 source 闭包限制），对每个文件跑 `findOccurrences`（511-545 行）。
- `findOccurrences` 是**纯词法**扫描：`variable_name`/`command_name` 等按文本相等收集（519-540 行），明确“not scope-aware”，会跨文件、跨同名不同作用域返回（注释 492-508 行）。
- handler 只按 `includeDeclaration` 过滤“当前位置自身的声明”（server.ts:780-786）。因此 references 的集合与 definition/completion/rename 的作用域集合**按设计就不同**；它更像“workspace 文本引用搜索”。`includeAllWorkspaceSymbols` 不改变 references（它本来就扫全部）。

### 4.3 Completion —— `onCompletion`（server.ts:472-623）

- 先取词（光标前移一列，475-480 行）；注释/单独 `{`/词中间（下一个字符非空白）等早退（484-505 行）。
- 变量补全（`$`、`${` 前缀）→ `getAllVariables({ uri, position })`（server.ts:520-524；analyzer 689-699 行），即 `getAllDeclarations` 后只留 Variable；普通词补全 → `findDeclarationsMatchingWord({ exactMatch: false, ... })`（525-530 行，前缀匹配在 analyser 389 行）。
- 符号结果经 `deduplicateSymbols`（server.ts:900-927）：**当前文件优先**，同名+同 kind 的跨文件符号被丢弃（914-923 行）。这是 completion 与 definition 的关键差异——definition 不去重，completion 去重，所以局部遮蔽 sourced global 时 completion 只给一个，definition 给两个（风险 3）。
- 再拼保留字、`$PATH` 可执行文件、builtins、选项与 snippets（542-615 行）；有词时整体按前缀过滤（617-620 行）。

### 4.4 Rename —— `onPrepareRename` + `onRenameRequest`（server.ts:794-874）

- prepare 只做“这里是不是可重命名符号”与变量命名校验（798-807 行）。
- rename 先拿 `symbolAtPointFromTextPosition` 区分变量/函数（810 行；节点判定在 analyser 905-945 行），校验新名（817-826 行）。
- **作用域判定**：`analyzer.findOriginalDeclaration`（`analyser.ts:398-488`）：
  1. 自光标向上找 `parentScope`（`subshell` 或带 `compound_statement` 函数体，1192-1199 行）；
  2. 函数体内变量先走 local 语义 `findDeclarationUsingLocalSemantics`（declarations.ts:483-517），subshell 与外层走 global 语义 `findDeclarationUsingGlobalSemantics`（declarations.ts:363-475）；boundary 逐层上移（analyser 446 行）；
  3. 找不到父作用域时，再按 `getOrderedReachableUris` 的 source 顺序在文件间找全局声明（analyser 451-478 行）。
- 返回 `{ declaration, parent }`：
  - **文件内 rename**（`!declaration || parent`，server.ts:836-850）：在声明所在函数/subshell（或整文件）内用 `findOccurrencesWithin`（analyser 556-686 行）收集，局部遮蔽生效——它会把同名的局部作用域整体加入忽略区间（变量 614-645 行、函数 647-683 行）。这就是“函数 local 不会改到 sourced global”的保证（风险 3 中 rename 与其它三者结论不同的原因）。
  - **workspace rename**（852-873 行）：编辑声明文件 + `findAllLinkedUris(declaration.uri)` 的反向 source 闭包（864 行），每个文件内仍然按 kind/作用域过滤（556-686 行），不是裸文本替换。
- 结论：rename 是四条能力中作用域建模最完整的；它“避免改到不可见同名符号”的机制 = `findOriginalDeclaration` 定位唯一原声明 + `findOccurrencesWithin` 跳过嵌套遮蔽区间 + `findAllLinkedUris` 只走真实 source 边。动态 source 缺边时，不可见文件不会出现在 edit 里。

### 4.5 一句话对照表

| 能力 | 文件集合 | 作用域 | 同名处理 |
| --- | --- | --- | --- |
| definition | 当前文件 + source 闭包（可配置全 workspace） | 当前文件局部 + 外部全局 | 全保留（可能多个） |
| completion | 同 definition | 同 definition | 当前文件优先，去重为一个 |
| references | 全部已索引文件 | 无（词法扫描） | 全部保留 |
| rename | 声明文件 + 反向 source 闭包 | 函数/subshell/local 完整建模 | 遮蔽区间被排除，只改可见者 |

---

## 5. 三个具体风险（fixture + 请求 + 预期响应）

以下三个场景都有协议级回归测试（从真实 `LspServer.initialize` → `register` → 注册的 connection handler 进入），位于 `server/src/__tests__/cross-file-visibility.test.ts`。

### 风险 1：source 环（a → b → a）

- **fixture**（测试内临时目录 `bash-lsp-source-ring-*`）：
  - `a.sh`：`source ./b.sh` + `say_hi`
  - `b.sh`：`source ./a.sh` + `say_hi() { echo hi; }`
- **当前决议机制**：图遍历有 visited/不动点保护——`findAllSourcedUris`（`analyser.ts:1163-1184`）用 Set 防无限递归；`findAllLinkedUris`（960-991 行）每轮无新增即停；`getOrderedReachableUris`（1026-1051 行）的重排也只对 Set/已存在元素操作。因此**不会栈溢出或无限循环**。
- **请求**：对 `a.sh` 第 2 行（0-based `line=1`）的 `say_hi` 发 `textDocument/definition`。
- **预期响应**：恰好一个位置——`b.sh` 中函数定义（0-based 第 2 行 `Range(1,0)-(1,21)`），不因环路重复。测试：“source ring (risk 1)”（cross-file-visibility.test.ts，`terminates and resolves the definition across the cycle`）。
- **残留语义风险（非崩溃）**：bash 运行时在环里两个文件都未定义函数时会继续往下执行；静态的 source 顺序在存在环时没有唯一拓扑序，`getOrderedReachableUris` 的结果依赖文件被加入 Set 的顺序。若 `a.sh` 与 `b.sh` 都定义同名函数，definition 选中谁取决于这个顺序，而 references 仍会把两个定义都返回。环场景建议配合 `# shellcheck source=/dev/null` 或拆分文件消除环。

### 风险 2：同一文件经不同相对路径重复索引

- **fixture**（临时目录 `bash-lsp-dup-path-*`）：
  - `lib.sh`：`dup_func() { :; }`
  - `m1.sh`：`source ./lib.sh`；`sub/m2.sh`：`source ../lib.sh`
  - 另在 `alias` 创建指向 workspace 根的**目录符号链接**，经 `alias/lib.sh` 再访问同一 inode。
- **当前决议机制**：`resolveSourcedUri` 用 `path.join(rootPath, candidate)` + `pathToFileURL`（`sourcing.ts:224-230`）。词法相对路径会被规范化，`./lib.sh` 与 `../lib.sh` 解析到同一个绝对 URI，缓存只有一个键（测试先断言这一点）。
- **真正的重复面**：全链路**没有 `realpath`**（`fs.ts:56` 的 realpath 只用于判断目录 walk 是否成环，不用于归一化缓存键）。`alias/lib.sh` 与 `lib.sh` 是两个不同 URI 字符串 → `uriToAnalyzedDocument` 两个键 → 同一符号两份声明。
- **请求与预期**：
  - definition 从 `m1.sh`/`m2.sh` 进入后，缓存中 `lib.sh` 键只有一个（去重正确）。
  - 打开 `alias/lib.sh` 后，对其中 `dup_func` 发 `textDocument/references`，预期返回 **2** 个声明位置（`lib.sh` 与 `alias/lib.sh` 各一），workspace 符号/rename 也会出现幽灵重复；编辑其中一个 URI 只失效该键，另一个陈旧副本继续参与结果。
  - 测试：“same file through distinct paths (risk 2)”。
- **可选修复方向（不在本提交实施）**：在后台发现（`getFilePaths` 返回后）与 source 决议（`resolveSourcedUri` 命中后）统一做一次 `realpath` + 重新挂回 workspace 相对路径；代价是刻意用别名路径区分的项目会受影响，需要配置开关。

### 风险 3：函数 local 遮蔽 sourced global —— 四个能力答案不一致

- **fixture**（临时目录 `bash-lsp-shadow-*`）：
  - `lib.sh`：`VALUE=from_lib` 与 `echo "$VALUE"`
  - `main.sh`：`source ./lib.sh`；`f()` 内 `local VALUE=local_value` 后 `echo "$VALUE"`；文件末尾再有全局 `echo "$VALUE"`。
  - 光标在函数体内的 `$VALUE`（0-based `line=3, character=9`）。
- **机制原因**：见第 4 节对照表——rename 用 `findOriginalDeclaration`（命中 `parent` 非空 → 文件内 rename，`server.ts:836-850`）并由 `findOccurrencesWithin` 把 local 作用域外的全局排除；而 definition 的 `getAllDeclarations` 同时合并“当前文件 local 结果”和“外部文件 global 结果”且不去重；references 本就跨作用域。
- **请求与预期响应（已被测试钉住）**：
  - `textDocument/rename(newName=VALUE2)`：`changes` 只含 `main.sh`，两个 TextEdit（local 声明 `Range(2,8)-(2,13)` 与函数体内使用 `Range(3,9)-(3,14)`）；`lib.sh` **不出现在 changes 中**。
  - `textDocument/definition`：返回**两个**位置——函数内 local（`main.sh Range(2,8)-(2,25)`）与被遮蔽的 sourced global（`lib.sh Range(0,0)-(0,14)`）。
  - `textDocument/references(includeDeclaration=true)`：位置同时覆盖 `main.sh` 与 `lib.sh`（URI 集合等于两者）。
  - completion（词前缀请求）：经 `deduplicateSymbols` 只给一个 `VALUE`（当前文件优先）。
  - 测试：“function local shadowing a sourced global (risk 3)”。该测试故意钉住分歧，未来若统一作用域分层，必须显式更新它而不是让四个 handler 各自漂移。

---

## 6. 协议级回归测试与多文件 fixture

- fixture（提交内最小多文件）：`testing/fixtures/cross-file/`
  - `main.sh`：`source ./lib.sh`、`print_config_path`、`echo "$CONFIG_PATH"`
  - `lib.sh`：`CONFIG_PATH=/etc/app.conf` + 函数 `print_config_path` 内 `echo "$CONFIG_PATH"`
  - `node_modules/excluded/not-indexed.sh`：定义同名 `CONFIG_PATH`，验证默认 `backgroundAnalysisIgnore`（`config.ts:57-59`）使其不可见。
- 测试：`server/src/__tests__/cross-file-visibility.test.ts`
  - **同一光标**（`main.sh` 末行 `CONFIG_PATH`，0-based `line=3`；completion 用真实客户端的词前缀位置 `character=17`）分别打 `onDefinition`/`onReferences`/`onCompletion`/`onRenameRequest`（全部是 `connection.onX.mock.calls[0][0]` 注册的真实 handler，不经低层 helper），断言四者锚定同一可见集合：definition 指向 `lib.sh` 唯一声明；references 恰为三处（lib 声明、lib 函数内使用、main 使用）且不含 node_modules；completion 恰好一个 `CONFIG_PATH`；rename 的 `changes` 仅含 `main.sh`+`lib.sh` 且 TextEdit 与 references 的三个名字 range 一致。
  - **sourced 文件编辑后索引失效**：对已打开的 `lib.sh` 发 Full-sync `didChange`（重命名为 `CONFIG_PATH_AFTER_EDIT`），随后 definition 变空、references 只剩 main 自身、completion 旧名消失新名出现、workspace symbol 也不再返回旧名（证明重建的是索引而非仅打开文档视图）。
  - **动态 source 保守结果**：临时工程 `source "$LIBDIR/secret.sh"`，另在项目外放诱饵目录；spy `fs.existsSync` 断言**永不探测**环境变量展开后的绝对路径；definition 返回空、rename 仅改本文件、同时产生 `Source command could not be analyzed` 诊断。

---

## 7. 修改作用域时的检查清单（避免 handler 间漂移）

1. 新的可见性规则只应落在共享层：`util/declarations.ts`、`analyser.ts` 的可达 URI/遮蔽计算、`util/sourcing.ts`，不要在某个 `server.ts` handler 里单独解释。
2. 改动后必须同时跑：definition、references、completion（含 `$` 变量分支与去重）、prepareRename/rename（文件内与 workspace 两条分支）、hover、documentSymbol。参考 `server/src/__tests__/input-declarations.test.ts` 用同一例子驱动多个 consumer 的模式。
3. 符号语义变化要同时覆盖“支持的输入”和“邻近的不支持输入”，避免凭空发明声明（动态 source、管道中的 read、`declare -g`、命令替换等）。
4. 遵守 WASM 树所有权：替换/淘汰文档必须 `tree.delete()`，分析失败保留旧缓存，不持有已释放树的节点（`analyser.ts:101-104`、114、324-329 行）。
5. 保持取消/新鲜度：编辑、关闭、配置变更、shutdown 下旧任务不得发布诊断或覆盖新分析（`analyser.ts:83`、253-256、277 行；`server.ts:190-193`、258-267 行）。
6. 不允许为“猜”动态路径而展开环境变量去扫描文件系统；无法静态解析就缺边 + 可解释诊断，用户可用 shellcheck 指令显式标注。
