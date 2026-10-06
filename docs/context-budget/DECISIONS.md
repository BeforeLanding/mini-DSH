# 设计取舍：五个选择，以及它们被钉在哪里

更新：2026-10-06。路线图 M9 的最后一件交付（`docs/INTERNSHIP_ROADMAP.md:227`）：

> `NX-11`：整理设计取舍：事件与投影分离、协议完整性、可靠编辑、验证时效和未知副作用恢复。**能从代码和测试解释选择**。

**本文回答什么。** 每一条只回答三件事：这个选择的**替代方案是什么、它的具体失效是什么**；这个选择在**哪几行代码**上成立；**哪个测试**在它被改回去时会红。这五条也正好是路线图 §6「建议能回答这些追问」里那几问的换一种问法——那七问问的是「你怎么办」，本文给的是「你凭什么这么说」。

**本文不回答什么。** 不复述决策本身，也不复述任何数值。规范性的技术决策编号（D-01…D-21）、默认参数与官方依据一律在 [PLAN](PLAN.md)——它是「技术取舍」的唯一维护位置（见 [AGENTS.md](../../AGENTS.md) 的文档入口）。本文是它的**非规范性说明**：每节开头给出对应的 PLAN 条目，要改决策请改那里，改完回来同步本文的锚点**与结论**。只同步锚点是漏过的活——NX-34 修订 D-02 时行号都改准了，第 1 节却继续写着「没有 compaction」，直到同日的 NX-35 才靠一条新回归发现（见该节两处反转注记）。

## 怎么读

**锚点约定。** 每节末尾的锚点表由 `test/decisions-doc.test.ts` 机读，所以格式是固定的，不是随手写的：

- 每行以「类型列为 `代码`」或「类型列为 `测试`」开头，共三列：类型、锚点、它钉住什么。
- **代码锚点**写成 `相对仓库根的路径:行号`。测试会断言：文件存在、行号不超过该文件的实际行数，并且「它钉住什么」一列里**第一个反引号 token** 必须出现在该行上下 5 行以内。加这一条是因为行号会漂——文件上面插几行，锚点就指到别的函数上去了，而截图看不出来。
- **测试锚点**写成「测试文件路径」后接分隔点再接「测试名」（两者都带反引号）。测试名必须**逐字**出现在那个文件里。
- 每节必须**至少各有一行代码锚点与一行测试锚点**，并且锚点行只能出现在节内——某节退化成纯散文、或有人在正文里随手贴一行锚点，都会让测试失败。

**反转注记约定。** PLAN 里凡以「修订 D-xx」开头的决策，都改掉了本文某一节援引的结论；**那一节必须点出修订者的编号**（如 `D-21`），否则测试失败。加这一条是因为 NX-34 修订 D-02 时把本文的行号都改准了、散文却没跟着改，第 1 节继续写着「没有 compaction」——锚点回归对散文一句话都不问。和锚点一样，它只钉「有没有承认被改过」，**不证明注记把改动说对了**。

**这条测试买不到什么，先说清楚。** 它只证明锚点还指着真实存在的东西，**不证明那个测试确实断言了文中的话**。上下 5 行的邻近检查是位置检查，不是语义证明；「这段代码做的正是这里写的事」仍然只能靠人读。锚点存在 ≠ 论证成立。

**替代方案的来源标注。** 每条替代方案都带一个来源标记：

- `【决策时记录】`——当时就写下的理由，能在 PLAN／REQUIREMENTS 的同一条目里查到同期出处。
- `【事后重构】`——为本文补的理由，仓库里没有同期记录。

不加这一下，事后补的理由会被读成当初的决策依据，而两者在面试里被追问时的分量完全不同。

---

### 1. 事件与投影分离

**选择。** JSONL 事件日志是唯一事实来源；任何时刻送进模型的输入，都是从它**派生**出来的一个投影。裁剪、reset、恢复都不改写已落盘的事件，只改变「从这些事件里取哪一段、怎么解出消息」。规范条目见 [PLAN 的 D-02 与 D-08](PLAN.md#设计决策及取舍)。

**替代方案及其具体失效。**

- 全量发送历史：无法控制规模，长会话必然撞上窗口，且撞上时没有任何退让余地。【决策时记录】
- 只保留最近 N 条消息：会切断 `tool_call` 与 `tool_result` 的配对，模型收到一个没有结果的调用或一个没有调用的结果。【决策时记录】
- 模型生成摘要 / 向量检索旧内容：引入生成误差与新依赖，而摘要本身无法被核对——事件日志能逐条比对，摘要不能。【决策时记录】**【已被 NX-34 收窄，理由仍然成立的那一半见下】** 本条否决的是「让摘要**取代**事件」，这一点没被动过：压缩只在**请求投影**里换掉一段消息，原始事件一条不删。但 NX-34 确实引入了模型生成摘要，取的是把原否决理由**包住**的形态——摘要落成事件、frame 标出它替换掉的事件号，模型因此能按事件号**逐字节**回读原文（`read_history`，见 [PLAN 的 D-21](PLAN.md#设计决策及取舍) 与 REQUIREMENTS 的 R-22）。原理由剩下的那一半照旧成立：摘要文本自己依然无法被逐条比对，回读入口只是让事实可核对，**不保证模型会去核对**。
- 只存消息、不存事件：`unknown` 与 `skipped` 这类信息在消息序列里没有位置，恢复时无从判断某个工具到底跑没跑。【决策时记录】
- 只存快照、不存事件：恢复得出终态，但说不清中间发生过什么，也无法回答「它当时为什么不继续」。【决策时记录】
- reset 物理删除日志或复用序号：可追溯性直接消失，且删除本身不可逆。【决策时记录】
- 把投影结果**回写**成事件（缓存投影）：看起来省钱，但投影规则一旦改变，历史里就混进了旧规则的产物，而「投影不修改事件原文」这条也就再不可测。【事后重构】

#### 锚点

| 类型 | 锚点 | 它钉住什么 |
| --- | --- | --- |
| 代码 | `src/core/event-store.ts:97` | `append` 只把新的一行推进写入队列并按 `seq` 校验，从不回写已有行 |
| 代码 | `src/core/session-runtime.ts:89` | `visibleEvents` 是「最后一次 `session/reset` 之后」的切片，reset 是视图边界而非删除 |
| 代码 | `src/core/session-runtime.ts:250` | `clear` 追加一条 `session/reset` 事件，文件里一行不少 |
| 代码 | `src/core/context-runtime.ts:71` | 裁剪只从 `selected` 里剔除，作为参数的 `events` 原数组不参与 |
| 测试 | `test/context.test.ts` · `request projection drops oldest complete tasks, preserves raw events and current task` | 投影后原事件与投影前逐条相等，被裁的任务只出现在 `removedTaskIds` 里 |
| 测试 | `test/core.test.ts` · `Session clear keeps the same id and drops derived chat history` | reset 之后 id 不变、事件仍在、派生消息为空 |
| 测试 | `test/store.test.ts` · `crash replay unions only this run projections and restores the latest attempted input estimate` | 恢复是追加式的，原有事件前缀逐字保留 |

#### 代价

- **每次请求都要重新投影。** 裁剪是纯计算，长会话里这笔开销重复发生，换来的是不必维护任何投影缓存的一致性。
- **旧信息可能不在模型眼前。** 被裁掉的旧任务仍然躺在日志里、`/history` 查得到，但模型看不到——这不是 bug，是 D-02 明确接受的代价。
- **日志只增不减。** 事件文件没有删除路径，`parseLog` 与投影的开销仍随事件数上涨——NX-34 的压缩只在**请求投影**里把一段消息换成落盘摘要，原始事件一条不删，它买到的是「装得下」而不是「少解析」，代价是多一次受预算约束的模型调用。本条原先写的是「没有 compaction……要压缩就得先改契约（NX-16 的前提正是如此）」：**那条契约已经改完了**（[PLAN 的 D-21](PLAN.md#设计决策及取舍) 修订 D-02／R-03，R-03 的「不自动摘要」现在只描述压缩之前的裁剪基线）。压缩的参数与区间规则是数值与细节，按本文开头的约定仍留在 PLAN。

---

### 2. 协议完整性

**选择。** 送进模型的每一条 `assistant/tool_calls` 都必须带着它每一个调用的结果；裁剪永远不切断配对，停止或取消时也要为每个在途调用补出一条结果——真实完成、明确未执行的 `skipped`，或开始过但结果不可知的 `unknown`。规范条目见 [PLAN 的 D-03 与 D-06](PLAN.md#设计决策及取舍)，验收见 REQUIREMENTS 的 R-03、R-04。

**替代方案及其具体失效。**

- 按「最近 N 条消息」截断：会把 `tool_calls` 和它的结果分到两侧——供应商要么直接拒绝这种请求，要么接受了，而模型看到的是一个已发出、无回音的工具调用。【决策时记录】
- 只计成功的工具调用：失败与拒批不计数，于是「一直失败、一直重试」不受任何预算约束。只限制循环本身也管不住单批工具的数量。【决策时记录】
- 停止时不补结果、把调用留在半途：会话里出现一个只有 `tool/start` 的调用，恢复时无从判断它到底跑没跑。【决策时记录】
- 只保护当前 task，不保护「还带着在途工具的旧任务」：一个已结束但工具没配完的旧任务会被裁掉，而裁掉的正是唯一能解释那一轮的证据。【事后重构】
- 在投影里就地「修复」——给缺失的结果补一条空结果：事件与投影的边界就没了，而且补出来的东西和真的跑过一遍在日志里长得完全一样。【事后重构】

#### 锚点

| 类型 | 锚点 | 它钉住什么 |
| --- | --- | --- |
| 代码 | `src/core/context-runtime.ts:6` | `assertToolProtocol` 对孤立结果、缺失结果、重复或空 id 三种情况直接抛错，不静默丢弃 |
| 代码 | `src/core/context-runtime.ts:40` | 组内只要还有未配对的调用、或 run 尚未结束，该组就被标成 `protected` |
| 代码 | `src/core/context-runtime.ts:75` | 返回投影之前再跑一次 `assertToolProtocol`，裁剪不可能产出坏投影 |
| 代码 | `src/core/agent-loop-runtime.ts:249` | 异常路径为每个在途调用补结果，按「进过工具入口没有」区分 `unknown` 与 `skipped` |
| 代码 | `src/core/pending-tools.ts:2` | `pendingTools` 是「已声明未配对」的唯一判定，恢复与错误路径共用同一份实现 |
| 测试 | `test/context.test.ts` · `history groups entire tasks including multiple runs and never splits pending tools` | 带在途工具的组被判 `protected`；`assertToolProtocol` 对缺结果与孤立结果分别抛错 |
| 测试 | `test/budget.test.ts` · `a batch with one tool allowance executes only the first and pairs all skipped results` | 一批三个工具只执行第一个，其余各有 `skipped` 结果，投影仍然合法 |
| 测试 | `test/core.test.ts` · `Cancelling a multi-tool turn still records a result for every tool_call` | 取消时每个 `tool_call` 仍拿到结果，数量一一对应 |

#### 代价

- 一批工具在额度将尽时是「执行到额度用尽、其余标 `skipped`」，不是「整批一起拒绝」。顺序执行会留下一个中间态，只能靠 `skipped` 结果把它解释清楚——这一条在 R-04 里是被明确接受的。
- 受保护的组永远不裁剪。于是一个在途调用始终没被配对的旧任务会一直占着上下文位置。这是有意的取舍：宁可多占，也不裁掉无法解释的那一段。

---

### 3. 可靠编辑

**选择。** 编辑走「读—验—改—提交」四步的乐观并发控制：读取时留下完整字节的 SHA-256 与真实路径；修改时按**唯一字面替换**产生新内容；提交前再复核一次目标路径与指纹，然后借同目录临时文件 `sync` 之后 `rename` 替换。规范条目见 [PLAN 的 NX-13 决策节](PLAN.md#nx-13-编辑与交付决策)与 REQUIREMENTS 的 R-16。

**替代方案及其具体失效。**

- 直接覆盖写（`fs.writeFile` 打到目标上）：写入本身不是原子的，进程在写一半时死掉会留下一个被截断的文件。这比失败更糟——它看起来像成功了。【决策时记录】
- 按行号或正则替换：行号会在模型两次编辑之间漂移；正则则可能匹配上多处，然后静默地改错地方。【决策时记录】
- 只在审批**前**检查一次版本：审批等待单独限 5 分钟，用户完全来得及在这期间自己改文件，那次编辑就会把用户的改动覆盖掉。【决策时记录】
- 承诺跨文件事务或文件系统级比较交换：单文件 `rename` 是原子的，跨文件不是。承诺了就只能靠回滚假装，而回滚自己也会失败。【决策时记录】
- 拿「读到的文本」当版本凭证（比较内容是否相等）：内容相同的两个版本无法区分，用户改回原样时检测不出来。【事后重构】
- 写回时把 CRLF 统一成 LF：字节级差异会污染 diff，「保留用户原有修改」这句话也就失去了意义。【事后重构】

#### 锚点

| 类型 | 锚点 | 它钉住什么 |
| --- | --- | --- |
| 代码 | `src/core/file-edit.ts:21` | `snapshot` 一次读齐真实位置、字节指纹与权限位，解码用 `ignoreBOM` 保持字节精确 |
| 代码 | `src/core/file-edit.ts:48` | `checkHash` 先校验 `expectedHash` 的形状，再比对内容是否冲突 |
| 代码 | `src/core/file-edit.ts:53` | `replaceUnique` 对「找不到」与「不唯一」分别拒绝，不做模糊匹配 |
| 代码 | `src/core/file-edit.ts:91` | 先落同目录的 `temporary` 文件，写入并 sync 之后复核路径，最后 `rename` 替换 |
| 代码 | `src/core/file-edit.ts:109` | `rename` 成功之后的清理失败不会把一次已提交的编辑倒置成失败 |
| 代码 | `src/tools/files.ts:78` | 审批通过之后才提交；提交后出错报的是「已提交但结果不确定」，不是「编辑失败」 |
| 测试 | `test/file-edit.test.ts` · `file editing preserves exact Unicode/BOM/CRLF bytes and rejects ambiguous or unsupported text` | BOM 与 CRLF 逐字节往返；歧义与找不到的 `oldText` 被拒 |
| 测试 | `test/file-edit.test.ts` · `atomic editing detects changed and newly created targets and cleans failed/cancelled temporary files` | 目标被改动时报冲突；失败或取消之后目录里不残留临时文件 |
| 测试 | `test/file-edit.test.ts` · `atomic edits preserve permissions and internal symlinks, refusing approval-time retargeting` | 提交后权限位不变；审批期间软链改指向被拒 |
| 测试 | `test/task-changes.test.ts` · `task journal preserves dirty baseline, rejects stale reads, and resumes across JSONL restart without attributing user edits` | 用户已有改动进入基线；陈旧读取被拒；恢复不重放，也不把用户改动归因给 Agent |

#### 代价

- **最后一次复核到 `rename` 之间仍有外部进程竞态。** 第 101–102 行核验通过之后、`rename` 之前，别的进程仍可能改动目标。这是应用层乐观检测，不是操作系统级保证——PLAN 的 NX-13 决策节把它写死为「属于应用层乐观检测」。
- **落盘不确定时要人来判。** 文件可能已经改好而结果事件没写成，所以报的是「已提交但结果不确定」，须核验后才能继续，而不是简单重试。这与第 5 节的 `unknown` 是同一个设计取向。
- **快照要占地方。** 每个被跟踪文件都要留一份内容快照，`maxEditBytes` 默认 1 MiB、每 task 默认 100 个文件；超过限额的文件仍可有界读取，但不能编辑。

---

### 4. 验证时效

**选择。** 显式声明的检查被记成一条**与文件版本绑定**的证据：命令执行前记下声明文件的 SHA-256 与真实位置，执行后再记一次，两次不一致就不是 `passed`；此后任何一次编辑都会让这条证据变成 `stale`。而无论证据多完整，交付报告的 `acceptance` 恒为 `not_asserted`。规范条目见 [PLAN 的 NX-15 决策节](PLAN.md#nx-15-决策)与 REQUIREMENTS 的 R-18。

**替代方案及其具体失效。**

- 把「命令退出 0」直接当作检查通过：退出 0 只说明这条命令没报错，既不说明它跑的是当前版本，也不说明它覆盖了改动。【决策时记录】
- 把普通 Bash 自动识别成验证：只有模型显式声明文件范围才算数，否则「我跑过测试了」这句话无从核对到底跑了什么，也没有范围可查。【决策时记录】
- 成功后丢掉旧的失败记录：一份只留最新一次通过的清单，会把「先前失败过、改了之后才过」这段掩盖掉。所以每次检查独立保留。【决策时记录】
- 把 `passed` 当成任务验收：显式声明的文件与命令只是一个**有界**样本，证明不了未声明的依赖、目录新增或别处的改动。【决策时记录】
- 用修改时间判断文件有没有变：改回原字节会让时间变而内容不变；反过来也有保持时间却改了内容的操作。用内容哈希加真实位置才是可判定的。【事后重构】
- 只在查询时按需检查、不落盘检查前版本：那就永远答不出「这条证据当时基于哪个版本」，也分不开「检查**中**被改过」与「检查**后**被改过」。【事后重构】

#### 锚点

| 类型 | 锚点 | 它钉住什么 |
| --- | --- | --- |
| 代码 | `src/core/task-verification.ts:15` | 声明文件的版本快照；`tolerateErrors` 只在检查**后**那次读取上打开 |
| 代码 | `src/tools/bash.ts:49` | `journal` 把检查意图（含检查前版本）先落盘，落盘之后才执行命令 |
| 代码 | `src/core/task-verification.ts:63` | 状态由检查前后版本是否一致推出，`unavailable` 与 `unknown` 各自有独立分支 |
| 代码 | `src/core/task-verification.ts:65` | freshness 拿**当前**文件重算，并叠加此后的 `file/change` |
| 代码 | `src/core/task-verification.ts:70` | 查询自带范围说明：只覆盖声明的文件与命令 |
| 代码 | `src/core/task-verification.ts:148` | 交付报告的 `acceptance` 恒为 `not_asserted`，不随证据变多变强而改变 |
| 代码 | `src/tools/bash.ts:56` | 取消之后不绕过 signal 去读新版本，检查后版本记 `unavailable` |
| 测试 | `test/bash-verification.test.ts` · `Bash explicitly records approved checks, preserves failure, detects check mutation and leaves ordinary commands unverified` | 状态序列含 `passed`/`failed`/`stale`；之后的编辑把 freshness 推成 `stale`；普通命令不生成任何验证记录 |
| 测试 | `test/task-verification.test.ts` · `verification retains failure, detects changed versions, and restores unknown without execution across continuation/reset` | 失败记录不被后来的成功抹掉；文件变了即 `stale`；恢复不重放命令 |
| 测试 | `test/task-report.test.ts` · `delivery report separates completed run, current coverage, unverified edits and all failed checks with independent pages` | `acceptance` 恒为 `not_asserted`；过期证据与未覆盖文件分别列出 |

#### 代价

- **检查开销按声明文件数走。** 默认最多 100 个文件、每个最多 1 MiB，声明得越多越慢。模型得自己权衡「覆盖够不够」与「读一遍要多久」。
- **过期判定宁可保守。** 文件被文件工具改动过就算 `stale`，即使它最终被改回了原字节。代价是偶尔会把仍然有效的证据标成过期——这个方向的错误比反过来安全。
- **证据只覆盖声明范围。** 未声明的依赖、目录新增、检查过程中被改又改回的文件，以及 Bash 之外途径的修改，都不在保证内。R-18 与 PLAN 的 NX-15 决策节都写明了这一条。

---

### 5. 未知副作用恢复

**选择。** 一个工具**已经开始、但结果没有落盘**时，恢复把它记成 `unknown`——而不是「没跑过」；恢复过程本身不重放任何工具。只要同一个 task 里存在一条 `unknown` 结果，自动续跑就被拒绝，必须由人核验副作用之后显式开新任务。规范条目见 [PLAN 的 D-06 与 D-08](PLAN.md#设计决策及取舍)，验收见 REQUIREMENTS 的 R-11、R-12。

**替代方案及其具体失效。**

- 把没有结果的调用当作「没执行过」，恢复后重放：一个已经写了一半文件的命令会被执行第二遍，而它未必可重复。【决策时记录】
- 把未知结果当作失败直接重试：同样等于再执行一次，只是把它包装成了错误处理。【决策时记录】
- 崩溃之后自动续跑、不必人介入：「自动重放缺失结果可能重复副作用」，这是 PLAN 的 D-08 与 REQUIREMENTS 都写下的拒绝理由。【决策时记录】
- 恢复后回到「上一个已知良好状态」再继续：那需要文件系统快照，而恢复只是事件重建，不恢复文件系统。【决策时记录】
- 让恢复顺手把文件「纠正」回日志里记的样子：事件日志是**事实**来源，不是期望状态。照它去改磁盘，等于让 Harness 在没有模型、也没有审批的情况下自己动手改文件。【事后重构】
- 只按「有没有结果事件」判断，不看有没有 `tool/start`：那就分不出「派发之前被预算拦下」和「派发之后结果丢了」。这两件事的处理方式正好相反——前者可以放心跳过，后者必须先核验。【事后重构】

#### 锚点

| 类型 | 锚点 | 它钉住什么 |
| --- | --- | --- |
| 代码 | `src/core/session-runtime.ts:49` | 恢复时用 `pendingTools` 逐个找出在途调用并补一条结果，由有没有 `tool/start` 决定 `unknown` 还是 `skipped` |
| 代码 | `src/core/session-runtime.ts:75` | 崩溃窗口里还停在 running 的 run 被封成 `error`，不留在半途 |
| 代码 | `src/core/session-runtime.ts:151` | 同 task 只要存在一条 `unknown` 结果，自动续跑就被拒并说明原因 |
| 代码 | `src/core/task-changes.ts:39` | 文件编辑意图没有配对结果时同样抛错，不让新任务在不知道结果的情况下开工 |
| 代码 | `src/core/agent-runtime.ts:32` | `continue` 只是开一段新 run；拒绝的逻辑在 `beginRun` 里，不在调用方 |
| 测试 | `test/store.test.ts` · `recovery preserves task state, adds unknown/skipped results and never executes tools` | 两个在途调用分别补成 `unknown` 与 `skipped`；副作用文件未被触碰；用量标 `uncertain` |
| 测试 | `test/store.test.ts` · `a stale writer lock blocks recovery until it is removed explicitly, then restore marks the interrupted tool unknown` | 崩溃残局（日志停在 `tool/start` + 残留锁）经显式销锁后恢复，补出的正是 `unknown`，且续跑被拒 |
| 测试 | `test/continue.test.ts` · `continuation protects all prior runs and refuses unresolved tool outcomes` | 存在未决结果时 `/continue` 抛错；reset 之后报的是「没有可续跑的任务」 |
| 测试 | `test/tool-results.test.ts` · `structured failed and timed-out command events restore from JSONL without replaying side effects` | 恢复出来的命令结果与原始事件逐字相等，而副作用文件仍是原值——证明没有重放 |

#### 代价

- **恢复之后当前 task 可能续跑不了，只能显式开新任务。** 这是刻意的：宁可让用户多走一步确认，也不静默重放一个有副作用的操作。
- **`unknown` 一旦落进日志就一直是 `unknown`。** 后来的人工核验结论不会写回事件——要写就得在模型与审批之外改文件。所以日志里会一直留着「当时不知道」这个事实。
- **模型那一侧的尾部会丢，工具那一侧不会。** 流片段按 250ms 或 4KiB 合并追加、不逐 token sync，所以崩溃可能丢掉最后一段还没写盘的流；恢复会为缺 usage 的请求补一条 `estimated` 用量和一条 `complete:false` 的 `model/end`。工具不同：`tool/start` 是语义事件，先落盘并等待 sync 之后才执行命令，所以「已经开始」这件事本身不会丢。

---

## 总表

五条选择、它们的规范出处，以及有没有一条能直接跑的演示。**本表只是索引**；权威锚点在上面各节的锚点表里，由 `test/decisions-doc.test.ts` 校验。

| # | 选择 | 规范出处 | 可跑的演示 |
| --- | --- | --- | --- |
| [1](#1-事件与投影分离) | 事件日志是唯一事实来源，请求投影由它派生 | PLAN D-02、D-08 | 无对应演示 |
| [2](#2-协议完整性) | 配对不可能被裁剪切断，停止时为每个在途调用补出结果 | PLAN D-03、D-06 / R-03、R-04 | `pnpm demo:resume` |
| [3](#3-可靠编辑) | 字节指纹 + 唯一字面替换 + 同目录临时文件 `rename` | PLAN 的 NX-13 决策节 / R-16 | `pnpm demo:fix`（只走顺利路径） |
| [4](#4-验证时效) | 检查证据绑定文件版本，之后的编辑使其过期 | PLAN 的 NX-15 决策节 / R-18 | `pnpm demo:fix`（只走通过路径） |
| [5](#5-未知副作用恢复) | 结果未落盘记 `unknown`，不重放，并挡住自动续跑 | PLAN D-06、D-08 / R-11、R-12 | `pnpm demo:unknown` |

**关于「可跑的演示」这一列，两点要说清楚。** 第一，三条演示用的是预设的脚本化模型，退出码 0 只说明 Harness 的行为符合预期，不代表任何模型能力（见 [README 的演示一节](../../README.md#演示)）。第二，`demo:fix` 只走**顺利路径**——它展示两个编辑都用 `read_file` 给的 `expectedHash` 提交成功、一次显式检查落成验证记录，但它**不展示**冲突、过期、`unknown` 这些分支。那些分支的证据在锚点表列的测试里，不在演示里。列在这里的两处 `demo:fix` 都只是「这条选择在真实运行里长什么样」，不是它的证明。

**还有两件本文没有覆盖的事。** 一是事件持久化的写入语义（锁、sync 粒度、尾部半条记录）——它属于 D-08 与 PLAN 的持久化一节；崩溃残局里那把 `writer.lock` 的处置入口是 `pnpm session:lock <sessionId>`（NX-21）：只读检视锁体与 pid 探针，解除要显式 `--remove --token`，**不按 PID 自动移除**。二是上下文裁剪与输出额度的参数取舍——那些是数值，按本文开头的约定一律留在 PLAN。
