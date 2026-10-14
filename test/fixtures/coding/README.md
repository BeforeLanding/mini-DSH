# 编程任务 fixture（NX-05a / NX-05b）

这 12 个无依赖 Node ESM 小项目用于验证 Harness 的读文件、编辑和执行检查流程。模拟模型按预设工具序列执行，参考解由测试驱动方持有；它们不代表真实模型自主编程成功率。

**真实模型跑过之后，这条边界已经量化**（NX-08g0）：筛查批次 12/12、对照 A 6/6，两处都取满值——**结局方差为零，量不出差异**。机制是每个 fixture 都把公开且受保护的 `check.mjs` 放在工作区里、任务说明直接给出命令，模型因此只需**收敛到绿**而非**一次写对**。所以这组 fixture 测的是「有完整 oracle 时能否收敛」，不是「能否独立产出正确实现」；详细判据与补救成本排序见 [CHANGES 的 NX-08g0 节](../../../docs/context-budget/CHANGES.md#nx-08g0-任务集天花板效应定性边界与补救排序)。

`pipeline` 是这里的第 13 个、也是唯一一个**多阶段** fixture：它在同一个会话里按序下发十四个阶段（`TASKS/*.md`），后阶段依赖前阶段的产物。它不进筛查批次（见下）。

`audit` 是第 14 个、也是唯一一个为**对照 B**（有界工具输出）设计的 fixture：单任务，受保护的 `report.mjs` 打印约 0.9 MB 的违规报告（项目估算器口径约 277k token，是输入目标 65,536 的 **4.2 倍**），而公开的 `check.mjs` 只有一条断言、失败输出指不出任何字段——模型要看细节只能去跑报告，于是「工具输出是否有界」成为可观察量。它同时不进筛查批次与阶段序列，单独一份注册表 `boundedIds`。

`repair` 是第 15 个、也是唯一一个带**项目规则**的 fixture：`initial/` 下有根目录 `AGENTS.md` 与 `src/AGENTS.md` 两份规则，作用域不同，模型必须先查 `src` 才拿得到其中一条。它供 [NX-10 的三条演示](../../../README.md#演示)使用，规则随 `project:context` 注入系统提示、也能由 `project_context` 工具查回——这是评测路径（`runFixtureTask` 不装载 `runtime-context`/`project-context`）里不存在的一段。它另有一份 `partial/src/cart.mjs` 中间态（只修好两条规则中的一条），由 [coding-fixtures.test.ts](../../coding-fixtures.test.ts) 钉住「它确实过不了公开检查」。它单独一份注册表 `demoIds`。

`blind` 是第 16 个，本身**不是一套新任务**，而是 `pipeline` 的**无公开检查变体**（NX-08h）：同一套十四个阶段、同一个 `docs/SPEC.md` 与同一份参考解，只去掉 `initial/check.mjs`、并把阶段说明末句由「运行 `node check.mjs N`」改成按 SPEC 自验。差别必须**只有这一件事**——这正是它可用的前提，因为与 `pipeline` 并排读的两个数字只有在这个前提下才能相互解释。它与 `pipeline` 测的不是同一件事：`pipeline` 测「有完整、即时、廉价 oracle 时能否收敛」，`blind` 测「能否按规格独立产出正确实现」，而 [NX-08g0](../../../docs/context-budget/CHANGES.md#nx-08g0-任务集天花板效应定性边界与补救排序) 判定的天花板正来自前者的 oracle。该前提由 [coding-fixtures.test.ts](../../coding-fixtures.test.ts) 的六条断言钉住，其中最强的一条是「从 `pipeline` 去掉的每一行都必须与公开检查有关」——只断言「不含 `check.mjs`」会放过一整段被改写的任务要求。它不进筛查批次、不进阶段序列，单独一份注册表 `blindIds`。

**「重构」类**是筛查批次里的两项：`interface`、`inventory`（种类仍是 `edit`，判据的两段由 NX-39-3d 补齐）。它们的判据分**两段**，而两段成立的**条件不同**：

| 段 | 问什么 | 在哪些态上成立 | 看什么 |
|---|---|---|---|
| 1 行为不变 | 有没有动到不该动的地方 | **初始态与参考态都成立** | 数值语义（与改动前逐位相同）＋ 纯度（不改入参） |
| 2 新接口 | 任务点名要改的那两处改了没有 | **只在参考态成立** | 返回形状、渲染文本、调用方派生自那次计算 |

**这个分法本身是判据的一部分。** 旧判据只有第 2 段——它说的全是「任务点名要改的那两处改了没有」，**没有一句**在说行为没变，而「改结构、不改行为」才是这道题的考点：一份把求和外加 `+0.01` 的实现在旧判据下与参考解一样全绿。两段写混的话，初始态判不过的原因就不再唯一——「行为被改坏了」与「改动还没做完」给出同一个读数，而报告里前者是失败、后者只是没完成。门禁因此拿**改动前的那份源码**当工作区跑一遍 `verify.mjs`，要求它退出 1、stderr 里出现「新接口」而**不**出现「行为不变」。

段 1 的量法是**差分**：[`_shared/refactor.mjs`](_shared/refactor.mjs) 把 fixture 目录下 `initial/src/` 的**改动前那份实现**加载进来当参照物（工作区之外，agent 改不到），对同一批输入断言两者算出同一个数（`assert.equal` 在 strict 下走 `Object.is`，含浮点累加顺序在内逐位相同），并断言入参没被改动。**为什么不另写一张期望值表**：那张表是照着参考解抄下来的答案，参考解改一次得跟着改，而且它测不出「参考解与改动前在这一维上是否真的没变」——那恰好是重构类判据要问的唯一一件事。这不违反 R-23：`initial/` 本来就是交给 agent 的起点，隐藏的是判据本身（这批输入与「必须逐位相同」这条规则）。输入空间 = 手写边界（空、单条、多条、`quantity` 为 0、进位敏感的小数）＋ 200 条固定种子的 LCG 生成——不用 `Math.random`：判据的输入空间在任何机器、任何一次运行上必须逐字相同，否则「这次过了」与「上次没过」不是同一件事，失败也无法复现。生成的那一片有它自己的护栏：候选「只在前几条手写用例上算对、在别处算错」必须判不过。

两处**如实记的口径边界**。① `inventory` 的参考解在 `Object.prototype` 的名字上**确实改了行为**：原实现按 `catalog[sku] ?? 0` 取值，`sku` 为 `'toString'` 时取到的是继承来的那个函数、算出 `NaN`，参考解改用 `Object.hasOwn` 之后把它归进 `missing`（实测原实现 `NaN`、参考解 `{total: 1, missing: ['toString']}`）。这是任务**没点名**的行为变化，把这类输入放进「不变」那一段会让参考解自己判不过，因此生成的 SKU 只用普通名字——判据管的是任务点名的那两处，不因此扩大范围。② 同一个未知 SKU 重复出现时 `missing` 该不该去重，任务说明没有规定（参考实现按出现次数重复列出），因此生成的用例里每个未知 SKU 最多出现一次——凭空规定一个读法会把另一种同样合理的写法判成错。

**「代码理解」类**是第 18–21 个：`repro-sessions`、`repro-money`、`repro-tally`、`repro-order`（种类 `repro`，NX-39）。它们四份是**同一个模板的四份实例**，共同形状如下。

判据不再是「工作区终态长什么样」，而是**agent 新建的那份产物的运行结果**。工作区里只有权威规格 `docs/SPEC.md` 与一处**静默的**实现缺陷，**没有公开检查**——有的话这道题就退化成照抄。任务要求 agent 在工作区根目录新建 `repro.mjs`，验收器把它放到工作区副本上跑两次：原始缺陷上必须非零退出、`reference/` 覆盖之后必须恰好 0 退出。这条 **FAIL_TO_PASS** 判据有一条直接的好处：两种偷懒写法都过不了——恒 0 在缺陷上不退非零，恒非零在参考实现上不退 0。可改文件为空（`sources[id] = []`），于是 `initial/` 里的一切自动进受保护集合，而 agent 新建的产物因为不在 `initial/` 里天然可写。判据实现在 [`_shared/criteria.mjs`](_shared/criteria.mjs)（两个新种类共用一份），门禁见 [coding-criteria.test.ts](../../coding-criteria.test.ts)；它单独一份注册表 `comprehensionIds`。

四份实例各自换一种**缺陷类别**，而不是同一个 off-by-one 抄四遍——否则「代码理解」类量到的是同一个能力点的四次重复。每一份都**只在一处、只在一行**上偏离规格，且都表现为**静默的值错**（不抛错）：

| fixture | 工作区里唯一导出的函数 | 缺陷类别 | 规格要求 vs 实现 |
|---|---|---|---|
| `repro-sessions` | `groupSessions(timestamps, gapMs)` | 比较边界 | 相邻时间差**恰好等于** `gapMs` 时同一个会话；实现按 `>=` 断开 |
| `repro-money` | `roundMoney(amount)` | 取整方向 / 符号 | 中点向**远离零**进位（`-0.125 → -0.13`）；实现用 `Math.round`，负中点向 `+∞` 进位 |
| `repro-tally` | `tallyByKind(entries)` | **漏掉一个分支** | 类别不合法（缺失／`''`／非字符串）的条目归入 `'other'`；实现把它 `continue` 掉，金额凭空消失 |
| `repro-order` | `rank(players)` | 比较器不完整 | 分数相同时按 `id` 升序；实现只比分数，同名次保持输入顺序（`sort` 稳定，因此错得确定） |

四份的规格都**明写**那条被违反的规则，但**例子部分一律不给**能区分两者的输入——这正是「读规格、再拿实现去核」的循环，而不是「跑一遍例子就知道」。`repro-order` 这一条尤其要说清：它依赖 `Array.prototype.sort` 在 ES2019 之后的**稳定性**，缺陷因此是确定的（同分者保持输入顺序），不是「次序随便」。门禁除了逐份查「恰好一处 hunk」「反例产物 ≠ 参考产物」「隐藏件不进 workspace 与任务文本」「产物不在 `initial/` 里」「模拟模型能经 `write_file` 走到判过」之外，还查一件**复制模板才会犯的错**：`TASK.md` 里点名的模块与导出名必须与 fixture 实际装配的那一份一致——复制出来的东西会让 agent 去 import 上一个 fixture 的模块，而那时判据照常工作、`fixtures:check` 照常全绿。

**已知可被绕过的一处，本步只能如实收紧、不能宣称堵上**：判据只看退出码，因此一份**不真正调用实现**、只读源码文本的产物也能满足 FAIL_TO_PASS。NX-39-3c 把两类合并进同一份 [`_shared/criteria.mjs`](_shared/criteria.mjs) 之后实跑了两种写法来量：**整文件比对参考实现文本**（退 `1/0`）与**定向 grep**（只在源码里找那一个出错的表达式，退 `1/0`）**都判过**。根因是**两类的不对称**：`mutation` 的变异体与等价体对 agent 全不可见，文本比对只剩「整体同一性」一条路，一条就被等价体挡住；`repro` 的**缺陷源码是可见的**，定向写法在信息上完全够用。要收紧得给 `repro` 也配**两侧**等价体（缺陷侧堵「找缺陷 token」、参考侧堵「赌一个修法 token」），而即便如此也只是**抬高门槛而不是证明**——任何**具体**的 token 都可能恰好同时出现在缺陷与缺陷等价体里、又同时缺席参考与参考等价体。这与「一模块一缺陷」那类**可以证明**的前提不同，是需要如实标注的残余风险。落地上的缓解是：产物内容随 `write_file` 事件一起落进 `runs.jsonl`，事后可核，但**没有机械门禁**。

**与设计的一处落差，如实记**：NX-39 的设计里这两类新任务要做成**多阶段**，理由是裁剪只移除「已结束且非当前」的 task，单任务会话永远不触发裁剪，于是上下文那一维在对照批次里只剩「压缩 + 有界」两半。这八份目前都是**单任务**。排期上的处置是把它交给 NX-39-5 的离线因子预检按实测决定（R-21 的验收条款本来就要求「处理没真的发生就不得开跑」），而不是在这里凭推理改成多阶段。

**「测试编写」类**是第 22–25 个：`mutation-bands`、`mutation-quota`、`mutation-slug`、`mutation-versions`（种类 `mutation`，NX-39-3c）。判据的方向与前一类相反：**被判的不是源码，是 agent 写的那套测试**。

工作区里的 `src/<mod>.mjs` 已经**正确实现**了 `docs/SPEC.md`，另有一份公开的 `check.mjs`（只跑规格里给的例子、在正确源码上全绿）。任务要求新建 `suite.mjs`，验收把它放到工作区副本上跑多次：在当前源码上**恰好退 0**；在 `mutants/` 的每个**变异体**上杀掉（退非零）的个数 ≥ `criteria.json` 的 `minKilled`；在 `equivalents/` 的每个**行为保持的等价实现**上**仍然退 0**，杀掉任何一个即判失败。可改文件同样为空，于是正确实现、公开 `check.mjs`、规格与配置全部进受保护集合——agent 不能改源码或改公开检查来「让测试过」。

| fixture | 工作区唯一导出 | 变异算子 | 变异体 | 参考套件杀 | 公开检查杀 | `minKilled` |
|---|---|---|---|---|---|---|
| `mutation-bands` | `bandOf(score)` | 阈值比较符翻转、边界常量、标签错配 | 6 | **6** | 2 | 4 |
| `mutation-quota` | `takeWithin(entries, limit)` | 越限判断、负值校验、累加式、收集顺序、`break`→`continue`、空 id | 7 | **7** | 2 | 5 |
| `mutation-slug` | `slugify(name, options)` | 兜底/长度守卫、首尾连字符、空串判据、截断尾部、折叠 `+` | 6 | **6** | 1 | 4 |
| `mutation-versions` | `compareVersions(left, right)` | 段数上限、空段正则、相等短路、只比前两段、删去「左小」分支、缺段补零 | 6 | **6** | 2 | 4 |

**「等价体不被杀」是这一类的防过拟合机制，也是它比 `repro` 强的地方。** agent 一个变异体也看不见，所以「比对源码文本」这条路上唯一写得出来的是**整体同一性**判断，而那必然连与自己文本不同的等价体一起杀掉——实测装上一份整文件比对产物时读数是 `killed=6/6, equivalentsKilled=2`，判不过。

两条硬约束与「一模块一缺陷」同源：每个变异体只改**一个文件、一处 hunk**（`countHunks === 1`，含整行删除那份）、导出面在 `initial`／每个变异体／每个等价体上**逐字相同**（改动多于一处的变异体可能被「别的改动」杀掉，读数就不再对应这一处）；每个**等价体必须是整文件重写**（≥2 处 hunk），只改一两处的「等价体」与原文差别太小、太像一次针对性的规避。

**`minKilled` 不是白送的**——这一条由两处机械门禁各量一遍：`pnpm test` 里的用例实跑那份公开 `check.mjs`，要求它在正确源码上退 0、不杀任何等价体、且杀数 **< `minKilled`**（并断言 `weak/suite.mjs` 与 `check.mjs` **逐字相同**，免得把它换成一个精心做弱的稻草人）；`fixtures:check` 再查一次参考套件杀数 **≥ `minKilled`**。Harness 侧另有一处复算：读数里的 `minKilled`／变异体总数／等价体总数必须与**Harness 自己数的目录项**一致，对不上整份作废。口径上「跑不完」**不算**「杀灭」（超时不是发现缺陷，否则一个会挂死的套件白拿分）。

**等价体的「行为保持」是由「参考套件没杀它」来代理**，不是证明：与规格逐条对照写出来的参考套件是最强的现成见证，但它不覆盖规格之外的行为，因此理论上一份「只在规格外的输入上偏离」的等价体会漏过。这一点与 `repro` 的 `reference/` 是同一类近似（那边的「修好了」也只是「参考套件认了」），两条都靠**写规格时把边界列全**来保证，而不是靠门禁。

`ledger` 是第 17 个，也是唯一一套**判据的载体不在工作区里**的任务。它换的是另一条思路：`blind` 证伪了「删掉公开 oracle 就能测独立产出」（完整权威规格对确定性编程任务同时就是判据的载荷），`ledger` 因此不再动规格，而是把**判据的某一段**只写进第 1 阶段的排期说明正文——`checksum:` 的口径（金额换算成「分」、取绝对值、求和）不在 `docs/SPEC.md` 里、也不可由它推导；而真正用上它的第 4 个阶段离第 1 个阶段足够远，上下文装不下时裁剪一定会先把那条说明整个拿走。它测的是「判据的载体在会话历史里时，丢掉了还守不守得住」。契约的四条落点与两条上下文字段的实测见 [PLAN 的 NX-38 契约落点](../../../docs/context-budget/PLAN.md#契约的落点fixture-ledgernx-38-2-已实现)，离线机制证明见 [nx38-covenant.test.ts](../../nx38-covenant.test.ts)。它不进筛查批次、不进阶段序列、不进对照 B 仪器与演示夹具，单独一份注册表 `ledgerIds`；**目前没有对应阶段**，付费批次的上限与判据另行预注册。

## 任务与文件

- `boundary`：修复空集合、尾部和小数索引边界；任务见 [TASK.md](boundary/TASK.md)。
- `options`：扩展 separator / skipEmpty，保留默认行为与原数组；任务见 [TASK.md](options/TASK.md)。
- `interface`：金额返回值变为对象，同时修改收据调用方；任务见 [TASK.md](interface/TASK.md)。两段判据见上文「重构」类。
- `normalize`：规整姓名中的空白与大小写；任务见 [TASK.md](normalize/TASK.md)。
- `dedupe`：按 id 保留首次出现的对象；任务见 [TASK.md](dedupe/TASK.md)。
- `pagination`：修复从 1 开始的分页偏移；任务见 [TASK.md](pagination/TASK.md)。
- `query`：构建稳定且正确编码的查询串；任务见 [TASK.md](query/TASK.md)。
- `retry`：异步操作失败后限次重试；任务见 [TASK.md](retry/TASK.md)。
- `merge`：递归合并嵌套配置并整体替换数组；任务见 [TASK.md](merge/TASK.md)。
- `csv`：处理引号、逗号和空字段的单行 CSV；任务见 [TASK.md](csv/TASK.md)。
- `inventory`：跨订单计算与收据模块修改接口；任务见 [TASK.md](inventory/TASK.md)。两段判据见上文「重构」类。
- `summary`：按类别汇总事件数量和金额；任务见 [TASK.md](summary/TASK.md)。
- `pipeline`：分十四个阶段实现「模块依赖 → 构建计划」工具；阶段见 [TASKS/](pipeline/TASKS)。
- `audit`：修正字段规整逻辑与审计比对，使 1600 条记录全部与数据集给出的期望规范值一致；任务见 [TASK.md](audit/TASK.md)。数据集由 [generate.mjs](audit/generate.mjs) 确定性生成（计数、取值池与三条缺陷轴都在那个文件里），重跑同一条命令得到逐字节相同的 `initial/data/records.jsonl`。
- `ledger`：分四个阶段实现「流水 → 台账」导出，判据的一段落只在第 1 阶段的排期说明里；阶段见 [TASKS/](ledger/TASKS)。
- `repro-sessions` / `repro-money` / `repro-tally` / `repro-order`：读 `docs/SPEC.md`、新建一份复现脚本，指出实现与规格不符的那一处；任务见各自的 [TASK.md](repro-sessions/TASK.md)。四份的形状与缺陷类别见上文。
- `mutation-bands` / `mutation-quota` / `mutation-slug` / `mutation-versions`：读 `docs/SPEC.md`，为已正确的实现新建一套测试，要求杀掉足够多的变异体且不杀行为保持的等价实现；任务见各自的 [TASK.md](mutation-bands/TASK.md)。四份的形状、变异算子与阈值见上文。
- `repair`：按两份 `AGENTS.md` 的规则修复购物车金额；任务见 [TASK.md](repair/TASK.md)。两处缺陷各被公开检查的一条断言钉住、互不遮蔽（单项折扣被忽略、整单百分数被当比例且不取整），`partial/src/cart.mjs` 是只修好第一条的已知中间态。供 [NX-10 演示](../../../README.md#演示)使用。

每项的 `initial/` 是完整初始工作区，`reference/src/` 仅保存参考修改，`verify.mjs` 是独立行为验收器。公开检查位于初始工作区的 `check.mjs`，命令为 `node check.mjs`。所有项目不需安装依赖、API Key 或网络。

### 两种布局互斥

- **单任务**：`<id>/TASK.md`，驱动只发一次 `agent.send()`，会话里只有一个 task。
- **阶段序列**：`<id>/TASKS/*.md`，按**文件名**排序（顺序由 `01-`／`02-` 这类前缀承载，不由目录项返回顺序承载），驱动在同一会话内逐阶段 `agent.send()`。每次 `send` 分配新 `taskId`，先前结束的阶段因此成为可裁剪的旧任务——这是上下文对照（NX-08e）能产生差异的前提，单任务会话无论多大都不会触发裁剪。

同时存在两者、或 `TASKS/` 里没有 `.md`，`readTaskSequence` 都直接报错而不静默退回单任务：接受哪一种布局就决定了模型被要求做多少，而读者很难察觉。`pipeline` 的公开检查按阶段累积（`node check.mjs <阶段号>` 跑第 1 到该阶段的全部断言），`verify.mjs` 仍是**工作区终态**的一次判定，不按阶段拆分。

`pipeline` 的阶段数是按「累计历史要明显越过 65,536 的输入目标」定的。**6 阶段那版已被实测否证**：3 次重复里只有 2 次真正越过阈值，且都发生在最后 1～2 个阶段。10 阶段的诊断跑在第 6 个阶段越过、后 5 个阶段受裁剪，但按同样的读数，越过阈值的**绝对阶段号大致固定**（历史随阶段号近似线性增长），加阶段只是增加越界之后的阶段数——因此再扩到 14 阶段，让低波动的那条轨迹也留得下足够多的受处理阶段。**14 阶段这一版已被实测确认**：3 次 armB 全部触发裁剪（首次落在第 8/6/6 个阶段，受处理阶段 7/9/9），而 6 阶段那版是 3 次里 1 次完全不触发。依据与实测见 [PLAN](../../../docs/context-budget/PLAN.md#nx-08e1-多阶段依赖-fixturepipeline) 与 [CHANGES 的 NX-08e 节](../../../docs/context-budget/CHANGES.md#nx-08e-对照-a全历史-vs-现有裁剪实测)。

## 运行

在仓库根目录执行：

```powershell
pnpm fixtures:check
pnpm test
```

`fixtures:check` 遍历 `fixtureIds`（筛查批次 12 项 + 阶段序列 + 对照 B 仪器 + 演示夹具 + 无公开检查变体 + 判据载体仪器 + 两个新种类的注册表），为每个任务新建临时目录，复制初始代码、执行独立验收、应用参考解、再次验收，然后删除本次创建的目录。逐行 JSON 包含初始/参考结果的 passed、退出码、输出及受保护文件变更。**前提按种类各查各的**（`edit` 种类与历史逐字相同；`repro` 还要多查两件事：没放产物必须判不过、放上反例产物必须判不过，放上参考产物不仅要判过、**读数里那一对退出码还要显式成立**——只让 `edit` 那套「初始失败、参考通过」跑一遍的话，新种类的初始态失败只是因为产物不存在，与判据有没有分辨力无关；`mutation` 多查的是：没放产物判不过、放上那份**公开 `check.mjs`** 判不过**且杀数显式小于 `minKilled`**、放上参考套件判过**且杀数显式不小于 `minKilled`**）。全部 25 项符合各自的前提时命令退出 0，否则退出 1。

`pnpm eval:offline` 只跑**筛查批次**（`screeningIds` 的 12 个单任务 fixture，对上 `phaseCaps.screening.runs = 12`）。多阶段序列属于对照 A 的仪器，不进筛查批次；它的驱动路径由 [eval-runner.test.ts](../../eval-runner.test.ts) 离线覆盖。

测试入口为 [coding-fixtures.test.ts](../../coding-fixtures.test.ts)。它实际装配 Cordis 与文件/Bash 工具，用模拟适配器读取源码、检查失败、编辑并重跑。options 故意先只修 separator，收到 skipEmpty 的失败后再补修；interface 和 inventory 各编辑两个源码文件。最终 run 状态与独立验收结果分别检查，模型回答不会直接变成验收通过。

复用接口在 [coding-fixtures.ts](../../../scripts/coding-fixtures.ts)：`createFixture(id)` 返回 kind、workspace、`tasks`、参考 edits、`artifact`、applyReference、evaluate 和 close。创建者须在 finally 调用 close；参考 edits 只供离线测试驱动使用，后续真实模型评测只发送 `tasks` 和初始工作区。`evaluate` 默认超时 30 秒（`fixtureProcessTimeoutMs`）、输出上限 32 KiB，可通过 timeoutMs / maxOutputBytes 配置。**种类由 `fixtureKind(id)` 决定**：`edit`（既有 17 个，行为逐字不变）、`repro`（代码理解，4 个）、`mutation`（测试编写，4 个）。**类别由 `fixtureCategory(id)` 决定**，与种类**正交**：种类说判据怎么算，类别说问的是什么能力——`edit` 这一类里同时住着 bug 修复、功能实现与重构三种。它用 `Record<FixtureId, …>` 逐项列全（漏一个即编译错误），因为它是**报告口径的一部分**（分类别报分子/分母），按注册表推断会在某天重排注册表时静默改掉历史口径。前三类的划分依据是各自 `TASK.md` 的正文：**bug 修复 2**（`boundary`、`pagination`）＋ **功能实现 8** ＋ **重构 2**（`interface`、`inventory`）；`audit`／`repair` 看着像修复，但它们不在筛查批次里。新种类在 `evaluate` 时多拿一个**工作区之外**的报告目录（开在 fixture 自己的临时目录里，随 close 一起消失），验收器把读数写进 `report.json`，Harness 读回来后**按自己的规则复算一遍**并与读数里那份结论比对——两边不一致即失败，否则「判据的规则」会与「Harness 认定的规则」悄无声息地漂开。`mutation` 的复算还多一层：读数里的 `minKilled`／变异体总数／等价体总数要与 Harness 自己数的目录项对得上，否则整份作废。注册表分九份：`screeningIds`（12 个单任务）、`sequenceIds`（阶段序列）、`boundedIds`（对照 B 的单任务仪器）、`demoIds`（演示夹具）、`blindIds`（`pipeline` 的无公开检查变体）、`ledgerIds`（判据载体仪器）、`comprehensionIds`（代码理解，4 个）、`mutationIds`（测试编写，4 个）、`fixtureIds`（以上之和，25 项，`fixtures:check` 用）。`readFixtureFile` 读取 fixture 目录里非 `initial/`／`reference/` 的部位（`repair` 的 `partial/`、`ledger` 的 `naive/` 与两个新种类的 `oracle/`／`weak/`／`mutants/`／`equivalents/`），路径越界直接报错。
两个新种类的判据实现在 [_shared/criteria.mjs](_shared/criteria.mjs)（一份实现供全部 fixture 复用，因此门禁测试能直接对它跑正例与反例），每个 fixture 的 `verify.mjs` 只有两行、`criteria.json` 声明产物名与种类；`criteria.json` 的 `kind` 与注册表不一致会直接抛错。**「重构」类那两段判据不共用一份实现**：`_shared/refactor.mjs` 只提供两边都要用的零件（加载改动前的那份实现、确定性用例生成、「数值不变 ＋ 不改入参」那一条），两段各自看什么由 `interface`／`inventory` 的 `verify.mjs` 自己写——它们的输入形状与要断言的语义各不相同，抽成一份反而要把两套语义塞进同一串回调。

可信验收器不从候选工作区读取测试逻辑；package.json / check.mjs 的内容和软链状态也受检查。公开检查被删改、只迁移一半接口或导入时提前退出都不会被这组回归误判为通过。临时目录与子进程不是操作系统安全隔离；这是已知离线 fixture 的验收设施，不声称能防御任意恶意代码。NX-05a 本步未新增生产验证事件、版本关联或任务交付报告；后续 NX-15 已独立实现显式文件范围验证与交付查询，仍不将普通 Bash 或 fixture 流程自动标为任务验收。

## 修改前基线（2026-09-29）

环境：Windows / Node v24.16.0 / pnpm 11.22.0。实际命令 `pnpm fixtures:check` 退出 0：

- boundary：初始退出 1，`clampIndex(0, 0)` 实际 0、期望 -1；参考解退出 0。
- options：初始退出 1，自定义 separator 实际 `a, , b`、期望 `a||b`；参考解退出 0。
- interface：初始退出 1，空数组金额实际 0、期望 `{ amount: 0, currency: 'CNY' }`；参考解退出 0。

三个初始状态验收 0/3，三个参考解验收 3/3；三个预设模拟模型工具流程验收 3/3。这是 NX-05a 历史基线，未调用付费模型，未测量真实模型质量。

## NX-05b 本地基线（2026-09-30）

Windows / Node v24.16.0 / pnpm 11.22.0：`pnpm fixtures:check` 初始 0/12、参考 12/12；`pnpm test` 141/141（其中 12 项模拟模型流程均通过）；`pnpm check` 72 文件语法通过，`git diff --check` 通过。每项参考解和验收器均留在候选工作区外。新增九项主要是短小、确定性的行为修复与扩展；原路线中按大文件/日志定位和长任务/续跑各三项分布的设想尚未覆盖，后续评测不能据此宣称这些场景的效果。没有付费模型实验。精确 SHA 6d1fd3b 的 [CI 36655224744](https://github.com/BeforeLanding/mini-DSH/actions/runs/36655224744) Ubuntu/Windows × Node22/24 四组均 success。

## NX-05b 场景分布补齐（2026-09-30）

- 单文件修复或扩展：`boundary`、`options`、`normalize`。
- 多文件修改：`interface`、`inventory`、`merge`。`merge` 的入口与辅助模块必须同步迁移，单改一个文件仍不能通过。
- 大诊断日志定位：`pagination`、`query`、`csv`。每项初始工作区有约 66 KiB、350 行合成日志，线索在第 320 行；模拟模型通过 grep 与有界行读取定位，再读取源码、修复并重测。日志由独立验收器保护。
- 预算约束与续跑：`dedupe`、`retry`、`summary`。每项模拟模型先因请求预算停止，保留已完成的失败检查和 skipped 编辑，再显式继续同一 task；成功后核对工具不重放与独立验收。代码本身仍是短任务，不能从这些模拟流程推断自然长任务成功率。

正常用户权限 `pnpm check`（72 文件）、`pnpm test`（147/147，无跳过）、`pnpm fixtures:check`（初始 0/12、参考 12/12）及 `git diff --check` 通过；精确 SHA 53e5aba 的 [CI 36657576782](https://github.com/BeforeLanding/mini-DSH/actions/runs/36657576782) Windows/Ubuntu × Node22/24 四组 success。没有使用付费模型。
