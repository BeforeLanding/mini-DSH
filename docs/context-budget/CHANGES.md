# 改动与验收证据

更新：2026-10-02。本文件保存任务的详细行为、验证、提交和 CI 证据；可扫描状态见 [TASKS](TASKS.md)。以下任务证据从原 TASKS 原样迁入，原 CHANGES 的实现总结保留在文末。

## NX-27 Windows Git Bash 的 `/tmp`

### 现象、决策与实现

Windows 上 Git for Windows 的 `cygpath -w /tmp` 指向用户临时目录，且 Git Bash 中 `/tmp` 可写；同一 token 交给 Windows `node:path` 却从当前盘根解析，例如得到 `D:\tmp\out.txt`。命令由前者执行、由后者审批，语义不一致使 `echo x > /tmp/out.txt`、`cat /tmp/out.txt` 与 `node tmp.mjs > /tmp/r.log` 全部误报 `path escapes the workspace`。

实现选择映射而非白名单：`resolveGitBashTemp` 只在 Windows 且 POSIX 归一化后仍位于 `/tmp` 时，取其相对部分并以 `os.tmpdir()` 为根调用既有 `resolveInside`。因此普通临时文件放行，而 `/tmp-link` 不匹配、`/tmp/../etc` 先命中 `..` 判据、临时目录内指向外部的 junction 命中 `through a symlink`。其他平台与文件工具的 workspace 根没有变化。

### 回放、测试与反例

真实模型的 782 次 bash 调用回放中，拒绝从 **6 条降到 2 条**；消失的恰是 `7d13fdc54a`／`52e783f9c4`／`21c76e9675`／`11dc755c95` 四个 NX-27 指纹，留下 NX-29 的 `/missing` 与命令内 `cd` 导致的 `../package.json` 两条既有边界。矩阵新增 Windows／非 Windows 分支与两条反例，输出仍是 `no contract drift; 28 known gap(s) still open`。

关闭映射分支并重建后，定向测试的三个子测试分别变红：`echo x > /tmp/nx27.txt`、`cat /tmp/nx27.txt`、`node tmp.mjs > /tmp/nx27.log` 均从 allow 退回 deny；向外 junction 的理由同时从 `through a symlink` 退化为普通 workspace escape。恢复后定向测试 4/4 通过。

```
pnpm check                                       # syntax ok: 93 files
pnpm test                                        # tests 217 / pass 217 / fail 0
pnpm lint                                        # Checked 102 files. No fixes applied.
pnpm fixtures:check                              # 16 项：初始均失败、reference 均通过
pnpm eval:offline                                # planned/executed/accepted 12/12/12
pnpm eval:estimate                               # estimator/corpus matchesReference 均为 true
node docs/context-budget/nx17-gate-probes.mjs    # no contract drift; 28 known gap(s) still open
node docs/context-budget/nx24-replay-probe.mjs   # no unexpected deny: 2 条全部有归属
```

提交：`5c62097`（NX-27-0 立项）、`4670aca`（NX-27-1 映射与回归），以及本提交（NX-27-2 契约、回放与回填）。全程零付费模型调用。

## NX-25 here-doc 正文按消费者分流

### 现象、决策与实现

闸门此前把整串命令逐 token 扫描，here-doc 的正文也在其中：`cat <<'EOF'` 里的 `curl https://example.com` 是交给 `cat` 的数据，却被当成新命令段拒绝；但不能无条件跳过，因为 `bash <<'EOF'` 确实会执行正文。D-18 因此只引入一条窄语义：识别未被引用的 `<<WORD`／`<< WORD`／`<<-WORD` 与带引号定界符，按出现顺序配对正文；`sh`／`bash`／`zsh`／`dash`／`ksh` 消费者的正文递归走同一闸门，其余正文从顶层扫描剥离。命令行本身始终保留，所以 `curl <<EOF` 与 `cat <<EOF; curl x` 仍拒绝；`<<<` here-string、引号里的 `"<<EOF"` 与注释里的形状不按 here-doc 处理。

实现集中在 `src/core/sandbox-runtime.ts`：`hereDocumentRedirects` 做一趟引号／转义感知的重定向扫描，`splitHereDocuments` 负责按 shell 顺序取正文，`#inspect` 共享同一个计数／字节预算递归检查 shell 正文。消费者取简单命令首词的 basename；`env bash <<EOF` 等包装形式仍属于 D-16 已登记的包装命令边界，不借本项恢复通用 shell parser。

失败闭合与上限均给独立理由：最多 **16 份** here-doc、正文累计 **256 KiB**、shell 正文递归最多 **3 层**；缺终止词、坏定界符或越过任一上限都拒绝。边界值（16 份、恰好 256 KiB、3 层）逐条放行，下一单位逐条拒绝。

### 回放与连带结果

诊断矩阵的 `known gap NX-25` 先读到 `met`，再搬进 `fixed: here-document consumers`，并增加 `bash` 正文拒绝的孪生行；结果为 `no contract drift; 28 known gap(s) still open`（原 29）。真实回放 782 次 bash 调用中，拒绝由 **7 条降到 6 条**：消失的唯一条目是 `c7475a2f5e`，即 NX-28 的 node here-doc 正文里 `a:\tb\tc` 被当成盘符路径。盘符规则一行未动，NX-28 是由“数据正文不再进入路径扫描”连带闭合。

另一条含 here-doc 的回放 `7d13fdc54a` 仍被拒，因为命令行本身是 `cat > /tmp/t1.mjs <<'EOF'`：拒绝来自 `/tmp` 与 Windows `node:path` 的语义差异（NX-27），不是正文。本项没有把它误放。探针删除 NX-28 指纹后退出 0，其余 6 条集合与理由不漂移。

### 验证与反例

```
pnpm check                                       # syntax ok: 93 files
pnpm test                                        # tests 213 / pass 213 / fail 0
pnpm lint                                        # Checked 102 files. No fixes applied.
pnpm fixtures:check                              # 16 项：初始均失败、reference 均通过
pnpm eval:offline                                # planned/executed/accepted 12/12/12
pnpm eval:estimate                               # estimator/corpus matchesReference 均为 true
node docs/context-budget/nx17-gate-probes.mjs    # no contract drift; 28 known gap(s) still open
node docs/context-budget/nx24-replay-probe.mjs   # no unexpected deny: 6 条全部有归属
```

四个失败闭合守卫逐一临时放宽、每次重建后只跑定向用例，均按对应断言变红：数量 `> 16` 改成 `> 17` 后 17 份未拒；字节 `> 262144` 改成 `> 262145` 后 262145 字节未拒；深度 `>= 3` 改成 `> 3` 后 4 层未拒；缺终止词分支改成吞到 EOF 后未拒。逐项恢复后定向用例重新通过。测试过程还抓出一处真实实现坑：只排除第一个 `<<` 会在 `<<<` 的第二个字符重新命中，必须同时检查前一个与后两个字符；`cat <<<"curl example.com"` 的回归将它钉住。

### 提交

`f04251d`（NX-25-0 契约）、`c214059`（NX-25-1 分流）、`9759b38`（NX-25-2 上限），以及本提交（NX-25-3 回放与回填）。全程零付费模型调用。

## NX-18 目录逃逸的 token 级判定

### 现象与根因

`..` 是闸门保留的四条整串正则之一。整串正则的优点是廉价且稳定，代价是**不区分「数据」与「代码」**——`/(?:^|[\s"'=])(?:[^\s"']*[\\/])?\.\.(?:[\\/]|[\s"']|$)/` 只看文本形状，于是引号里的同形文本一起被拒：`echo "see ../docs for details"`（散文里的 `../`）、`grep -n ".." src/index.ts`（正则）、`git log --grep "../ fixes"` 三条全判 `.. path escape is blocked`。这条规则同时是用户「放宽不得削弱 `..`」条款点名保护的对象，所以 NX-17／NX-19／NX-24／NX-32 四轮都刻意绕开它。

**先把这条例外的价格算清**：把 `.eval-evidence/` 下 782 次真实模型 bash 调用按**各会话自己的 workspace** 重放，含 `..` 的调用 **57 条，其中只有 1 条被拒**（`062d867579`）。

**但那条不是整串正则的错**：命令是 `cd src && for f in …; do …; done; cat ../package.json; ls ../data`——闸门**不知道命令内部的 `cd` 改过目录**，`../package.json` 相对 workspace 根确实越界。**所以本轮修完它仍然被拒**。它在 `nx24-replay-probe.mjs` 的断言集合里**保留**，只把注记从「`..` 整串正则」订正成真实原因（闸门不看命令内的 `cd`，属 D-16 撤掉的命令位置状态族）。把这两件事分开写，是因为「登记一条缺口」与「这条缺口会不会被本轮关掉」是两回事。

### 判据

整串正则退场，改为 **token 级路径形状判定**（`src/core/sandbox-runtime.ts` 的 `isPathEscape`）。一个 token 判为逃逸，当且仅当它的**去引号正文**同时满足：

| # | 条件 | 挡住的误判 |
| --- | --- | --- |
| ① | 不含空白 | `"see ../docs for details"`、`"../ fixes"`（含空白的 token 不是可寻址路径，沿用 NX-24-5 处理前导斜杠时的同一条先例） |
| ② | 按 `[\\/=]` 切分后存在分量恰为 `..` | `a..b`、`...`、`a/x../y`（判分量而不是判子串） |
| ③ | 正文含分隔符，或它在原串里是裸词 | 引号成词的裸 `".."`（真实语料里那是正则），同时保住裸 `..` 仍被拒 |

**`=` 计入分量边界是有意的保守取法**：不计入的话 `--file=../secret` 会因为「分量是 `--file=..`」被放过去，顺着这次放宽新开一个洞。代价是 `--grep=..` 这类惰性文本仍被拒——它与 `--dir=..` 在形状上无判据可用，按 NX-29 的口径处理：没有可用的形状判据就不放宽。

### 交付物

| 文件 | 改动 |
| --- | --- |
| `src/core/sandbox-runtime.ts` | 删掉整串 `..` 正则；新增 `isPathEscape` 与循环内的一次调用；`:18` 与 `:78` 两处注释里的「四个整串正则」改为「三个」并写明为何只有这一条被放出来 |
| `test/core.test.ts` | allow 表 +5（三条惰性文本 ＋ 两条「分量不是子串」孪生行）；deny 表 +7（裸 `..`、`cd ..`、`cp ../a b`、`"../secret"`、`--file=../secret`、`X=..; cat $X/secret`、刻意钉住的 `--grep=..`） |
| `docs/context-budget/nx17-gate-probes.mjs` | 两行 `known gap NX-18` 读到 met 后搬进新契约组 `fixed: lazy dotdot text`；`X=..; cat $X/secret` 搬到 `kept` 组而孪生行留在 gap 组；头部两处注释同步 |
| `docs/context-budget/nx24-replay-probe.mjs` | `062d867579` 的注记订正；头部说明「本项修完它为什么仍在」 |
| `docs/context-budget/REQUIREMENTS.md` | R-20 的四条判据里第 1 条由四改三、第 2 条补 `..` 判据；验收句与已知边界句订正 |
| `docs/context-budget/PLAN.md` | 新增 D-17；D-16 末尾加一条带日期的局部修订注记 |
| `docs/context-budget/TASKS.md`、`PROGRESS.md`、`README.md` | 状态、待办清单与计数同步 |

### 实测证据

```
pnpm check                                       # syntax ok: 93 files
pnpm lint                                        # Checked 102 files. No fixes applied.（0 诊断）
pnpm test                                        # tests 211 / pass 211 / fail 0
node docs/context-budget/nx17-gate-probes.mjs    # no contract drift; 29 known gap(s) still open
node docs/context-budget/nx24-replay-probe.mjs   # no unexpected deny: 7 条全部有归属
```

矩阵的已知缺口由 **32 行降到 29 行**：两行是 NX-18 的两条，第三行见下。**回放探针的拒绝集合一条未增**（仍 7 条，`062d867579` 含在内，理由仍是 `.. path escape is blocked`——拦住它的从整串正则换成了 token 判定，而它相对 workspace 根确实越界）。

**一处连带收紧，是矩阵读到 `met` 才发现的**：`X=..; cat $X/secret` 由 allow 变 deny。分词把 token 切在 `;` 之前，于是 `X=..` 的分量 `..` 与边界 `=` 同时命中。它原本挂在 `known gap NX-32 variable indirection` 组下，现在搬到 `kept` 组——**但理由是 `..` 而不是变量间接**：孪生行 `Y=/etc; cat $Y/passwd` 仍是 gap，两条分开记，不合并成「变量间接已覆盖」。

### 反例实跑

仓库硬性惯例：每条新分支都要能证明用例会咬。两条各自打掉一个分支，跑完都用 `git restore` 复原：

```
① 还原整串正则并停用 token 判定
   ✖ Sandbox blocks dangerous commands and allows ordinary workspace commands
     AssertionError: echo "see ../docs for details"
       actual: 'deny'   expected: 'allow'
   pass 210 / fail 1
② 把分量判定退化成 body.includes('..')（判子串而非分量）
   ✖ 同上用例   AssertionError: ls a/x../y   actual: 'deny'   expected: 'allow'
   pass 209 / fail 2
改回：pass 211 / fail 0
```

第 ① 条证明「含空白放行」这一支是承重的；第 ② 条证明「分量不是子串」这一支是承重的（退化成子串判定就会把 `a/x../y` 这样的普通文件名判成逃逸）。

### 未做与代价

- **不修 `062d867579`**：它的根因是闸门看不见命令内的 `cd`，那是 D-16 撤掉的命令位置状态族。本项**不宣称**「回放里的 `..` 拒绝已清零」，只宣称判据从整串换成了 token 级。
- **`--grep=..` 仍是误拒**，且刻意保留（无判据可用）；它被写进测试与矩阵，将来若要放宽必须先给出可用的形状判据。
- **净放宽一条**：引号包住裸 `..`（`cd ".." && cat x`）从此放行。这是本项的记录在案代价，写在 D-17 与 R-20 里，不用「已闭合」措辞。
- **闸门仍然不是安全边界**：真正的边界是 `utils/path.ts` 的 `resolveInside` 与人工审批，两者都不是操作系统隔离。

### 验收

`test/core.test.ts` 的 allow/deny 表逐条钉住六种仍被拒的路径形状与三条新放行的惰性文本；矩阵 `no contract drift`、已知缺口 29 行；回放探针退出 0 且拒绝集合不增；两条反例实跑各自点名到具体用例。**只动 `src/` 的一个函数与三份文档，未碰 `utils/path.ts`、`contracts.ts` 与 estimation 语料**（`pnpm eval:estimate` 仍退出 0）。

### 提交

`8e36afd`（NX-18-0 立项）、`b9ca89f`（NX-18-1 判据替换）、`dfcfa1c`（NX-18-2 契约与矩阵），以及本提交（NX-18-3 回填）。

### CI

本次推送（`8e36afd`…`0ddeaeb`）的 [CI 36992959210](https://github.com/BeforeLanding/mini-DSH/actions/runs/36992959210) 在 tip `0ddeaeb` 上四组合（Ubuntu/Windows × Node 22/24）**全部 success**，**attempt=1**，无重跑。**本次含 `src/`、`test/` 改动**（判据替换与契约扩表），所以与 T6 那次不同——不是靠文档改动顺带触发；四组合覆盖的是同一条 `pnpm check` + `pnpm test` 链。

## T6 Biome 的收窄配置与处置

### 现象与根因

`pnpm lint` 从未绿过。仓库里**没有 `biome.json`**，于是 Biome 以默认规则运行——制表符、双引号、分号、导入排序——而全仓库的既有风格是 2 空格、单引号、无分号。结果不是「有些文件不合规」，而是**每一个源码文件都不合规**：250 个有诊断的文件里，**每一个**都至少有一条 `format` 告警。这是一次**全局配置分歧**，被当成了 250 个独立问题。

**没有排除项让噪声又翻了一倍**：初始 717 条诊断里，**196 条落在 `dist/`、14 条落在 `.eval-evidence/`**——构建产物与评测证据，两者都在 `.gitignore` 里。真实属于源码的是 **507 条（366 err / 117 warn / 24 info）**。

**长行靠配置救不了。** Biome 2.5.14 拒绝 `lineWidth > 320`，而仓库有 **17 行超过 320**（最长 732，`src/core/event-validation.ts`）、131 行超 200、1219 行超 120。所以「修到绿」不是翻一个开关，是**必然要重排约 2000 行**。

### 修绿成本实测（草稿副本，两种修法各跑一遍）

配置取最贴近现有风格的 `space/2/single/asNeeded/lineWidth 320`：

| 修法 | 触及文件 | 行数 | 剩余 | `pnpm check` | `pnpm test` |
| --- | --- | --- | --- | --- | --- |
| 安全 `--write` | 210 | −4928 / +7491 | 160 err | ✅ `syntax ok: 93 files` | ❌ **fail 2** |
| `--write --unsafe` | 211 | −4961 / +7523 | 12 err | ❌ **8 条 TS2532/TS2345** | ❌ 构建先失败 |

**两条路都会打破仓库自己的回归套件，因为那里钉着机器不变量**：

1. **`test/estimation.test.ts` 给 `src/core/token-estimator.ts` 钉了 SHA-256**。重排即改字节，报错原文是「re-run the NX-08c measurement and update the recorded conclusions and 核验日期」——**重排这个文件等于作废一次实测结论**。
2. **`test/decisions-doc.test.ts` 校验 `DECISIONS.md` 的三十行代码锚点**。`organizeImports` 一开就位移行号，锚点随之漂移（报 `event-store.ts:97 附近找不到 append`）——与 NX-21 咬过的那次同因。
3. **unsafe 修法删掉 `!`**（`noNonNullAssertion` 的「修复」就是删除），立刻产生 8 条 `TS2532`／`TS2345`。

### 交付物

**用户选定方向：收窄配置，不设门禁**——不重排既有代码，只把 Biome 调成与仓库风格不冲突，并把它真正抓到的发现逐条修掉。

**`biome.jsonc`**（新增；用 `.jsonc` 而非 `.json` 是为了让每条排除项**就地带上理由**）：

- `vcs.useIgnoreFile: true` —— 让排除表跟着 `.gitignore` 走，`dist/`、`.eval-evidence/`、`.demo-runs/` 自动出局。
- `files.includes: ["**", "!test/fixtures"]` —— `test/fixtures/` 是**故意写坏的初始态**（`retry/initial/src/retry.mjs` 的未用参数就是待修缺陷本身），`pnpm fixtures:check` 的 16 项契约依赖它们保持坏。**Biome 不得「修好」它们。**
- `formatter.enabled: false`、`assist.enabled: false` —— 见上：判定不可满足，且会打破上面两条不变量。**这是有意关闭，不是「暂时忽略」。**
- 只关三条与仓库刻意写法正面冲突的规则：`style/noNonNullAssertion`（107 处）、`style/useTemplate`（46 处）、`suspicious/noControlCharactersInRegex`（`src/plugins/cli.ts` 剥离 ANSI 用的 `\x1b` 正则）。**其余发现逐条修，不用关规则绕过。**

**`package.json`**：移除 `format` 脚本。formatter 关掉之后 `biome format --write .` 是**静默空转**，留着比没有更糟。`lint` 与 `lint:fix` 保留（后者现在只应用 lint 修复，不再动格式）。

**`AGENTS.md:21`** 由「`pnpm lint` 当前不是 CI 门槛；不要用 `lint:fix` 或 `format` 顺带重排无关代码」改写为：不是 CI 门槛但**当前应为绿**，并写明「**不要为了顺手统一格式把它们打开**」及其代价。

**9 个源码文件逐条订正（+26 / −18 行）**：

| 文件 | 订正 |
| --- | --- |
| `src/core/agent-loop-runtime.ts` | 删未使用的 `estimateInput` 导入 |
| `src/core/file-edit.ts` | 两处 `let handle` 补 `FileHandle \| undefined`；`noUnsafeFinally` **逐行豁免**并写明理由 |
| `src/core/session-runtime.ts` | `if (!begin \|\| begin.type !== …)` → `begin?.type !== …` |
| `src/core/task-changes.ts` | `if (!state \|\| state.status !== …)` → `state?.status !== …` |
| `src/plugins/cli.ts` | `escape` → `onKey`（三处），不再遮蔽全局 `escape` |
| `src/tools/files.ts` | 补 `FileSnapshot` 类型导入与 `let before: FileSnapshot \| undefined`；字符类里去掉多余转义 |
| `test/bash-verification.test.ts` | 解构里删掉未使用的 `session` |
| `test/coding-fixtures.test.ts` | 两处 `forEach` 箭头体补花括号（不再返回 `assert.match` 的值）；三处**必须**是字面 `${…}` 的字符串逐行豁免 |
| `test/integration.test.ts` | `escape` → `escaped`（三处） |

**`noUnsafeFinally` 为何豁免而不重构**：`file-edit.ts` 的 `finally` 里那个 `throw` 是该块**唯一**的抛出路径，且只在 `rename` 从未成功（`committed` 为假）时才走——那种情况下没有「已被吞掉的原始异常」需要保护。规则按**形状**报警，此处按**语义**豁免；重构恢复路径的风险大于收益。

**为什么本方向能成立而「修到绿」不能**：`src/core/token-estimator.ts` 在关掉 formatter／organizeImports／noNonNullAssertion 之后**零诊断**，因而**字节不动**，钉版哈希自然保住。这正是这组配置选择的落点。

### 实测证据

```
$ pnpm lint                      # 修前：545 errors / 124 warnings / 48 infos
$ biome check .
Checked 102 files in 102ms. No fixes applied.
exit=0                           # 0 诊断

$ pnpm check
syntax ok: 93 files

$ pnpm test
ℹ tests 211
ℹ pass 211
ℹ fail 0
```

三条机器不变量按名通过：

```
✔ the decision write-up keeps every code and test anchor pointing at something real
✔ every in-repository markdown anchor points at a real heading
✔ pinned reference still matches the estimator and corpus it was measured against
```

### 反例实跑

把 `formatter.enabled` 打开、`assist.organizeImports` 设回 `on`（即「顺手统一一下格式」那一步），其余不变。**在真实工作树上跑，跑完 `git restore .` 复原**：

```
$ biome check .
Checked 102 files in 119ms. No fixes applied.
Found 175 errors.

$ biome check --write .
Checked 102 files in 347ms. Fixed 100 files.
Found 1 error.
Found 3 warnings.

$ pnpm test
✖ the decision write-up keeps every code and test anchor pointing at something real
✖ pinned reference still matches the estimator and corpus it was measured against
ℹ tests 211 / pass 209 / fail 2
```

改回来即恢复 `Checked 102 files / 0 诊断` 与 `pass 211 / fail 0`。**这组排除项是承重的，不是装饰**——这也正是 `AGENTS.md:21` 那句警告为什么要写明代价。

（数字与上文「修绿成本实测」里的 177 errors / 102 files 略有出入，因为那张表是在**订正之前**的草稿副本上测得，这 2 条差异正是 T6-1 修掉的那几处发现。两处都按各自实际输出原样保留，不合并成一个数。）

### 两处只有真跑才会暴露的坑

1. **`biome.json`（`.json`）不接受 `//` 注释**——2.5.14 报 parse error。改用 `biome.jsonc` 才有注释。
2. **更危险的是：配置解析失败时 Biome 不报错，直接退回默认规则**。用 `.json` 写带注释的版本时，`pnpm lint` 会**照常输出一整套默认规则的诊断**，看上去「配置生效了但代码不合规」。第一次跑就落进这个坑，靠「诊断条数与修前逐字相同」才发现。**这是本项最值得记的一条**：配置文件写错不会红，只会静默失效。

### 未做与代价

- **不加 CI 步骤、不加测试**（用户选定）。**代价要写明**：没有门禁就会漂移。补偿是两处——`biome.jsonc` 的每条排除项带理由，`AGENTS.md:21` 写明「不要为了顺手统一格式把它们打开」及其代价。
- **`src/core/token-estimator.ts` 一个字节未动**（`git diff --stat` 可证）。
- 未纳入 `pnpm lint` 进 README 的零密钥八条（那八条是装配／回归／任务集／评测／演示，lint 不属这一族，且会打破「八条」计数）。

### 验收

`pnpm lint` 0 诊断退出 0；`pnpm check` `syntax ok: 93 files`；`pnpm test` `pass 211 / fail 0`；`pnpm fixtures:check` 16 项；`pnpm eval:offline` 12/12；`pnpm eval:estimate` 退出 0（证明未碰 estimation corpus）。全部零付费、不出网。

**一处流程失误，如实记录**：T6-0 只跑了立项的验收（`grep` 计数与 diff 范围），**没有跑 `pnpm test`**，而立项一节里链向本节的锚点此时还不存在——`test/docs-links.test.ts` 因此在一个提交的时间里是红的。本提交补上本节后转绿。教训：**文档里的新锚点本身就是一条要跑的验证**。

### 提交

`c01f253`（T6-0 立项）、`b46dd79`（T6-1 配置与源码订正），以及本提交（T6-2 口径订正与回填）。

**CI**：本次推送（`c01f253`…`ed33743`）的 [CI 36990893326](https://github.com/BeforeLanding/mini-DSH/actions/runs/36990893326) 在 Ubuntu／Windows × Node 22／24 四组合**全部 success**，**attempt=1**，无重跑。本次含 `src/`、`test/` 与 `package.json` 改动，因此触发；T6-2 单独一次纯文档推送本会落在 `paths-ignore` 内，它与前两个提交同批推送，所以一并被这次 run 覆盖。

## NX-21 会话锁的陈旧核验入口与显式移除

### 现象与根因

`JsonlStore.open` 对任何已存在的 `writer.lock` 一律拒绝（提示语 `session writer lock exists; verify stale locks explicitly`），而 `quarantineTail` 也要先抢同一把锁，因此崩溃之后**销掉这把锁是恢复的唯一路径**。仓库此前没有任何可脚本化的核验入口，这一步只能由人手删文件——NX-10 的第三幕照实演示了它。

**入口形态被一处实测事实定死**：`src/plugins/cli.ts:38` 在 `ctx.effect` 建立 REPL **之前**就 `await JsonlStore.open(...)`，撞上崩溃过的会话直接抛错。所以 `/recover`／`/lock` 这类**进程内命令在真正需要它的时刻根本不可达**——入口只能是独立脚本。

**方向依据是既有的规范性条款**，不是新决策：`PLAN.md` 的持久化一节写着「失效锁显式核验，**不仅凭 PID 自动移除**」。因此本项不新增决策编号，只在该行补上入口名字。

### 交付物

**核心**（`src/core/event-store.ts`，与 `quarantineTail` 同处——它是既有的「操作者恢复助手」先例）：

- `LockInspection`：`present`／`ownerReadable`／`token`／`pid`／`modifiedAt`／`pidStatus`／`eventsTail`。
- `static inspectLock(directory, sessionId)`：**纯读**。与 `open` 不同，它**不 `mkdir`**——核验不能有副作用，目录不存在就是「无锁」。只读 `events.jsonl` 的**最后 1 字节**判定尾部，口径与 `decodeLog` 一致。
- `static removeStaleLock(directory, sessionId, token)`：缺文件抛 `session writer lock is gone; nothing to remove`；`owner.token !== token` 抛 `writer lock ownership changed`；两者都过了才 `unlink`。**它不读 pid、不做任何存活判断。**
- `open`／`close`／`quarantineTail` **一行未动**，既有锁语义逐字保留。

**入口**（`scripts/session-lock.ts` → `pnpm session:lock <sessionId> [--remove --token <token>]`）：目录解析逐字照抄 `src/plugins/cli.ts:32`。检视成功即退出 0（**发现陈旧锁不是失败**）；参数错、移除被拒、移除抛错 → 退出 1 并写 stderr。「下一步」那行打印**完整 token**，使命令可直接复制。

**PID 探针只作线索**：三态 `alive`／`not-found`／`inconclusive`，`pid ≤ 0` 或非整数一律 `inconclusive`——本机实测（win32，Node 24）`process.kill(0, 0)` **会成功**，直接问会拿到一个假的 `alive`；`EPERM`（进程存在但无权发信号）归入 `alive`。输出固定带一句「pid 复用下 `alive` 不等价于持有者还在」。

### 实测证据

```
$ pnpm check
syntax ok: 92 files            # NX-21-1 后（新增 1 个脚本）；NX-21-2 加测试文件后为 93

$ MINI_DSH_SESSION_DIR=/tmp/nx21-probe node dist/scripts/session-lock.js <id>      # 无锁
锁：无
事件：events.jsonl 尾部完整
没有需要处置的锁，直接恢复：MINI_DSH_SESSION_ID=<id> pnpm start
exit=0

$ printf '{"token":"t","pid":1}' > /tmp/nx21-probe/<id>/writer.lock
$ node dist/scripts/session-lock.js <id>                                           # 陈旧锁
锁：存在  mtime=2026-10-02T08:57:18.615Z
持有者：token=t pid=1
pid 探针：not-found（本机无此进程）
注意：pid 存活只作线索，pid 复用下不等价于「持有者还在」；确认旧进程与副作用之后再解除。
下一步（确认副作用后可执行）：
  pnpm session:lock <id> --remove --token t
exit=0

$ node dist/scripts/session-lock.js <id> --remove --token wrong
session:lock 失败：writer lock ownership changed
exit=1    # 锁仍在，ls 可见 writer.lock
$ node dist/scripts/session-lock.js <id> --remove --token t
锁已移除：…/writer.lock
exit=0    # ls 只剩 events.jsonl

# 四种用法错一律退出 1：无参、--remove 缺 --token、--token 无 --remove、未知选项 --bogus
```

**两处只有真跑才会暴露的坑**：

1. **`--token` 的取值既不是旗标也不是位置参数**。第一版用「过滤掉 `--` 开头的」挑位置参数，于是 `--token wrong` 里的 `wrong` 被算成**第二个 sessionId**，四个状态里两个直接报「必须给出一个 sessionId」。改成按「谁消费了谁」逐个走才对。
2. **演示里判定「锁已移除」不能到判定那一刻再查文件**。第一版把 `!(await exists(lockPath))` 写进 `[5]` 的 `checks`，跑出来是 ✗——因为 `[4]` 重开会装上一把**新锁**，那时 `lockPath` 当然又存在。必须在下手那一幕就地取值。这条改的是**断言**，不是实现。

**另一处连带修正**：本次向 `event-store.ts` 插入 45 行使 `DECISIONS.md` 钉住的 `src/core/event-store.ts:52`（`append`）漂到 `:97`，由 `test/decisions-doc.test.ts` 当场抓出：

```
✖ the decision write-up keeps every code and test anchor pointing at something real
  + [ '锚点与说明对不上：src/core/event-store.ts:52 附近 5 行内找不到 `append`' ]
```

### 回归与反例实跑

新增 `test/session-lock.test.ts` 六条用例：检视是纯读且不建目录、pid 三态与不可读锁体、`eventsTail` 两态、错 token 被拒且锁仍在、正 token 移除后 `open` 成功且 `restore` 补出**恰好一条 `unknown`**、`session:lock` 脚本的 CLI 表面（四种用法错退出 1 + 检视 + 拒绝 + 移除）。**已退出的子进程 pid 由「spawn 后等它退出」取得**，比猜一个大数字可靠（大 pid 可能撞上 pid 复用）。

**反例实跑**（把 `removeStaleLock` 的 token 比较改成恒真 `if (!isRecord(owner))`）：

```
ℹ tests 211
✖ removeStaleLock refuses a token the operator did not just read
✖ the session:lock script inspects, refuses a bad token and removes on an explicit one
ℹ pass 209 / fail 2
```

改回后 `pass 211 / fail 0`。两条都咬——守卫同时被核心用例与 CLI 冒烟用例覆盖。

### 第三幕改用新入口

`scripts/demo-unknown.ts` 的 `[3]` 从一行裸 `fs.unlink` 改为 `inspectLock` → **先用错 token 试一次** → 正确 token `removeStaleLock`。反例直接演在演示里。`pnpm demo:unknown` 退出 0，判定由 6 条增至 9 条：

```
✓ 重开先被陈旧锁拒绝
✓ 入口报出的 pid 探针指向一个已不存在的进程
✓ 错误 token 被拒、锁仍在
✓ 正确 token 显式移除（下一幕重开会装上新的锁）
✓ 副作用文件仍在（它真的写过）
✓ 恰好一条 unknown 结果，且就是那次 bash
✓ 被崩溃中断的 run 被封为 error
✓ 补出的记录落盘（日志行数增加）
✓ 自动续跑被拒
```

`[3]` 的实际输出：

```
入口报出的持有者：token=e5fd18c5-…-108c09696edb pid=45936；pid 探针 not-found；事件尾部 complete
先用错 token 试一次："writer lock ownership changed"；锁仍在？true
再用检视到的 token 显式移除；锁仍在？false
```

### 口径订正与不动的东西

改动：`README.md`（零密钥八条里的计数、测试小节、`demo:unknown` 一节从「目前**没有**对应入口…已立项 NX-21，本次未修」改为入口说明、持久化一节补上入口命令并**逐字保留**「不会仅凭PID自动解除」）、`PROGRESS.md`（当前状态新增一条、阻塞段就地改写为已解决、下一步摘掉 NX-21 并新增第 9 条）、`DECISIONS.md`（结尾那句「没有可脚本化的处置入口」改为指向入口）、`PLAN.md`（持久化一行补入口名字，决策文字未动）。

**带日期的历史证据逐字不动**：`TASKS.md` 的 NX-10 一节「恢复的唯一路径是先由人删掉该锁」、本文件的 NX-10-5／NX-10-6 两节、`PROGRESS.md:25` 的 `[NX-21](#阻塞)` 与「本次只立项不修」。那些限制在写下时**为真**。NX-21 的 backlog 条目按 NX-22 的先例处理：前半写处置、后半「**原始记录（todo）**」照抄原文。

**未触碰**：`test/fixtures/estimation/corpus/chinese/doc-readme-context.txt`（含 README 持久化段落的冻结快照，改它会让 `corpusDigest` 变、`pnpm eval:estimate` 退出 1——本次实测该命令仍退出 0）。`README.md` 的 CLI 命令清单未改（没有新增斜杠命令）、`.env.example` 未改、`open`／`close`／`quarantineTail` 未改。

### 验收

`pnpm check` **93 文件**、`pnpm test` **211/211**（199 → 205 → 211 的第三次增长即本次 6 条）、`pnpm demo:unknown` 退出 0（判定 9 条全 ✓）、`pnpm fixtures:check` 16 项（初始 0/16、参考 16/16）、`pnpm eval:offline` 12/12、`pnpm eval:estimate` 退出 0。零付费、无网络、无 tag、未触碰生产 ECS。

**CI**：本次推送（`4fb4e7c`…`1081781`）的 [CI 36987638064](https://github.com/BeforeLanding/mini-DSH/actions/runs/36987638064) 在 Ubuntu／Windows × Node 22／24 四组合**全部 success**，**attempt=1**，无重跑。本次含 `src/` 与 `test/` 改动，因此触发；此前 `b8f9bc4` 那次纯文档推送按 OPS 的 `paths` 过滤不触发，是预期行为。

### 提交

`4fb4e7c`（NX-21-0 立项）、`90b7733`（NX-21-1 核心与脚本）、`2d35d28`（NX-21-2 测试与 DECISIONS 锚点）、`4551e62`（NX-21-3 第三幕）＋本提交（NX-21-4 回填）。

## NX-22 文档内锚点的逐个校验与口径订正

### 现象与根因

[NX-11](#nx-11-整理设计取舍五节) 把「相对链接与锚点目标逐个命中」做成可核对的检查时，只覆盖了 `DECISIONS.md` 一个文件（`test/decisions-doc.test.ts` 里目标路径与 topics 都是硬编码的）。全仓其余 md 之间的锚点**从没被任何检查碰过**，于是漂了 6 处——文件在、标题不在，点击停在页首，肉眼扫不出来。

### 口径判定：成本数字以 `NX-08-REPORT` 的成本表为准

同一个批次有三个互相矛盾的数字：`CHANGES.md` 的 f-4b **标题**写 `$0.02`、紧邻**正文**写 `$0.03`，`PROGRESS.md` 两条写 `$0.03`／`$0.04`。判定依据不是随手挑一个：

- `NX-08-REPORT.md` 的成本表把 NX-08f 两次烟测合计记为 **$0.05**，并拆成「第一次 139k token 约 **$0.02**、第二次 166k 约 **$0.03**」；同一文件开头的总额 $6.44 按这 $0.05 计入。**这张表内部自洽**，另外三处各自不自洽。
- 按价格页 off-peak 输入 $0.15/M 复算：139k ≈ $0.021、166k ≈ $0.025，与 $0.02／$0.03 吻合。**反证**：若两笔都记 $0.03，合计是 $0.06，与 $6.44 里的 $0.05 对不上。
- **结论：错的是 CHANGES 的 f-4b 正文与 PROGRESS 的两条；CHANGES 的两个标题是对的，未改。** 共改正三处数字。

### 处置：新增 `test/docs-links.test.ts`

扫描全仓 md（排除 `node_modules`／`.git`／`dist`／`.demo-runs`／`.eval-evidence`），抽出 `](目标)` 形式的链接，对带 `#` 的仓库内目标计算标题 slug 集合、逐个断言命中；目标文件不存在也报。按 **github-slugger v2 语义**：小写 → 去标点与符号（`-` 与 `_` 例外，要保留）→ **每个字面空格各换一个 `-`**。沿用 `test/decisions-doc.test.ts` 的 `../../` 根定位与 CRLF 归一写法。

**两个坑都实测踩到过，都留在代码注释里**：

1. **空格不折叠**：`烟测 — done` 得到 `烟测--done`（em dash 被剥掉，两侧空格各换一个连字符）。按 `\s+ → -` 折叠会把这一类**正确的**双连字符链接误报成坏的。
2. **反引号内不算链接**：第一版把本文档里「用反引号引用的坏链接示例」也判成了红。GitHub 上那渲染成**代码**而不是链接，所以先剥掉行内代码段再匹配——**在 `` ` `` 里引用一个坏链接是说明它，不是使用它**。

**还有一处是手算 slug 不可靠的直接证据**：NX-22 登记时的诊断说两条 `PROGRESS` 链接「只有数字对不上（`003`／`004`）」。实际把数字改对之后**测试仍然红**——真实 slug 是 `…付费约-003-结果仍未观测到处理生效`，`结果` 前是**单**连字符（原文是 `）— **结果`，中间只有一个空格），而链接里写的是双连字符。**登记时漏了这处，正是要把这件事做成回归而不是再手工核一遍的理由。**

### 要修的 6 处

| 位置 | 问题 | 修法 |
| --- | --- | --- |
| `TASKS.md:9` `[PLAN 的对照有效性条件](PLAN.md#nx-08 评测批次上限预注册)` | 锚点含**字面空格**，任何 slug 规则下都不存在 | 改为 `#nx-08-评测批次上限预注册`（同文件上文已写对） |
| `TASKS.md:253` `[NX-31](#其他待办按依赖排序)` | 目标「其他待办，按依赖排序：」是**正文行**不是标题 | 去掉链接（NX-31 全文无对应节） |
| `TASKS.md:344` `[NX-21](#其他待办按依赖排序)` | 同上 | 去掉链接（NX-21 全文无对应节） |
| `TASKS.md:345` `[NX-20](#其他待办按依赖排序)` | 同上 | 指向 NX-20 新立的节（该节已存在） |
| `PROGRESS.md:26` | slug 数字与连字符数都不对；该条成本写 `$0.04` | `付费约-004--结果` → `付费约-003-结果`；成本 → **$0.03** |
| `PROGRESS.md:27` | 同上；该条成本写 `$0.03` | `付费约-003--结果` → `付费约-002-结果`；成本 → **$0.02** |

另订正 `CHANGES.md` 的 f-4b **正文**：`约 **$0.03**（139k token…）` → **$0.02**（标题已对，未改）。

### 验证

**修前红——恰好 6 条，逐条如下**（`pnpm test`，第二轮用）：

```
✖ every in-repository markdown anchor points at a real heading
  + 'docs/context-budget/TASKS.md:9 锚点在 docs/context-budget/PLAN.md 中不存在：nx-08 评测批次上限预注册',
  + 'docs/context-budget/TASKS.md:253 锚点在 docs/context-budget/TASKS.md 中不存在：其他待办按依赖排序',
  + 'docs/context-budget/TASKS.md:344 锚点在 docs/context-budget/TASKS.md 中不存在：其他待办按依赖排序',
  + 'docs/context-budget/TASKS.md:345 锚点在 docs/context-budget/TASKS.md 中不存在：其他待办按依赖排序',
  + 'PROGRESS.md:26 锚点在 docs/context-budget/CHANGES.md 中不存在：nx-08f-4c-重跑烟测--done2026-10-01付费约-004--结果仍未观测到处理生效',
  + 'PROGRESS.md:27 锚点在 docs/context-budget/CHANGES.md 中不存在：nx-08f-4b-真实模型烟测--done2026-10-01付费约-003--结果未观测到处理生效'
ℹ tests 205 / pass 204 / fail 1
```

**恰好 6 条、其余 160 条全过——这同时证明检查器没有假阳性**（全仓带锚点的仓库内链接 160 余条）。

**修后**：`pnpm test` → `ℹ tests 205 / pass 205 / fail 0`；`grep -c '付费约 \$0\.04' PROGRESS.md` = **0**。

**反例实跑**（把刚修好的 `PROGRESS.md:26` 锚点末尾加一个 `X`）：

```
ℹ tests 205 / pass 204 / fail 1
PROGRESS.md:26 锚点在 docs/context-budget/CHANGES.md 中不存在：nx-08f-4c-重跑烟测--done2026-10-01付费约-003-结果仍未观测到处理生效X
```

改回后回到 `pass 205 / fail 0`。

### 未覆盖

只校验锚点的**存在性**，不校验它是否指向语义贴切的位置；也**不校验**不带锚点的相对链接（指向源码、图片等）是否存在——那是另一类，本项不动。

### 提交

`4c7946c`（NX-22-0 立项）、`5e170b7`（NX-22-1 测试与修前红）、`0d11876`（NX-22-2 修 6 处锚点与三处成本）、`e3ae322`（NX-22-3 报告计数），以及本提交（NX-22-4 回填）。

## NX-20 路线图状态段的带日期修订注记

### 现象与根因

`docs/INTERNSHIP_ROADMAP.md` 是**带日期的记录**，它开头那条「修复更新（2026-09-29）」已声明源码基线评估「作为历史证据保留」。但它的 §5 停在 2026-09-29 的时点——「NX-01～NX-03、NX-05a 与 NX-12 已完成，**以下其余功能均为 todo**」，§6 的简历段还写着「完成 **57 条回归**及 Windows/Linux × Node 22/24 CI」——而 M5／M6／M7 与 M9 此后已全部走完（NX-04／07／08／09／10／11 均已交付）。文件名与定位是「开发路线」，读者按它判断项目进展，因此这些陈旧点是**误导性的**，不是无害的历史。

### 处置

**不逐处改写正文。** 该文件在同一页上同时承载「带日期的历史证据」与「当前状态」，逐处改写会让这两者混成一片（例如 §3 的 F1～F3 缺口描述、各处复现值，本来就该保持评估时点）。按该文件自己的既有惯例——「修复更新（2026-09-29）：」与「路线修订：2026-09-29，」两条页首注记——**在 H1 标题之后、正文之前**追加一条 `> **状态修订（2026-10-02）：**` 引用块，按类归纳四组订正，并显式写明「正文一字未改」与「与本条无关的带日期结论继续保留」。

四类订正：① **§5 完成标记**——NX-04／NX-07／NX-08／NX-09／NX-10／NX-11 均已完成，§5 开头那句「其余功能均为 todo」不再成立；② **数字**——回归数 57 → **205**、`pnpm check` 产物 46 → **91**、真实模型付费额度由「尚未在本次任务中设定或使用」变为约 **$6.44**；③ **术语**——「Windows/Linux」中的「Linux」应读作 **Ubuntu**；④ **§4 的方向段落**——「先实现…」「缺少…」多已落地（NX-07 大结果回读、NX-13 变更清单与 diff、NX-14 结构化命令结果、NX-15 `verification`、NX-08a 的 `requestId`、NX-05a／b 的 3 与 12 个 fixture）。

**正文位置一律引标题与引文，不引行号。** 注记本身就插在页首，任何「line N」引用会在插入后立刻漂移——`NX-22` 的锚点校验器把同一类问题变成了回归（见本文档的 NX-22 一节）。

### 验证

```
$ git diff --numstat docs/INTERNSHIP_ROADMAP.md
9	0	docs/INTERNSHIP_ROADMAP.md
```

**9 行全部为新增、0 行删除**，即正文逐字未动——这是「不静默改写正文历史」的可核对证据。

三类数字逐条核对出处：`pnpm check` 实测 `syntax ok: 90 files`；回归数 204 见 `PROGRESS.md` 的基线行；（**2026-10-02 追记：NX-22 新增 `test/docs-links.test.ts` 后 `pnpm check` 90 → 91、`pnpm test` 204 → 205，上面这句话里的 90／204 是 NX-20 当时的读数，注记正文已同步为 91／205。**）总额约 $6.44 见 `NX-08-REPORT.md:14`（筛查 $0.15 ＋ 对照 A $4.81 ＋ 对照 B 两次烟测 $0.05 ＋ NX-08h $1.43）；CI 用词见 `README.md:154`「覆盖 Ubuntu / Windows 和 Node.js 22 / 24」。

```
$ grep -n "Ubuntu\|Windows" README.md
154:GitHub Actions 在推送到 `main`、提交 Pull Request 或手动触发时运行 CI，覆盖 Ubuntu / Windows 和 Node.js 22 / 24。…
```

### 未覆盖

注记按**类**归纳，**不逐行标注**每一处陈旧点（例如 §4 各段的具体措辞、§1 若干完成度表述）。判据是「读者按四条读下去不会再被路线图误导」，而非「每个过时句子旁边都有注」。理由是逐行标注会让注记长过正文本身。若日后需要逐行版，另立待办。

### 提交

`ecf5249`（NX-20-0 立项）、`f3a04d2`（NX-20-1 注记），以及本提交（NX-20-2 回填）。

## 部署链路零风险前置核对（2026-10-02，零付费）

### 为什么只做前置，不做真部署

`.github/workflows/deploy-ecs.yml` 已切换为 tag 触发，但仓库**当前没有任何 tag**——`v*.*.*` 触发路径一次都没有被触发过。真实部署会 SSH 到生产 ECS 并原子切换 `current`：GitHub 的 `production` environment 下五项 Secrets（`ECS_HOST`／`ECS_PORT`／`ECS_USER`／`ECS_SSH_KEY`／`ECS_KNOWN_HOSTS`）**均已配置**，而 `docs/ECS_DEPLOYMENT.md` 写明「标签一旦推送不得删除、强推或改指向」。因此本轮**只做不触碰生产的部分**，首次真发布由用户另行决定。

**核对 run 历史时纠正了一处此前的过度概括。** 「部署新路径未验证」容易被读成**整条链路**没验证过，事实不是：2026-09-30 有 **8 次 `workflow_run` 触发的 Deploy ECS 全部 success**，而当时的 workflow（`8893f8a`）就已包含 `environment: production`、`persist-credentials: false`、`scripts/deploy-ecs-bundle.sh` 的 `prepare`／`activate` 与 `REVISION` 校验——**这些都真跑过生产**。`2ac85bd`（2026-09-30 10:57，`ci: 改为版本标签触发 ECS 部署`）**唯一改掉的是触发器**，而最后一次成功的部署 run（同日 10:47 +0800）就在它之前 10 分钟。**所以没验证的是触发器，不是部署机制。**

### 做了什么

1. 本地实跑工作流第 49–50 步用的**同一个脚本** `bash scripts/test-ecs-bundle.sh`。已核实它是**纯本地**的：`mktemp` 临时目录 ＋ 临时 git 仓库 ＋ `MINI_DSH_DEPLOY_BASE` 覆盖，且 Git Bash 上显式 defer 掉 symlink 段。
2. 逐条比对 `deploy-ecs.yml` 的 tag 断言与 `docs/ECS_DEPLOYMENT.md` §版本标签与发布锚点 的清单。

### 验证

```
$ bash scripts/test-ecs-bundle.sh
Invalid commit SHA
Invalid release path
Bundle import, wrong SHA/path/revision rejection passed.
Linux symlink activation checks deferred to Actions.
$ echo $?
0
```

（前两行是负向断言**期望**被拒的提示，出现在退出码 0 的一次成功运行里。）

### 已核对一致

工作流 `Resolve and verify deployment target` 步（`deploy-ecs.yml:41-48`）的 `git merge-base --is-ancestor "$deploy_sha" origin/main`，以及 tag push 时额外校验 `refs/tags/v[0-9]+\.[0-9]+\.[0-9]+` 且 `git rev-list -n 1 "$RELEASE_REF"` 等于检出 SHA——与 `docs/ECS_DEPLOYMENT.md` §发布流程／§版本标签与发布锚点 写的「目标提交必须可从 `main` 到达」「标签名在工作流内再次校验为 `vMAJOR.MINOR.PATCH`」逐条对应，未发现遗漏。`Publish requested release` 步对 `ECS_USER == deploy`、端口范围、严格主机密钥校验的断言，也与该文档 §服务器布局／§回滚 的描述一致。

### 本轮**没有**验证的

- **tag push 与 `workflow_dispatch` 这两条新触发器本身**是否真的唤起工作流。这是 `2ac85bd` 唯一改变的东西，也是**唯一没有成功历史**的东西。
- **手工回滚块**（`docs/ECS_DEPLOYMENT.md` §回滚）：它是一次都没实跑过的独立程序，在服务器终端执行，本轮无从验证。注意「上一版本」这条线本身有证据——`test-ecs-bundle.sh` 断言过 `PREVIOUS_RELEASE` 的写入，2026-09-30 的激活也真跑过，但**回滚方向**没有。
- 本机 `test-ecs-bundle.sh` 在 Git Bash 上**显式 defer 掉 symlink 段**，所以本轮本地运行没有覆盖「原子切换」那几行；那几行在服务器上已被真跑过，但**不是由本轮的本地证据覆盖的**。
- 首次发布前须实跑一次 tag 发布，并核对服务器 `REVISION` 等于标签解析出的 commit SHA。

**明确不算「未验证」的**：SSH 连接、bundle 传送、`prepare`／`activate` 原子切换、`REVISION` 回写、`PREVIOUS_RELEASE` 记录、`environment: production` 门——它们在 2026-09-30 的 8 次成功运行里都真跑过。

### 提交

无独立行为变化，随本次 NX-22 的回填提交一并提交。

## NX-32 命令闸门的有意收缩与取消窗口

### 现象与根因

不是缺陷修复，是**有意的能力撤回**。触发点是两件实测事实：① `docs/INTERNSHIP_ROADMAP.md` 的 NX 编号全集只到 NX-16，整条闸门收紧线（NX-17／19／24／26／30／31）**不在路线图内**，而路线图写明「M5～M7 加最小 M9 演示即可形成投递版本」——那条线其实早已走完；② `src/core/sandbox-runtime.ts` 因此长成 `src/` 里最大的单文件（576 行，占全部源码 3954 行的 14.6%，第二名 271 行），而它**在唯一没有审批兜底的 `autoApprove` 模式里也拦不住**——`test/coding-fixtures.test.ts:62,377` 就是 `autoApprove: true`，而文档早已写明 `node -e`／`python -c` 的程序字符串不在覆盖内，NX-08f 又实测到模型自写 `node -e` 探针（armA 21 次、armB 75 次）。

判据本身也没有终点：它是「这段文本会不会被 shell 执行」，用启发式词法逼近一个上下文相关的语法，每修一处必露下一处——实测序列就是 NX-26（保留字）→ NX-30（算子）→ NX-31（包装命令）。

### 设计决策

从「这段文本会不会被 shell 执行」改为「**粗形状防误操作**」，只留四条判据：四个整串正则；token 上的 UNC／盘符绝对路径／系统路径与 `resolveInside`；**按段首工具名**的出网拦；引号感知的分词。细节与代价见 [PLAN D-16](PLAN.md#d-16-命令闸门的有意收缩nx-32)。

**两个必须做对的点，各配一条反例。**

1. **段首谓词必须保留，且不能按文本切分。** 它既服务于出网按工具名的判定，也是 `/bin`／`/usr/bin` 命令词豁免的兜底。段界取 token 之间的**空隙**里有没有分隔符——契约里的 `awk '/stage(7|7)|phase 7/{f=1} f'` 的 `|` 在被引号吃掉的 token 内部，按文本切会凭空切出一段。
2. **`previousEnd` 必须在所有 `continue` 之前更新**——这是 NX-26 的教训（那次的旗标不能挪到循环末尾，因为有四处 `continue`）。

### 净放宽与净收紧清单

| 方向 | 项 | 说明 |
| --- | --- | --- |
| 收紧 | 本地回环不再豁免 | `curl http://localhost:8080/health` 由默认白名单放行变**拒绝**，且没有审批逃生门（闸门 deny 发生在 `approve` 之前） |
| 收紧 | 纯本地操作数被一并拒绝 | `scp report.pdf backup.pdf`、`rsync -avz src/ dest/`、`nc -l 8080`、`ping 127.0.0.1`——判据不看目标，**记录在案的过拒** |
| 放宽 | NX-23 闭合 | 裸 URL 规则随操作数模型删除，`git log --grep "https://github.com/x"` 放行 |
| 放宽 | 环境展开撤销的连带 | `cat $MINI_DSH_UNSET_VAR/file`、`node -e "show('a: b$ad')"` 等由拒绝变放行——**不是修好了，是判据没了**，已登记为 `known gap NX-24 reopened` |

**新登记的欠拦（NX-32 两条）**：非段首的 URL 操作数（`git clone https://example.com/x.git`、`echo "http://evil.example" | xargs curl`）、变量间接（`X=..; cat $X/secret`、`Y=/etc; cat $Y/passwd`）。

### 验证

```
pnpm check                                        # syntax ok: 90 files
pnpm test                                         # tests 204 / pass 204 / fail 0（收缩前 216）
pnpm build && node docs/context-budget/nx17-gate-probes.mjs   # no contract drift; 32 known gap(s) still open
node docs/context-budget/nx24-replay-probe.mjs    # 退出 0；782 次调用 7 条拒绝全部有归属（收缩前 9 条）
pnpm eval:estimate                                # 退出 0（语料 digest 未动）
pnpm fixtures:check                               # 退出 0
pnpm eval:offline                                 # planned 12 / accepted 12 / completed 12
```

**语料 digest 的地雷已排除**：`corpusDigest`（`scripts/estimation-corpus.ts:54`）只对 corpus 目录里的 40 个样本取 SHA-256，**从不与 `src/` 比对**——删 `SandboxConfig.allowHosts` 不会让 `eval:estimate` 变红。`core-contracts.txt` 自本项起与 `contracts.ts` 不再逐字相同，按「冻结快照」对待（其 README 本来就授权这一点）。

### 反例实跑

| 关掉的东西 | 实测到的红 |
| --- | --- |
| 段首守卫 `atSegmentStart &&`（`:531` 白名单那条） | `cp foo /usr/bin/evil` → `allow`（应为 deny，理由 path escapes the workspace） |
| 段首判定改为读全部前文（而非 token 空隙） | `echo "x\|y" /usr/bin/ls` → `allow`（应为 deny） |
| 出网裁决提前到路径检查之前 | `wget -O /etc/passwd http://localhost/x` → 理由变成出网，T1 的 `/system path is blocked\|path escapes the workspace/` 断言红，`actual: 'network tool is not covered…'` |
| 出网赋值挪到段首白名单的 `continue` 之后 | `/usr/bin/curl example.com` → `actual: 'allow'` / `expected: 'deny'` |

### 取消窗口（NX-32-2）

`src/core/command-runner.ts` 的 `kill()` 原本是 fire-and-forget：Windows 上发出 `taskkill /T /F` 就不管，`stop()` 设完 status 立刻返回，`close` 一到就 resolve——结构上存在「已返回 `cancelled` 而进程树还没拆完」的窗口。POSIX 没有这个问题（`kill(-pgid, SIGKILL)` 系统调用层面同步且不可捕获）。

改为：`kill()` 返回永不 reject 的 `Promise<void>`（Windows 分支包成 Promise ＋ 2 秒 `treeKillDeadlineMs`；POSIX 同步杀完即 resolve），`stop()` 存进 `terminating`，`close` 只在它存在时多等一步。正常退出路径一行未变，仍然只在 `close` 上 resolve。

**本机实测：观测不到新旧差别。**
```
durationMs（4 次中位）：新 418ms ／ 老 457ms
返回时孙进程存活：      新 0/5 ／ 老 0/5
```
老实现的 `close` 本来就要等 taskkill 把子进程杀掉才触发，所以这次等待在**常见路径上是空操作**，只在 taskkill 慢于子进程死亡那个病态分支上起作用——而那正是本地复现不出来的分支。因此**没有**加「`durationMs` 不得短于一次 taskkill 往返」的断言：实测两边都过，那样的断言声称能区分实现却不区分。CI run 36837866707 那次 windows/Node 24 的红与它的关系是**推断**（该次重跑即绿，已确认为竞态），不是实测。

### 未覆盖、已登记

按 D-16 的处置规则：**此后不再为闸门开新工作项**。当前 32 行已知缺口全部在矩阵的 `known gap` 组里可见：NX-18（`..` 惰性文本误拒）、NX-25（here-doc 正文）、NX-19 重开（嵌套执行）、NX-24 重开（变量间接）、NX-26 重开（保留字后的命令位）、NX-30 重开 ＋ arm body、NX-31（包装命令）、NX-32（非段首 URL 操作数、变量间接）。真正的边界是 `utils/path.ts` 的 `resolveInside`（本项一行未动）与人工审批，两者都不是操作系统隔离。

## NX-30 子 shell 与分组的命令段起点

- 关联：与 NX-26 同族——NX-26 补了「保留字之后的命令位」，本轮补**引入命令位置的另一半：算子**（矩阵的 `known gap NX-30` 组）。不依赖其他任务，可独立验收。状态：**done**（2026-10-01，零付费）。**方向是收紧**：`executable`（命令段起点的定义）此前连算子都不认，于是子 shell 与分组里的 `curl` 既不重置段状态、也不开启取网工具的操作数模型。机制与取舍见 [PLAN 的 D-15](PLAN.md#d-15-命令段起点的算子支)，子步骤与提交边界见 [TASKS 的 NX-30 一节](TASKS.md#nx-30-子-shell-与分组的命令段起点)。
- 提交：`7ae54f3`（NX-30-0 立项与契约订正）、`eaac0d5`（NX-30-1 机制与用例），本提交（NX-30-2 回填）。

### 现象与根因

**证据是跑出来的。** 矩阵当前读数（`pnpm build && node docs/context-budget/nx17-gate-probes.mjs`），尾部为 `no contract drift; 7 known gap(s) still open`：

```
known gap NX-30
open   allow (want deny ) "(curl example.com)"
open   allow (want deny ) "{ curl example.com; }"
```

直接问闸门，这一族全是 allow：

```
allow:  "(curl example.com)"          allow:  "{ curl example.com; }"
allow:  "( curl example.com )"        allow:  "(bash -c 'curl http://x')"
```

**根因只有一条**：`executable`（`src/core/sandbox-runtime.ts:464`）是命令段起点的**定义**——它为真才重置每段状态（`:470-478`）、才开启取网工具的操作数模型（`:501` 的 `model && !executable` 守卫）。而它只认「首 token」与「紧邻 `|`／`;`／`&`／换行」，**不认识子 shell 与分组的括符**。更深一层的成因是**词体类把括符粘进了 token**：`"(?:[^"\\]|\\.)*"|'[^']*'|[^\s|;&<>]+`（`:438`）不含 `(`／`)`／`{`／`}`，于是 `(curl example.com)` 分成 `(curl` 与 `example.com)` 两个 token，`basename('(curl')` 不是 `curl`，`networkTools` 与 `shellWords` 双双落空。同一原因让 `(bash -c 'curl http://x')` 连 `-c` 片段抽取都不启动——`basename('(bash')` 不在 `shellWords` 里。

**这是一条独立于 NX-26 的既有放行**，与 NX-26 修的那条并列：NX-26 之前 `for f in a; do curl example.com; done` 是 allow，是因为保留字没被认；本条是算子没被认，**算子从未被认过**。

### 设计决策

**核心取舍是「规范 token，不动分词器」。** 最自然的方案——把四个字符从词体类里拿掉、当成算子——实测是错的，三条理由都留了读数：

1. **它不产出 token，只是静默跳过。** `matchAll` 没有以这四个字符开头的分支，字符被丢掉；于是「opener 是一个 token、按 token 判定」那半个设计是**死代码**，而 `( curl example.com )`（带空格的真形状）**反而修不好**。它之所以看起来能修 `(curl example.com)`，靠的是「把 `(` 删掉、让 `curl` 落到 index 0」——碰巧，不是机制。
2. **它会凭空造出裸 `/` 开头的 token。** `mkdir -p src/{a,b}/x` 被切成 `src/`、`a,b`、`/x`，最后那个是**根路径操作数** → `path escapes the workspace`；`echo {a,b}/c` 同理。这是对**普通合法命令**的误伤，语料里就有这一族。
3. **改用把 `(` 加进分隔符类**（`[|;&\n(){}]`）会引入另一处误拒：`$()` 里的 token 变可执行、`commandWord` 被重置成 `date`，于是 `echo $(date) https://example.com` 由 allow 变 deny——顶层 `echo` 的惰性 URL 豁免失效。

三条合起来是一个判据：**分词器与 `expanded` 的下标对齐是下游的承重墙**。`pipedDownstream`（`:477` 用 `start + raw.length`）、`eval` 参数切片（`:561` 按 token 下标过滤）、`-c` 片段抽取三处全都建立在它上面。所以宁可**规范 token**，也不改分词。

**采用的机制**：分词器、分隔符正则 `[|;&\n]`、`findShellCommandFlag`（`:194`）的分隔符守卫、`bindingWord`（`:257`）**一行都不动**（`:256` 那句「与 #inspect 的分词器同源」的注释因此一字不改）。改为在去引号之后把 token 首尾**未被引用**的 `(`／`{` 与 `)`／`}` 剥掉——含 `$(` 的词跳过（`$(pwd)/file.txt` 的 `)` 是词内结构，不是子 shell 收尾），空结果保留原样（免得孤立的 `)` 变成空 token）。再把 `(`／`{` 接进**与保留字同一支**的 `pendingCommandPosition` 前视：opener **自身**处于命令段起点、且未被引用也未被规范化时，令紧随的一个 token 也算段起点。`)`／`}` 只收尾，不引入命令位。

`raw === token` 的含义在此自然扩展为「未被引用**且未被规范化**」：`(curl` 规范化后 `raw !== token`，故**不**设旗标——它自己就是命令；孤立的 `(`／`{` 保持 `raw === token`，设旗标，与保留字行为完全对称。

### 净放宽清单

四条，都是 NX-26 那两条的同一形状——子 shell 里的 `commandWord` 终于**是那个真实的命令**，于是既有的豁免判据开始生效。改前 `commandWord` 停在 `(` 上，`stdoutOnlyCommands` 豁免与 `-c` 片段豁免都查不到它，所以是误拒。每条都配一条**顶层对照**（今日即 allow），证明这是**同一语义终于生效**，不是新语义：

| 子 shell 形状 | 改前 | 改后 | 顶层对照 | 生效的豁免 |
| --- | --- | --- | --- | --- |
| `(echo https://example.com)` | deny | allow | `echo https://example.com` | `stdoutOnlyCommands` |
| `{ echo https://example.com; }` | deny | allow | `echo https://example.com` | `stdoutOnlyCommands` |
| `(printf "%s" https://example.com)` | deny | allow | `printf "%s" https://example.com` | `stdoutOnlyCommands` |
| `(echo bash -c "curl https://evil/x")` | deny | allow | `echo bash -c "curl https://evil/x"` | `-c` 片段豁免（`bash` 是 `echo` 的实参，从不执行） |

**豁免边界一条未动**：`(echo https://example.com | cat)` 与 `{ echo https://example.com | cat; }` 仍被拒绝——接管道时下游可能真的取网。这条作为**孪生行**写进用例与矩阵，防止净放宽被误读成「子 shell 里的 echo 一律放行」。

**三条接受的过拒**，全部落在 shell 语法错误的输入上，写进用例让它成为**记录在案的决定**（与 NX-24 的 `cat "/Program Files/secret"` 同一处置）：

| 命令 | 为什么可接受 |
| --- | --- |
| `{curl example.com;}` | bash 里 `{curl` 是普通命令名（分组要求 `{` 单独成词），command-not-found |
| `curl (example.com)` | bash 语法错误；规范化把括符剥掉后 `example.com` 是主机形状词——这正是 NX-26 的 CHANGES 预告过的那一类 |
| `(curl example.com` | 不配对，bash 语法错误 |

### 验证

实现顺序：`pnpm build` → 先确认矩阵两行读到 **`met`**（留证）→ 搬进契约组 → 重跑。

```
pnpm build && node docs/context-budget/nx17-gate-probes.mjs
    # 改前：open   allow (want deny ) "(curl example.com)" / "{ curl example.com; }"
    #       no contract drift; 7 known gap(s) still open
    # 改后先读到：met    deny  (want deny ) 两行
    # 搬移后：closed: NX-30 subshell and group command position 全 ok（16 行）
    #       no contract drift; 8 known gap(s) still open   （7 − 2 已闭合 + 1 arm body + 2 NX-31）
pnpm check            # syntax ok: 90 files
pnpm test             # 216/216（原 215，新增 1 条用例）
pnpm fixtures:check   # 16 项，退出码 0
pnpm eval:offline     # 12/12
node docs/context-budget/nx24-replay-probe.mjs
    # 退出码 0：782 次真实调用仍是那 9 条、no unexpected deny —— 真实语料上零新增拒绝
pnpm demo:fix / demo:resume / demo:unknown   # 均退出 0
```

**过拒回归闸是本次最关键的一条读数**：`nx24-replay-probe.mjs` 对 782 次真实模型 bash 调用做**集合断言**（不是计数），任何未登记的新拒绝都会让它变红。它保持 `no unexpected deny`，说明本项在真实语料上既不新增拒绝也不丢失拒绝。这与事先的静态测量一致：语料里「真正由算子引入命令位」只有 2 处（`(git status --porcelain || echo no-git)` 与 `{ echo "FAIL(exit=$?)"; … }`），**0 处取网**。

### 反例实跑

四条，每条都实测到**指定用例变红**（`pnpm test` 报 `fail 1`、`✖ Sandbox treats a subshell or group opener at command position as a command-segment start`）：

| # | 关掉的东西 | 首个变红的断言 | 说明 |
| --- | --- | --- | --- |
| 1 | 删掉 opener 旗标那半支（`|| commandPositionOpeners.has(token)`） | `{ curl example.com; }` → `actual: 'allow'` / `expected: 'deny'` | 旗标半支承载**检测**：规范化只能剥掉粘在词上的括符，`( curl x )` 与 `{ …; }` 里那个**单独成词**的 opener 只能靠前视旗标接上 |
| 2 | 只保留首部规范化、去掉 `.replace(/[)}]+$/, '')` | `(curl example.com)` → `actual: 'allow'` / `expected: 'deny'` | 单独钉住**尾部收尾剥离**——最容易被后来的人当作冗余删掉的一行；`example.com)` 不匹配主机形状（正则要求 `(?:\/|$)` 收尾） |
| 3 | 整段规范化去掉（只留旗标） | `(curl example.com)` → `actual: 'allow'` / `expected: 'deny'` | 分支级兜底：规范化整体缺失时 `(curl` 仍是原样 token，`basename` 不是 `curl`，检测整段失效 |
| 4 | `commandPositionOpeners` 缩成 `['(']` | `{ curl example.com; }` → `actual: 'allow'` / `expected: 'deny'` | 证明**花括号不是装饰**：`{` 与 `(` 走同一支判据但彼此独立，缺一个就漏一组形状 |

**两个被否决的方案也各留了实测反例**（这是 D-15 那条决策的直接证据，不是推演）：

| 被否决的方案 | 实测反例 |
| --- | --- |
| 把 `(`／`)`／`{`／`}` 从词体类 `[^\s|;&<>]+` 里拿掉 | **五条普通合法命令被误伤**：`mkdir -p src/{a,b}/x`、`echo {a,b}/c`、`cp {src,lib}/index.ts dist/`、`cd $(dirname $0)/src`、`cat $(pwd)/file.txt` 全部变 `path escapes the workspace`（切出的裸 `/x` 被当根路径操作数）。它同时**看起来**修好了 `(curl example.com)`——靠的却是「把 `(` 删掉、让 `curl` 落到 index 0」，所以连带空格的 `( curl x )` 都得另外修 |
| 把 `(`／`)`／`{`／`}` 加进分隔符类 `[|;&\n(){}]` | `echo $(date) https://example.com` 由 allow 变 **deny**（`unauthorized outbound request`）：`)` 让 `$()` 之后的 token 变成段起点、`commandWord` 被重置，顶层 `echo` 的惰性 URL 豁免失效 |

### 未覆盖、已登记为独立待办

- **NX-30 的剩余半**：`case $x in a) curl … ;; esac` 的臂体——`a)` 是一个 token，臂体不是段起点。矩阵新增 `known gap NX-30 arm body` 一行让它**不被静默**（与 NX-25 从 NX-24 拆出时同一处置）。`exec` 与赋值／重定向前缀（`exec curl x`、`X=1 curl x`、`>out curl x`）本轮同样未做，留在 TASKS 的 NX-30 条目里标为未做。
- **NX-31（本轮新登记）**：**命令位被包装命令吃掉**——`env curl example.com`、`nice curl example.com`、`timeout 5 curl example.com`、`command curl example.com`、`find . -name x -exec curl example.com ;` 今日全是 allow；**进程替换** `<(curl x)` 同属这一族。与本族同一个根因，但机制不同：要新增一份「操作数里哪个才是命令」的工具知识表（`env -i A=1 cmd` 跳过 `-i` 与赋值、`nice -n 5 cmd` 跳过 `-n N`、`timeout -k 5 10 cmd` 跳过时长与 `-k N`、`xargs -n1 cmd` 跳过自己的旗标），且与 D-12 记录过的「不采用按工具清单收窄」正面相邻，须先定边界。矩阵已加两行 `known gap NX-31`。**语料 0 处**（782 次调用里 `exec` 0 次、真实赋值 0 次、前导重定向 0 次），加它买的是必要性不是安全性。
- **不宣称命令闸门已闭合**：`..`、系统路径、工作区外路径、软链、递归删除、`sudo`、UNC、allowHosts、惰性输出的管道边界全部照旧；`node -e`／`python -c` 程序字符串、脚本文件内容、base64 解码后进 shell、here-doc 正文照旧不在覆盖内。

## NX-26 保留字之后的命令段起点

- 关联：NX-24 期间登记的相邻缺陷（`nx17-gate-probes.mjs` 的 `known gap NX-26` 组）。不依赖其他任务，可独立验收。状态：**done**（2026-10-01，零付费）。**方向是收紧**——与 NX-24 相反，本轮修的是**闸门漏掉了一段真正会执行的命令**：`executable`（命令段起点的定义）不认识 shell 保留字，于是保留字后面的命令词既不重置段状态、也不开启取网工具的操作数模型。机制与取舍见 [PLAN 的 D-14](PLAN.md#d-14-命令段起点的词法判定)，子步骤与提交边界见 [TASKS 的 NX-26 一节](TASKS.md#nx-26-保留字之后的命令段起点)。
- 提交：`784eb4a`（NX-26-0 立项与契约订正）、`4e7afd2`（NX-26-1 机制与 `do`／`then`／`else`）、`5c96ce0`（NX-26-2 条件引导词），本提交（NX-26-3 回填）。

### 现象与根因

**证据是跑出来的。** 矩阵当前读数（`pnpm build && node docs/context-budget/nx17-gate-probes.mjs`）：

```
known gap NX-26
open   allow (want deny ) "for f in a b; do curl example.com; echo $f; done"
```

根因在 `src/core/sandbox-runtime.ts:439` 的一行判据：

```ts
let executable = index === 0 || /[|;&\n]\s*$/.test(expanded.slice(0, start))
```

它只有两种情况——**首 token** 与**紧邻 `|`／`;`／`&`／换行**。而 `executable` 为真才是**命令段起点**：它重置每段状态（`:441-449` 的 `networkTool`／`commandWord`／`hostOperandSeen`／`pipedDownstream`），并且是操作数模型的入口——`:466` 的 `model && !executable && …` 守卫。于是 `do`／`then`／`else`（以及 `if`／`elif`／`while`／`until`）后面那个 token 一切判定都不跑。

这是一条**独立于 NX-24 的既有放行**，不是 NX-24 改出来的；但 NX-24 绑定 `for` 变量后会有更多命令走到这条路径（`for f in a; do curl example.com; echo $f; done` 在 NX-24 之前是误拒）。

### 设计决策

**判据不新增，只把「谁会开启一个命令位」补全。** 判据仍是 D-12 的「这段文本会不会被 shell 执行」，不取出现位置。

**机制是单 token 前视旗标。** token 为真时，若它本身处在命令段起点、且是**原样未被引用、不含路径分隔符的字面词**、且属于闭集 `if`／`elif`／`while`／`until`／`do`／`then`／`else`，就令**紧随其后的一个 token** 也算段起点。

```ts
let executable = index === 0 || /[|;&\n]\s*$/.test(expanded.slice(0, start)) || pendingCommandPosition
pendingCommandPosition = false
…
if (raw === token && commandIntroducers.has(token)) pendingCommandPosition = true
```

**闭集取七个词**，是 shell 里引入命令位的完整集合。明确排除：终结符 `fi`／`done`／`esac` 之后没有新命令；`case` 后面的词是主语不是命令；`in`／`!`／`time` 不引入命令位。

**为什么只活一个 token。** 单 token 前视使 `<保留字> <rest>` 与把 `<rest>` 写在首 token 位置**判定完全一致**——保留字在判据里是**透明的**，本项不引入比顶层更强的检查。跨词存活会把 `do echo curl example.com` 的实参 `curl` 当成命令词。

替代：见到保留字即拒——那是位置判据，会误伤 `echo do curl example.com`；只把 `do`／`then`／`else` 计入——`if curl example.com; then echo ok; fi` 与 `while curl example.com; do …; done` 仍放行（同一机制、同一行判据，留一个洞只等于把问题推后）。

### 净放宽清单

两条，都与**顶层同形状的既有判定对齐**，不是新语义——顶层 `echo https://example.com` 与 `echo bash -c "curl https://evil/x"` 今日就已放行；循环／条件体里此前被拒，只是因为 `commandWord` 还停在保留字（`for`／`if`）上，`stdoutOnlyCommands` 豁免与 `-c` 片段豁免都不生效。

| 命令 | 改前 | 改后 | 通道 |
| --- | --- | --- | --- |
| `for f in a; do echo https://example.com; done` | deny | allow | `commandWord` 从此是 `echo`，惰性 URL 豁免生效 |
| `for f in a; do echo bash -c "curl https://evil/x"; done` | deny | allow | `bash` 是 `echo` 的实参，`-c` 片段豁免同样生效 |

配对的顶层对照（今日即 allow）写进了用例，证明这是**同一语义终于生效**，而不是新语义。

### 未放宽的部分

豁免的边界一条未动：`for f in a; do echo https://example.com | cat; done`（管道仍关掉豁免）、`for f in a; do echo $(curl https://evil/x); done`（`in command substitution:`）、`for f in a; do bash -c "curl https://evil/x"; done` 与 `do bash -c "curl http://x"`（`in shell -c argument:`，改前改后同判——`:512` 的抽取本就不以 `executable` 为前提）。`..` 整串正则、系统路径、工作区外路径、软链、递归删除、`sudo`、UNC、allowHosts 全部照旧。循环体内的 allowHosts 语义与顶层一致，由 `locked` 实例双向固定。

### 代价与残险

**一处新过拒**：`X=do; $X curl example.com` 变拒绝——环境展开先于分词，由**本串内刚绑定**的字面量展开出来的保留字被当成保留字，而 bash 不会在展开后重新识别保留字。方向是过拒，与 NX-24 的 `cat "/Program Files/secret"` 同一处置，写进用例让它成为一条**记录在案的决定**。

### 验证

**爆炸半径是实测的，不是推断的。** 用闸门自己的分词正则与分隔符正则，把 `.eval-evidence/**/events.jsonl` 里 **782 次真实模型 bash 调用**重放（`node docs/context-budget/nx24-replay-probe.mjs`）：

```
bash 调用 782 次，其中 9 次被拒
no unexpected deny: 9 条全部有归属
```

**与 NX-24 收口时逐字相同**——本项在真实语料上既不新增拒绝、也不丢失拒绝。另一项直接测量：关键字处在命令位的共 24 处，后随 token 全是 `echo`／`printf`／`node`／`od`，**零个是取网工具**（这次测量是临时的，**复现的守卫是 `nx24-replay-probe.mjs` 的集合断言**——它对同一批调用断言 9 条具名结果，任何未登记的新拒绝都会让它变红。刻意**不**新建第四个探针文件：计数型探针违反仓库「断言集合而不是计数」的做法）。

矩阵两次读数（**先读到 `met` 留证，再搬行**）：

```
（NX-26-1 之后）
known gap NX-26
met    deny  (want deny ) "for f in a b; do curl example.com; echo $f; done"
no contract drift; 5 known gap(s) still open, 1 gap row(s) now meet the target

（NX-26-3 搬行之后）
no contract drift; 7 known gap(s) still open
```

```
pnpm check            # syntax ok: 90 files
pnpm test             # tests 215 / pass 215 / fail 0 / skipped 0（原 212，新增 3 条用例）
pnpm fixtures:check   # 退出码 0，16 项
pnpm eval:offline     # 12 条 status=completed、accepted=true
node docs/context-budget/nx24-replay-probe.mjs   # 退出码 0：782 次调用 / 9 条拒绝 / no unexpected deny
pnpm demo:fix / demo:resume / demo:unknown       # 均退出 0
```

顺带订正：README 的测试计数此前停在 **207**（NX-24 落地时漏改，当时已是 212），本步一并改为 **215**——它本来就要随本项改动。README 的门禁段落另补一句命令段起点认保留字。

### 反例实跑

三条承重约束各有一条反例，每条都证明**该分支确实在咬**（`pnpm build && node --test dist/test/core.test.js`）：

| 关掉的东西 | 实跑的读数 | 还原后 |
| --- | --- | --- |
| 删掉旗标赋值行 | 用例变红（`deny` 行变 `allow`），矩阵 NX-26 行**退回 `open`** | 复绿 |
| 把赋值行挪出 `if (executable)` 块 | **allow 行** `echo do curl example.com` 变红：`actual: 'deny'`、`expected: 'allow'` | 复绿 |
| `raw === token` 换成 `basename` | **allow 行** `"do" curl example.com` 变红：`actual: 'deny'`、`expected: 'allow'` | 复绿 |
| 关键字集缩回 `do`／`then`／`else` | `if curl example.com; then echo ok; fi` 变红：`actual: 'allow'` | 复绿 |

第二条最要紧：它证明「保留字必须**自身**处于命令段起点」不是装饰——去掉这一条，一个普通 `echo` 的实参就会让整条命令被拒。第三条在 782 次语料上**不改变任何判定**（防御性，非语料驱动），照实写明。

### 未覆盖、已登记为独立待办

- **NX-30 保留字以外的「命令位置引入符」**：子 shell 与分组 `( curl example.com )`、`{ curl example.com; }` 今日仍是 allow（矩阵新增两行 `known gap NX-30` 让这处暴露不被静默）——`(`／`)`／`{`／`}` 在现有分词里归进 token 体（`[^\s|;&<>]+`），要先把算子集扩进去才谈得上判定；`case … in X)` 的臂体同理；`exec` 与赋值／重定向前缀（`do exec curl x`、`do VAR=1 curl x`、`do >out curl x`）则是那个单 token 前视被赋值／重定向／`exec` 这个 token 自己吃掉。**方向与本项相同（收紧）**，但前两类属「未跟踪算子」这一独立机制（会引入新的误拒：字面量 `(`／`{` 后面的主机形状词），第三类是 `exec` 是否该进闭集的取舍。
- **本项不宣称命令闸门已闭合**：`env` 包装（`do env curl example.com` 仍放行）、`exec`、子 shell 与分组、`case` 臂体都照旧不在覆盖内。本项只把「命令段起点」的判定补到与 shell 保留字一致，代价是展开先于分词带来的一处过拒。

## NX-24 闸门词法偏差的误拒收口

- 关联：NX-19 期间登记的相邻缺陷（`nx17-gate-probes.mjs` 的 `known gap NX-24` 组）。不依赖其他任务，可独立验收。状态：**done**（2026-10-01，零付费）。**方向是放宽**——NX-19 修的是「真正会执行的文本被顶层分词漏掉」，本轮修的是反面：**闸门自己的词法与真实 shell 不一致，把数据当成了路径或变量**。子步骤与提交边界见 [TASKS 的 NX-24 一节](TASKS.md#nx-24-闸门词法偏差的误拒收口)，展开与绑定模型见 [PLAN 的 D-13](PLAN.md#d-13-环境展开与命令内绑定)。
- 提交：`fcd06e7`（NX-24-0 立项与契约订正）、`27f27aa`（NX-24-1 反斜杠转义）、`84d9555`（NX-24-2 引号感知）、`a9708c1`（NX-24-3 波浪号）、`a173952`（NX-24-4 命令内绑定）、`f8f642c`（NX-24-5 路径形态），本提交（NX-24-6 回填）。

### 现象与根因

**证据是回放出来的，不是推断的。** 把 `.eval-evidence/` 下 33 份 `events.jsonl` 里 **782 次真实模型 bash 调用**逐条取出重放（`pnpm build && node docs/context-budget/nx24-replay-probe.mjs`），NX-24 之前**32 条被拒**：

```
23  unset environment variable in command
 9  path escapes the workspace
```

**方法学陷阱（我第一版就是这么错的）**：改用 `process.cwd()` 当 workspace 重放会得到 **64** 条，其中 32 条是**重放自身的伪影**——模型在评测里 `cd "C:\…\mini-dsh-fixture-*/workspace"`，而闸门的 workspace 就是那个临时目录。必须按会话从 `tool/result` 的 `cwd` 读回 workspace，否则结论凭空翻倍。这条写进了探针的文件头。

**它改变了模型的行为**，不是推断——原始事件里模型的自述原文：

```
Hmm, the bash tool rejects `$f`? Let me just cat each file.
the tool reports "unset environment variable in command" possibly because it detects
`$VARIABLE`. Let me write a temp test script file instead.
```

根因是一条，不是四条：`sandbox-runtime.ts` 的环境展开是**引号盲、反斜杠盲**的整串 `String.replace`（对**本串内刚绑定过的**名字也一无所知），而路径形态判据只认「两条以上前导斜杠 ＋ 首分量含空白」。

| 族 | 条数 | 形状（原文） | 判定 |
| --- | --- | --- | --- |
| ① `for` 绑定变量 | 18 | `for f in src/*.mjs; do echo "=== $f ==="; cat "$f"; done`；`for n in 07 08 09 10; do node tmp-verify-$n.mjs > r$n.log 2>&1; echo "$n exit=$?"; done` | 误拒 |
| ② 反斜杠转义 | 2 | `node -e "…Array.from({length:2000},(_,i)=>\`n\${i}…\`)"`；`sed -n "$(grep -n '^## 11' docs/SPEC.md \| cut -d: -f1),\$p" docs/SPEC.md` | 误拒：`\$` 已转义 |
| ③ 单引号内的 `$NAME` | 1 | `node --input-type=module -e '…throws("a: b$c\n", …)…'` | 误拒：单引号内不展开 |
| ④ 被引号成词的正文以 `/` 开头 | 5 | `awk '/^## 11/,/^## 12/' docs/SPEC.md`；`sed -n '/^## *9/,/^## *10/p' docs/SPEC.md`；`awk '/stage(7\|7)\|phase 7/{f=1} f' check.mjs` | 误拒：awk／sed 程序正文被当成绝对路径 |
| ⑤ **真阳性，本次刻意保留** | 2 | `node -e "… show('a: b$ad'); …"`；`node -e "… ['a: b $c', /line 1[\s\S]*/] …"` | **拦对了**：`$ad`／`$c` 在**双引号内且未转义**，bash 真的会展开成空串、静默改坏模型写的程序 |

### 设计决策

**判据取「这段文本会不会被 shell 展开」，不取出现位置。** 沿用 NX-17／NX-19 的方向：`$NAME` 在单引号内、在 `\` 之后就不该展开；`/^## 11/` 在引号内就不是路径。

**四个族用一个改法，不给每族打补丁。** 共同根因是「展开不看引号也不看反斜杠」，所以把整串 `replace` 换成**一趟引号与转义感知的扫描** `expandEnvironment`。它逐字复制不替换的字符（含反斜杠与引号），仍只产出**同一条 `expanded` 字符串**——下游的 token 偏移（`tokens[index].index`、`expanded.slice(...)`）、`..` 整串正则与片段抽取都建立在这条串的原样形状上，改动它的形状等于同时改这三处的判据。

**`\X` 整对复制，处理的是「`\$` 与 `\\$` 的分界」。** `\$` 是字面量，而 `\\` 先被整对吃掉、紧随的 `$` 仍是裸的、仍会被展开。写成「见到反斜杠就跳过下一个」会让 `echo \\$(curl x)` 漏检（有用例固定）。

**双引号内的 `'` 不得开启单引号区间**（`!double` 守卫）。这是最容易写错的一处：少了它，真阳性 `node -e "show('a: b$ad')"` 会变成**放行**——而 bash 在双引号内确实会展开 `$ad`。

**双引号内仍展开是特性，不是 bug。** `cat "$HOME/.ssh/id_rsa"` 必须继续被拒（`test/core.test.ts` 的 `Sandbox expands env paths before the escape check…` 已锁）。要改的只是展开对引号与反斜杠视而不见。

**`for` 绑定用「代表值替换 ＋ 全候选值形状门槛」。** `for NAME in w1 w2 …` 的每个候选值都必须通过 `isSafeBindingWord`，任一不通过即整条拒绝；这样「用哪个值做代表检查」与逐值检查等价。否决的替代方案各有具体失效：只替换**首值**→ `for f in a /etc/passwd; do cat $f; done` 被放过；**多值文本拼接**→ `"$f"` 在双引号内合成一个词，同样被放过；**逐值展开循环体**→ 要对 `do…done` 做语法解析、要新增宽度上限，嵌套还会相乘。兜底是词表本身始终留在展开后的串里，危险字面量照旧被路径分支看见。

**赋值只认命令段起点，且刻意不收 `read`。** `(?:^|[;&|\n])` 之外不认 `NAME=`，否则 `curl -d name=x` 这类实参会被当成赋值。`read NAME` 的取值来自 stdin、静态不可知，绑任何值都是猜测，按「不能证明安全就拒绝」处理。

**三条拒绝理由互不共用**：`unset environment variable in command`、`unsafe for loop value in command`、`unsafe assigned value in command`。共用会让以后调绑定规则污染环境变量用例的判据。

**④ 取最窄的推广：把 `/^\/{2,}/` 改成 `/^\/+/`，判据本身不动。** 加**元字符**判据是错的、已实测否决：sed 的程序正文里合法地含 `*`（`/^## *9,/`），把 `*` 计入会**漏掉** sed 那一例，不计入 `*` 又会放过 `/*/secret` 这种真实的根级读取。接受的连带是「首分量含空白的 POSIX 根路径不再算路径操作数」——与既有 `//` 形态**同一取舍**（`//Program Files/…` 今天就已经被跳过），只是把拼法从两条斜杠放宽到任意条，写进用例与矩阵各一行让它成为**记录在案的决定**。

### 净放宽清单

21 条误拒转放行，即上表①②③④各族。反向的 2 条真阳性**保持拒绝**，且 `test/core.test.ts` 新增用例把它们的**理由**也钉住（`unset environment variable`），以免以后哪次放宽顺手把它们放过。

### 未放宽的部分

NX-17／NX-19 记为「未放宽」的规则**本次一行未动**：`..` 逃逸（整串正则，属 NX-18）、系统路径、工作区外路径与软链、归一化后仍越界的双斜杠路径、递归删除与 `sudo`、UNC、出网与 allowHosts。`test/core.test.ts` 里这些行逐条仍在，并新增了 `node -e "//comment"`、`ls /`、`ls //etc` 等的孪生断言。

### 验证

基线（动手前 `node docs/context-budget/nx17-gate-probes.mjs`）：`no contract drift; 7 known gap(s) still open`，其中 `known gap NX-24` 三行两 `open`（`echo '$HOME'`、`kind=local; echo $kind`）一 `open`（here-doc）。

两条缺口行的达标留证（NX-24-5 之后、搬移之前）：

```
met    allow (want allow) "echo '$HOME'"
met    allow (want allow) "kind=local; echo $kind"
open   deny  (want allow) "cat <<'EOF'\ncurl https://example.com\nEOF"   ← 未闭合，改登 NX-25
```

搬移进两个新契约组后：`no contract drift; 6 known gap(s) still open`（NX-18 ×2、NX-23 ×2、NX-25 ×1、NX-26 ×1），`fixed: quote-blind expansion`（12 行）与 `fixed: quoted program text`（6 行）全部 `ok`。

```
pnpm check            # syntax ok: 90 files
pnpm test             # tests 212 / pass 212 / fail 0 / skipped 0（原 207，新增 5 条用例）
pnpm fixtures:check   # 退出码 0，16 项
pnpm eval:offline     # 12 条 status=completed、accepted=true
pnpm demo:fix / demo:resume / demo:unknown   # 均退出 0
node docs/context-budget/nx24-replay-probe.mjs   # 退出码 0：782 次调用 / 9 条拒绝
```

**回放终态：32 → 9 条**（4.1% → 1.15%）。9 条逐条有归属，探针做的是**集合断言**（任何一条翻面都会红），不是计数断言：

| 条数 | 归属 |
| --- | --- |
| 2 | **真阳性**（双引号内未转义的 `$ad`／`$c`），本次刻意保留 |
| 4 | NX-27：`> /tmp/…`，Git Bash 的 `/tmp` 与 `node:path` 不一致 |
| 1 | NX-28：here-doc 正文里形如 `a:\tb\tc` 的字面量被判为盘符路径 |
| 1 | NX-18：`cat ../package.json`（从 `src` 上一级仍在工作区内）撞 `..` 整串正则 |
| 1 | NX-29：正则字面量 `/missing` 与真实绝对根路径同形，无判据可用 |

`062d867579` 那条（NX-18）值得单独说一句：它在改动**之前也被拒**，只是当时的理由被更早触发的 `unset environment variable` 遮住了；本次让它暴露出真正的拦点是 `..` 规则。这不是本轮引入的回归。

### 反例实跑（每条新分支都要能证明用例会咬）

| 关掉的东西 | `node --test dist/test/core.test.js` 的输出 | 还原后 |
| --- | --- | --- |
| `\X` 整对复制改单字符前进（NX-24-1） | `AssertionError [ERR_ASSERTION]`（`Sandbox does not expand a variable whose dollar sign is backslash-escaped`） | 复绿 |
| 单引号分支恒不置位（NX-24-2） | 同上（`…by shell quoting rules…`） | 复绿 |
| `~` 还原成引号盲的 `replace`（NX-24-3） | 同上（`…bare tilde but not one inside single quotes…`） | 复绿 |
| 删掉 `for` 分支（NX-24-4） | 同上（`…resolves names bound inside the command…`） | 复绿 |
| `isSafeBindingWord` 恒真（NX-24-4） | `actual: 'system path is blocked'`，`expected: /unsafe for loop value/` | 复绿 |
| 还原 `/^\/{2,}/`（NX-24-5） | 同上（`…quoted program body starting with a slash…`） | 复绿 |

最后一行是**只能断言理由**的那一处：关掉形状门槛后 `for f in a /etc/passwd; do cat $f; done` **仍然被拒**，只是理由变成 `system path is blocked`——命令的判定没变，只有理由串变了。这就是拒绝理由必须互不共用的实证。

### 只有实测才会暴露的坑

1. **`process.cwd()` 重放会让数字翻倍**（64 vs 32），且翻倍的那一半与闸门无关。见「方法学陷阱」。
2. **`*` 不能进形状门槛的禁用字符集**：首版把 `*` 当危险字符，于是 `for f in src/*.mjs` 被判 unsafe——而通配符只会在这个目录里展开，`/*` 已经被前导斜杠那条挡下。这个是跑出来才发现的。
3. **`isSafeBindingWord` 的门槛在多数情况下只改变「理由」而不改变「判定」**，因为词表本身留在串里。若测试只断言 `action` 而不断言 `reason`，这道门槛会**静默失效**且测试全绿。
4. **只替换首值会造成真实绕过**：`for f in a /etc/passwd; do cat $f; done` 取首值 `a` 就放行，而 bash 第二次迭代真的读 `/etc/passwd`。

### 未覆盖、已登记为独立待办

改前/改中发现的相邻缺陷，按 NX-17 的先例只登记不修，都已实测并进相应矩阵：

- **NX-25 here-doc 正文被当命令词**（从 NX-24-③ 拆出）：`known gap NX-25` 一行。拆出的理由是它有一处三族没有的真难点——正文是数据还是脚本取决于**消费它的命令**（`cat <<'EOF'` 是数据，`bash <<'EOF'` 会被真正执行，当前靠「正文里的 URL 被当命令词」误打误撞拦下）。
- **NX-26 `do`／`then`／`else` 之后不算命令段起点**：`known gap NX-26` 一行。**`for f in a; do curl example.com; done` 今日就是 allow**（已实测）——这是一条**独立于 NX-24 的既有放行**；但绑定 `for` 变量后会有更多命令走到这里（`for f in a; do curl example.com; echo $f; done` 改前是误拒、改后变放行），所以不能装作没看见。
- **NX-27 Git Bash 的 `/tmp` 与 `node:path` 不一致**：win32 上 `path.resolve('/tmp/out.txt')` → `D:\tmp\out.txt`，于是任何 `/tmp/...` 都被判越界（实测 `echo x > /tmp/out.txt`、`cat /tmp/out.txt` 全拒）。机制与词法无关。
- **NX-28 引号成词的正文以 `<字母>:\` 开头被判为盘符路径**：`node --input-type=module <<'EOF'` 正文里的 `parseDeps('a:\tb\tc\n')` 被当成 `a:\` 盘符。与族④同属「正文被当成路径」，但触发的是盘符那条臂，加「首分量含空白」盖不住它（首分量 `tb` 不含空白）。用 bisect 定位到具体行。
- **NX-29 正则字面量与绝对根路径同形**：单引号 payload 里出现未转义的 `'` 时 tokenizer 会像 shell 一样断开引号区间，`assert.match(x, /missing/);` 里的 `/missing` 成了独立 token——与真实读取根目录的 `/missing` **形状完全相同**。这不是闸门漏检（闸门与 shell 一致），是拒因不够明确；处置方向是**给引号坏掉的命令更明确的理由**，而不是放宽路径判据。

## NX-19 出网拦截的真实缺口收口

- 关联：NX-17 期间登记的相邻缺陷（`CHANGES.md` 的 NX-17 节末「未覆盖待办」与 `nx17-gate-probes.mjs` 的 `known gap NX-19` 组）。不依赖其他任务，可独立验收。状态：**done**（2026-10-01，零付费）。方向是**加强**，不是放宽。子步骤与提交边界见 [TASKS 的 NX-19 一节](TASKS.md#nx-19-出网拦截的真实缺口收口)，覆盖模型见 [PLAN 的 D-12](PLAN.md#d-12-沙箱命令策略的覆盖模型)。
- 提交：`8ad5765`（NX-19-0 立项与契约订正）、`371eec9`（NX-19-1 取值旗标）、`fc23fcb`（NX-19-2 工具集与操作数模型）、`d2a045f`（NX-19-3 `$(...)`／反引号递归）、`5e1f99c`（NX-19-4 `-c`／`eval`）、`8aacdf0`（NX-19-5 反斜杠 UNC）、本提交（NX-19-6 回填）。

### 现象与根因

四个形状在 NX-17 后就已登记，**当前全部放行**（`nx17-gate-probes.mjs` 的 `known gap NX-19` 组，实测）：

```
allow  bash -c "curl http://example.com"
allow  echo "$(curl https://example.com)"
allow  nc example.com 80
allow  cat \\server\share\secret
```

根因有三条，互相独立：

1. **顶层分词看不见真正执行的那段文本。** 模型的整串命令交给 `bash -lc`（`src/tools/bash.ts:53` 的 `args: ['-lc', command]`、`src/core/command-runner.ts:51` 的 `spawn`），由 bash 用完整 shell 语法重新解析。`$(...)`、反引号与 `-c` 的参数都是**会被执行**的文本，而 `inspectCommand` 只在顶层做词法与形状检查。这与 NX-17 修的「闸门的分词与 shell 不一致」是同源缺陷的不同面。
2. **取网工具集只有 `curl`/`wget`。** `networkTool` 仅由这两个 basename 触发（`sandbox-runtime.ts:71` 原文），所以 `nc`／`ssh`／`scp`／`rsync`／`ping`／`dig` 的主机操作数从不进入判定。
3. **反斜杠 UNC 整段跳过检查。** 路径分支的入口是 `/^(?:\/|[A-Za-z]:[\\/])/`，`\\server\share` 既不以 `/` 开头也不是盘符，两个条件都不匹配。

另有一处**相反方向的既有缺陷**（本次一并修，见下）：`curl -o out.txt http://localhost/x` 被误拒。

### 设计决策

**判据取「这段文本会不会被执行」，不取出现位置。** 把这类片段抽出来递归走同一个 `inspectCommand`，而不是「见到 `$(` 就拒」——后者会误伤 `echo "$(date)"`、`git commit -m "$(cat msg.txt)"`。这条沿用 NX-17 已定的判据方向。

**递归保留全部语义，不是「见到取网工具就拒」。** `echo "$(curl http://localhost/health)"`、`bash -c "curl http://localhost/x"` 必须放行；allowHosts 在片段里照旧生效——矩阵里用现成的 `locked` 实例（`allowHosts: ['api.internal']`）双向固定：同一形状默认库放行、locked 库被拒，换成白名单主机又放行。这是最容易写成一刀切的地方。

**echo/printf 豁免分两种。** 对 `-c`／`eval` 的**抽取**生效（`echo bash -c "curl x"` 里的 `-c` 只是文本），对 `$()`／反引号的**扫描不生效**（`echo "$(curl x)"` 里的替换真的会执行）。落地是复用 `sandbox-runtime.ts` 原有的 `commandWord`/`pipedDownstream`。

**取网工具按操作数模型取目标，不是一张「见到就拒」的名字表。** 三种模型：`url-or-host`（`curl`/`wget`，位置参数可能是本地文件，只看形状像目标的）、`operand`（`ssh`/`sftp`/`nc`/`telnet`/`ping`/`dig`/`nslookup`/`host`，**第一个非旗标位置参数就是目标**，其后的位置参数是远端命令）、`remote-spec`（`scp`/`rsync`，只认 `[user@]host:path`，裸文件名即便含点也不是目标）。工具词自身不是位置参数——首版把 `ping`／`ssh`／`nc` 当成第一个操作数去比对 allowHosts，于是 `ping 127.0.0.1` 一律被拒，这个坑只有实测才会暴露。

**与 NX-17「不采用网络工具清单」的记录正面交代。** NX-17 的决策记录写着「清单天然不完整，未列入的工具会从「拒绝」变成「允许」，属于真实的出网拦截削弱」。那次否决的是**用清单替换通用 URL 规则**——方向是削弱。本次是**叠加到拒绝侧**：未列入的工具不变，列入的由放行变拒绝。清单不完整的残险相同，影响方向相反，故接受，并把「只减少漏报、不承诺闭合」写进 R-20 的边界句与 PLAN 的 D-12。

**「取值不是网络目标」的旗标表逐工具登记，且默认仍是检查。** `curl -o`／`wget -O`／`ssh -i` 等旗标之后的 token 不做主机判定（但仍做路径判定，`curl -o /etc/cron http://localhost/x` 照旧被拒）；`--url`、`-x/--proxy`、`--resolve` 刻意不入表，因为它们的值就是目标。不能用「flag 之后一律跳过」——那会让 `curl -s example.com` 把 URL 当 `-s` 的取值而漏检。短旗标按工具分开登记：curl 的 `-O` 是布尔量，wget 的 `-O` 取文件名。

**上限：深度 3、单次命令片段数 32，超限即拒绝并用独立理由串。** 片段必是父串的真子串，终止性本来不靠上限；上限挡的是宽度与工作量。耗尽若放行，`$(a$(b$(c$(curl x))))` 就成了一个明文可复制的绕过构造。理由串与出网、UNC 三者**互不共用**，否则以后调上限会污染出网用例的判据。上限取模块常量而不进 `SandboxConfig`——`test/fixtures/estimation/corpus/code/core-contracts.txt` 是 `contracts.ts` 的逐字副本且被 digest 钉住，改配置契约会让副本悄悄漂移。

**反斜杠 UNC 用收紧的正则，不用 `^\\\\` 一刀切**，否则 `printf '\\n'` 这类正当写法会中招（有用例固定）。也不能只靠路径分支兜底：POSIX 上 `path.resolve` 会把 `\\server\share` 当成工作区内的相对名而放行。

**唯一一处净放宽（NX-19-1）。** `curl -o out.txt http://localhost/x` 此前被拒：既有「裸主机名操作数」规则把 `-o` 的**取值**当成了主机（`out.txt` 是 host-shaped，而 `networkTool` 在段内粘滞）。这不是策略选择而是实现缺陷——NX-17 记录的豁免对象是「裸主机名操作数」，而输出文件名不是主机名操作数。它必须先修：清单扩展会把同类误报复制到 `ssh -i`／`scp`／`rsync`（`wget -O page.html`、`curl -sS -o out.json` 当时同样被拒）。因此它独立成一步、排在清单扩展之前，且在提交信息里写明性质。

### 未放宽的部分

NX-17 记为「未放宽」的规则**本次一行未动**：`..` 逃逸（整串正则，含引号内的惰性文本误判，属 NX-18）、系统路径（`/etc`、`/dev`、`/proc`、`/sys`、`/root`、`/boot`）、工作区外相对与绝对路径、归一化后仍越界的双斜杠路径（`//etc/passwd`、`//home/user/.ssh/id_rsa`）、递归删除与 `sudo`、以及「惰性输出接进管道」（`echo "…" | xargs curl`）。`test/core.test.ts` 里这些行逐条仍在。

### 验证

基线（动手前，`pnpm build && node docs/context-budget/nx17-gate-probes.mjs`）：`no contract drift; 6 known gap(s) still open`——24 条约定行全 `ok`，6 条缺口行全 `open`。

四条缺口行的达标留证（NX-19-5 之后、搬移之前）：

```
met    deny  (want deny ) "bash -c \"curl http://example.com\""
       reason: in shell -c argument: unauthorized outbound request
met    deny  (want deny ) "echo \"$(curl https://example.com)\""
       reason: in command substitution: unauthorized outbound request
met    deny  (want deny ) "nc example.com 80"
       reason: unauthorized outbound request
met    deny  (want deny ) "cat \\\\server\\share\\secret"
       reason: UNC path is blocked
```

搬移进约定组后：`no contract drift; 7 known gap(s) still open`，新组 `closed: NX-19 outbound closure` 全部 `ok`，剩余 7 条是本次**不修**的 NX-18（2）、NX-23（2）、NX-24（3）。

```
pnpm check            # syntax ok: 90 files
pnpm test             # tests 207 / pass 207 / fail 0 / skipped 0（原 205，新增 2 条用例）
pnpm fixtures:check   # 退出码 0：16 项，初始 passed:false ×16、参考 passed:true ×16
pnpm eval:offline     # 12 条 status=completed、accepted=true（筛查批次未被扰动）
node docs/context-budget/nx17-gate-probes.mjs   # 见上
```

### 反例实跑（每条新分支都要能证明用例会咬）

| 关掉的东西 | `node --test dist/test/core.test.js` 的输出 | 还原后 |
| --- | --- | --- |
| `!skipHostCheck`（NX-19-1） | `AssertionError [ERR_ASSERTION]: curl -o out.txt http://localhost/x` | 复绿 |
| 工具集退回 `['curl','wget']`（NX-19-2） | `AssertionError [ERR_ASSERTION]: nc example.com 80` | 复绿 |
| 短路片段抽取（NX-19-3） | `AssertionError [ERR_ASSERTION]: echo "$(curl https://example.com)"` | 复绿 |
| 短路脚本片段检查（NX-19-4） | `AssertionError [ERR_ASSERTION]: bash -c "curl http://example.com"` | 复绿 |
| UNC 分支改永不匹配（NX-19-5） | `AssertionError [ERR_ASSERTION]: cat \\server\share\secret` | 复绿 |

四处**只有实测才会暴露**的坑，已修并留在代码注释与提交信息里：① 工具词自身被当成第一个位置参数（`ping 127.0.0.1` 一律被拒）；② `-c` 之后只有**一个** token 是脚本（取全部会误伤 `bash -c 'echo hi' example.com`）；③ 片段必须走真正的 shell 去引号（`bash -c "echo \$(curl x)"` 的外层 `\$` 会变成 `$`，内层 bash 真的执行它，保留反斜杠就漏检）；④ 双引号内的 `\$` 是字面量、外层不执行，与 ③ 并不矛盾——用例把两侧都钉住了。另外 NX-19-5 的一次临时改动把 `\\` 写成了字面 NUL，落地前由 `NUL: false` 检查拦下并修正。

### 未覆盖、已登记为独立待办

改前发现的相邻缺陷，按 NX-17 的先例只登记不修（都已实测并进 `nx17-gate-probes.mjs` 的 `known gap` 组，读作 `open`）：

- **NX-23「URL 是数据还是请求目标」**：`git log --grep "https://github.com/x"`、`npm install --registry https://registry.npmjs.org`、`git remote add origin https://…` 与 `curl https://…` 同判为拒绝。它是 NX-17 `CHANGES.md` 已点名的残留，属**放宽**方向；且修它要引入「哪些位置算 URL 消费位置」的子命令知识，与仓库「判据取形状与能力、不取出现位置」正面冲突。直接证据：`git log --grep=<url>` 放行而 `git log --grep <url>` 拒绝，同一条语义两种结果。
- **NX-24「闸门词法仍与 shell 有系统偏差」**：三处同源、机制各不相同——单引号内的 `$HOME` 仍被环境展开后判越界（`echo '$HOME'` → `path escapes the workspace`，而真实 shell 不展开）；shell 变量被当未定义环境变量（`kind=local; echo $kind` → `unset environment variable in command`，这条**完全没有出网**，纯属误拒）；here-doc 正文被当命令词（`cat <<'EOF'` 的引号定界符正文在 shell 里是纯文本，却报 `unauthorized outbound request`）。本轮只修了执行路径上的检查，没有返工引号盲的环境展开。

**本次不宣称「出网已闭合」。** 以下结构性不在覆盖内，逐条写进 R-20 的边界句：`node -e`／`python -c` 的程序字符串、脚本文件内容（`bash script.sh`）、管道解码后再执行（`echo <base64> | base64 -d | sh`）、here-doc 正文、未列入清单的取网程序。这是应用层形状启发式，不是操作系统隔离——`src/plugins/sandbox.ts` 的系统提示文案未改。

## NX-08h 打破任务集天花板（方案 2，无公开检查变体）

- 关联：[NX-08g0](CHANGES.md#nx-08g0-任务集天花板效应定性边界与补救排序) 的**方案 2**（「增设**无公开检查**变体：工作区不含 `check.mjs`，只能按 SPEC 自验」）。状态：**离线部分 done**（2026-10-01，零付费）；付费烟测与结果回填另计。子步骤与提交边界见 [TASKS 的 NX-08h 一节](TASKS.md#nx-08h-打破任务集天花板方案-2无公开检查变体)，仪器与预注册见 [PLAN 的 NX-08h 一节](PLAN.md#nx-08h-无公开检查变体blind)。
- **本次零代码改动**：`src/**` 一行未动（`git diff --stat 75a4614^..HEAD -- src/` 为空）。新增的 `blindIds` 与 `blind` 阶段都落在 `scripts/`（评测与 fixture 注册），不在生产路径上。
- 提交：`75a4614`（NX-08h-0 立项与 PLAN 预注册）、`9bfafb4`（NX-08h-1 骨架与注册表）、`32efaf3`（NX-08h-2 阶段说明与 SPEC）、`a1d1077`（NX-08h-3 阶段枚举与上限）、`935b769`（NX-08h-4 契约与机制证明用例）、本提交（NX-08h-6 回填）。

### 动因与设计要点

**为什么必须新建 fixture，而不是给 `runFixtureTask` 加「隐藏 check.mjs」的开关。** 机制上不可行：`protectedFiles` 在 `createFixture` 时按 `initial/` 快照（`scripts/coding-fixtures.ts:87`），而 `check.mjs` 不在 `sources.pipeline` 里、因而是受保护项；运行期把它删掉会让 `evaluate()` 的 `lstat` 走 catch 分支（`:99-100`）把它记进 `protectedFilesChanged`，`passed` 恒为 false。要让它能用，就必须再去特判验收器——那正是在改独立验收口径来配合隐藏一个文件，与 NX-08h 自己的要求反向。新建 fixture 还保住两件东西：处理在 fixture 树里可见可评审；`.eval-evidence` 里六个历史目录零扰动。

**仪器与可比性。** `blind` 是 `pipeline` 的复制，**只改三处**：删掉 `initial/check.mjs`；十四份 `TASKS/*.md` 的末句由「完成后运行 `node check.mjs N`」改为按 `docs/SPEC.md` 自验；`initial/docs/SPEC.md` 里两处提到 `check.mjs` 的句子改为只提独立验收。模型、prompt、初始工作区、验收器、单次 run 预算与输入目标 65,536 都与 NX-08e 的 `armB` 一致，**唯一差异是没有公开 oracle**。

**为什么不能并进 `sequenceIds`。** `phaseCaps.sequence.runs = 1` 而 registry 会有 2 项，`repeatCount(1, 2)` 直接抛 `a phase scheduled for 1 runs cannot be split evenly across 2 fixtures`（`scripts/eval-cli.ts:83-88`，已被 `test/eval-cli.test.ts` 钉住）。即便整除，也会让对照 A 的两臂拿到不同的任务集，把被比较的东西从上下文策略换成任务难度。因此单独一份注册表 `blindIds`。

**新阶段 `blind` 不进 `batchPhases`**，与 `sequence`／`smoke` 同口径取逐阶段预算的理论上界（14 × 32 = 448 请求；14 × 2,000,000 = 28,000,000 token）。`batchCaps` 因此保持 `{18, 3_200, 88_000_000}` 不变。**这不是 NX-08h 的正式预注册数字**——NX-08g0 的「不得沿用本轮的 `phaseCaps` 数字」指的是不得搬用 NX-08e 那套对照 A 的上限；`blind` 上的正式对照批次的上限要等本次烟测的实测之后另行确定，理由与 NX-08e2 的教训相同（按外推定的 token 上限被实测推翻过 64%）。

**`phaseCaps` 由测试逐字钉死。** `test/eval-runner.test.ts` 用 `assert.deepEqual(phaseCaps, {…})` 记住全部阶段，加一个阶段而不改它就会红；同一用例里另按 `blind` **自己的**阶段数钉住理论上界，并断言它与 `pipeline` 的阶段数相等——阶段数一旦漂开，两次烟测的读数就不能再并排比。

### 离线证据（零付费）

```
pnpm check            # syntax ok: 90 files
pnpm test             # tests 205 / pass 205 / fail 0 / skipped 0（原 203，新增 2 条）
pnpm fixtures:check   # 退出码 0：16 项，初始通过 0、参考通过 16、expected 全为真
pnpm eval:offline     # planned 12 / executed 12 / accepted 12（筛查批次未被扰动）
pnpm demo:fix         # 退出码 0
pnpm demo:resume      # 退出码 0
pnpm demo:unknown     # 退出码 0
```

`fixtures:check` 逐行 JSON 里 `blind` 的两条：

```
blind: initial passed=false, exitCode=1, 含 AssertionError=true, protectedFilesChanged=[]
blind: reference passed=true, 输出="acceptance passed: blind"
```

`pnpm eval:offline` 仍是 12/12，是这次改动的关键旁证：注册表加了一档、`fixtureIds` 由 15 变 16，但筛查批次的清单与上限都没动，NX-08d 的 12/12 因此仍然对应同一个任务集。

### 反例实跑（四条）

机制证明只有在能变红时才算数。四条各自改坏一处、跑、还原、复绿：

| 改坏什么 | 期望 | 实测 |
| --- | --- | --- |
| 给 `blind` 的阶段说明加回一行 `node check.mjs 1` | 红 | 红，`AssertionError: blind stage 1` |
| 删掉 `blind` 阶段说明里一行与公开检查**无关**的内容 | 红 | 红，`stage 3 改掉了一行与公开检查无关的内容：- 环成员必须真的从 order 里消失，而不是留在末尾。` |
| 把 `blind/verify.mjs` 的 marker 改回 `acceptance passed: pipeline` | 红 | 红，严格相等失败 |
| 同上，跑 `pnpm fixtures:check` | 退出码 1 | 退出码 1，`blind: reference passed=false, expected=false`；改回后退出码 0 |

第二条是这套仪器最要紧的一条：只断言「不含 `check.mjs`」会放过一整段被改写的任务要求，而那样的改动会让仪器悄悄测起别的东西。

### 一个诚实说明

NX-08h-1 与 NX-08h-2 的全部内容是从 `pipeline` 机械复制后的改写，它们的验收**只在事后核对差异范围**（逐份 `diff`、`grep` 两类提到公开检查的行），当时并没有回归测试在写的时候挡住漂移——NX-08h-4 的用例是在改写**之后**才写的。这一点与 NX-11-2…NX-11-5 的处境相同，照实写在这里，不假装每步都有同等强度的验收。

### 付费烟测（NX-08h-7）与结论

命令与预演逐字核对过再开跑：

```
pnpm eval:screening --phase blind --plan-only   # 零花费：1 个任务 × 1 次重复 = 1 次运行：blind；448 请求 / 28000000 token；只做计划预演
MINI_DSH_EVAL_EVIDENCE_DIR=.eval-evidence/blind-full pnpm eval:screening --phase blind
```

证据目录 `.eval-evidence/blind-full/`（不入库）。2026-10-01，`deepseek/deepseek-v4-flash`，服务端回显 `deepseek-flash`。**退出码 0**。

**终态验收通过**：`accepted=true`、`acceptance.exitCode=0`、`acceptance.output` 逐字为 `acceptance passed: blind`、`protectedFilesChanged=[]`。

**用量**：222 请求 / 256 工具 / **8,710,662 token**（输入 8,435,331 + 输出 275,331）/ 主动时间 1,284,263 ms ≈ 21.4 分钟。222 条 usage **全部来自 provider**，估算回退 0 次。成本按价格页 off-peak 口径（2026-10-01 为国庆，与 NX-08e 同一判断）**约 $1.43**；若按 peak 则 $2.86。

**按预注册的三条判据分类**：

| 判据 | 是否命中 |
| --- | --- |
| 「天花板被打破」= `accepted === false` **且** 退出码 1 **且** `protectedFilesChanged` 为空 **且** 输出含 `AssertionError` | **否**（`accepted === true`） |
| 「因其它原因被拒」= `accepted === false` 但上面三条不同时满足 | 不适用 |
| 「未被打破」= `accepted === true` **且** 没有阶段以 `max_steps` 结束 | **字面命中**（零 `max_steps`） |

**因此这次读数是「没有观测到失败」。** 按预注册的措辞，只可写「这一次没有失败」，**不得**写「无公开检查不影响结果」「模型不需要 oracle」，也不写任何比例或对比。**与 `armB` 的比较不在本次预注册内**——`blind` 上的正式对照批次的上限尚未确定，要另立预注册与授权。

#### 预注册漏掉的一种情形：4/14 个阶段以 `context_overflow` 结束

逐阶段状态：**10 个 `completed`、4 个 `context_overflow`**（第 6、7、13、14 阶段），每个溢出的阶段各留下 **1 个未发出的投影**。

**这不是「模型答错了」，也不是 `max_steps`。** 触发点是 `agent-loop-runtime.ts:80-81` 的第一个合取项：`estimatedInputTokens > policy.inputTargetTokens`（65,536）。该判断发生在**裁剪之后**——四个阶段的 `removedTaskIds` 分别是 5／6／12／13，即能裁的旧任务已经全部裁掉，剩下的当前任务（恒受保护、不可裁）单独就超过了输入目标。末次投影的估算输入分别为 65,607／78,280／66,724／66,643。窗口是 1,000,000，第二个合取项（窗口）离得很远，所以溢出与窗口无关。

**这一条**我的预注册**没有预见到**：三条判据里只防了 `max_steps`（「没有阶段以 `max_steps` 结束」），没有防 `context_overflow`。按预注册条款「开跑前写死，之后不得改动」，我**没有回改判据正文**；这里照实记下这处缺口——它是这条判据的一个已知漏洞，不是把结果往「未打破」里归的理由，也不是把它读成「打破」的理由。

#### 机制：模型自己把 oracle 建了回来

四个溢出阶段里，模型都在**自己写检查脚本**：第 6 阶段建 `tmp-verify-06.mjs`、第 7 阶段建 `tmp-verify-07.mjs`，第 10 阶段又回头跑了一次 `node tmp-verify-07.mjs > r7.log`，第 14 阶段把 `log13.txt` 用 `sed`＋`grep` 过了一遍。**117 次 bash 调用里有 31 次是 `node` 加内联脚本**（`-e` / `--input-type=module -e`），用来直接 import 刚写完的模块并打印结果。**117 次 bash 里提到 `check.mjs` 的是 0 次**——被删掉的那个文件，模型一次都没有去找。

**可检验的读数**：让当前任务膨胀到越过输入目标的，正是这些自建脚本、它们的输出与 `write_file` 写下的脚本正文（第 7 阶段的末两个投影从 62,522 跳到 78,280）。

这条与 NX-08f 的发现同形：那一次是「给 agent 一个通用 shell，它就能把大数据在工具进程里降维」；这一次是「给 agent 一份权威 SPEC，它就能自己写出检查脚本」。**n=1，两次都是单次观察，不得外推成规律。**

#### 这次读数不能支持什么

- 不能支持「有公开 `check.mjs` 不影响结果」，也不能支持「无公开 `check.mjs` 影响结果」——**没有观测到差异**不等于**没有差异**（NX-08f 的两次烟测是同一处先例：n=2 且两次同侧，写的是「未观测到处理生效」）。
- 不能把这次当作干净的单因素对照。**设定上**只差一个因素（工作区里有没有公开 `check.mjs`），但**运行中**它在 Harness 侧又带出了第二个可见差异：四个阶段的输入目标被当前任务顶穿。任何与 `armB` 的并排读法都受这一处混杂影响。
- 不能读成模型能力结论（`accepted` 只有 1 个取值，仍然量不出通过率）。
- 不能据此改 `blind` 或重跑。预注册写明「无论结果如何都不改 fixture、不重跑」；这里的溢出是**要报告的现象**，不是**要修掉的缺陷**——把输入目标调松之后重跑，就变成按结果挑仪器了。

**下一步（需单独立项与授权，不在 NX-08h 范围内）**：把「输入目标 65,536 在没有 oracle 时是否过紧」作为一个独立问题立项；`blind` 上的正式对照批次（`armA`／`armB` 等价物）同样需要先按实测重预注册上限。

## NX-11 整理设计取舍（五节）

- 关联：路线图 M9 的最后一块（`docs/INTERNSHIP_ROADMAP.md:227`：「整理设计取舍：事件与投影分离、协议完整性、可靠编辑、验证时效和未知副作用恢复。**能从代码和测试解释选择**」）。状态：**done**（2026-10-01，零付费）。子步骤与提交边界见 [TASKS 的 NX-11 一节](TASKS.md#nx-11-整理设计取舍五节零付费)。
- **本次零代码改动**：`src/**` 一行未动（`git diff --stat 582a67a..HEAD -- src/` 为空）。新增的 `test/decisions-doc.test.ts` 只读 `docs/context-budget/DECISIONS.md` 与源文件，不导入任何 `src/` 模块。
- 提交：`747e8a8`（NX-11-0 立项）、`1f235c1`（NX-11-1 骨架与第 1 节）、`ebc8623`（NX-11-2 协议完整性）、`316c233`（NX-11-3 可靠编辑）、`12a7a88`（NX-11-4 验证时效）、`905e315`（NX-11-5 未知副作用恢复与总表）、`f19fb3e`（NX-11-6 锚点回归）、`b98bb83`（NX-11-7 三处入口）、本提交（NX-11-8 回填）。

### 动因（开工前核实）

| 缺口 | 依据 |
| --- | --- |
| 「能从代码和测试解释选择」在仓库里无法被任何人核对 | PLAN 的 D-01…D-11 与 NX-13/NX-15 决策节**写下了选择**，却通篇没有一条代码锚点或测试锚点 |
| 五条主题散落四处 | PLAN（D-02/D-03/D-06/D-08/D-09）、REQUIREMENTS（R-03/R-10/R-11/R-12/R-16/R-18）、README 的四个功能节；要拼五处才拼得出一条完整回答 |
| 「追问 → 选择 → 替代方案 → 锚点」没有接起来 | 路线图 §6 的七条「建议能回答的追问」正是这五条的换一种问法，但没有文档把它们接到可核对的位置上 |

**为什么新文档必须是非规范性的**：`AGENTS.md` 的文档入口写明 PLAN 是「当前源码基线、里程碑、技术取舍、默认参数和官方依据」的唯一维护位置。因此 `DECISIONS.md` 不复述数值、不重定义决策编号，决策本身一律指向 PLAN；三处入口（README／PLAN／AGENTS）都写明了这一句，不写就会让新文档被读成第二个决策源。

### 设计要点

**锚点必须可机读。** 每节末尾的锚点表固定三列（类型／锚点／它钉住什么），`test/decisions-doc.test.ts` 只解析以「类型列为 `代码` 或 `测试`」开头的表格行，完全不碰散文——正文里提到某个文件不会被当成锚点。判定规则：代码锚点的文件存在、行号不越界，且「它钉住什么」一列的**第一个反引号 token 落在该行上下 5 行内**；测试锚点的测试名逐字出现在所指文件里；五条主题各成一节（`###`），每节至少各有一行代码与一行测试锚点，且锚点行不能落在节外（`####` 子标题不切换节，二级标题会离开节）。失败时一次列出全部问题，而不是只报第一条。

**这条测试买不到什么，写进了文档与测试注释**：它只证明锚点还指着真实存在的东西，**不证明那个测试确实断言了文中的话**。上下 5 行的邻近检查是位置检查，不是语义证明；「这段代码做的正是这里写的事」仍然只能靠人读。

**替代方案要标来源。** 每条替代方案带 `【决策时记录】` 或 `【事后重构】`：前者能在 PLAN／REQUIREMENTS 的同一条目里查到同期出处，后者是为本文补的。全文 30 条替代方案里 21 条有同期出处、9 条属事后重构（第 1 节 1 条、第 2 节 2 条、第 3 节 2 条、第 4 节 2 条、第 5 节 2 条）。不标这一下，事后补的理由会被读成当初的决策依据。

### 五节内容

1. **事件与投影分离**：原始事件不可变、投影是派生视图、reset 追加而非删除。4 条代码锚点（`event-store.ts:52` 的 `append` 只推进新行、`session-runtime.ts:76` 的 `visibleEvents` 是切片、`:212` 的 `clear` 只追加、`context-runtime.ts:71` 只从 `selected` 里剔除）+ 3 条测试锚点。
2. **协议完整性**：配对不可能被裁剪切断，停止或取消时为每个在途调用补出三态结果。5 条代码锚点（`context-runtime.ts:6`/`:40`/`:75`、`agent-loop-runtime.ts:208`、`pending-tools.ts:2`）+ 3 条测试锚点。代价里照实写出一条容易忽略的后果：**受保护的组永不裁剪**，因此在途调用始终没被配对的旧任务会一直占着上下文位置——这是有意的取舍。
3. **可靠编辑**：「读—验—改—提交」四步乐观并发控制。6 条代码锚点 + 4 条测试锚点。代价里写明第 101–102 行核验到 `rename` 之间仍有外部进程竞态，是应用层乐观检测。
4. **验证时效**：证据绑定文件版本、之后的编辑使其过期、`acceptance` 恒为 `not_asserted`。7 条代码锚点 + 3 条测试锚点。
5. **未知副作用恢复**：结果未落盘记 `unknown`、恢复不重放、挡住自动续跑。5 条代码锚点 + 4 条测试锚点。代价里区分了两侧：**模型侧的尾部流片段会丢**（250ms/4KiB 合并、不逐 token sync，恢复补 `estimated` 用量与 `complete:false`），**工具侧不会**（`tool/start` 是语义事件，落盘并等待 sync 之后才执行命令）——不把它写成「整个会话都可能丢」。

全文共 5 节、27 行代码锚点、17 行测试锚点。结尾总表给出五条选择 → 规范出处 → 可跑的演示，并写明这一列的两点局限：三条演示用脚本化模型（退出码 0 不代表模型能力），且 `demo:fix` **只走顺利路径**，冲突／过期／`unknown` 那些分支的证据在锚点表列的测试里、不在演示里。第 1 节明确标「无对应演示」。

### NX-11-6 锚点回归的当场收获

写测试之前，人写的锚点里已有三处「说明列的首 token 落在锚点 5 行之外」：`file-edit.ts:91` 的说明写的是 `rename`（实际在第 104 行）、`bash.ts:49` 写的是 `verification/start`（该串只出现在 `task-verification.ts`）、`session-runtime.ts:48` 写的是 `tool/start`。三处都改成该行上真实出现的东西。这正是加这条回归的理由——这种漂移肉眼看不出来。

反例实跑（同一条用例，只改文档不动代码）：

```
改动                                             结果
`src/core/pending-tools.ts:2` → `:9999`          fail 1：代码锚点行号越界：…（该文件 20 行）
`src/core/pending-tools.ts:2` → `:19`            fail 1：锚点与说明对不上：… 附近 5 行内找不到 `pendingTools`
还原为 `:2`                                       pass 1 / fail 0
```

第二条尤其重要：`:19` 是**范围内**的合法行号，只有邻近检查才拦得住它——只验「文件存在、行号不越界」是不够的。

### 验证（全部零付费）

```
pnpm check            # syntax ok: 90 files（原 89，新增 decisions-doc.test.ts）
pnpm test             # tests 203 / pass 203 / fail 0 / skipped 0（原 202，新增 1 条）
pnpm fixtures:check   # 15 项 expected 全为真（本项不动 fixture）
pnpm eval:offline     # planned 12 / executed 12 / accepted 12（screeningIds 未动）
git diff --stat 582a67a..HEAD -- src/   # 空：本项一行都不改 src/
```

另核对：`DECISIONS.md` 里 13 个相对链接的文件与锚点目标逐个命中；`README.md` 零密钥块内 `pnpm` 命令数仍为 8（本次不新增命令）。

**已知边界，不写成已覆盖**：锚点回归只验存在性与邻近性，不验语义；即「那个测试确实断言了文中的话」这一步没有机器保证。文档里已把这条边界写在「怎么读」一节，本节重复一次是为了它不被读成「五个选择已被自动证明」。

## NX-10 固定代码修复演示（三幕）

- 关联：路线图 M9 的演示件（`docs/INTERNSHIP_ROADMAP.md:226`：「固定代码修复演示，展示项目规则→定位→修改→失败测试→再修复→diff 与证据；另展示预算停止/恢复和 unknown」）。状态：**done**（2026-10-01，零付费）。子步骤与提交边界见 [TASKS 的 NX-10 一节](TASKS.md#nx-10-固定代码修复演示三幕零付费)。
- **本次零代码改动**：`src/**` 一行未动。三条演示只向本地注册 `scripted/demo` 适配器，从不 import `src/index.ts`，因此不读 `.env`、不出网、不调用付费 API。
- 提交：`ce7dc6f`（NX-10-0 立项）、`92b64ef`（NX-10-1 fixture）、`333ab2c`（NX-10-2 三态基线）、`89405c8`（NX-10-3 第一幕）、`3439388`（NX-10-4 第二幕）、`82dc7bd`（NX-10-5 第三幕）、`1577b38`（NX-10-6 陈旧锁用例）、`a310a34`（NX-10-7 文档与计数）、本提交（NX-10-8 回填 + NX-21 立项）。

### 动因（开工前核实）

| 缺口 | 依据 |
| --- | --- |
| `scripts/` 下没有读者面向的入口 | 12 个脚本全是 eval／fixture／构建／部署设施 |
| **「项目规则」这一段在演示路径上根本不存在** | 规则源只有 `AGENTS.md`（`src/core/project-context-runtime.ts:122`），14 个 fixture 的 `initial/` 里一个都没有；`scripts/eval-fixture.ts:96-101` 的 `runFixtureTask` 不装载 `runtime-context` 与 `project-context` |
| 三块能力各自有测试，但没被串成叙事 | 预算停止／恢复见 `coding-fixtures.test.ts:295`，unknown 见 `store.test.ts:44`，diff 与证据只在 `task-*.test.ts` 与 CLI 测试里，`coding-fixtures.test.ts` 从不调用它们 |

**为什么不把两个 context 插件补进 `runFixtureTask`**：那会改掉 `eval:offline`／`eval:screening` 与对照 A 两臂的系统提示，让已记录的基线数字与预注册上限不再对应同一件事。演示自带一套装配（`scripts/demo-context.ts`），评测路径一字未动。

### NX-10-1 演示 fixture `repair` — done

15 个 fixture 里唯一带项目规则的：`initial/AGENTS.md`（根作用域：`percentOff` 是整数百分数、总额四舍五入到 2 位小数、`src/legacy/` 与 `src/pricing.mjs` 是历史遗留且不被导入、受保护文件清单）与 `initial/src/AGENTS.md`（`src` 作用域：单项 `discount` 是项行金额的比例、在求和前逐项应用、未声明按 0 处理）。模型必须先查 `src` 才拿得到第二条。

两处缺陷各被公开检查的一条断言钉住、互不遮蔽：`subtotal` 忽略 `item.discount`（断言 1 失败），`discount` 把整百分数当比例且不取整（断言 2、3 失败）。`check.mjs` 的三条断言各自带说明文本，失败输出直接点名违反的是哪条规则。`verify.mjs` 用与公开检查**不相交**的取值域（含空车、单项折扣为 0 与 1 的边界、以及一条公开检查没覆盖的取整用例），期望值全部选在二进制可精确表示或取整后精确的位置，避免浮点尾差把正确实现判成失败。

注册表新增 `demoIds` 并并入 `fixtureIds`；不进 `screeningIds`（那 12 个已冻结，且会让 `phaseCaps.screening.runs` 与 12/12 的历史基线不再对应），也不进 `sequenceIds`／`boundedIds`。`sources.repair` 只列 `src/cart.mjs`，因此两份 `AGENTS.md`、`check.mjs`、`package.json`、`src/legacy/` 与 `src/pricing.mjs` 全部进受保护集合。

验收：`pnpm fixtures:check` 输出 15 行、`expected` 全为真（`repair` 初始退出 1，参考解 `acceptance passed: repair`）。

### NX-10-2 中间态三态基线 — done

`partial/src/cart.mjs` 是「只修好第一条规则」的已知中间态。用例钉住：初始失败（退出 1，失败点名第一条规则）→ 只应用 `partial/` 仍失败（退出 1，失败**改点名第二条**，第一条的消息消失）→ 应用 `reference/` 通过；逐个改写两份 `AGENTS.md`、`check.mjs`、`src/legacy/cart.mjs` 后确认 `protectedFilesChanged` 恰为该项且验收因此不通过。`readFixtureFile` 只服务 fixture 目录内部，越界读取直接报错。

验收：`pnpm test` 201/201（原 200，新增 1 条）。

### NX-10-3 第一幕 `pnpm demo:fix` — done

九步全部经真实工具：`project_context{src}` → `grep` → `read_file` → `edit_file`（只修第一条规则）→ `bash node check.mjs`（**失败，退出码 1，stderr 点名未修的那条规则**）→ `edit_file`（补齐）→ `bash` 带 `verification.files`（退出 0 并落成验证记录）→ `task_changes` → `task_report`。每一步的结果按模型当时看到的原文打印，超长才截断且写出截断标记；交付报告因为绝大部分是逐次 usage 明细而按自己的字段重排，不改任何数值。

装配打印系统提示的四个条目与顺序（`agent:identity` 10 / `sandbox:policy` 15 / `runtime:environment` 100 / `project:context` 110）。判定三条：run `completed`、`task_changes` 有非空确认 diff、工作区之外独立验收通过且未改受保护文件。同时写明 `task_report` 的 `acceptance` 恒为 `not_asserted`，并指出**第 5 步那次失败的 bash 没有声明 `verification.files`，所以不进检查记录**——普通命令不构成检查。

运行证据落在 `.demo-runs/`，与 `.eval-evidence/`（真实模型证据）分开，两者都不入库。

### NX-10-4 第二幕 `pnpm demo:resume` — done

首段预算 `maxModelRequests: 4`：第 4 次请求本身发得出去，但它带回的那条编辑在**派发之前**被拦下，所以前三条命令真的执行了、第四条一次都没跑（无 `tool/start`）。随后 `agent.continue()` 在同一 task 上开新的一段 run 把它补做。拦它的不是固定轮数上限，而是可配置的请求预算。

七条判定：首段确实因 `max_steps` 停止；被跳过的编辑在首段没有 `tool/start`；它在恢复后真的执行了一次；`continuations=1`；没有工具被执行两次；两段 run 的前后关系被记录；最终 run `completed` 且独立验收通过。

**两处只有真跑才会暴露的坑**（第一次跑时都踩到了，都已修并留在注释里）：① 适配器必须按「哪几步真的被回答了」推进，而不是按请求次数推进——按次数推进时那条被跳过的编辑会被当成已消费，恢复后凭空消失，工作区永远停在中间态（独立验收报 `-192 !== 6`）；② 判断「已回答」要取**最后一条**同名工具结果——取第一条命中的是停止那一段留下的 `skipped`，于是同一条命令被无休止重发，8 次请求预算全部烧光仍是旧结论。

### NX-10-5 第三幕 `pnpm demo:unknown` — done

崩溃是真的：子进程执行 `echo started > .demo-side-effect; sleep 300`，父进程轮询到副作用文件出现后按进程树杀掉它（win32 `taskkill /PID <pid> /T /F`，POSIX `process.kill(-pid,'SIGKILL')`）。父进程等的是**副作用文件**而不是 `tool/start`——后者在 bash 启动之前就已落盘，只有前者能证明命令真的在执行中，杀戮因此不会与「命令已跑完」抢时间。留在磁盘上的残局：日志停在 `tool/start`，目录里一把没人释放的 `writer.lock`。

**这一步暴露了一个目前没有对应入口的操作**：`JsonlStore.open` 对任何已存在的锁一律拒绝（`src/core/event-store.ts:40`，「session writer lock exists; verify stale locks explicitly」），而 `quarantineTail` 也要先抢同一把锁（`:17-20`），所以恢复的唯一路径是由人确认 pid 已死、再显式删掉那把锁；`src/plugins/cli.ts:36-40` 的启动恢复撞上崩溃过的会话直接抛错，也没有 `/recover`。演示照实做这一步并说明它属于操作者的判断，据此立项 **NX-21**，本次不修。

六条判定：重开先被陈旧锁拒绝；副作用文件仍在；恰好一条 `unknown` 结果且正是那次 bash；被中断的 run 封为 `error`；补出的记录落盘（日志行数 9 → 11）；自动续跑被拒（`unknown tool outcome; verify side effects before starting a new task; automatic continuation is blocked`）。平台相关的杀进程那半不写进 `pnpm test`。

### NX-10-6 陈旧会话锁的显式恢复路径用例 — done

残局构造与演示一致（日志停在 `tool/start`，目录里放着崩溃时形状的 `writer.lock`），钉住：`open` 拒绝；`quarantineTail` 也因同一把锁报 `EEXIST`——销锁是唯一路径而不是可选优化；销锁后重开成功；`restore` 补出恰好一条 `unknown` 而非 `skipped`（这条调用有过 `tool/start`）；被中断的 run 封为 `error`；补出的记录真的追加到日志上；副作用文件未被触碰；`beginRun(..., true)` 同步抛出 `unknown tool outcome`（挡住续跑的判定发生在派发任何请求之前）。

验收：`pnpm test` 202/202（原 201，新增 1 条）。

### NX-10-7 演示一节与计数订正 — done

README 新增「演示」一节（放在「运行」之后）：三条命令各展示什么、退出码的含义、fixture `repair` 的用法、`.demo-runs/` 与 `.eval-evidence/` 的分工，以及 `demo:unknown` 暴露的那个没有入口的步骤。三处计数按实跑订正：89 文件（原 84）、202 条测试（原 200）、15 项 fixture（原 14）；零密钥块由五条命令扩到八条，新增三条的行尾注释就是各自的退出码含义。**带日期的历史证据逐字未动**（README 的 SHA 锚定行、`PROGRESS.md` 里 NX-08f 那条的「14 项／198/198」、NX-09 各行、CHANGES 各处）。

### 验证（全部零付费）

```
pnpm check            # syntax ok: 89 files（原 84，新增 5 个演示脚本）
pnpm test             # tests 202 / pass 202 / fail 0 / skipped 0（原 200，新增 2 条）
pnpm fixtures:check   # 15 项 expected 全为真（原 14，新增 repair）
pnpm eval:offline     # planned 12 / executed 12 / accepted 12（screeningIds 未动）
pnpm demo:fix         # 退出码 0；连跑两次均 0
pnpm demo:resume      # 退出码 0；连跑两次均 0
pnpm demo:unknown     # 退出码 0；连跑三次均 0（脚本自清理 .demo-runs）
```

**已知边界，不写成已覆盖**：POSIX 的 `process.kill(-pid)` 分支在本机（Windows）无法实跑，只能标注为未验证；第三幕的杀进程在 CI 上不跑，只跑它之后的确定性断言（NX-10-6）。

## NX-09 README 定位、原创增量、架构图与零密钥运行入口

- 关联：路线图 M9 的入口件，解锁条件是路线图 §6 的「完成 M7 后，再用真实实验数字补充」——M7 出口（NX-08 的两次对照与 [NX-08-REPORT](NX-08-REPORT.md)）已满足。状态：**done**（2026-10-01，零付费）。子步骤与提交边界见 [TASKS 的 NX-09 一节](TASKS.md#nx-09-readme-定位原创增量架构图与零密钥运行入口)。
- **本次零代码改动**：`src/**` 一行未动，全部是文档。

### 动因（开工前实测，不是估读）

| 问题 | 位置 | 实测 |
| --- | --- | --- |
| 测试数陈旧 | README「验证」节 | 写「当前 190 条测试」，`pnpm test` 实测 200/200 |
| 工具清单陈旧 | README「结构」节 | 写「Bash、五个文件工具和 task_changes」共 7 个，实际 `src/tools/` 注册 9 个（漏 NX-06 的 `request_trace`、`task_report`） |
| 基线数字陈旧 | PROGRESS「主分支基线」条 | 写 195/195 测试、13 项 fixture，实测 200/200、14 项 |
| 表述过时 | README 开篇 | 「结构化验证记录仍是后续规划」——该能力已由 NX-15 交付，且本文 NX-15 一节已在描述它 |
| 读者向内容缺失 | 全篇 | 无定位/范围/非目标、无教程基线与独立扩展分界、无架构图、无零密钥上手路径、无实验报告入口 |

路线图 §6 明确要求「应明确教程基线与独立扩展的边界」；M9 出口要求「陌生读者能按说明运行并检查最终文件/测试；项目介绍清楚区分教程基线、独立扩展、真实模型结果与模拟回归」。

### NX-09-0 立项 — done

把 TASKS 里的 NX-09 待办提升为七行子步骤表（格式对齐 NX-08 的表）。`AGENTS.md` 要求「**开发前**须在 TASKS 中列出子步骤、各自验收和预计提交边界」，因此本步先于 README 的任何改动落地。同时把「下一步主线」从 NX-08 改为 NX-09。

验收：`grep -c '^| NX-09-' docs/context-budget/TASKS.md` = 7；`git diff --stat` 只含 `docs/context-budget/TASKS.md`。提交 `f315ab9`。

### NX-09-1 README 开篇：定位与范围/非目标 — done

补三段：是什么、范围（单 Agent／单本地工作区／CLI；核心依赖服务契约）、**明确不做**五项（多 Agent 调度与托管平台、向量记忆与长期记忆、操作系统级隔离、费用硬上限、任意执行位置的精确恢复）。每项都能在 `PLAN.md` 的 D-01 或路线图 §4.7 找到依据。

措辞上刻意**不照抄**路线图 §6 的禁语列表，避免把「生产级」「严格成本上限」「任意断点恢复」「任务成功率显著提高」这些词写进 README。MCP 写成「只按可选外部插件接入」（README 已记录可选 Context7 MCP），**不写成「不支持 MCP」**——那会与本节自相矛盾。

同时删掉「结构化验证记录仍是后续规划」。该句就在本步重写的段落里，若挪到 NX-09-3 会造成两个提交改同一句、互不可单独 revert。

验收：`grep -c '结构化验证记录仍是后续规划' README.md` = 0；`grep -c '不支持 MCP' README.md` = 0。提交 `74d7995`。

### NX-09-2 教程基线与独立扩展分界 — done

新增「基线与本项目的分界」一节，分界点为提交 `c5fc9c4`：它及之前是教程主线，`43e3829`（M0 文档基线）起是本项目自己的开发。按提交范围／语言／工具／测试／已有能力五行对照。

八条 git 命令逐条实跑核对：

```
git rev-list --count c5fc9c4                              # 11：教程主线提交数（含端点）
git ls-tree -r --name-only c5fc9c4 | grep -c '\.ts$'      # 0：基线没有 TypeScript
git ls-tree -r --name-only c5fc9c4 src/ | wc -l           # 22：基线源文件数
git show c5fc9c4:src/tools/files.js | grep -o "name: '[a-z_]*'"   # 5 个文件工具
git show c5fc9c4:src/tools/bash.js  | grep -o "name: '[a-z_]*'"   # bash
git show c5fc9c4:test/core.test.js        | grep -c '^test('      # 20
git show c5fc9c4:test/integration.test.js | grep -c '^test('      # 2
git log --oneline --reverse | sed -n '12p'                # 43e3829：分界之后的第一个提交
```

另注明本仓库**不存在**「教程第 N 天 ↔ 某个 CB 编号」的映射——仓库里没有这个数据，只有一句对教程本身的引用。

验收：八条命令输出与 README 记的值逐个一致；`grep -cE '第 ?[0-9]+ ?天.*CB-|CB-[0-9]+.*第 ?[0-9]+ ?天' README.md` = 0。提交 `fc1788f`。

### NX-09-3 陈旧数字与过时表述订正 — done

改三处（README 测试数 190 → 200、README 的 `tools/` 清单 7 → 9、PROGRESS 主分支基线 195/13 → 200/14）。

**fixture 计数不做整体替换**：README 里「NX-05b 扩展到 12 项」与 `eval:offline`／`eval:screening` 两处的「12 个 fixture」**都是对的**——筛查批次确实冻结在 12 个。改法是在前者后面补一句「当前注册表共 14 项 = 筛查 12 项 + `pipeline` + `audit`」。盲目 12→14 会把后两处改错。

**历史证据逐字不动**：README 的 SHA 锚定历史（`147/147`、`check72/test123`、`53e5aba`）与 PROGRESS 中带日期的历史条（`198/198` 等）。依据是 `PROGRESS.md` 自己的更新规则——只改当前状态，不改历史证据。

验收：`grep -nE '当前 [0-9]+ 条测试' README.md` 只有一处且为 200；`grep -c '190' README.md` = 0；`grep -ho "name: '[a-z_]*'" src/tools/*.ts | sort -u | wc -l` = 9，加插件提供的 2 个共 11，与 README 一致；`147/147` 与 `198/198` 的计数改动前后相同。提交 `72e263a`。

### NX-09-4 Mermaid 架构图 — done

在「结构」节加一张 `flowchart LR`，只表达三件事：请求路径（CLI → `agent.send` → Agent Loop → 投影／预算／模型适配器／工具注册表）；**事件日志是唯一事实来源，请求投影是由它派生的视图**（虚线），因此裁剪只作用于投影、不删原始事件；**工具在两处注册**——`tools/` 9 个与插件 2 个，分列以免与同节的工具清单冲突。

原来那句「请求经过 CLI → agent.send → Agent Loop → Session Event Log → LLM」与图重复，改为只留图不表达的两点（Loop 通过服务契约工作；每个已记录的 tool_call 都保证有配对结果）。

验收：mermaid 围栏恰好 1 个；`grep -c '^```' README.md` = 8（偶数，围栏配对）；图内工具名集合与 `grep -ho "name: '[a-z_]*'" src/tools/*.ts src/plugins/*.ts | sort -u` 的 11 个逐个一致。**不安装新依赖做渲染校验**（与本仓库不引入新依赖一致），渲染由 GitHub 承担，语法保持最基础的 `flowchart` 子集。提交 `fcd2b14`。

### NX-09-5 零密钥上手路径 — done

原「运行」节第一段就是 `Copy-Item .env.example .env` + `pnpm start`，读者要看得见任何东西都必须先申请密钥。拆成两小节：「零密钥跑通」与「接真实模型」。

「零密钥跑通」的五条命令，行尾注释是实测输出：

```
pnpm install --frozen-lockfile
pnpm check            # syntax ok: 84 files
pnpm test             # tests 200 / pass 200 / fail 0 / skipped 0
pnpm fixtures:check   # 14 项：初始全部失败、参考解全部通过
pnpm eval:offline     # planned 12 / executed 12 / accepted 12
```

`pnpm eval:offline` 自己会打印 `note: 模拟模型驱动，用于验证运行器与整批上限；通过率不作为模型能力证据`，README 引用这行而不是另做断言。五条命令在本机逐条实跑，退出码均为 0。

**不写「5 分钟内跑完」**这类无命令可验的墙钟承诺——任务名里的「5 分钟」指的是零密钥与可复现。验收：`grep -nE '[0-9]+ ?分钟内|分钟跑完' README.md` 输出为空；零密钥小节内不出现 `pnpm start`。提交 `8f08de9`。

### NX-09-6 真实模型实验一节与回填 — done

新增「真实模型实验」一节，链 `NX-08-REPORT.md`，按 M9 出口分列四类（教程基线／独立扩展在 NX-09-1、2 两节，真实模型结果在本节，模拟回归在「验证」节与本节末段）。摘要三批实验的规模与结果，并写明三条边界：链路可用但能力结论不写（两处通过率测量方差为零）、对照 A 的处理确实生效但它省下的是上下文规模、**对照 B 的仪器没有成立且这不等于处理无效**。「结局饱和」与「样本量小」作为**两条独立限制**分列。

**硬红线（grep 可判）**：该节内 `grep -nE '提升|提高|优于|更好|最好|显著|效率|收益|成功率|%'` 输出为空。这条**故意严格**——连「token 少 45.4%（非效率提升）」这种带免责的写法也不写，直接链报告、不复述数字；因此节内也不出现任何百分号，对照 B 的两个峰值改写成「都不到输入目标的一半」。**不声称 CI 通过**——本次没有对应的 CI run，只写本地实测（仓库惯例是任何 CI 结论都附 run 链接）。

回填：TASKS 的七行子步骤全部置 done、`## 已完成` 增 NX-09 条并记 7 个提交号；PROGRESS 的「下一步」改写；另立项 **NX-20**（路线图状态段整体陈旧，见下）。

### 顺带立项：NX-20 路线图状态段整体陈旧

`docs/INTERNSHIP_ROADMAP.md` 是**带日期的记录**，line 3 已把源码基线评估定为「历史证据保留」。已核实陈旧点至少四处：顶部注记与 line 215 的「真实模型实验额度尚未在本次任务中设定或使用」（已被 NX-08 的约 $4.96 推翻）、line 194 的 M5 出口「旧 57 条回归」（现为 200 条）、line 213/215 的 M7 出口、line 233-239 §6 的「当前可以写…完成 57 条回归及 Windows/Linux × Node 22/24 CI」（且「Linux」与 README 实际使用的「Ubuntu/Windows」不一致）。

**NX-09 不改它**：只改 §6 会让全文自相矛盾，且违反该文件自己的修订注记惯例。按 NX-17 的先例（改前发现的相邻缺陷另立待办，不塞进当前提交）立项 NX-20，须整体处理。

### 验证（全部零付费）

```
pnpm check            # syntax ok: 84 files
pnpm test             # tests 200 / pass 200 / fail 0 / skipped 0
pnpm fixtures:check   # 14 项，初始 0/14、参考 14/14
pnpm eval:offline     # planned 12 / executed 12 / accepted 12
```

外加各步的 grep 判据（见上）。五条命令均不读 `.env`、不出网、不调用付费模型。

## NX-08f 对照 B：现有裁剪 vs 裁剪加有界工具输出


- 关联：NX-08 的第二条对照，也是 `armA`/`armB` 明确归属对照 A 之后空出来的那一支。状态：**in_progress**。整批上限与阶段尚未预注册（见 PLAN 的「对照 B 因此不再有对应的阶段与上限」），本节按子步骤累积证据。

### 与对照 A 的两处结构差别

- **不受会话组成前置限制**。对照 A 要产生差异，会话里必须存在**已结束且可裁剪的旧任务**（`context-runtime.ts:29,68-74` 只移除 `!protected && complete` 的组），所以它必须用多阶段序列。有界工具输出改变的是**当前 task 内部**的历史规模，而当前 task 恒 `protected`、无法被裁剪——单任务会话下无界臂就会 `context_overflow`、有界臂完成，两臂可直接分辨。
- **判别量是 `context_overflow` 这个结构性事实，不是 `accepted`**。因此 NX-08g0 判定的「任务集天花板效应」不会让对照 B 失效：它不需要两臂在通过率上分出高低。

### 自变量：为什么是「同一插件的不同配置」而不是「装 / 不装」

`src/plugins/tool-results.ts` 在 `apply()` 里**无条件**注册 `read_tool_result`（`:45-53`），而 `tools.schemas()` 每次请求都把工具表交给模型，`token-estimator.ts:10` 又把它计入输入估算。因此「装 / 不装」会让两臂的 `tools` 数组相差一整个条目——既改变模型看到的能力，也改变估算，被比较的就不只是有界性，违反 R-21 的「两臂共用同一 prompt 与工具」。

改用 `maxPreviewBytes`：两臂都装载同一个插件，有界走生产默认（`positiveLimit` 的 16 KiB 预览），无界抬到 64 MiB（`UNBOUNDED_PREVIEW_BYTES`，bash 单流采集上限 8 MiB 经 JSON 转义后最坏约翻倍，仍装得下）。两者的工具与 schema 逐字相同，唯一差别是结果是否被投影截断。**生产代码零改动**——`maxPreviewBytes` 是现成配置项。

### NX-08f-1 工具输出开关与两臂装配 — done（2026-10-01，零付费）

- **改动**：`scripts/eval-fixture.ts` 新增 `ToolOutputMode`（`{ bounded: boolean }`）与 `UNBOUNDED_PREVIEW_BYTES`，`runFixtureTask` 追加**第 5 个可选位置参数** `toolOutput`。不传时不装载插件，既有阶段（screening / armA / armB / sequence）与全部离线用例的行为一字不变。
- **验收**：`test/eval-runner.test.ts` 新增用例用同一个 fixture（`boundary`）、同一段 300 KB bash 输出、同一预算，只切 `bounded` 一个参数，并**从会话事件里读回结果形态**（`runFixtureTask` 只在给出 `sessionDirectory` 时落盘）：
  - `bounded: true` → 恰一个 `tool/result`，`stdout.previewTruncated === true`、带 `ref`、`stdout.text` 恰 8,192 字节（= `maxPreviewBytes`/2）且**不含**末尾哨兵；
  - `bounded: false` → `stdout.text` 以末尾哨兵结尾、>200,000 字节、**无** `previewTruncated`。
- **一处易错点（已写进用例）**：`tool/result` 的内容是 `CommandResult` 的 JSON，**命令原文也在里面**，末尾哨兵因此在 `command` 字段出现一次。判断「结果有没有被截断」必须看 `stdout.text` 而不是整段 JSON——第一版断言整段 JSON 时被这条绊住。
- **回归**：`pnpm check` 84 文件语法通过；`pnpm test` **196/196**（原 195，新增 1 条）。未调用付费模型。

### NX-08f-2 单任务 fixture `audit` — done（2026-10-01，零付费）

- **为什么必须新建**：现有 12 个单任务 fixture 没有一个能自然越过输入目标。实测最大的是三份 66.7 KiB / 350 行的 `diagnostics/trace.log`（`pagination` / `query` / `csv`），但它们的任务只要求 grep 定位、不要求遍历，读遍整个工作区也只有约 20.2k token。`pipeline` 单阶段更小（约 6.7k），越线靠的是跨阶段累积——那是对照 A 的路径。
- **形态**：单任务。数据集 `data/records.jsonl` 是「原始字段 + 数据集给出的期望规范值」的金标数据；`src/normalize.mjs` 把原始字段规整后必须逐条等于 `expected`；`src/audit.mjs` 的 `auditRecords` 报出不一致项；受保护的 `report.mjs` 把每一条不一致连同**原始值、规整结果、期望值与该字段的规范形式**一起打印出来。
- **为什么模型会真的跑报告**：公开的 `check.mjs` 只有一条断言，失败输出是一行 `AssertionError`（实测 `1863 !== 0`），指不出是哪条记录、哪个字段；`TASK.md` 指向 `report.mjs`。用例里把这条性质钉死了——断言公开检查的输出**不含** `field=`，否则模型可以直接读 `check.mjs` 反推规则、报告就不会被跑，「无界」那一臂也就不会产生大输出。
- **规模（实测）**：数据集 1600 条、297,726 字节；完整报告 **909,266 字节 ≈ 276,994 估算 token**，是输入目标 65,536 的 **4.23 倍**。用例用项目自己的估算器量而不是字节数——CJK 与 ASCII 的 token 单价不同，字节数会给出错误的余量。违规 1863 条，三条轴各有：`KIND name 534`、`KIND email 458`、`KIND amount 871`（用例逐条断言三轴都非零，防止改生成器时塌成单轴）。
- **（2026-10-01 订正，NX-08f-4c）**：上面的 **909,266 字节 / 276,994 token / 4.23 倍**是本步交付时的读数。f-4b 发现报告源码里的散文规则是一处泄露后，f-4c 把它去掉，报告随之缩到 **745,243 字节 / 223,573 token / 3.41 倍**。数据集的 1600 条 / 297,726 字节与三条轴的违规计数（534 / 458 / 871）**不受影响**。原文保留以便对照。
- **三条缺陷轴，每条一个真实缺陷、分布在两个文件里**：
  1. `normalizeName` 只 `trim`，不折叠内部连续空白（约 1/3 的记录带缺陷）；
  2. `normalizeEmail` 只 `trim`，不小写化（约 2/7）；
  3. `normalizeAmount` 用 `String(Number(value))`，吃掉规范形式末尾的 0（约 1/2，只有金额本身以 0 结尾的记录才违规，因此是子集轴而不是恒违规）；
  4. 另有 `audit.mjs` 的复制粘贴缺陷——email 字段用的是 `normalizeName`，因此**即使把 `normalizeEmail` 修对，email 违规也不会消失**。只改一个文件解决不了，这是「跨文件修改」的落点。`normalizeEmail` 被 import 却未被使用，模型读源码时能看到这条线索。
- **数据集可复现**：`generate.mjs` 用确定性 LCG 而不用 `Math.random`，记录数、取值池、缺陷比例与种子都在那个文件里，重跑同一条命令得到逐字节相同的 `records.jsonl`。这比现有 `trace.log` 那种无生成器的二进制式产物更可核对。
- **独立验收的两个方向**（`verify.mjs`）：规范记录必须一条都不报（第 x1 条三个字段各需要一条不同规则，因此同时钉住三条规则与「email 用的是 email 的规整器」）；反过来，结构上不规范的记录必须报到**正确的字段**上。缺了反向那一半，「让 `auditRecords` 恒返回空数组」就能通过。取值域与工作区数据集有意错开（`quinn` / `frost` / `vertex.example`），防止针对 shipped 数据特判。
- **公开检查也堵了同一个洞**：`check.mjs` 在断言之外多一条反向断言 `auditRecords([{ id: 'probe' }]).length >= 1`。它只用 `TASK.md` 已经写死的「三个字段缺一不可」，不泄露 name / email / amount 各自的规范形式。
- **回归**：`pnpm fixtures:check` **14 项**全部「初始失败、参考通过」（`audit` 初始退出 1、参考 `acceptance passed: audit`）；`pnpm test` **198/198**（原 196，新增 2 条：仪器规模与三轴、数据集与报告生成器受保护）；`pnpm eval:offline` 仍 **12/12**（`screeningIds` 未动）；`pnpm check` 84 文件语法通过。未调用付费模型。

### NX-08f-3 离线机制证明 — done（2026-10-01，零付费）

- **要证明的东西**：只切「工具输出是否有界」这一个参数，同一台 `audit` 仪器、同一份预算、同一段工具序列，两臂的结局是否真的分叉。这一步**不依赖真实模型**——脚本适配器给出固定序列（跑公开检查 → 跑报告 → 读两个源文件 → 改两个源文件 → 复跑检查），因此测到的是 Harness 的机制。真实模型是否会真的产生那份报告，是 f-4b 的付费烟测要回答的，本步结论不得外推。
- **同一装置的两处落点**：`test/eval-runner.test.ts` 的用例钉行为（断言两个结局与峰值区间），`docs/context-budget/nx08f-output-probe.mjs` 把数值打出来供人核对与回填。改一处要同时改另一处，两边的口径写在各自文件头。
- **实测（单次 run 预算 16 请求 / 2,000,000 token，输入目标 65,536）**：

  | 臂 | 状态 | 验收 | 请求 | 工具 | 峰值估算输入 | 投影次数 | 未发出投影 |
  | --- | --- | --- | --- | --- | --- | --- | --- |
  | 有界 | `completed` | `true` | 8 | 7 | **8,703** | 8 | 0 |
  | 无界 | `context_overflow` | `false` | 2 | 2 | **343,813** | 3 | 1 |

- **两臂的差别确实只在结果有没有被截断**：工具序列逐条相同、预算相同、初始工作区相同，且**两臂都只用了 2 次工具调用时就已经分叉**（无界臂停在报告之后、下一阶段也跑不起来）。峰值估算输入相差 **39.5 倍**，而这一列正是处理本身设定的量。
- **溢出不是裁剪失效造成的**：单任务会话里当前 task 恒 `protected`，用例断言两臂的 `removedTaskIds` 都是空数组。这是对照 B 与对照 A 的结构差别——对照 A 必须先构造出可裁剪的旧任务才可能分叉，对照 B 不需要。
- **「已准备但未发出」有据可查**：无界臂的 `unsentProjections === 1`。`requestId` 在投影之前生成（`agent-loop-runtime.ts`），所以那条越过输入目标、随后抛 `BudgetStop('context_overflow')` 的投影在日志里仍可辨认，有界臂则为 0。
- **回归**：`pnpm test` **199/199**（原 198，新增 1 条）；`pnpm check` 84 文件语法通过。未调用付费模型。

### NX-08f-4 接好诊断阶段 `smoke` — done（2026-10-01，零付费）

- **目的**：让付费烟测能被既有的 `--phase` / `--plan-only` 机制调度。这一步必须早于 f-4b，否则「跑什么、上限多少、差在哪」在花钱之前无从核对。
- **新增诊断阶段 `smoke`**，跑 `boundedIds`（即 `audit`），1 次运行。上限取**单次 run 预算的理论上界**（32 请求 / 2,000,000 token），与 `sequence` 同口径：该阶段的计划里只有 1 个 fixture，整批上限本来就不构成中途制动，取更紧的值只会把一次跑完的烟测变成带 `aborted` 的退出码 1。**它不进 `batchPhases`/`batchCaps`**——对照 B 正式的两臂（`armC`/`armD`）与它们的上限留到 f-5 按实测预注册，`batchCaps` 仍是 `{18, 3_200, 88_000_000}`。
- **新增 `toolOutputPolicy(phase)`**：`smoke` 返回 `{ bounded: false }`（无界），其余阶段返回 `undefined`（不装载插件）。烟测取无界是刻意的——它要回答的正是「模型会不会真的产生大输出」，那是有界臂永远问不出来的问题。
- **一处重构**：`ToolOutputMode` 从 `eval-fixture.ts` 移到 `eval-runner.ts`。阶段 → 模式的映射是策略，策略模块（`eval-runner` 的 `armPolicy` 旁边）才是它的落点，驱动只负责按模式装配。`import` 是类型级的，两文件不构成运行期循环。
- **预演必须看得见差异**：`--plan-only` 分支新增一行打印工具输出模式。对照 A 的臂间差异（`inputTargetTokens`）已经在预演里，对照 B 的差异不打印就等于预演失效。只打语义不打数值——具体预览上限属于驱动侧实现细节，写死在入口会多出第二处需要同步的常量。
- **验收（实测命令输出）**：
  - `pnpm eval:screening --phase smoke --plan-only` → `smoke-full: 1 个任务 × 1 次重复 = 1 次运行：audit`、`工具输出：无界（结果原样进入历史，不截断）`、证据目录 `.eval-evidence/smoke-full`；**未建立目录、未发出请求、不需要密钥**。
  - `pnpm eval:screening --plan-only` 与 `pnpm eval:sequence --plan-only` 仍打印 `不装载 tool-results 插件（既有阶段的行为）`——既有阶段行为一字不变。
  - `test/eval-runner.test.ts` 新增用例钉住 `toolOutputPolicy`（只有 `smoke` 非空）；`phaseCaps` 与 `batchCaps` 的逐值断言同步；`test/eval-cli.test.ts` 的 phases 循环与「unknown phase」错误串加入 `smoke`（错误串顺序敏感）。
- **回归**：`pnpm test` **200/200**（原 199，新增 1 条）；`pnpm check` 84 文件语法通过。未调用付费模型。

### NX-08f-4b 真实模型烟测 — done（2026-10-01，付费约 $0.02）— **结果：未观测到处理生效**

- **命令与规模**：`pnpm eval:screening --phase smoke`，1 次运行，`deepseek/deepseek-v4-flash`（服务端回显 `deepseek-flash`），无界工具输出。证据在 `.eval-evidence/smoke-full/`（不入库）。
- **结果**：`completed`、`accepted=true`、**7 请求 / 12 工具 / 138,931 token**（输入 134,678、输出 4,253）、主动 21.9 秒、审批 0；7 条 usage **全部来自 provider**、估算回退 0 次。逐阶段峰值估算输入 **33,507**，是输入目标 65,536 的 **51%**——**没有越过，`unsentProjections` 为 0，一次裁剪都没有**。
- **模型实际做的 12 次调用**（从 `assistant/tool_calls` 逐条读出）：

  | # | 调用 | 结果字节 |
  | --- | --- | --- |
  | 1 | `bash 'find . -type f … \| head -50 && echo "---" && ls -la'` | 1,004 |
  | 2–4 | `read_file` `check.mjs` / `src/normalize.mjs` / `src/audit.mjs` | 938 / 554 / 1,021 |
  | 5 | **`read_file report.mjs`** | 1,620 |
  | 6 | `read_file data/records.jsonl` | **32,832**（撞上 tool 的 32 KiB 上限） |
  | 7 | `read_file package.json` | 145 |
  | 8 | `read_file data/records.jsonl startLine=173` | **32,770** |
  | 9–10 | `write_file src/normalize.mjs` / `edit_file src/audit.mjs` | 951 / 383 |
  | 11 | `bash 'node check.mjs'`（带 verification） | 470 |
  | 12 | **`bash 'node report.mjs \| tail -5'` + 自写探针** | 1,888 |

- **两处泄露，都是本 fixture 自己造的**，模型因此**从未在破损状态下跑过 `report.mjs`**：
  1. **`report.mjs` 的源码里有 `RULES` 映射**（1,404 字节的文件，把三条规范形式写成了可读文本）。我当初把规则放进生成器源码，是为了让报告「自解释」；代价是**读源码 = 读报告的全部信息量**，而源码只有 1.4 KB。模型的总结里直接写着「Canonical rule **(from `report.mjs`)**」。
  2. **数据集每行自带 `expected`，`TASK.md` 又明说「带一份期望的规范值」**。模型只读了 2 块（32,832 + 32,770 = 65.6 KB，占数据集 297.7 KB 的 **22%**）就覆盖了三条规则——因为无论怎么抽样，raw/expected 对照都在前两块里。
- **它确实在收窄**：唯一一次跑 `report.mjs` 是在**修好之后**，而且写的是 `node report.mjs | tail -5`——那时输出已经只剩 `SUMMARY 0`。整批**没有任何一条 bash 结果超过 2 KB**，最大的两条是 `read_file` 撞上 32 KiB 上限的那两块。
- **可以写什么、不可以写什么**：本批次**未观测到处理生效**——真实模型没有产生大输出，对照 B 在这个 fixture 上**没有分辨力**。**不得**外推成「有界工具输出无影响」，也不得用 n=1 断言「模型总是收窄」；能说的只有这一条轨迹上模型的行为。这是 PLAN 风险表第 ① 行的情形，处置按 NX-08e2 的教训：如实记录，不修改已跑的预注册数字。
- **成本**：约 **$0.02**（139k token，按价格页 off-peak 口径、无缓存命中；算法与 NX-08g 报告一致）。这是 NX-08f 目前为止唯一的付费项。

### NX-08f-4c 修掉仪器的第一处泄露 — done（2026-10-01，零付费）

- **改的是什么**：f-4b 的烟测显示模型**读了 `report.mjs` 的源码就拿到了全部规则**（1,404 字节的文件里有一个 `RULES` 映射，把三条规范形式写成了可读的中文句子），于是它从没在破损状态下跑过报告。这一步把那个映射去掉：报告只逐条打印「原始记录 / 当前的规整结果 / 规范值」三元组，**规范形式只能从这三者的对照里自己读出来**，`report.mjs` 源码里不再有任何一句规则文本。
- **同时改掉的是任务说明**：`TASK.md` 原文写着「数据集的每条记录都带一份期望的规范值」——等于直接把「抽样数据就能得到规则」这条捷径指给模型看。现在只说 `report.mjs` 逐条打印不一致项。
- **只改这一个变量**。PLAN 的 D-11 要求「先固定基线，再每次只调整一个因素」，因此这一步**不动数据集的 `expected` 字段、不动违规比例、不动工具序列**——第二处泄露（数据行自带期望值，抽样即可反推规则）仍然存在，它是否足以独立让仪器失效，由重跑回答。把两处一起改会分不清是哪一处起了作用。
- **规模变化**：报告由 909,266 字节 / 276,994 token / 4.23 倍缩到 **745,243 字节 / 223,573 token / 3.41 倍**（去掉的是每个违规块里那行散文规则）。数据集与三条轴的违规计数一字未变。
- **用例同步**：`test/coding-fixtures.test.ts` 的余量断言由「> 4 倍」改为「> 3 倍」并写明理由——余量要买的是「一条不截断的结果就足以把当前 task 顶过输入目标」，不是尽量大。
- **回归**：`pnpm test` **200/200**；`pnpm fixtures:check` 14 项仍「初始失败、参考通过」；`pnpm check` 84 文件语法通过。未调用付费模型。

### NX-08f-4c 重跑烟测 — done（2026-10-01，付费约 $0.03）— **结果：仍未观测到处理生效**

- **命令**：`MINI_DSH_EVAL_EVIDENCE_DIR=.eval-evidence/smoke2-full pnpm eval:screening --phase smoke`（换目录是为了保留第一次的证据，`ensureWritable` 本就拒绝覆写同一目录）。1 次运行，`deepseek/deepseek-v4-flash`，无界工具输出。
- **结果**：`completed`、`accepted=true`、**13 请求 / 23 工具 / 165,626 token**（输入 155,344、输出 10,282）、主动 57.4 秒；逐阶段峰值估算输入 **26,791**，是输入目标的 **41%**（比第一次的 51% 还低）；**零裁剪、零未发出投影**；13/13 usage 来自 provider。
- **它换了策略，但避开的还是同一件事**：第一次用 `read_file` 分块抽样数据集，这次用 **6 次 `node -e` 自写探针**——在脚本里 `readFileSync` 整份数据集、算完只打印小摘要。**整批最大的一条工具结果只有 4,843 字节**（`wc -l data/records.jsonl; head -20 …`）。**它从头到尾没有在破损状态下跑过 `report.mjs`**；唯一两次跑到它（第 19、22 次调用）都发生在改完代码之后，其中一次还写成 `node report.mjs | tail -5`，另一次 `node report.mjs | cat`（那时输出已只剩 `SUMMARY 0`，492 字节）。
- **它自己说明了规则从哪来**：改写后的 `src/normalize.mjs` 里留了一行注释「规范形式（**由数据集的 expected 值反推得到**）」。**因此第二处泄露才是实际生效的那条路径**——去掉源码里的散文规则（f-4c）没有改变结局，符合「一次只改一个因素」的预期读法：改掉的确实是真泄露，但它不是模型走的那条。
- **可写与不可写**：本批次仍是**「未观测到处理生效」**。n=2 且两次都取同一侧，仍**不足以**写成「有界工具输出无影响」或「模型总是收窄」；能说的是**这条链路上两次运行的机制解释一致**。

### 关于仪器为什么难成立——一个可检验的解释

两次运行指向同一机制，值得单独记下来，因为它解释的是 **Harness 的假设**而不是模型的个性：

- **给 agent 一个通用 shell，它就能把大数据降维成小摘要。** 模型不需要把 745 KB 的报告或 297 KB 的数据集读进上下文——它写一段 `node -e`，让数据在**工具进程里**被消费，只把聚合结果带回来。`read_file` 的 32 KiB 上限、`report.mjs | tail -5`、`wc -l && head -20` 全是同一件事的不同写法。
- **因此「有界工具输出」买到的保险，是「agent 没有把结果降维」的那一类情形**（它必须逐字理解内容，而不是对它做计算）。NX-07 的设计没有错，但它防的是另一类失控。
- **这条解释是可检验的**：要让它失效，任务的内容必须**无法被脚本降维**——例如必须逐字理解的长文档、或只有人（模型）读过才能判断的语义。把它做成 fixture 意味着换一类任务，不是继续调现有的 `audit`。
- **一条方法上的红线**：如果继续改 fixture 直到出现预期的分叉，那就是在**按结果挑仪器**——与 NX-08e2「外推值被实测推翻」那次的教训同源。本轮到此为止，是否换任务形态由人决定。

### 子步骤与提交边界

| 子步 | 内容 | 付费 | 状态 |
| --- | --- | --- | --- |
| NX-08f-1 | 工具输出开关与两臂装配（`runFixtureTask` 第 5 参 + 单测） | 否 | **done** |
| NX-08f-2 | 新增单任务 fixture `audit`（大输出仪器） | 否 | **done** |
| NX-08f-3 | 离线机制证明（同 fixture 下无界臂溢出、有界臂完成）+ 诊断探针 | 否 | **done** |
| NX-08f-4 | 接好诊断阶段 `smoke`，使付费烟测可被 `--phase`/`--plan-only` 调度 | 否 | **done** |
| NX-08f-4b | 真实模型烟测：模型是否**真的**产生大输出 | **是**（需单独授权） | **done — 未观测到处理生效** |
| NX-08f-4c | 修掉报告源码里的散文规则，重跑烟测 | **是**（重跑另授权） | **done — 仍未观测到处理生效** |
| NX-08f-5 | 按实测预注册 `armC`/`armD` 的 `phaseCaps` 与 `batchCaps` | 否 | **不开跑**（仪器未成立） |
| NX-08f-6 | 正式批次（1 fixture × 6 次重复 × 2 臂） | **是** | **不开跑** |
| NX-08f-7 | 报告回填（NX-08-REPORT / CHANGES / TASKS / PROGRESS） | 否 | **done** |

顺序不可调换：先离线证明**开关**有效（f-3），再花钱测量**模型**是否产生差异（f-4b），最后才按实测预注册（f-5）。这正是 NX-08e2 的反面——那次先用 n=1 外推定案，再被 n=6 否证。

**收尾（2026-10-01）**：f-4b 与 f-4c 两次烟测都得到「未观测到处理生效」，且第二次给出了可检验的机制解释（agent 用自写探针把大数据在工具进程里降维）。**f-5/f-6 因此不开跑**——对照 B 的自变量从未被触发，预注册没有实测可依。**继续改 fixture 直到出现预期的分叉就是按结果挑仪器**，与 NX-08e2「外推值被实测推翻」的教训同源；是否换一类「无法被脚本降维」的任务重建仪器由人决定，不属于本步。结论已并入 [NX-08-REPORT 的 NX-08f 一节](NX-08-REPORT.md#nx-08f-对照-b仪器未成立)。

## NX-08g 评测报告与结论

- 关联：NX-08 的收尾项；NX-08e 与 NX-08g0 的合并结论。状态：done（2026-10-01）。**不调用付费模型、不新增运行、不改 `src/` 与 fixture**；全部数字从既有证据目录的 `runs.jsonl` 与 `sessions/*/events.jsonl` 读出。
- **交付物**：[NX-08-REPORT.md](NX-08-REPORT.md)。它合并 NX-08d 筛查跑与 NX-08e 对照 A 两次实验，对应路线图 4.5 的「需要报告」清单逐项分列两个批次；逐步证据仍在本文件、参数仍在 PLAN，报告不复制它们。选独立文件而不是本文件里的一节，是因为 NX-09 的 README 要链「实验报告」，而这两次实验在本文件里没有单一对应节（NX-08c 的估算误差只引用、不重述数值）。
- **验收**：含样本量、重复间波动、失败案例、成本与不可行项；不写未验证的提升比例；**引用 NX-08g0 的判据**，并把「**结局饱和**（方差为零，量不出差异）」与「**样本量小**（1 条序列，区间宽度无意义）」作为两条独立限制分别陈述；harness 行为（裁剪生效、预算未触顶、编辑写保护、命令闸门误判）与真实模型能力（通过率、提升比例、泛化）分开写。
- **本步新算的一处**：筛查跑的工具级统计此前没有，为补齐报告的项目表从原始事件现算——编辑失败率 **2/17 = 11.8%**（两次都是 `oldText not found`，都落在 `pagination`：工作区是 CRLF，模型两次 `edit_file` 被挡回、改用 `write_file` 成功）、**真失败 0 次**（唯一一次非零退出的验证是模型自写 `node -e` 探针失败，同一命令里 `check.mjs` 已打印 `public checks passed`）、探针 4 次 / `check.mjs` 18 次。筛查的 11.8% 高于对照 A 的 4.0%，原因是**分母不同**（17 vs 150）而不是任务更难，两个数不可直接比较。
- **口径订正（2026-10-01）**：把下文 NX-08e 节的探针口径明确为「命令中含 `node -e` 的 bash 调用」，并按此把 armA 由 20 订正为 **21**（逐次 1 / 1 / 19）、两臂合计由 95 订正为 **96**。此前漏计了一条把探针接在 `check.mjs 2 &&` 之后的复合命令；该命令同时计入 `check.mjs` 调用数，两组数相加会大于 bash 调用总数。只影响这一个数，方向性结论不变，NX-08e 节与 TASKS／PROGRESS 已同步。
- **未纳入本步**：NX-08f（对照 B，未预注册、未开跑）、NX-08h（打破天花板，需新契约与付费授权）、NX-08c 的数值（只引用）。报告不含任何通过率型结论或提升比例。

## NX-08g0 任务集天花板效应：定性、边界与补救排序

- 关联：NX-08g 报告的前置。状态：done（2026-10-01）。**不调用付费模型、不新增运行、不改 `src/` 与 fixture。** 此前它只是散落在各处的一句旁注（「任务集有天花板效应」），本步把它展开成可核对的判据与可执行方案。

### 现象与判据

两处**互相独立**的测量都取满值：

| 实验 | 规模 | 结果 |
| --- | --- | --- |
| NX-08d 筛查 | 12 个单任务 fixture × 1 次 | **12/12 accepted**，零拒绝、零不可行、零基础设施失败 |
| NX-08e 对照 A | 1 条十四阶段序列 × 3 次重复 × 2 臂 | **6/6 accepted**，零 `max_steps`、零 error、零未发出投影 |

判据是**方差为零**：以 `accepted` 为分子的任何统计量在两次实验里都没有可用的变异，因而**没有分辨力**——不是「差异很小」，是「量不出来」。这与样本量是**两个独立的限制**：样本量小影响的是估计的区间宽度，天花板效应让被估计的量本身失去取值。报告里必须分开陈述。

### 天花板是什么做的

不是「任务简单」这么笼统。三条可核对的机制：

1. **公开且受保护的 oracle 就在工作区里，任务说明直接给出命令。** 十四个阶段的 `TASKS/NN-*.md` **全部**以「完成后运行 `node check.mjs N`」结尾（如 `TASKS/01-parse.md`、`TASKS/14-audit-delta.md` 末段），而 `check.mjs` 位于初始工作区、受验收保护、可无限次重跑。模型因此不必*一次写对*，只需*能收敛到绿*。6 次运行里它跑了 **151 次验证**（均值 25.2 次/运行）、**118 次 `check.mjs`**、**96 次自写 `node -e` 探针**（探针口径见「工具级统计」一节的订正）——oracle 不只是可用，是被大量使用且几乎免费。
2. **收敛确实发生过，而且都在同一阶段内完成。** 5 次真失败全部随后再次编辑并转绿，没有一次把失败带到下一阶段（见上节工具级统计）。
3. **预算从未成为约束。** 6 次运行零 `max_steps`；单阶段最高用量为 14/32 请求（44%）、1,355,463/2,000,000 token（68%，armA），未触顶。

三条合起来：**这份 fixture 测量的是「在有完整、即时、廉价 oracle 的条件下能否收敛」，不是「能否独立产出正确实现」**。这个区别决定了 12/12 与 6/6 各自能支持什么结论。

### 因此现在就不该写的结论

- 任何**通过率形式的能力结论**（模型多强、哪条臂更好）——没有变异。
- 任何**提升比例**（「裁剪让通过率提高 X%」）——同上；NX-08e 连处理效应都测不出。
- 把 12/12 或 6/6 **外推到长任务、大仓库、无公开检查的真实场景**——机制 1 在这些场景里不成立。
- **可以**写的：链路可用性（真实模型能在这条 Harness 上跑通并交付）、仪器的有效性（裁剪确实生效、两臂分叉是结构性的）、成本与用量的量级。

### 换连续指标能不能救

**对这个对照不能。** NX-08e 里唯一有明显差异的连续指标是 token，而 token 正是处理本身设定的量——裁剪的定义就是少喂历史，所以它是**操纵检查**，不是结局。请求数只差 5.4%，墙钟反而更长，修复次数 1 对 4 在 n=3 且挤在同一阶段。**当处理的定义直接改变某个指标时，那个指标就不能再当结局。** 换指标只在「处理不直接作用于该指标」时才可行——修复次数勉强算一个，但 n=3 撑不住。

对筛查跑（无处理，只是能力基线）换指标没有意义：没有可比的两组。

### 补救方案（排序，含成本）；**本轮一条都不执行**

| # | 方案 | 攻击哪条机制 | 成本 | 代价 / 风险 |
| --- | --- | --- | --- | --- |
| 1 | 把「能力结论不可写」固化成文档口径 | — | **0**（本轮已做） | 无 |
| 2 | 增设**无公开检查**变体：工作区不含 `check.mjs`，只能按 SPEC 自验 | 机制 1 | 离线改造 0 元；**验证需一次付费跑** | 改变 fixture 契约，需新的预注册与独立验收口径 |
| 3 | 提高阶段难度（跨多文件重构、规格留冲突需判断、引入不可逆步骤） | 机制 1、2 | 离线改造 + 付费验证 | 参考解可能也要重界定；容易做过头变成「不可解」 |
| 4 | 收紧单次 run 预算，让预算成为真约束 | 机制 3 | 0（改参数） | 变成另一种实验（测预算压力），不再是「自然走出的历史规模」 |
| 5 | 换带公开失败率的任务源（真实仓库 issue） | 1、2、3 | 高（构建 + 维护 + 多次付费） | 超出当前 fixture 框架范围 |

**2 是唯一直接打在机制上的低成本方案**，而且 fixture 部分可以离线改好——但要花钱才能知道它是否真的产生失败。3 与 5 更彻底、成本更高。**本轮不执行 2～5 中任何一条**：它们各自都需要新的预注册与明确授权，且 NX-08f（对照 B）的优先级更高。

### 对现有任务的处置

- NX-08d 与 NX-08e 的结论**不做追溯修改**：它们各自写明了边界，本次只是把边界从一句话展开成可核对的判据。
- NX-08g 报告须引用本节，并把「结局饱和」与「样本量小」作为**两条独立的限制**分别陈述。
- 方案 2/3 建议单独立项（**NX-08h**）承接；开跑前单独预注册，**不得**沿用本轮的 `phaseCaps` 数字。

## NX-08e 对照 A：全历史 vs 现有裁剪（实测）

- 关联：NX-08 的正式对照批次。状态：done（2026-10-01）。**本步调用付费模型**（约 $4.8～9.6，见下）。
- **规模**：1 条十四阶段序列 × 3 次重复 × 2 臂 = **6 次运行**，模型 `deepseek/deepseek-v4-flash`（服务端回显 `deepseek-flash`），窗口 1,000,000。两臂共用同一 prompt、初始工作区、验收器与单次 run 预算，**差异只有输入目标**（armA 1,000,000 ／ armB 65,536）。证据在 `.eval-evidence/armA-14stage/` 与 `.eval-evidence/armB-14stage/`（不入库）。
- **前置条件已满足（R-21 的两条）**：**会话组成**——十四阶段在同一会话内按序下发，每个阶段新 `taskId`，先前阶段成为可裁剪的旧任务；**规模**——armA 三次的峰值估算输入为 123,064 / 182,538 / 145,083，远超 65,536。两臂因此确实会产生差异位置，不是等价对照。

### 处理确实生效（这是 e2-4 要买的那个东西）

| 臂 | # | 结果 | 首次裁剪落在 | 受处理阶段 | 峰值估算输入 |
| --- | --- | --- | --- | --- | --- |
| armB | 0 | accepted | 第 8 阶段 | 7/14 | 65,533 |
| armB | 1 | accepted | 第 6 阶段 | 9/14 | 65,145 |
| armB | 2 | accepted | 第 6 阶段 | 9/14 | 65,314 |
| armA | 0 / 1 / 2 | accepted | **从不裁剪** | 0/14 | 123,064 / 182,538 / 145,083 |

上一轮 6 阶段批次的对照：3 次 armB 里 **1 次完全没触发**（峰值 50,719，与 armA 行为完全相同），另两次只在最后 1～2 个阶段触发。现在 **3/3 触发，最低 7 个受处理阶段**。加阶段这一步的目的由此达成。

逐阶段峰值估算输入（三次均值）显示分叉是结构性的，不是噪声：

| 阶段 | 1 | 5 | 8 | 10 | 12 | 14 |
| --- | --- | --- | --- | --- | --- | --- |
| armA | 25,045 | 56,415 | 109,156 | 122,533 | 135,736 | **150,228** |
| armB | 18,650 | 47,488 | 63,508 | 64,146 | 65,253 | **56,690** |

两臂在第 1～5 阶段同步增长，第 6～7 阶段开始分离，第 8 阶段起 armB 钉在 65,536 附近而 armA 继续涨到 150k。第 14 阶段相差 **2.65 倍**。

### 结局饱和：这份实验回答不了通过率

**6 次运行全部 `accepted=true`**——退出码 0、stdout 恰好 `acceptance passed: pipeline`、受保护文件零改动、无 `infeasible`、无 `max_steps`、无未发出投影，14/14 阶段全部跑完。两臂各 3/3。

因此**本批不能支撑「裁剪是否损害任务成功」这类结论**，原因不是样本量小，而是**二值结局在两边都取满值**：没有失败可解释。这与「只有 1 条 fixture 序列」是两个独立的限制，必须在报告里分开写。任务集对这档模型而言太容易——NX-08d 筛查跑的 12/12 是同一个病的另一处表现。

### 用量、步数与时间

| | 请求 | token | 输入占比 | 有效时间 |
| --- | --- | --- | --- | --- |
| armA | 261 | **19,861,006** | 98.9% | 18.7 分钟 |
| armB | 247 | **10,838,050** | 97.9% | 19.6 分钟 |
| 比 | 5.4% 少 | **45.4% 少** | — | 大致持平 |

逐次：armA 4,856,014 / 8,841,669 / 6,163,323（极差 1.82 倍）；armB 2,495,773 / 4,145,281 / 4,196,996（极差 1.68 倍）。

**裁剪省的是上下文，不是步数。** 请求数只差 5.4%，墙钟反而略长——每阶段的轮数没变，变的是每轮喂进去的历史。把「token 更少」读成「更快」或「更省事」在这份数据里都不成立。

**provider/estimated 分列（R-21）**：508 条 `model/usage` **全部 `source = provider`**，`estimated` 为 **0**，估算回退一次都没发生。按 token 计为 100% / 0%（该分列从 `sessions/*/events.jsonl` 的 `model/usage` 按 `source` 求和得出，不取自只有条目数的 `RunTaskDetail.usageSources`）。

### 工具级统计：编辑失败率、修复迭代与探针使用（从原始事件补算）

这三项都**从 `sessions/*/events.jsonl` 现算**，未改 `src/`、未重跑任何一次运行。`runs.jsonl` 的设计目标是逐阶段预算与裁剪观测，不含工具级；引用它们时须说明来源是原始事件。

**编辑失败率**——分子是 `file/change-result` 里 `status !== 'applied'` 的条目，分母是全部 `file/change-result`：

| | armA | armB | 合计 |
| --- | --- | --- | --- |
| 编辑变更 | 70 | 80 | **150** |
| 编辑失败 | 3 | 3 | **6** |
| 失败率 | 4.3% | 3.8% | **4.0%** |

六次失败**全部是 Harness 的写入保护触发，不是模型写出坏代码**，且模型每次都当场恢复：

- **5 次** `file conflict: expected <hash>, found <hash>; read again before editing` —— 写入时携带的期望哈希与磁盘不符，是乐观并发保护（编辑基于过期的读）。
- **1 次** `oldText not found; read the exact text including line endings` —— `edit_file` 的字面量匹配失败；工作区文件是 CRLF，这条例外信息里的提示是准确的。

**修复迭代次数**不能直接用「非零退出的验证」（全批 9 次）——那个数会高估。按**断言失败的阶段号与当前阶段号的关系**分类后：

| 分类 | 判据 | armA | armB | 合计 |
| --- | --- | --- | --- | --- |
| 探针 | 命令不是 `check.mjs`，是模型自写的 `node -e` | 1 | 0 | 1 |
| 预期失败 | 断言失败的阶段 > 当前阶段（跑了后面的检查） | 1 | 2 | 3 |
| **真失败** | 断言失败的阶段 **=** 当前阶段 | **1** | **4** | **5** |

**真失败 5 次，全部随后再次编辑（5/5 修复）**，随后的编辑合计 8 个（armA 2 / armB 6）。最多的一次是 armB `25ae27c9` 第 6 阶段：连错两次、三次编辑后转绿。

**5 次真失败里 4 次落在第 6 阶段**（`src/delta.mjs`，把第 5 阶段渲染出的文本反解回「模块名 → 批号」）。这是全序列唯一的难度热点，而 `TASKS/06-delta.md` 正好明文预警过那个坑（「`cycles` 段的成员行同样是缩进行，必须靠段落归属排除」）——**被预告的陷阱仍然绊倒了 3/6 次运行**，说明它是真实的（尽管不大）的难点。

**臂间不能读成效应**：armA 也命中同一个阶段（1 次），真失败在 n=3 下的 1 对 4 分不出处理效应与噪声。这几项是工具级**行为**，不是结局。

**一个附带的观察**：裁剪臂更依赖自写探针。

| | armA | armB |
| --- | --- | --- |
| `bash` 调用 | 107 | 161 |
| 其中 `node -e` 自写探针 | 21（逐次 1 / 1 / 19） | **75（逐次 18 / 24 / 33）** |
| 其中 `check.mjs` 调用 | 52 | 66 |

**口径与订正（2026-10-01）**：探针口径明确为「命令中含 `node -e` 的 bash 调用」。按此口径 armA 为 21，此前记的 20 漏计了一条把探针接在 `check.mjs 2 &&` 之后的复合命令（该命令同时计入上表的 `check.mjs` 调用，所以两组数相加会大于 bash 调用总数）。订正只影响 armA 一个数，方向性结论不变。

逐次看，armB 三次探针数（18 / 24 / 33）**全部高于** armA 的两次最低值 1、1，方向是一致而不是靠某一次拉开的。合理解释是：历史被裁掉之后，模型改用即时探针重新推导行为，而不是依赖会话里已有的验证记录。**但这仍是 n=3 的行为观察，不是结局差异**，报告引用时须标明。

### 成本，以及我在这一步之前把成本报错了

按 PLAN 已写明的算法（价格页 2026-09-30 版；flash 输入 cache-miss、输出；**假设无缓存命中**，这是保守方向）：

- off-peak（输入 $0.15/M、输出 $0.60/M）：armA $3.08 + armB $1.73 = **$4.81**
- peak（输入 $0.30/M、输出 $1.20/M）：armA $6.15 + armB $3.46 = **$9.61**

批次时间窗为 UTC 02:37–03:05，**落在 peak 窗口 01:00–04:00 UTC 之内**；但价格页写明「中国法定假日不计 peak」，2026-10-01 为国庆，故实际应按 **off-peak**，即约 $4.81。两数都列出，因为这一判断依赖假期规则而非代码。

**先前对用户的报价 $16～19 是错的，高了约 2～3 倍。** 错因值得记下：我用 `PROGRESS` 里「6 阶段批次约 $4」反推了一个 $/M 费率，而那个历史金额**本身不可复现**——按价格页即便全按 peak 算，那批 8,188,650 token 也只有 $2.53。**拿一个不可复现的数当基准去外推**，正是本批同一次工作里刚写进口径清单的那条毛病。以后报价一律用价格页直接算。

### 这份数据不支持的结论

- 不写「armA / armB 谁的成功率更高」——6/6 全通过，二值结局饱和。
- 不写提升比例、不写泛化：样本量是 1 条 fixture 序列 × 3 次重复 × 2 臂。
- 不把「token 少 45.4%」读成效率提升——请求数与时长大致持平，省下的是上下文规模。
- 不把「armB 真失败 4 次 vs armA 1 次」读成裁剪导致质量下降：n=3，且 4 次里 3 次挤在同一个阶段、armA 也命中过该阶段。同理，探针数（armB 75 vs armA 20）是行为观察，不是结局。
- 缓存命中未记录：事件流里没有 cache 字段，成本按「无缓存命中」保守计，真实账单应不高于此。

## NX-08e2-4（重启）把序列扩到十四阶段，并按新规模重预注册上限

- 关联：NX-08e / NX-08f 的前置。状态：done（2026-10-01，本地通过）。**本步的付费部分只到诊断跑，对照 A 的正式批次仍未开跑。**
- **为什么重启 e2-4**：e2-3 基于 **n=1** 的烟测判定「6 个阶段足够，e2-4 无需执行」，而对照 A 的首次实测（6 次运行）把这条结论否证了。三次 armB 里**只有两次真正触发裁剪**（首次裁剪落在第 5、第 6 个阶段），第三次的末阶段峰值输入只有 50,719，从未触及 65,536——那次运行的行为与 armA 完全相同，是一条不携带任何处理信息的对照-对照配对。重复间波动（armA 末阶段峰值 108,541 / 84,167，armB 64,374 / 65,293 / 50,719）横跨阈值本身，所以 n=1 的结论约 2/3 的时候成立、且只在最后 1～2 个阶段成立，早不到能改变任务走向。证据在 `.eval-evidence/armA-full/`、`.eval-evidence/armB-full/`。
- **修法是加阶段，但加阶段买到的东西要说清**：阶段数是这个 fixture 里唯一可调的量。10 阶段的诊断跑给出一个跑之前没想清楚的性质——**越过阈值的绝对阶段号大致固定，与总阶段数无关**（历史规模随阶段号近似线性增长），因此加阶段不改变越界位置，只增加越界之后还剩几个受处理的阶段：受处理阶段数 ≈ 总数 − 5。据此再扩到 14，低轨迹也留得下 7 个以上受处理阶段。**加阶段买的是「处理真的生效」，不是统计功效**：样本量仍是 1 条序列 × 3 次重复 × 2 臂、二值结局，NX-08g 的报告不得据此写提升比例。
- **10 阶段诊断实测**（`.eval-evidence/sequence-10stage/`，付费）：1 次运行，status `completed`、accepted `true`、64 请求 / 2,639,688 token。逐阶段末次投影 15.6k → 23.7k → 39.9k → 55.6k → 60.7k｜**第 6 阶段首次裁剪**（第 2 次投影，移除 3 个旧任务）→ 63.5k / 63.5k / 65.1k / 64.8k / 51.8k，后 5 个阶段全部受裁剪。第 5 阶段仍只有 60,652（未越界），越界点在第 6 阶段——与「绝对阶段号大致固定」的读数一致。
- **14 阶段诊断实测**（`.eval-evidence/sequence-14stage/`，付费）：1 次运行，status `completed`、accepted `true`、**132 请求 / 6,379,862 token / 566 秒**。逐阶段末次投影 24.4k → 37.6k → 47.3k → 60.0k｜**第 5 阶段首次裁剪**（第 6 次投影，移除 1 个旧任务）→ 第 6～14 阶段全部受裁剪，移除数 3 → 5 → 6 → 7 → 7 → 8 → 8 → 10 → 11。**峰值 65,183（第 5 阶段），越界后 10 个阶段受处理**——比 10 阶段那版的 5 个多一倍，越界点也与「绝对阶段号大致固定在第 5～6 个」的读数一致。
- **一次读错，记在这里**：这一步开始时我把这次运行当成「被会话中断、没有产出」——判据是 10:27 时目录里只有空的 `sessions/pipeline/`、`runs.jsonl` 还没写出。**实际是它当时还在跑**，10:37 以退出码 0 正常结束，`runs.jsonl` 与 `report.json` 都落了盘。`runs.jsonl` 在整次运行结束时才写，中途去目录里看它缺席并不说明进程已死；这条判据本身是错的，不该再用来判断一次评测跑是否还活着。曾据此建议跳过重跑，所幸这次运行本来就已在进行，没有产生额外花费。
- **重预注册（本步）**：`armA`/`armB` 由每臂 `600 / 15,000,000` 改为 **`1,400 / 40,000,000`**，`batchCaps` 由 `{18, 1_600, 38_000_000}` 改为 **`{18, 3_200, 88_000_000}`**；`phaseCaps.sequence` 已随 `ddb24dd` 改为 `448 / 28,000,000`。
  - requests 取理论上界：3 × 14 × 32 = 1344 → **1,400**（与筛查同口径）。
  - tokens 取「3 × 实测单条 × 2 倍余量」：`3 × 2 × 6,379,862 = 38,279,172` → **40,000,000**。
- **这条 token 值写过两版，第一版是错的，第二版才是实测**：先按 10 阶段的 2,639,688 加上 4 个「同量级」的受裁剪阶段外推得 `2,639,688 + 4 × 311,230 = 3,884,608`，据此定的上限是 24,000,000；本次实测 6,379,862，**比外推高 64%**。原因是 **token 由每阶段请求数驱动，不是阶段数线性外推**——14 阶段平均 9.4 请求/阶段（第 6、9、13 阶段分别用了 17、15、13 次），而 10 阶段那次只有 6.4。按外推值定的 24,000,000 对 3 次运行只剩 25% 余量，而 6 阶段批次的跑次间波动有 2.4 倍宽（0.82M～1.95M/run）——**那个上限正好会犯预注册里明令禁止的错：在中途掐断某一臂，让被比较的东西从上下文策略变成预算**。教训是外推的 token 数不能替代实测，更不能用来定硬中止阈值。
- **顺带修掉一处陈旧注释**：`scripts/eval-runner.ts` 里 `batchCaps` 上方仍写着「整批 156 次运行」，而它早已是 18 次（156 是「12 + 72 + 72」那套已作废的读法）——同一段注释里两个数字互相矛盾，一并改成 18。
- 验证：`pnpm check`（84 文件语法通过）、`pnpm test`（**195/195**，含 `test/eval-runner.test.ts` 里 `phaseCaps` 与 `batchCaps` 的按值断言）、`pnpm fixtures:check`（13 项、初始 0/13、参考 13/13）、`pnpm eval:offline`（12/12）本地通过。三条 `--plan-only` 实测：`armA`/`armB` → 1 项 × 3 次重复 = 3 次运行，1400 请求 / 40000000 token，输入目标分别 1,000,000 / 65,536；`sequence` → 1 次运行，448 请求 / 28000000 token。四条都不建目录、不出网。

## NX-08e2-6 按实测重预注册 `phaseCaps` 与单次 run 预算
- 关联：解除对照 A 的闸门。状态：done（2026-10-01，本地通过）。本次不调用真实模型。
- **为什么必须重算**：`phaseCaps` 的 `armA`/`armB` 原各 72 次运行，按「12 任务 × 2 臂 × 3 次」算出。fixture 变成多阶段序列后，「一次运行」的含义从「一个单任务」变成「整条六阶段序列」，那个算式连同「全程 156 次」一起作废。
- **新旧对照**：`armA`/`armB` 72 → **3** 次；`batchCaps` `{156, 5_200, 98_000_000}` → **`{18, 1_600, 38_000_000}`**。按用户选定的样本量：1 条序列 × 3 次重复 × 2 臂。
- **请求上限取理论上界而非实测**：3 次 × 6 阶段 × 32 请求 = 576，进位到 600。实测只有 159，但请求数 32 是「两臂获得相同工作量」的**约束**；上限若比它更紧，就会在批次中途掐断某一臂，让被比较的东西从上下文策略变成预算。这与筛查阶段同口径（12 × 32 = 384 → 400）。
- **token 上限取实测两倍余量**：3 × 2 × 2,188,159 ≈ 13,128,954，进位到 15,000,000。**只有 1 次观测**，所以这是量级估计不是分布；重复间波动要到对照 A 跑完才知道。单次 run 预算（每阶段一份）仍是每次运行的硬闸门。
- **一处口径纠正，与提问时的口径不同**：提问时给的是「runs 6 / 请求 400 / token 30,000,000」。请求数 400 是按筛查的数量级顺手写的，按上面的算式应当是**每臂 600**；取 400 会让 3 次运行对上一个比理论上界更紧的上限，在第 3 次运行前就可能中止该臂。已按 600 预注册。
- **明确 `armA`/`armB` 的归属**：它们是**对照 A 的两条臂**（`armA` = 全历史，`armB` = 现有裁剪），不是「对照 A 批次 / 对照 B 批次」。此前 PLAN 的 156 = 12 + 72 + 72 隐含了后一种读法；现在按运行期语义固定为前者，并在 PLAN 里写明**对照 B 因此不再有对应阶段与上限**，留待 NX-08f 前单独预注册——不得沿用本轮数字。
- **两臂的差异压缩到一个参数**：新增 `armPolicy(phase, contextWindowTokens)`（`scripts/eval-runner.ts`）。`armB` 返回 `evalPolicy` 本身（文档默认输入目标 65,536，历史超出就移除最旧的完整任务）；`armA` 把输入目标抬到模型窗口，让「输入 ≤ 目标」恒成立，历史只受窗口容量约束。称它「全历史」的边界被写进注释：**不是无限**，输入 + 输出预留 + 容量余量仍须落在窗口内，越过是 `context_overflow` 而不是静默截断。窗口不高于 armB 的目标时 `armPolicy` 直接抛错——否则两臂会被悄悄对调成「armA 裁得更多」，而报告看不出来。输出预留只由 `maxTotalTokens`/`maxOutputTokens` 决定、与输入目标无关（`src/core/run-budget-runtime.ts:38-45`），所以差异确实只在裁剪上。
- **入口跟随阶段**：`scripts/eval-screening.ts` 按阶段选策略（`armA`/`armB` 用 `armPolicy`，其余用 `evalPolicy`），`--plan-only` 把输入目标打出来——臂的差异在花钱之前就看得见；`summary` 也记 `inputTargetTokens`，让证据自带「这是哪条臂」。
- **任务集**：`phaseRegistry` 对 `armA`/`armB` 打开为 `sequenceIds`。两臂用**同一份**任务集是刻意的——对照 A 比较的是上下文策略，不是任务难度。
- 验证：`pnpm test`（192/192，新增 1 条臂差异用例、改写 2 条），`pnpm check`（84 文件）、`pnpm fixtures:check`（13 项、`expected` 全为真，退出码 0）、`pnpm eval:offline`（planned 12、accepted 12，退出码 0）在本机通过。四个阶段的 `--plan-only` 实测：`screening` → 12 项 / 400 请求 / 8M；`sequence` → 1 项 / 192 / 12M / 输入目标 65,536；`armA` → 1 项 / 600 / 15M / **输入目标 1,000,000**；`armB` → 1 项 / 600 / 15M / **输入目标 65,536**。四条都不建目录、不出网、未产生付费请求（`.eval-evidence/` 内容不变）。提交 `f239774`。

### NX-08e2 本批提交的跨平台证据（2026-10-01）

| 提交 | 内容 | CI |
| --- | --- | --- |
| `6978f63` | NX-08e2-1 逐阶段投影观测 | [36798536341](https://github.com/BeforeLanding/mini-DSH/actions/runs/36798536341) 四组 success |
| `c84c5a1` | NX-08e2-2 入口按阶段参数化 | [36798753257](https://github.com/BeforeLanding/mini-DSH/actions/runs/36798753257) 四组 success |
| `1b7d5c9` | NX-08e2-5 验收放宽 | **无独立 run**，见下 |
| `2f20cff` | NX-08e2-3 烟测结论回填（文档） | [36799815136](https://github.com/BeforeLanding/mini-DSH/actions/runs/36799815136) 四组 success |
| `f239774` | NX-08e2-6 重预注册与两臂策略 | [36800057508](https://github.com/BeforeLanding/mini-DSH/actions/runs/36800057508) 四组 success |

- 四组指 Ubuntu / Windows × Node.js 22 / 24，均为 success、无重跑。**今天这批推送均未触发 Deploy ECS**（最近一次 Deploy ECS 仍是 2026-09-30 的 `36661471055`），与 OPS-01 的「部署改为 tag 触发」一致。
- **`1b7d5c9` 没有逐提交的独立 run**：它与 `2f20cff` 在同一次推送里到达 origin，CI 只挂在 tip `2f20cff` 上。该 run 证明这批内容整体通过，**不构成 `1b7d5c9` 自身在 Windows 上的独立证据**。这是 NX-08e1-3 已经记过一次的同一类缺口（攒到最后一起推），本次仍然发生——两步都只在本机验证过 Windows 行为（`pnpm fixtures:check` 与 `pnpm test` 含真实的 Node 子进程验收）。

## NX-08e2-5 验收放宽到 SPEC 的实际要求
- 关联：NX-08e2 烟测暴露的夹具缺陷。状态：done（2026-10-01，本地通过）。本次不调用真实模型。
- **为什么改**：`pipeline` 的独立验收 `verify.mjs` 断言 `diffPlan('order: 1\n', plan)` 抛出的消息匹配 `/missing batches section/`、`diffPlan('totally wrong\n', plan)` 匹配 `/unknown header/`。这两句话 SPEC **没写**、`TASKS/06-delta.md` **没写**、模型可见的公开检查 `check.mjs` **也没有**——它们只是参考解 `delta.mjs` 恰好吐出的字符串。而 SPEC 第 5 节与 `TASKS/06-delta.md` 实际要求的是「抛 `Error`，消息里带从 1 开始的行号」。于是**按 SPEC 实现、只是换了错误消息的解法会失败**：NX-08e2 的烟测正是如此，模型抛 `line 1: expected "source:" section, found "order:"`（带行号，符合 SPEC），却在第 75 行被判不通过，而那一行之前的断言——含两条功能性 `diffPlan` 比较——全部通过。
- **改法**：把两条断言换成 `rejectsWithLineNumber(text)`，断言「必须拒绝」且「消息里有 `line <数字>`」。`missing batches section` 这个**条件**仍被覆盖（输入缺 `batches` 段就必须报错），只是不再钉措辞。验收应当由任务说明决定；改之前是验收比说明更严。
- **参考解随之自洽**：原参考解抛的 `missing batches section` **不带行号**，与它自己那份 SPEC 的那句话相抵触。现在改为指向最后一行有内容的行（`line ${lastLine}: missing batches section`）——文本就是在那里结束、而没有出现 `batches` 段的。
- **防止放宽变成空断言**：新增用例 `the sequence acceptance requires a line number instead of one exact error wording`（`test/coding-fixtures.test.ts`）同时钉两个方向——把参考解的消息替换成**烟测里模型抛的那条**（措辞完全不同、带行号）后验收仍通过；替换成**不带行号**的消息后验收必须失败并给出「expected a line number」。只用前者会退化成「只要抛点东西就算过」。
- **不影响既有读数**：裁剪触发点与验收措辞无关，NX-08e2-3 的逐阶段投影读数不需要重测，也**不需要重跑付费烟测**。
- 验证：`pnpm test`（191/191，新增 1 条，无失败/跳过）、`pnpm fixtures:check`（13 项、初始 13/13 以退出码 1 失败、参考 13/13 通过、`expected` 全为真，退出码 0）、`pnpm eval:offline`（planned 12、accepted 12，退出码 0）、`pnpm check`（84 文件）在本机通过。未产生付费请求。提交 `1b7d5c9`。

## NX-08e2-3 `pipeline` 的真实模型烟测与结论
- 关联：NX-08e2 的核心测量——6 个阶段是否足以触发上下文裁剪。状态：done（2026-10-01）。**首次为 e2 调用付费模型**：`deepseek/deepseek-v4-flash`（服务端回显 `deepseek-flash`），1 次序列运行，成本约 **$1**（input 2,125,115 + output 63,044，按 PLAN 的 flash 峰值口径估算）。
- 命令：`pnpm eval:sequence`（等于 `node dist/scripts/eval-screening.js --phase sequence`），证据在 `.eval-evidence/sequence-full/`（不入库）。协议探测与 NX-08d 一致：回显 `model=deepseek-flash`，流式路径 `complete=true`、usage 来自 provider。
- **结论：6 个阶段足够，触发点是第 4 个阶段。** 因此 NX-08e2-4（增减阶段）**不需要执行**。

| 阶段 | 状态 | 请求 | 工具 | token | 峰值估算输入 | 首次裁剪于第几次投影 | 被丢掉的旧阶段 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 01 parse | completed | 7 | 9 | 58,351 | 13,757 | — | — |
| 02 order | completed | 5 | 6 | 93,939 | 23,951 | — | — |
| 03 cycles | completed | 9 | 9 | 299,853 | 42,592 | — | — |
| 04 batches | completed | 9 | 10 | 480,928 | **63,710** | **第 8 次** | 01 |
| 05 report | completed | 8 | 8 | 484,792 | 65,496 | 第 1 次 | 01, 02 |
| 06 delta | completed | 15 | 14 | 770,296 | 63,741 | 第 1 次 | 01, 02, 03, 04 |

- 全序列 53 请求 / 56 工具 / 2,188,159 token，主动时间约 293 秒；`completed=1`、`stopped=0`、`errored=0`；usage **53/53 来自 provider**（估算 0）。
- **阶段 1–3 从未裁剪、阶段 4 才首次裁剪**，与 `groupHistory` 只在 `run/finish` 之后把组标 `complete` 的结构约束一致：阶段 1 若出现 `removedTaskIds` 就是驱动接线错误。阶段 4 的峰值 63,710 逼近输入目标 65,536，第 8 次投影越过它并丢掉最旧的阶段；此后进入 e0-3 探针预测过的**滚动状态**——阶段 5 从第 1 次投影起就丢，阶段 6 把前四个阶段全丢，只留自己（current task 恒受保护）。
- **没有被 `max_steps` 截断的阶段**：最高 15 次请求、77 万 token，都远低于每阶段 32 请求 / 2,000,000 token 的 `singleRunBudget`。因此这些历史规模是模型自然走出来的，不是预算截断的产物——e0-3 提示的那个伪信号没有出现。
- **一处口径必须写清**：`estimatedInputTokens` 是裁剪**后**的值，所以阶段 5/6 的「最后一次投影」反而比峰值小（62,699 / 52,025）。真正说明「这一阶段自己长了多少」的是 `maxEstimatedInputTokens` 与相邻阶段的增长，而不是最后一个读数。
- **验收结论 `accepted=false`（退出码 1，受保护文件未改动），但失败点不是功能**：`verify.mjs` 断言 `diffPlan('order: 1\n', plan)` 的消息匹配 `/missing batches section/`，模型抛的是 `line 1: expected "source:" section, found "order:"`。该短语 SPEC 第 5 节没写、`TASKS/06-delta.md` 没写、模型可见的 `check.mjs` 也没有；第 75 行之前的断言**全部通过**（含 `diffPlan(rendered, plan)` 与 `diffPlan(previous, plan)` 两条功能性比较），第 75 行之后没有执行。所以这是一条验收比任务说明更严的失败，处置见 NX-08e2-5。
- 验证：`pnpm eval:sequence`（planned 1、executed 1、`aborted=null`，退出码 0——未通过验收是评测数据而非脚本失败）。逐阶段读数取自 `runs.jsonl` 的 `tasks[]`。文档提交 `2f20cff`。

## NX-08e2-2 真实适配器入口按阶段参数化
- 关联：NX-08e2 的第二步，让 `pipeline` 有真实入口且上限口径在开跑前固定。状态：done（2026-10-01，本地通过）。本次不调用真实模型。
- **为什么需要**：`scripts/eval-screening.ts` 把 `phase` 写死为 `'screening'`，`phaseCaps` 只有 `screening`/`armA`/`armB`。多阶段 fixture `pipeline` 因此没有真实入口——用 `--tasks pipeline` 跑会套错 phase 标签与上限。
- **顺带修掉的既有缺陷（NX-08e1-1 遗留）**：`resolvePlanned()` 在未给 `--tasks` 时返回全部 `fixtureIds`。拆注册表后它是 **13 项**，而 `phaseCaps.screening.runs` 仍是 12：不带参数跑 `pnpm eval:screening` 时第 13 项 `pipeline` 会被排进计划却永远不被调度（开跑前检查取「累计 ≥ 上限」），`report.aborted` 非空、退出码 1。现在默认清单改为取**该阶段的注册表**（`screening → screeningIds` 12 项、`sequence → sequenceIds` 1 项），证据目录重新回到 `.eval-evidence/screening-full`。
- **参数与计划判据抽成纯函数**（新文件 `scripts/eval-cli.ts`）：`parseEvalArguments` / `phaseRegistry` / `resolvePlanned` / `evidenceScope` / `resolveInfeasible` / `resolveModel` / `resolveContextWindow`。抽出来的理由是**可离线验收**——入口脚本有顶层 await（协议探测、付费批次），被测试 import 会真的花钱，所以这些判据不能只住在那个文件里。入口脚本因此变薄，只做编排与落盘。
- **`--tasks` 只能取当前阶段清单内的子集**：跨阶段取任务现在直接报错并点名（`--tasks names fixtures outside the screening phase: pipeline`）。它正是上面那条缺陷的成因，堵死比记一笔「注意」可靠。
- **新增 `--plan-only`**：打印阶段、计划清单、单次/整批上限、模型、端点、窗口与证据目录，然后退出 0。它排在 `ensureWritable` 与 `probeProtocol` **之前**——否则「预演」自己就已经花了钱——因此不需要 API key，也不建目录、不出网。实测三条：默认打印 12 项与 `screening-full`，`--phase sequence` 打印 1 项与 `sequence-full`，`--phase screening --tasks pipeline` 以退出码 1 拒绝；三条跑完 `.eval-evidence/` 内容不变。
- **对照臂拒绝出计划**：`armA`/`armB` 的任务集在 fixture 变成多阶段序列后已经不成立（PLAN 的旧算式 12 任务 × 2 臂 × 3 次作废），要等烟测结论重算。在此之前 `phaseRegistry('armA')` 直接抛错并指向 PLAN，好过悄悄沿用一份已经不成立的任务集。
- **上限建模**：新增 `batchPhases = ['screening','armA','armB']`，`PhaseName = BatchPhase | 'sequence'`，`batchCaps` 改为对 `batchPhases` 归约——**诊断阶段不并入「整批 156 次运行」**，那个数字的含义因此不被烟测的增减污染。`phaseCaps.sequence` 预注册为 **runs 1 / requests 192 / tokens 12,000,000**，取逐阶段预算的理论上界（理由见 PLAN：该阶段只有 1 个 fixture，整批上限对它本就不构成中途制动，取更紧的值只会把一次跑完的烟测变成带 `aborted` 的退出码 1）。测试里 `batchCaps` 由「求和」升级为**按值钉死** `{ runs: 156, requests: 5_200, tokens: 98_000_000 }`。
- **一份口径随之写进 PLAN**：单次 run 预算是**每阶段一份**（每个阶段一次 `agent.send()` → `beginRun` 新建 `RunState`、counters 归零），整条六阶段序列的上界即 192 请求 / 12,000,000 token。某阶段用满 32 次请求会以 `max_steps` 停止并被如实记录，后续阶段仍拿到全新的 32 次额度——**被截断的阶段不能用来判断「需要几个阶段才越过 65,536」**，报告必须单列。
- 验证：`pnpm check`（82 文件）、`pnpm test`（190/190，新增 7 条 `eval-cli` 用例，无失败/跳过）、`pnpm eval:offline`（planned 12、executed 12、accepted 12、rate 12/12，退出码 0）、`pnpm fixtures:check`（13 项、`expected` 全为真，退出码 0）在本机通过；三条 `--plan-only`/拒绝路径见上，均不落盘、不出网、未产生付费请求。提交 `c84c5a1`。

## NX-08e2-1 逐阶段投影观测进入 `RunOutcome.tasks`
- 关联：NX-08e2 的第一步，为烟测准备读数。状态：done（2026-10-01，本地通过）。本次不调用真实模型。
- **为什么需要**：`RunState` 早就带 `removedTaskIds` 与 `estimatedInputTokens`（`src/core/budget.ts`），`agent-loop-runtime.ts` 每次投影都在更新它们，但驱动回传的 `RunTaskDetail` 只含 `taskId/status/counters`——判断「第几个阶段开始触发裁剪」所需的读数在驱动层被丢掉了，真实烟测跑完也答不出结论。
- **新增的逐阶段字段**（`scripts/eval-fixture.ts` 的纯函数 `summarizeStage(events, runId)`）：`estimatedInputTokens`（该阶段最后一次投影）、`maxEstimatedInputTokens`（该阶段投影梯度最大值）、`projections`（投影次数）、`firstPrunedProjection`（第几次投影首次裁剪，1 起；未裁剪为 `null`）、`removedTaskIds`（并集）、`unsentProjections`（有投影但没有对应 `model/start`，即被 `context_overflow` 或 token 预算拦下）、`usageSources`（provider/estimated 分列，R-21 要求的口径）。
- **刻意不做的两件事**：
  - **不改 `session-runtime`**：`RunState.estimatedInputTokens` 的「最近一次投影」是 D-08 的生产语义（恢复时按它重建），为了评测把它改成「本阶段最大值」是在污染生产状态。最大值现算即可。
  - **不复用 `requestTrace`**：它按「当前 task」过滤，同一会话里的更早阶段不在它的作用域内，拿不到这次要的东西；但它对「已发出投影但没有 model/start」的判定方式被照抄过来。
- **一处口径必须写清**：`estimatedInputTokens` 是**裁剪后**的值（`context-runtime.ts` 的 `measure()` 每次基于已裁剪的 `selected` 重算）。裁剪一旦开始，它就钉在输入目标附近，看不出该阶段自身长了多少；「首次裁剪那一次的真实规模」没有落盘，只能由相邻阶段的投影外推。最大值与首次裁剪序号正是为区分这两件事而记的。
- **测试**（`test/eval-runner.test.ts`，新增 3 条）：`summarizeStage` 的三个边界——未裁剪不编造证据、首次裁剪定位与并集去重、既不被别的 run 吸收也不隐藏未发出的投影（含空事件数组不产出 `estimatedInputTokens` 键）。全部用合成日志构造，不起子进程、不碰文件系统。既有的 `pipeline` 序列用例补了 4 条断言：每阶段 `projections > 0`、`max >= 最后一次`、`firstPrunedProjection === null && removedTaskIds.length === 0 && unsentProjections === 0`、`usageSources.estimated === counters.modelRequests`。模拟适配器全序列峰值 13,614，**「未裁剪」在这里是确定性事实**，所以零计数也有断言，而不只是「没被观察到」。
- 验证：`pnpm check`（82 文件）、`pnpm test`（183/183，新增 3 条，无失败/跳过）、`pnpm eval:offline`（planned 12、executed 12、accepted 12、rate 12/12，66 请求，退出码 0）、`pnpm fixtures:check`（13 项、初始 13/13 以退出码 1 失败、参考 13/13 通过、`expected` 全为真，退出码 0）在本机通过。未产生付费请求。提交 `6978f63`。

## NX-08e1-3 fixture 契约与基线回填
- 关联：NX-08e1 的收束。状态：done（2026-09-30）。纯文档，不触碰代码。
- `PLAN` 新增「NX-08e1 多阶段依赖 fixture：`pipeline`」小节：任务形态、六个阶段各自交付什么、依赖是靠什么落地的（公开检查按阶段累积 + 从 02 起断言 `planPipeline` 返回值的回流 + 06 反向解析 05 的渲染格式）、验收仍是终态一次判定、阶段数是唯一可调旋钮、注册表分三份，以及下面的阶段性结论。
- `TASKS` 新增 NX-08e1-1/-2/-3 与 NX-08e2 三行子步骤（含验收与提交边界）与三条「已完成」；NX-08e 行的前置改为「前置设施见 NX-08e0，任务集见 NX-08e1，规模是否达标由 NX-08e2 的烟测判定」。
- `PROGRESS` 的主分支基线由「12 项 fixture」改为 13 项（`pnpm eval:offline` 仍是 12），阻塞项与下一步改写为 NX-08e2。
- **记下一个负面事实，防止阶段数被读成已校验**：用模拟适配器跑完整序列时，逐阶段估算输入是 **11,695 / 12,175 / 12,536 / 12,862 / 13,208 / 13,614**，`removedTaskIds` 全为空——整个序列的峰值 13,614 远低于 65,536 的输入目标。原因不是 fixture 太小，而是模拟适配器在**第一个阶段就应用了全部参考改动**，后续阶段只能回一句话（全序列 22 次请求、16 次工具调用）。这个数字是驱动接线的证据，**不是**「6 个阶段足以触发裁剪」的证据；真实触发点由 NX-08e2 的烟测测量。
- 验证：`pnpm check`（82 文件）、`pnpm test`（180/180，无失败/跳过）、`pnpm eval:offline`（planned 12、executed 12、accepted 12、rate 12/12，退出码 0）、`pnpm fixtures:check`（13 项、初始 0/13、参考 13/13，退出码 0）在本机通过。
- **跨平台证据（本批三个提交共用）**：三个提交一次性推送（`54bb808..c554bab`），[CI 36693778212](https://github.com/BeforeLanding/mini-DSH/actions/runs/36693778212) 在 tip `c554bab` 上 Ubuntu/Windows × Node22/24 四组 success、attempt=1、无重跑。**该 run 只挂在 tip 上，没有逐提交的独立 run**——它证明的是这一批内容整体通过，不是每个 SHA 各自通过；同一批推送未触发 Deploy ECS。后续按提交粒度取证时应在每步提交后立即推送，而不是攒到最后。

## NX-08e1-2 离线覆盖多阶段驱动路径
- 关联：e0-2 明确声明未覆盖的三条驱动行为。状态：done（2026-09-30，本地通过）。本次不调用真实模型。
- **为什么现在才能补**：e0-2 当时没有任何声明 `TASKS/` 布局的真实 fixture，因此 `tasks` 明细、阶段 `counters` 求和、「基础设施失败中止后续阶段」只有单元级与 Harness 级证据；CHANGES 的 e0-2 条目把这一点写成了缺口而不是已验证。`pipeline` 落地后这条路径第一次有真实 fixture 可走。
- 新增三条用例（均在 `test/eval-runner.test.ts`）：
  - **走完整个序列**：`runFixtureTask('pipeline', scriptedAdapter)` 的 6 个阶段各分配一个新的 `taskId`、逐阶段 `completed`、`RunOutcome.status` 取最后一个阶段、终态验收通过、`counters` 等于各阶段逐字段之和。求和是用例里**逐字段独立写的**，没有复用 `eval-fixture.ts` 的 `sumCounters`——用例要给出「应该是多少」，复用实现里的求和等于用结论证明结论。
  - **基础设施失败中止后续阶段**：适配器在第二个阶段的正文出现时抛错。断言 `error` 被记录、阶段明细恰为 `[completed, error]`、第三阶段的正文**一次都没有被下发**（用一个「见过哪些阶段正文」的集合断言，而不是只看阶段数）。继续下发只会把同一个失败重复记成多份，而每一份都会进入阶段累计用量。用例同时固定一个容易误读的性质：`accepted` 是**工作区终态**判定，与这次 run 是否基础设施失败是两件事，模拟适配器在第一个阶段就应用了全部参考改动，所以终态仍然通过；成功率口径把带 `error` 的 run 从分母排除，不接受它作为分子。
  - **筛查上限与清单同步**：`phaseCaps.screening.runs === screeningIds.length`。否则以后新增 fixture 时，运行器会在第 13 个计划任务之前中止阶段（开跑前检查取 `累计 ≥ 上限`），12/12 的历史基线与旧上限就不再对应同一个任务集。
- 验证：`pnpm check`（82 文件）、`pnpm test`（180/180，新增 3 条用例，无失败/跳过）、`pnpm fixtures:check`（13 项、初始 0/13、参考 13/13，退出码 0）在本机通过。未产生付费请求。
- 提交：`ed95858`。

## NX-08e1-1 新增多阶段依赖 fixture `pipeline` 并区分筛查批次
- 关联：NX-08e 的前置；承接 e0-2 的驱动与 e0-3 的规模换算。状态：done（2026-09-30，本地通过）。本次不调用真实模型。
- **为什么需要**：e0 只固化了「一个 fixture = 一个任务序列」的驱动契约，但**没有任何 fixture 声明 `TASKS/` 布局**——现有 12 个全是单任务，离线基线与筛查跑的历史结论都建立在单任务会话上，对照 A 因此无法开跑。
- **fixture 形态**：`test/fixtures/coding/pipeline/`，同仓库、后阶段依赖前阶段产物的六阶段序列。01 解析声明文件（重复声明按出现顺序合并去重、外部依赖、带行号的格式错误）→ 02 拓扑排序（依赖在前，并列取首次出现位置最靠前者）→ 03 环检测（非平凡强连通分量与自环，从顺序中排除）→ 04 分批（批号 = 内部依赖最大批号 + 1，批内沿用 `order` 的相对次序）→ 05 渲染报告（`docs/SPEC.md` 逐字固定的文本格式）→ 06 增量对比（把 05 的格式反向解析回「模块名 → 批号」再比较）。每阶段实现一个模块，`src/pipeline.mjs` 作为编排在每个阶段被接长。
- **依赖是怎么真的落地的**（否则「多阶段」只是文件多）：
  - `check.mjs` 的公开检查**按阶段累积**（`node check.mjs 4` 重跑第 1 到第 4 阶段的全部断言），且每个阶段的断言只使用该阶段应当已经具备的字段，因此同一个受保护的 `check.mjs` 对所有阶段都成立，不需要按阶段换文件。
  - 从 02 起断言 `planPipeline` 的返回值，逼着每个阶段回头改 `src/pipeline.mjs` 并复用它自己上一阶段写的模块；02 阶段只改 `parse.mjs` 时 `check.mjs 2` 仍然失败（已实测）。
  - 06 的反向解析是刻意的闭环：最后一阶段必须回到自己在 05 产出的格式约定上，而不是再挂一个孤立模块。
  - `docs/SPEC.md` 承载全部接口契约，因此每个阶段都会被读到，它同时是阶段间接口的唯一来源。
  - 初始态是返回空值的桩（而不是抛错桩）：部分完成的阶段给出的是断言失败，而不是一个与被测逻辑无关的 `TypeError`。`check.mjs` 因此在初始态以未捕获的 `AssertionError` 退出 1，符合 `check-coding-fixtures.ts` 对 `initial.exitCode === 1` 的要求。
- **参考解与独立验收**：`reference/src/` 是 7 个完整模块；`verify.mjs` 用与工作区示例**不同**的一组输入独立验收——重复声明合并、自环、三元环、外部依赖、批量并列、环成员的间接依赖者、`cycles` 段缩进行不得被当成批次、格式错误的文本必须抛错。
- **注册表分三份**：`screeningIds`（12 个单任务，冻结）、`sequenceIds`（阶段序列）、`fixtureIds`（两者之和）。拆开不是洁癖：`test/coding-fixtures.test.ts` 的逐 fixture 用例只发 `fixture.tasks[0]` 并按单任务断言工作区终态，多阶段 fixture 进这个循环会假失败；`eval:offline` 也必须只跑筛查批次，否则 `phaseCaps.screening.runs = 12` 会把新 fixture 挤掉（开跑前检查取 `累计 ≥ 上限`），12/12 的历史基线随之作废。
- **阶段数取 6 的依据**：e0-3 的实测换算是「与现有 fixture 真实单任务峰值（17,220／27,147）同量级的阶段约需 3～4 个越过 65,536」，6 留出触发后的分叉空间。这是估算值，本轮没有真实模型证据（见 e1-3 记下的负面事实）。
- 验证：`pnpm check`（82 文件，fixture 的 `.mjs` 不进 `dist`，计数不变）、`pnpm test`（177/177，无失败/跳过）、`pnpm fixtures:check`（13 项、初始 0/13、参考 13/13，退出码 0）、`pnpm eval:offline`（planned 12、executed 12、accepted 12、rate 12/12，退出码 0，`runs` 仅含筛查批次）。另用 `dist` 的 `runFixtureTask` 以模拟适配器跑通全序列：`status completed`、6 个阶段均 `completed`、`accepted true`。全部离线，未产生付费请求。
- 提交：`2c61a58`。

## NX-08e0-3 离线量化裁剪触发所需的旧任务规模
- 关联：NX-08e 的前置；依赖 e0-2 的驱动。状态：done（2026-09-30，本地通过）。本次不调用真实模型。
- 新增诊断探针 `docs/context-budget/nx08e-prune-probe.mjs`，与 `review-probes.mjs` / `nx17-gate-probes.mjs` 同类：`pnpm build` 之后 `node` 直接跑，**是诊断脚本而不是回归断言或 CI 门禁**。它装配与 `scripts/eval-fixture.ts` 同一组插件（含 `files`/`bash`，使工具 schema 也进入估算），用一个只回一句话、不调任何工具的本地适配器，在同一 `session` 内按序下发 N 个阶段，逐阶段打印实测估算输入、增量、已裁剪任务数与状态。工作区是临时目录，跑完删除；不执行任何命令。
- **实测结果（本次运行）**：
  - 固定开销（system + 工具 schema + 一条最小 user 消息）**1,909 token**。这是每个请求的地板，不随阶段数变化。
  - 每阶段载荷 2,000 token → 实测增量 2,086，**第 31 个阶段**触发裁剪（此时估算输入 64,411，裁掉 1 个旧任务）。
  - 每阶段载荷 8,000 token → 实测增量 8,086，**第 8 个阶段**触发裁剪（58,427）。
  - 每阶段载荷 32,000 token → **第 2 个阶段**触发裁剪（33,909）。
- **机制确认**：触发后的稳态是「每新增一个阶段就丢掉最旧的一个」——2,000 那组在裁剪点输入停在 64,411 不再增长，说明裁剪确实按整任务移除且只移除到刚好装下为止，与 `context-runtime.ts:68-74` 的循环一致。这正是对照 A 里两臂开始分叉的位置。
- **换算与边界**：把某个阶段的真实历史规模代入「每阶段载荷」列即可得到所需阶段数。现有 fixture 的真实单任务峰值是 17,220（筛查跑 12 个 fixture）与 27,147（NX-08d0-3 的 `merge` 烟测），均含真实工具流量，因此**同量级的阶段约需 3～4 个才能越过 65,536**。探针本身测的是协议与载荷开销，不是真实模型的轨迹，最终阶段数由多阶段 fixture 的实际工具流量决定，以真实测量为准。
- 验证：`node docs/context-budget/nx08e-prune-probe.mjs` 退出码 0，输出如上；临时工作区无残留；除探针文件本身外不改动仓库。`pnpm check`、`pnpm test`、`pnpm eval:offline`、`pnpm fixtures:check` 不受影响（探针不在任何检查链里）。
- **本步的边界**：探针证明的是「累积多少历史会触发裁剪」，**不是**「真实模型在多阶段任务上会走多远」。多阶段 fixture 的阶段数与每阶段规模仍需按真实工具流量确定，并据此重新预注册 `phaseCaps`。

## NX-08e0-2 评测驱动支持同一会话内的任务序列
- 关联：NX-08e 的前置；承接 e0-1 的条件修正。状态：done（2026-09-30，本地通过）。本次不调用真实模型。
- **为什么需要这一步**：对照 A 要求会话中存在已结束且可裁剪的旧任务，而驱动原先每个 fixture 只建一个 session、只发一次 `agent.send()`（`scripts/eval-fixture.ts:42-50`），会话里永远只有一个 task，`removedTaskIds` 恒为空。加大任务不会改变这一点，因为当前 task 恒受保护（见 e0-1）。因此前置是把驱动扩成「一个 fixture = 一个任务序列」，而不是放大某一条任务。
- `scripts/coding-fixtures.ts` 新增 `readTaskSequence`，并新增两种互斥布局：`TASK.md` 是单任务，`TASKS/*.md` 是按**文件名**排序的阶段序列（顺序由 `01-`/`02-` 前缀承载，不由目录项返回顺序承载）。同时存在两者报错、`TASKS/` 里没有 `.md` 也报错，都不静默退回单任务——接受哪一种就决定了模型被要求做多少，而读者很难察觉，这与 e0-1 修正的那条错误判据属同一类陷阱。描述符的 `task` 字段由 `tasks: readonly string[]` 取代（旧字段在单任务与多阶段两种布局下含义不同，保留会让调用点静默只跑第一阶段）。
- `scripts/eval-fixture.ts` 改为对 `fixture.tasks` 逐阶段 `await agent.send()`，每次 `send` 分配新 `taskId`，先前结束的阶段因此成为可裁剪的旧任务。**不使用 `/continue` 串联阶段**：它复用 `taskId`，所有 run 并进同一个受保护组，裁剪同样不会触发（R-12）。验收仍在最后对工作区终态做一次判定，不新增阶段级验收契约。
- `RunOutcome` 增加 `tasks: RunTaskDetail[]`（`taskId`/`status`/`counters` 逐阶段明细），`status` 取最后一个阶段，`counters` 改为各阶段之和——`phaseCaps` 的 `requests`/`tokens` 是整批累计量，按阶段各记一次会把实际用量少算数倍；runs 仍按 fixture 运行次数计。**上限口径因此变化：`armA`/`armB` 的「12 任务 × 2 臂 × 3 次」算式在 fixture 变成阶段序列后失效，必须在开跑对照 A 之前重新预注册。** 本步不动 `phaseCaps` 的任何数值。
- 非 `BudgetStop` 的基础设施失败记入 `error` 后中止后续阶段：会话或工作区已经不健康，继续下发只会把同一个失败重复记成多份，而每一份都会进入阶段累计用量。预算触顶不属于这一类，它由 run 状态承载并继续下一阶段。
- **用例覆盖**：`readTaskSequence` 的顺序（含非 `.md` 文件被忽略）、两种布局并存报错、`TASKS/` 无 `.md` 报错、`TASK.md` 单任务回落；「现有 12 个 fixture 各只有一项 `tasks`」（固定离线基线与筛查跑历史结论不受本步影响）；以及经真实 `agent.send` 的三阶段会话——容量只比装下全部三阶段少 1 token，第三个任务的投影必须裁掉最早的阶段，断言 `removedTaskIds === [第一个 taskId]`、发送的正文不含第一阶段、阶段二与三仍在，且 `session.events` 的既有前缀一条未改（裁剪只作用于请求投影，`/history` 与恢复仍读得到旧阶段原文）。
- 验证：`pnpm check`（82 文件）、`pnpm test`（176/176，新增 3 条用例，无失败/跳过）、`pnpm eval:offline`（12 accepted，退出码 0）、`pnpm fixtures:check`（初始 0/12、参考 12/12，退出码 0）在本机通过。全部离线，未产生付费请求。
- **本步未覆盖**：多阶段路径只有单元级与 Harness 级证据，**尚无声明 `TASKS/` 布局的真实 fixture 走完 `runFixtureTask`**，因此 `tasks` 明细、阶段 counters 求和与「基础设施失败中止后续阶段」这三条驱动行为要等 e0-3 之后的 fixture 才在端到端路径上被覆盖。现在不把该缺口当作已验证。
- 提交：`18a50cc`。跨平台证据：[CI 36690199979](https://github.com/BeforeLanding/mini-DSH/actions/runs/36690199979) 在该 SHA 上 Ubuntu/Windows × Node22/24 四组 success、attempt=1，无重跑；同一批推送未触发 Deploy ECS。e0-3 的提交只改文档与 `docs/` 下的诊断脚本，按 OPS-02 的路径过滤不产生 CI run。

## NX-08e0-1 修正对照触发条件与需求（文档）
- 关联：NX-08e 的前置。状态：done（2026-09-30）。本步只改文档，不触碰代码。
- **诊断**：NX-08e 的前置条件原先被写成规模问题——PLAN、TASKS、PROGRESS 都说「候选任务必须产生超过输入目标 65,536 的历史，否则裁剪永不触发」，据此推出的动作是「构造更大的任务」。该判据不成立：`groupHistory` 按 `taskId` 分组，只有 `taskId === currentTaskId` 的组被标 `protected`（`src/core/context-runtime.ts:29`），`project()` 的循环只移除 `!protected && complete` 的组（同文件 `:68-70`）；新的 `agent.send()` 一律分配新 `taskId`，只有 `/continue` 复用旧 `taskId`（`src/core/session-runtime.ts:135`），而 `/continue` 把所有 run 并进同一个受保护组。因此**当前 task 无论多大都不会被裁剪**，能被裁剪的只有同一会话中更早结束的其它任务。筛查跑 12 个单任务 fixture 的 `removedTaskIds` 全为空是**结构性必然**，与任务规模无关。
- PLAN 的「对照有效性条件」重写为两个条件（会话组成 + 规模），逐条给出源码依据；同时说明对照 B 不受此限制（有界工具输出改变的是当前 task 内部的历史规模，单任务下就会让一臂 `context_overflow`、另一臂完成），两者可测性不对称。并标注 `phaseCaps` 的旧算术在 fixture 变成阶段序列后失效、须在开跑前重新预注册。
- **数值混用更正**：27,147 是 NX-08d0-3 的 `merge` 烟测（9 次请求）的估算输入，PROGRESS 与 PLAN 曾把它记成 12 个 fixture 的最大值；筛查跑的对应数是 17,220。两处现在分列。CHANGES 的 NX-08d、NX-08d0-3、NX-08d0-1 三节各加一条带日期的修正注记，**原始数值与当时的结论都保留，不重写历史记录**；d0-1 的注记另说明该修复是必要条件而非充分条件。
- REQUIREMENTS 新增 **R-21 评测对照的有效性条件**（此前 CHANGES 已记录「REQUIREMENTS 尚无 NX-08 条目」；R-20 已被 NX-17 占用）：两个必要条件、两臂共用模型/prompt/初始状态/验收器/单次预算、整批上限先预注册、报告口径与「每成功任务有效 token 只在成功次数非零时计算」，以及「改变当前 task 完整保护契约须先修订 R-03 与 D-02」的边界。状态写明 NX-08e/f/g 尚未开跑，无对照结论。
- 验证：`pnpm check`（82 文件）、`pnpm test`（173/173，无失败/跳过）在本机通过；纯文档改动不影响运行时行为。
- 提交：`a46d1fc`。

## NX-17 沙箱命令闸门误判修复（筛查跑发现）
- 关联：NX-08d 观察 4；不依赖 NX-08，可独立验收。状态：done（2026-09-30，本地通过，不调用模型）。
- **现象与根因**：合并成一句话会失真，实际是三个互相独立的机制，不是一个规则写错。
  1. **闸门的分词与 shell 不一致**。`"[^"]*"` 不识别双引号内的 `\"`。NX-08d 里被拒的真实命令 `node check.mjs && node --input-type=module -e "…"`（内联脚本含 `//` 注释与 `\"`）在旧分词下裂成 **49 个 token**，其中两个是注释里的裸 `//`，被当作 `/` 开头的绝对路径交给 `resolveInside`，在 Windows 解析为 `D:\` 后判越界；按 shell 语义分词后是 **6 个 token**，没有任何 `/` 开头的 token。这一条单独就修掉了事故本身，与 `//` 的形状规则无关。
  2. **`/` 开头的 token 一律当路径操作数**。`echo //`、`ls -la; // done`、`node -e "// comment"` 的 token 内容确实是 `//` 或 `// …`，不涉及引号，分词修好也不会变。
  3. **出网规则与是否真的取网无关**。规则只在「整个 token 的内容就是一个 URL」时触发，`echo "https://docs.example.com/guide"`、`git log --grep "https://github.com/x"` 因此被判 `unauthorized outbound request`。
- **设计决策**（按要求先定，本步据此实现）：
  - 路径放行判据用**形状是否可能寻址**，而不是出现位置或是否被引号包裹：`/` 开头的 token 只有真的可能寻址时才算路径操作数。纯分隔符串（`//`、`///`）不含路径分量，解析结果是根而非可读内容；双斜杠开头且**首个路径分量含空白**的 token 不是可寻址的根级路径（真实的根级目录名不会以空白开头），该形状来自 JS 注释或脚本正文被引号成词。单个 `/` 仍是真实的根目录操作数，继续拒绝——`ls /` 与 `ls //` 的处理不同是有意为之。
  - 出网规则改用**能力判据**而不是「出现在命令里」：`echo`／`printf` 只写标准输出，无法取网，其参数里的 URL 是数据。同一判据同时限定放宽边界——本段标准输出一旦接到下游命令，下游就可能取网，仍按原规则拦截。
  - **明确不采用**「按网络工具清单收窄」（只在 curl/wget/git/npm/pip… 的操作数位置检查 URL）：清单天然不完整，未列入的工具会从「拒绝」变成「允许」，属于真实的出网拦截削弱。开工前由用户在两个选项中选择能力判据。
- **未放宽的部分（测试逐条固定）**：`..` 逃逸、系统路径（`/etc`、`/dev`、`/proc`、`/sys`、`/root`、`/boot`）、工作区外相对与绝对路径、归一化后仍越界的双斜杠路径（`//etc/passwd`、`//home/user/.ssh/id_rsa`）、UNC（`//server/share/secret`）、`curl`／`wget` 的 URL 与裸主机名操作数、`git clone <url>`、以及 `echo "…" | xargs curl`、`echo "…" | cat > f` 这类把惰性输出接进管道的形状。`..` 规则（整串正则）与系统路径检查的代码完全未改。
- 提交：`5322291`（分词与路径形状）、`c4a02ae`（URL 能力判据）。两者各自独立验证通过，可分别 revert。
- 复跑入口：`node docs/context-budget/nx17-gate-probes.mjs`（`pnpm build` 之后）。它按 NX-17 前、修复中、仍拒绝、NX-18／NX-19 缺口五组打印每条的裁决与理由，并对「约定行偏离目标」和「缺口行仍未达标」分开计数——与 `review-probes.mjs` 同类，是诊断脚本而不是回归断言或 CI 门禁，契约仍由 `test/core.test.ts` 固定。当前输出：24 条约定行全部 `ok`，6 条缺口行 `open`，无契约漂移。
- 验证：`pnpm check`（82 文件）、`pnpm test`（173/173，新增 1 条引号内联脚本用例；无失败/跳过）、`pnpm fixtures:check`（初始 0/12、参考 12/12，退出码 0）、`pnpm eval:offline`（12 accepted，退出码 0）在本机通过。闸门不调用模型，本步全程未产生付费请求。
- **本步未覆盖、已记录为独立待办**（都是改前发现的相邻缺陷，不属于本次「放宽」范围，故不塞进这两个提交）：
  - `..` 族误判（**NX-18**）：`..` 规则是整串正则，会命中引号内的惰性文本——`echo "see ../docs for details"`、`grep -n ".." src/index.ts`、`git log --grep "../ fixes"` 全部被判 `.. path escape is blocked`。这条规则正是用户「放宽不得削弱 `..`」条款点名保护的对象，因此本步没有动它；收紧需要把它改成 token 级的路径操作数判定。
  - 出网拦截的真实缺口（**NX-19**）：`bash -c "curl http://example.com"`、`sh -c "wget …"`、`echo "$(curl …)"`、`nc example.com 80`、`ssh user@example.com`、反斜杠 UNC（`cat \\server\share\secret`）当前**全部放行**。其中反斜杠 UNC 与本步无关，是既有缺口。收口属于「加强」而不是「放宽」，需要单独设计与验收。

## NX-08d 筛查跑（12 任务 × 1，首次真实模型调用）
- 关联：M7；依赖 NX-08d0 的设施与预注册口径。状态：done（2026-09-30，本地实跑，**已调用付费模型**）。
- 命令：`node dist/scripts/eval-screening.js`（即 `pnpm eval:screening`）。模型 `deepseek/deepseek-v4-flash`，服务端回显 `model=deepseek-flash`，官方依据页标注该名为 Flash 当前档位的旧标签，对应版本 `DeepSeek-V4.1-Flash`；端点 `https://api.deepseek.com`，窗口按 PLAN 保守配置 1,000,000。单次 run 预算 32 请求 / 64 工具 / 300,000ms / 2,000,000 token，整批上限 400 请求 / 8,000,000 token，均为预注册值，本步未调整任何一项。证据：`.eval-evidence/screening-full/`（会话日志、`runs.jsonl`、`report.json`，不入库）。
- **原始分子/分母：12/12**。executed 12、notExecuted 0、aborted null、completed 12、stopped 0、errored 0、accepted 12、rejected 0、infeasible 0、rate { numerator 12, denominator 12, excludedInfeasible 0, excludedErrored 0 }。**失败案例：无**——没有拒绝、没有不可行、没有基础设施失败，因此本步没有可报告的失败样本，也没有任何一项需要按不可行口径排除。

| fixture | 状态 | 验收 | 请求 | 工具 | 输入 | 输出 | 合计 | 主动(s) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| boundary | completed | true | 5 | 7 | 15,120 | 1,203 | 16,323 | 7.9 |
| options | completed | true | 5 | 8 | 14,191 | 1,420 | 15,611 | 7.6 |
| interface | completed | true | 4 | 8 | 11,932 | 1,383 | 13,315 | 6.6 |
| normalize | completed | true | 5 | 5 | 12,235 | 911 | 13,146 | 6.4 |
| dedupe | completed | true | 7 | 9 | 22,454 | 1,539 | 23,993 | 10.3 |
| pagination | completed | true | 12 | 17 | 66,650 | 3,294 | 69,944 | 19.6 |
| query | completed | true | 10 | 17 | 58,742 | 4,115 | 62,857 | 21.4 |
| retry | completed | true | 5 | 8 | 16,018 | 2,257 | 18,275 | 11.1 |
| merge | completed | true | 7 | 9 | 41,999 | 6,017 | 48,016 | 27.1 |
| csv | completed | true | 10 | 13 | 77,546 | 7,117 | 84,663 | 35.9 |
| inventory | completed | true | 5 | 9 | 19,141 | 2,299 | 21,440 | 11.2 |
| summary | completed | true | 6 | 7 | 21,848 | 2,745 | 24,593 | 14.9 |
| **合计** | 12 completed | 12 | **81** | 117 | **377,876** | **34,300** | **412,176** | **180.0** |

- **用量核算**：81/400 请求（20.3%）、412,176/8,000,000 token（5.2%），整批上限未被逼近，无中止。输入占 91.7%。81 条 `model/usage` 全部为 `source: provider`，无一条回退到估算。主动时间合计 180.0s，最贵的 `csv` 35.9s；没有任何 run 触及 32 请求或 300,000ms。
- **成本（信息性）**：按核验日期 2026-09-30 的官方价格页，`deepseek-flash` 峰值 input 未命中缓存 $0.30/M、output $1.20/M，本次批次运行于周三 07:00 UTC（峰值）。按输入全部未命中缓存、无缓存折扣估算：377,876 × $0.30/M + 34,300 × $1.20/M ≈ **$0.15**（off-peak 约 $0.08）。远低于 PLAN 按整批上限给出的 3～4 美元量级。适配器不保留 `prompt_cache_hit_tokens`，因此无法从证据里核出缓存命中，该估算对缓存收益是保守的。
- **观察 1：上下文裁剪从未触发**。12 次 run 的 `removedTaskIds` 全为空，最大估算输入 17,220 token，对 65,536 的输入目标有 3.8 倍余量；12 次全部以 `completed` 结束，没有一次 `context_overflow`、`token_budget`、`max_steps`、`timeout` 或 `output_limit`。**该任务集无法用于「全历史 vs 现有裁剪」的对照**，两臂会完全等价。（2026-09-30 修正归因：当时把原因记为「任务太小」，不完整。裁剪只移除同一会话中更早结束的任务，当前 task 恒受保护；而本批每个 fixture 只发一次 `send`，会话里只有一个 task，所以 `removedTaskIds` 为空是**结构性必然**，任务放大也不会改变。规模是第二个条件，不是触发条件。依据见 PLAN 的对照有效性条件。）
- **观察 2：模型确实使用了验证路径**。12 次 run 共产生 20 条 `verification/start`，即模型按工具说明显式声明了 `verification.files`，而不是把退出码当成验收。
- **观察 3：文件纪律**。12 次 run 的 `file/change` 与写工具调用完全一致，只落在各自 fixture 的可编辑文件上（`interface`／`inventory`／`merge` 各改两个文件），工作区没有游离文件，受保护文件无一被改动（验收的 `protectedFilesChanged` 全为空）。烟测那次曾留下一个 `src/__extra_check.mjs` 自测文件，整批没有出现。
- **观察 4：沙箱命令闸门误判（已复现；修复见上一节 NX-17）**。`merge` 的一次请求被 `ToolError: path escapes the workspace` 拒绝，而该命令中不含 `..`。最小复现：`echo //`、`node -e \"// comment\"`、`ls -la; // done` 均被拒。原因是命令分词把独立的 `//` 当作以 `/` 开头的绝对路径，交给 `resolveInside` 后判越界；内联脚本里被转义的引号会破坏 `"[^"]*"` 分组，使 JS 注释暴露成独立 token。模型自行改用其他命令后仍通过验收，损失限于一次请求。同一路径上还发现 `echo \"http://x.com\"` 被判 `unauthorized outbound request`——只要命令里出现 `http(s)://` 即拒绝，与是否真的取网无关。**三个机制均已由 NX-17 修复，见上一节**。
- **结论边界（不可宣称的部分）**：12/12 是这 12 个任务的通过率，不是真实编程任务的成功率。任务集本身有天花板效应——工作区提供公开的 `check.mjs`、任务说明直接给出命令、依赖为零、改动规模在数十行内；本批只有 1 次重复，测不出重复间波动；全程没有触发任何预算与裁剪边界。因此本结果证明的是「真实模型能在这条 Harness 链路上跑通并交付」，不能用于推断模型在长任务、大仓库或上下文压缩场景下的表现。

## NX-08d0-3 真实适配器评测入口与逐 run 证据落盘
- 关联：M7；承接 d0-1 的预算口径与 d0-2 的结论分类。状态：done（2026-09-30，本地通过，含 2 次真实调用）。本次开始调用付费模型。
- NX-08d0-3 / `scripts/eval-screening.ts`（`pnpm eval:screening`）把真实 DeepSeek 适配器接到既有运行器与 fixture 驱动上。四处关键行为：**协议探测**先发一次裸请求与一次走适配器的流式请求，记录服务端回显的 `model`、`finish_reason` 与原始 usage 字段，排在落盘检查之后，证据目录冲突时不会先花钱；**参数显式化**要求 `MINI_DSH_MODEL`／`MINI_DSH_EVAL_MODEL` 给出模型名，缺失即失败，不回退到适配器默认模型列表（首位 `deepseek-v4-pro`，价格约为 flash 的 4 倍），窗口能力官方端点取 1,000,000、自定义端点必须显式声明；**证据落盘**把每个 run 的事件日志写入 `.eval-evidence/<phase>-<scope>/sessions/<fixture>/<sessionId>/events.jsonl`，每跑完一个 run 立刻追加一行 `runs.jsonl`，结束时写 `report.json`，同一范围的记录已存在时拒绝开跑；**成本可见**逐个 run 打印状态、验收结论、请求/工具数与本批累计量。`runFixtureTask` 增加可选 `sessionDirectory`，在 `finally` 里先等写入队列排空再关存储，证据没落盘的 run 不以成功结论结束 / `pnpm check`（82 文件）、`pnpm test`（172/172，无失败/跳过）、`pnpm eval:offline`（12/12，退出码 0）、`pnpm eval:screening --probe-only` 与 `--tasks merge` 均退出码 0 通过 / done / 4d10f2c（本地及四组合 CI 通过）。
- 协议探测结果（核验日期 2026-09-30）：请求体写 `deepseek-v4-flash` 时服务端回显 `model=deepseek-flash`，确认旧名映射成立并留下实际服务名作为证据；原始 usage 含 `prompt_tokens 11 / completion_tokens 1 / total_tokens 12 / prompt_cache_hit_tokens 0 / prompt_cache_miss_tokens 11 / prompt_tokens_details.cached_tokens 0`，满足 `normalizeUsage` 的 `total = prompt + completion` 校验；适配器流式路径 `finishReason=stop`、`complete=true`，thinking 打开时 `reasoningTokens` 如实落在 usage 里。
- 烟测（同一天，`merge`，真实调用 2 次）：两次都 `completed` 且通过独立验收，退出码 0。第一次 5 请求 / 10 工具 / 24,677 token / 主动 20.2s；第二次 9 请求 / 16 工具 / 119,689 token（输入 104,691、输出 14,998，其中 reasoning 10,700）/ 主动 69.7s。差异来源已定位到日志：请求 #2 单次产生 6,820 reasoning token，且输入按请求累积重发（1,664 → 22,752），工具次数不同会把总量放大数倍。第一次烟测的证据目录在布局调整时被删除，只保留终端输出的计数，不作为可复核证据；第二次的完整证据在 `.eval-evidence/screening-merge/`（不入库）。
- 两次烟测都**没有触发上下文裁剪**：`removedTaskIds` 全为空、最大估算输入 27,147 < 输入目标 65,536。这是 NX-08e 任务集选择的前置证据——见 PLAN「NX-08 评测批次上限」中的对照有效性条件。（2026-09-30 修正：27,147 是**本烟测**在第二次调用、9 次请求后的估算输入，属单 fixture 单个 task；它不是 12 个 fixture 筛查跑的最大值，后者为 17,220（见本节上一段 NX-08d）。两者不可互相替代。第二次烟测的 119,689 token 总量是**输入按请求累积重发**的结果，仍属同一 task，同样不产生可裁剪的旧任务。）
- 未纳入本步：筛查跑本身（NX-08d）。脚本不重试、不跳过、不因单次失败中止阶段；未通过验收是评测数据而非脚本失败，只有整批中止或基础设施失败才非零退出。会话日志含模型正文，留在 `.eval-evidence/` 且已加入 `.gitignore`。
- 跨平台证据：`pnpm fixtures:check` 初始 0/12、参考 12/12，退出码 0。三个 d0 提交在本 SHA 上 [CI 36681430450](https://github.com/BeforeLanding/mini-DSH/actions/runs/36681430450) 四组（Ubuntu/Windows × Node22/24）success、attempt=1；同一批推送只产生 CI run，最近一次 Deploy ECS 早于本次推送三小时，未被触发。d0-1 [CI 36680225323](https://github.com/BeforeLanding/mini-DSH/actions/runs/36680225323)、d0-2 [CI 36680420356](https://github.com/BeforeLanding/mini-DSH/actions/runs/36680420356) 同样四组 success、attempt=1。

## NX-08d0-2 评测 run 结论分类与显式成功率口径
- 关联：M7；依赖 d0-1。状态：done（2026-09-30，本地通过）。本次不调用真实模型。
- NX-08d0-2 / `RunOutcome` 增加可选 `acceptance`（`passed`、`exitCode`、验收输出、受保护文件变更）与 `infeasible`，`runFixtureTask` 把 fixture 的完整验收结论原样回传；`summarize` 增加 `infeasible` 计数与 `rate { numerator, denominator, excludedInfeasible, excludedErrored }`，分子只数通过验收的 run，分母排除不可行任务与基础设施失败，两者都单列计数。`accepted`／`rejected` 保持原有原始计数语义，已有消费者不受影响 / `pnpm check`（81 文件）、`pnpm test`（172/172，无失败/跳过）、`pnpm eval:offline`（accepted 12、rate 12/12，退出码 0）通过 / done / 9eb3769。
- 不可行标记只能由 `runPhase` 的可选 `classify` 追加，不能改写已观测的验收结论；`eval:screening` 要求 `--infeasible` 必须同时给出 `--infeasible-reason`，没有理由就不允许使用这个口径。
- 用例覆盖：三类结果各自进入正确的分子/分母（原始计数与口径计数分别断言）、不可行的 run 即使通过验收也不进分子、无结论（`accepted: null`）的 run 仍占分母且不计为通过、fixture 驱动回传的原始验收证据。未重试、未跳过、未引入新的事件或预算契约。

## NX-08d0-1 评测预算接入上下文目标与模型窗口能力
- 关联：M7；首次真实调用前的前置修复。状态：done（2026-09-30，本地通过）。本次不调用真实模型。
- 诊断：`runFixtureTask` 默认只传 `singleRunBudget` 的四项（32 / 64 / 300,000 / 2,000,000），`inputTargetTokens` 与 `contextWindowTokens` 都没有配置。`agent-loop-runtime` 只在 `configured.inputTargetTokens` 存在时才去查模型窗口容量，而 `ContextBudgetRuntime` 对两者均为 `undefined` 时恒判 `fits`——结果是投影从不裁剪、`context_overflow` 从不触发，PLAN「默认参数与行为」的输入目标 65,536 与 1,000,000 窗口在评测路径上从未生效。对筛查影响有限，但会让 NX-08e／NX-08f 的两臂上下文差异一起归零，对照测不出东西。（2026-09-30 修正：**本项修复是必要条件，但不是充分条件**。它让裁剪与 `context_overflow` 恢复可用，可单任务会话里根本没有可裁剪的旧任务，所以只修这一项仍不足以让对照 A 产生差异；对照 B 不受此限。见 PLAN 的对照有效性条件。）
- NX-08d0-1 / 新增 `evalPolicy = {...CLI_BUDGET, ...singleRunBudget}`：预注册四项覆盖在文档默认值之上，其余取 PLAN 文档值（输入目标 65,536、输出上限 16,384、输出预留下限 4,096、容量余量 2,048、请求/审批/收尾超时）。被比较的预算值一项未动。`FixtureAdapter` 增加可选 `capabilities` 并透传给 `llm.register`；查不到窗口容量时 `resolveBudget` 以 `context capacity must be explicitly configured` 硬失败，避免静默退化成无上限。`runFixtureTask` 默认预算改为 `evalPolicy`，run 状态缺失时按基础设施失败报告，不再用非空断言把缺失状态伪装成一次运行结论 / `pnpm check`（81 文件）、`pnpm test`（168/168，无失败/跳过）、`pnpm eval:offline`（12/12 accepted、66 请求，退出码 0）通过 / done / 8fd78a9。
- 用例覆盖：`evalPolicy` 合成与四项取值（防止退回成 `singleRunBudget`）、把输入目标压到 1 token 后经真实 Harness 跑出 `context_overflow`（预算再次丢字段会退化成 `completed`）、适配器不声明 capabilities 时得到明确错误而非 TypeError。
- 观察（非本次改动引起）：离线 token 总数在多次运行间有 ±30 量级抖动，实测 194,439～194,466。原因是 bash 工具结果里的 `durationMs` 位数不同，而工具结果文本参与输入估算；请求数（66）、工具数与逐项验收结论稳定。此前文档记录的单一数值 194,474 不可复现，属同类抖动。

## NX-08c 输入估算误差实验
- 关联：M7；承接 NX-08a／NX-08b 的导出契约与运行器。状态：done（2026-09-30，本地及四组合 CI 通过）。本次不调用真实模型。
- 被测版本：`src/core/token-estimator.ts` SHA-256 `5147905a6feac08718f5d180365f0c1e3ea9ad3b58a4c3da3747c1d65b0aed0f`（ASCII 0.3 / 非 ASCII 1.0 token，每消息 32、每请求 256 开销）。参考方为 DeepSeek 文档提供的离线 tokenizer 包 `https://cdn.deepseek.com/api-docs/deepseek_v4_tokenizer.zip`，`tokenizer.json` SHA-256 `89085f12ef79460ac5f66d1119325ddfc694b4ab209d80bbd81d35f081dc9614`，词表 128,000，工具 `tokenizers 0.22.2 (Rust)`，计数取 `add_special_tokens=false`。**核验日期 2026-09-30**；实测版本与日期固定在 [reference.json](../../test/fixtures/estimation/reference.json)，估算器或语料一变即失配。
- 语料 40 个样本（中文、英文、代码、schema 各 10，共 54,296 字符）取自 Harness 实际处理的文本：8 个编程 fixture 的 `TASK.md`、本仓库源码拷贝、运行期下发的工具 schema，另有 10 个代表性英文输入；来源与重新测量步骤见[语料说明](../../test/fixtures/estimation/README.md)。相对误差 =（估算 − 参考）/ 参考，正为高估；`ratio` 为总量比。

| 类别 | 样本 | 字符 | 参考 token | 估算 token | ratio | 最小 | p25 | 中位 | p75 | 最大 | 低估数 | 最深低估 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 中文 | 10 | 3,931 | 1,928 | 2,467 | 1.2796 | 0.1712 | 0.2294 | 0.2796 | 0.3220 | 0.3630 | 0 | — |
| 英文 | 10 | 4,606 | 991 | 1,386 | 1.3986 | 0.3173 | 0.3273 | 0.3870 | 0.4287 | 0.6296 | 0 | — |
| 代码 | 10 | 32,372 | 8,686 | 10,034 | 1.1552 | −0.1579 | 0.1374 | 0.1613 | 0.1746 | 0.2242 | 1 | −0.1579 |
| schema | 10 | 13,387 | 3,633 | 4,020 | 1.1065 | −0.2252 | −0.0408 | 0.2000 | 0.2439 | 0.3393 | 3 | −0.2252 |
| 合计 | 40 | 54,296 | 15,238 | 17,907 | 1.1752 | −0.2252 | 0.1632 | 0.2308 | 0.3287 | 0.6296 | 4 | −0.2252 |

- 结论一：估算器对自然语言一致保守，且偏差不小——中文 10/10 高估，最小 +17.1%；英文 10/10 高估，最小 +31.7%。中文偏差来自把非 ASCII 记 1.0 token，而官方文档给的中文近似值是 0.6，实测语料约合 0.55。方向安全（不会因低估而溢出），代价是输入目标 65,536 实际装下的内容少于字面值，裁剪比设计更早发生。
- 结论二：结构化工况**不是**一致安全。40 个样本有 4 个低估，最深 −22.5%（`schema/tool-results`），超过容量余量 `max(2,048, 10%)` 的 10%。四个低估样本是 `code/fixture-verify-csv`（−15.8%）、`schema/package-root`（−15.2%）、`schema/tool-results`（−22.5%）、`schema/tsconfig`（−6.7%），共同点是 ASCII 密集且标点、转义或短键密集，实际 token 密度高于 0.3/字符。这与 REQUIREMENTS「估算偏差可导致真实用量超出阈值」一致，现在有了量级：单次请求仍可能超出 `inputTargetTokens`／`contextWindowTokens` 的判断。
- 请求级补充测量（不固定，随请求内容变化）：同一份 JSON 序列化载荷交给估算器与官方 tokenizer，pagination 最大请求 10,002 字符 → 3,094 token，`estimateInput` 报 3,553（+14.8%）；boundary 9,531 字符 → 2,923 token，估算报 3,399（+16.3%）。工具 schema 占这两份载荷字符的 52.3% 与 54.9%，是 `estimateInput` 计费的最大单项。**这不是端到端比较**：该包自带的 `chat_template` 全文 0 次出现 `tools`，渲染结果不含工具定义，无法复现服务端实际 prompt；PLAN「官方依据」中“官方离线 tokenizer 与当前聊天模板的一致性尚未验证”由此得到证实。
- 实现：`scripts/estimation-corpus.ts` 负责语料读取、摘要与分位数计算，`scripts/eval-estimate.ts`（`pnpm eval:estimate`）现算估算值并打印分布，估算器或语料与 `reference.json` 失配时以退出码 1 拒绝静默通过；`test/estimation.test.ts` 的 5 个用例固定语料结构、三方摘要、逐类结论、「自然语言保守 / 结构化非一致安全」两条方向性判断，以及 CRLF 检出下的摘要稳定性（`core.autocrlf` 会把已提交的 LF 在 Windows 检出成 CRLF，摘要与参考值都按 LF 归一后计算）。参考值由官方 tokenizer 一次性测量后固定，生成步骤需要 Python，不进入 CI 与构建依赖 / `pnpm check`（78 文件 → 81 文件）、`pnpm test`（160/160 → 165/165，无失败/跳过）、`pnpm eval:estimate`（退出码 0）、`pnpm fixtures:check`（初始 0/12、参考 12/12）、`git diff --check` 通过 / done / 30939f0；三个提交（NX-08a 65095e0、NX-08b 0ca497f、NX-08c 30939f0）一次性推送，[CI 36672834797](https://github.com/BeforeLanding/mini-DSH/actions/runs/36672834797) 在该 SHA 上四组 success、attempt=1，同一 SHA 无 Deploy ECS run。
- 复现陷阱已写入语料说明：官方 zip 示例代码用 `transformers.AutoTokenizer.from_pretrained(dir, trust_remote_code=True)`，实测在该包上得到 `LlamaTokenizer`，对非 ASCII 返回空 id——`encode("修复索引边界问题")` 得 `[]`，会把中文算成 0 token；必须走 `tokenizers.Tokenizer.from_file`，同一文本在 Rust 路径下可完整往返且中文比例与文档的 0.6 一致。
- 未纳入本步：真实模型调用（NX-08d 起），也不调整估算器系数——预注册参数在真实调用开始前固定，改动需要整体重跑。本步的结论是后续修订估算器的依据，不是已经实施的修订。

## NX-08b 评测运行器与整批上限强制
- 关联：M7；承接 NX-08a 的导出契约。状态：done（2026-09-30，本地及四组合 CI 通过）。本次不调用真实模型。
- NX-08b / `scripts/eval-runner.ts` 固定单次 run 预算与三阶段整批上限，按阶段串行执行并累计 runs/requests/tokens，触顶中止该阶段并在报告中与任务结果分开呈现；`scripts/eval-fixture.ts` 把「插件栈 + 适配器 + fixture 验收」做成适配器注入的驱动，真实适配器与模拟适配器共用同一条路径；`pnpm eval:offline` 用模拟模型跑完筛查阶段 12 个任务 / `pnpm check`（74 文件 → 78 文件）、`pnpm test`（160/160，无失败/跳过）、`pnpm fixtures:check`（初始 0/12、参考 12/12）、`pnpm eval:offline`（planned 12、executed 12、aborted null、completed 12、accepted 12、66 请求 / 194,474 token，退出码 0）通过 / done / 0ca497f；三个提交（NX-08a 65095e0、NX-08b 0ca497f、NX-08c 30939f0）一次性推送，[CI 36672834797](https://github.com/BeforeLanding/mini-DSH/actions/runs/36672834797) 在该 SHA 上四组 success、attempt=1，同一 SHA 无 Deploy ECS run。
- 上限语义由 7 个用例固定：预注册常数与 PLAN 一致且阶段上限之和等于全程上限；上限恰好等于计划数时不误报中止；调小上限复现整批中止且已执行 run 仍保留各自状态与验收结论；请求上限在启动负担不起的 run 之前停止；整批上限不中断已开始的 run，超出量以单次 run 为上界；单次执行失败只记在该 run 上、不中止阶段；运行器经真实 Harness 驱动 fixture 的接线。
- 分工写入 PLAN：单次预算在 run 内由 Agent 循环强制，整批上限由运行器在 run 前后检查；开跑前用“累计 ≥ 上限”、跑完用“累计 > 上限” / done / 本步提交后回填。
- 未纳入本步：真实适配器接入与筛查跑（NX-08d）、估算误差实验（NX-08c）。12 个任务的完整离线跑由 `pnpm eval:offline` 承担，CI 内只以 2 个 fixture 覆盖接线，以免把 12 次真实子进程验收再加进 Windows CI。

## NX-08a 评测导出契约与投影归属
- 关联：M7；依赖 NX-06 的 request trace。状态：done（2026-09-30，本地及四组合 CI 通过）。本次不调用真实模型。
- NX-08a / `context/projection` 增加可选 `requestId`，与随后 `model/start` 同号，使投影归属成为日志中可读的事实而非位置推断；发射端在投影之前生成 id，因此因 `context_overflow`／token 预算未发出的请求仍带 id 可辨。`requestTrace` 优先按 id 归属，旧日志无该字段时退回“同一 run 内最近投影”，并以 `projectionLink` 如实标注所用方式；新增 `unsentProjections` 与每 run 终值 `counters`（补齐 `activeDurationMs`／`approvalDurationMs`），未结束的 run 报 `null` 而不是起始零值。事件信封仍为 version 1，新字段可选并按仓库既有 `optionalString` 惯例校验 / `pnpm check`（74 文件）、`pnpm test`（153/153，无失败/跳过）、`pnpm fixtures:check`（初始 0/12、参考 12/12）通过；新增用例覆盖同一 run 多次投影的按 id 归属、缺 id 的位置回退、未发出请求单列、计数空值、真实循环下投影与 `model/start` 同号及溢出后投影无对应请求 / done / 65095e0；三个提交（NX-08a 65095e0、NX-08b 0ca497f、NX-08c 30939f0）一次性推送，[CI 36672834797](https://github.com/BeforeLanding/mini-DSH/actions/runs/36672834797) 在该 SHA 上四组 success、attempt=1，同一 SHA 无 Deploy ECS run。
- 未纳入本步：整批上限的运行器侧强制（NX-08b）与估算误差实验（NX-08c）。REQUIREMENTS 尚无 NX-08 条目，是否补 R-20 待定。

## OPS-01 停止文档提交触发生产部署
- OPS-01a / Deploy ECS 改为 `vMAJOR.MINOR.PATCH` 标签或手动 ref 触发，目标须属于 main 历史 / 正常用户权限 `pnpm check`（74 文件）、`pnpm test`（150/150，无失败/跳过）、`pnpm fixtures:check`（初始 0/12、参考 12/12）、YAML 结构、三个内嵌 Bash 块、bundle 失败边界与 `git diff --check` 通过 / done / 2ac85bd；[CI 36662206000](https://github.com/BeforeLanding/mini-DSH/actions/runs/36662206000) 四组 success，同一 SHA 没有 Deploy ECS run。
- OPS-01b / 以仅修改 TASKS/PROGRESS 的提交验证纯文档 main push / 首次 CI 36662393361 的 Windows Node22 因 merge fixture 子进程 10 秒超时失败，其余 149 项和三组 matrix 通过；失败作业重跑后四组 success，同一 SHA 始终无 Deploy ECS run，远端 `workflow_dispatch` 必填 ref 可见，`git diff --check` 通过 / done / 92507d4。

## OPS-02 CI push 路径过滤
- OPS-02a / main push 忽略 docs、PROGRESS、README、AGENTS 与 history，PR 仍全量触发 / YAML 结构与触发配置、matrix、concurrency 检查通过；正常用户权限 `pnpm check`（74 文件）、`pnpm test`（150/150，无失败/跳过）、`pnpm fixtures:check`（初始 0/12、参考 12/12）及 `git diff --check` 通过 / done / 263d439；[CI 36662938984](https://github.com/BeforeLanding/mini-DSH/actions/runs/36662938984) 四组 success，纯文档提交 ef46988 的 workflow run 与 check run 均为 0。

## OPS-03 文档当前状态化
- OPS-03a / 将 500 行 PROGRESS 原文移动到 `docs/history/PROGRESS-2026-09-28--2026-09-30.md`，根文件保留当前状态、阻塞、下一步 31 行 / 18 个外部 URL、90 个 SHA 集合一致，7 个相对链接随目录修正后均可达，`git diff --check` 通过 / done / ef46988。
- OPS-03b / TASKS 改为一行状态清单，原 336 行详细行为、验证和证据迁入本文件并保留原 CHANGES 实现总结 / TASKS 降至 39 行，CHANGES 为 430 行；任务 ID、提交 SHA、CI URL、非标题证据行、35 个清单锚点与相对链接检查通过，`git diff --check` 通过 / done / 本步提交后回填。

## OPS-04 修订提交粒度规则
- OPS-04a / 以“可独立 revert 且存在可观察行为差异”为提交边界；同一能力的重复扩展按行为类别分组，不按 fixture 机械拆分；保留三项禁止合并的反模式，并让任务、证据和 PROGRESS 更新职责与新结构一致 / AGENTS 不再含“每完成一个小内容”“多个独立 fixture”或“每提交同步 PROGRESS”，明确保留“同属一个任务”“最后一起跑测试”“减少提交次数”，相关段落一致性检索及 `git diff --check` 通过 / done / 本步提交后回填。

## OPS-05 版本标签与发布锚点
- OPS-05a / 定义不可移动的 `vMAJOR.MINOR.PATCH` annotated tag、精确 SHA 的 main/CI 前置核验、tag push 部署、可选同名 GitHub Release、手动旧 tag 重部署与服务器上一版本回滚 / 7 个 Bash 代码块语法、触发规范必需字段、相对链接、任务锚点及 `git diff --check` 通过；本地 tag 数仍为 0 / done / 本步提交后回填；未创建或推送实际 tag/release。

## NX-06 请求 trace 与编程结果报告
- 关联：M7、R-19；依赖 NX-14/NX-15；状态：done（2026-09-30，本地及四组合 CI 通过）。
- NX-06a / 固定 trace、报告身份/用量/停止语义及隐私、分页边界 / REQUIREMENTS、PLAN、TASKS、PROGRESS 一致，`git diff --check` / done / c5ebe81。
- NX-06b / 已确认事件的请求 trace 核心，正确关联投影、usage、响应、工具结果和证据 ID / 纯回答、批工具、失败/skipped/unknown、重复 toolCallId、缺失末包、分页、续跑/reset 单元测试，`pnpm check` / done / b39e82a。
- NX-06c / 注册有界 `request_trace` 模型工具 / session 必需、参数范围、插件释放、恢复读取与既有工具清单回归，`pnpm check` 和针对性测试 / done / 513de75。
- NX-06d / task_report 增加 session/current run、全部 run、累计 counters/usage 与停止原因 / completed/预算停止/续跑/running/恢复/reset，保留文件 hash 与命令证据，针对性测试及 `pnpm check` / done / 04b4b57。
- NX-06e / CLI `/trace`、增强 `/report` 展示与 README 收尾 / UTF-8 字节分页、恢复后零模型调用、完整 `pnpm check`、`pnpm test`、`pnpm fixtures:check`、`git diff --check` / done / 08158b9；[CI 36661121345](https://github.com/BeforeLanding/mini-DSH/actions/runs/36661121345) 四组 success。
- 每步验证并回填后独立提交、推送，再开始下一步；跨平台结论仅在实际 CI 完成后记录。无真实模型/付费请求。

## NX-05b 将编程任务集扩展到 12 项
- CI-05b-a / 核实 CD 工作流及近期 CI 结论，记录 Windows Node24 的 CLI 输出等待超时证据与修复边界 / 对照 workflow、运行结论和失败日志，`git diff --check` / done / 64f370b。
- CI-05b-b / 只放宽实测慢流程的 CLI 输出等待与测试上限，保留其他等待上限 / `pnpm check` 72 文件、CLI 5/5、全量 147/147、`git diff --check` / done / 83e6396；[CI 36658529725](https://github.com/BeforeLanding/mini-DSH/actions/runs/36658529725) 四组 success，[Deploy ECS 36658656903](https://github.com/BeforeLanding/mini-DSH/actions/runs/36658656903) 实际部署校验通过。
- CI-05b-c / 回填精确 CI/CD 证据与完成状态 / `git diff --check`、最新 main CI 核验 / 本步文档提交后核验，不继续追加自身验收记录。
- 关联：M7；基于 NX-05a 的独立临时工作区、参考解与可信验收器；状态：四类各三项本地及四组合 CI 验收完成（2026-09-30）。上一轮仅完成数量及短任务验收；先前 CI 只证明当时的代码通过。
- NX-05b12a / 修正状态，固定 12 项四类各三的映射、逐步验收与提交边界 / `git diff --check` / done / 73ebb4d。
- NX-05b12b / merge 改为双模块接口任务，与 interface、inventory 构成多文件三项 / 初始 0/12、参考 12/12，遗漏任一模块仍失败，Cordis 工具流程 27/27，`pnpm check` 72 文件 / done / 86e5f9b。
- NX-05b12c / 工作区外验收保护非源码诊断文件，提供大日志定位测试支撑 / 嵌套诊断文件被篡改即拒，`pnpm check` 72 文件、fixture 回归 28/28 / done / 7f59566。
- NX-05b12d / pagination 加入 66 KiB、350 行诊断日志及 grep/续读定位流程 / 线索在第 320 行，初始 0/12、参考 12/12，工具搜索/读取/编辑/重测 28/28，`pnpm check` 72 文件 / done / 222c212 + 2822d79（前一提交漏纳被忽略的日志，后一提交修复并重验）。
- NX-05b12e / query 加入大诊断日志及 grep/续读定位流程 / 线索在第 320 行，初始 0/12、参考 12/12，工具回归 28/28，`pnpm check` 72 文件 / done / dc8ad78。
- NX-05b12f / csv 同范围 / 线索在第 320 行，初始 0/12、参考 12/12，工具回归 28/28，`pnpm check` 72 文件 / done / 7eca20f。
- NX-05b12g / 预算停止与显式续跑的通用测试支撑 / 真实 Cordis 两段运行、已完成工具不重放、skipped 调用后补做，`pnpm check` 72 文件、fixture 回归 29/29 / done / 786e9ae。
- NX-05b12h / dedupe 任务约束与显式续跑 / 首次对象 identity、严格 id 区分、预算停止→继续→独立验收，`pnpm check` 72 文件、fixture 回归 30/30、初始 0/12、参考 12/12 / done / e299adf。
- NX-05b12i / retry 任务约束与显式续跑 / 成功值 0、最终错误 identity、预算停止→继续→独立验收，`pnpm check` 72 文件、fixture 回归 31/31、初始 0/12、参考 12/12 / done / c35a75a。
- NX-05b12j / summary 任务约束与显式续跑 / 负值/零值及原数组保持，预算停止→显式继续→独立验收，检查未重复已执行副作用；`pnpm check` 72 文件、fixture 回归 32/32、初始 0/12、参考 12/12 / done / 0b47d65。
- NX-05b12k / 四类各三总体验收、文档及提交证据 / `pnpm check`（72 文件）、`pnpm test`（147/147）、`pnpm fixtures:check`（初始 0/12、参考 12/12）、三份大日志均被 Git 跟踪、`git diff --check` / done / 53e5aba；[CI 36657576782](https://github.com/BeforeLanding/mini-DSH/actions/runs/36657576782) 四组 success。
- 分类以主要验证场景计：单文件 boundary/options/normalize；多文件 interface/inventory/merge；大文件或日志定位 pagination/query/csv；长任务约束与续跑 dedupe/retry/summary。长任务类须有真实分段运行证据；模拟模型只证明 Harness 流程，不代表自主编程成功率。
- 补齐提交顺序：a 73ebb4d → b 86e5f9b → c 7f59566 → d 222c212、修复 d2 2822d79 → e dc8ad78 → f 7eca20f → g 786e9ae → h e299adf → i c35a75a → j 0b47d65；k 为本步说明。旧 `NX-05b` 记录和当时 CI 保留为历史基线，不把当时通过解释为本轮场景覆盖已验收。
- 精确 SHA 53e5aba222d0c58a446509e53ce4da8c57e5623d 的 [CI 36657576782](https://github.com/BeforeLanding/mini-DSH/actions/runs/36657576782) Windows/Ubuntu × Node22/24 四组 success。远端证据回填为独立文档提交，提交后核验最新 main CI，不无限追加自身验收记录。
- NX-05b0 / 固定九项新增任务及提交边界 / `git diff --check` / done / 56b3c8e。
- NX-05b1 / normalize 任务、初始代码、公开检查、参考解、独立验收与注册 / `pnpm fixtures:check` 初始 0/4、参考 4/4；Cordis 流程回归 10/10；`git diff --check` / done / a11f510。
- NX-05b2 / dedupe 同范围 / `pnpm fixtures:check` 初始 0/5、参考 5/5；Cordis 流程回归 12/12；`git diff --check` / done / 4761987。
- NX-05b3 / pagination 同范围 / `pnpm fixtures:check` 初始 0/6、参考 6/6；Cordis 流程回归 14/14；`git diff --check` / done / 2992fb8。
- NX-05b4 / query 同范围 / `pnpm fixtures:check` 初始 0/7、参考 7/7；Cordis 流程回归 16/16；`git diff --check` / done / 7b97939。
- NX-05b5 / retry 同范围 / `pnpm fixtures:check` 初始 0/8、参考 8/8；Cordis 流程回归 18/18；`git diff --check` / done / 4d35a39。
- NX-05b6 / merge 同范围 / `pnpm fixtures:check` 初始 0/9、参考 9/9；Cordis 流程回归 20/20；`git diff --check` / done / a6db3d2。
- NX-05b7 / csv 同范围 / `pnpm fixtures:check` 初始 0/10、参考 10/10；Cordis 流程回归 22/22；`git diff --check` / done / f60ea98。
- NX-05b8 / inventory 同范围 / `pnpm fixtures:check` 初始 0/11、参考 11/11；Cordis 流程回归 24/24；`git diff --check` / done / b258056。
- NX-05b9 / summary 同范围 / `pnpm fixtures:check` 初始 0/12、参考 12/12；Cordis 流程回归 26/26；`git diff --check` / done / 0c7511d。
- NX-05b10 / 12 项总体验收与使用说明 / `pnpm check`（72 文件）、`pnpm test`（141/141）、`pnpm fixtures:check`（初始 0/12、参考 12/12）、`git diff --check` / done / 73cf6e1。
- 九项逐步覆盖字符串规整、去重、分页、查询编码、异步重试、深层合并、CSV 引号解析、跨文件库存计算与聚合统计。每项工作区仅含任务初始代码与公开检查；参考修改及独立验收留在工作区外。每项验证和提交后再开发下一项，不合并提交。
- 原路线曾设想单文件、多文件、大文件/日志定位、长任务/续跑各三项。此轮 12 项主要覆盖短小确定性任务，后两类分布尚未实现；真实模型能力与这些场景的通过率均未测量。用户明确授权后已推送 `origin/main`；精确 SHA 6d1fd3b439678c5bb5eb518a9c0f2f2607af1032 的 [CI 36655224744](https://github.com/BeforeLanding/mini-DSH/actions/runs/36655224744) Ubuntu/Windows × Node22/24 四组均 success。
- NX-05b11 / 明确授权后的远端验收回填 / 精确 SHA、四组作业与 `git diff --check` / done / 独立文档提交后核验最新 main CI，不循环追加自身验收记录。

## NX-15 编程验证记录与交付报告
- 状态：done（2026-09-30）；关联 R-18，依赖 NX-13/NX-14；本地及四组合 CI 通过。
- NX-15a / 需求、契约和提交边界 / git diff --check 通过 / done / 0a6383f；已推送。
- NX-15b / 验证意图、结果、版本查询与 JSONL 校验恢复 / pnpm check（70 文件）、pnpm test（117/117，无跳过）、git diff --check / done / 4d1ea34；已推送。
- NX-15c / Bash 显式 verification 文件范围、审批后快照和结果记录 / pnpm check（71 文件）、Bash/验证记录 7/7、git diff --check / done / 6744816；已推送。
- NX-15d1 / task_report 文件覆盖与验证分页 / pnpm check（72 文件）、报告/验证/变更 7/7、git diff --check / done / 67acc56；已推送。
- NX-15d2 / CLI /report 和结束交付报告、coding 提示 / pnpm check（72 文件）、pnpm test（122/122，无跳过）、git diff --check / done / a79b495；已推送。
- NX-15c2 / 意图落盘等待后的 cwd 复核 / pnpm check（72 文件）、真实目录换址与 Bash 6/6、git diff --check / done / 4849b16，先于 e；已推送。
- NX-15e / 用户文档、实际提交与本地最终验收 / 正常用户权限 pnpm check（72 文件）、pnpm test（123/123，fail0/skipped0）、pnpm fixtures:check（初始 0/3、参考 3/3）、git diff --check / done / 87360a1；已推送，CI 36653379987 四组合 success。
- 实际提交顺序 a 0a6383f → b 4d1ea34 → c 6744816 → d1 67acc56 → d2 a79b495 → c2 4849b16 → e 87360a1；逐步验收与提交，无 squash/amend/rebase，无付费 API。
- 先前推送遭自动审批拒绝；用户随后明确授权推送至 GitHub 并核验 CI，七个提交已推送 origin。87360a1 的 [CI 36653379987](https://github.com/BeforeLanding/mini-DSH/actions/runs/36653379987) Ubuntu/Windows × Node22/24 四组合 success，每组 check72/test123/123、fail0/skipped0。
- 验证通过仅覆盖显式文件与命令，不自动证明任务验收。本地 Windows/Node24 与本轮精确提交 CI 均有实际证据，不套用 NX-14 的历史 CI。

- NX-15f / 明确授权后的远端验收回填 / 精确 SHA 与四组作业/日志核验、git diff --check / done / 独立文档提交后核验最新 main CI，不继续循环生成验收提交。

## CD-02 修复服务器 GitHub 下载失败
- 状态：传包修复已实测成功；原 19f4ec9 在 git clone 超时，修复提交 c9f452c 已实际发布，最终验收记录提交后核验最新 main。
- CD-02a：离线 Git bundle 发布脚本，分 prepare/activate，构建失败或 SHA 不符不得切换；实现与本地验证完成，两个 Bash 脚本语法、真实 bundle 导入、错误 SHA/路径/REVISION 拒绝、pnpm check（65 文件）/test（107/107）和 git diff --check 通过。Windows 无 flock/原生 Linux 软链，本地锁用 fixture 替身，原子激活验收待 b 的 Linux runner 与服务器实际运行；独立提交。
- CD-02b：done；c9f452c；YAML、触发门槛、精确 checkout SHA/完整历史、两次 main 核验、三段 Bash 语法及 diff 检查通过。[CI 36573968144](https://github.com/BeforeLanding/mini-DSH/actions/runs/36573968144) 四组 success；[CD 36574173979](https://github.com/BeforeLanding/mini-DSH/actions/runs/36574173979) success，Linux fixture 含真实锁/软链原子激活通过，服务器 check65/test107/107（无跳过）、实际 HEAD/REVISION/共享链接/目录身份核验通过。
- CD-02c：真实部署结果记录完成，git diff --check 通过；独立验收文档提交后继续核验最新 main，不把本地记录等同最新部署。
- 保留 production Secrets、严格主机校验、服务器发布锁和旧版本；不读取模型密钥或会话内容。

## CD-01 阿里云 CLI 发布
- 状态：done；自动发布链路已实测通过，用户已确认发布后的启动入口正常进入 CLI，工作区与持久会话目录正确；模型请求先前已在 bootstrap 验证。
- CD-01a：仅手动触发的公网 SSH 连接/运行环境检查；YAML 解析、main/production/手动触发门槛核验、runner/remote 两段 Bash 语法和 git diff --check 均通过；done；73988b5；[公网预检 36550421451](https://github.com/BeforeLanding/mini-DSH/actions/runs/36550421451) success。
- CD-01b：CI 成功后部署对应 main SHA、串行发布和版本切换；done；a632121；YAML、成功/push/同仓库/main 门槛、精确 SHA、并发设置、runner/remote Bash 语法、pnpm check（65 文件）、pnpm test（107/107）和 git diff --check 通过；[CI 36550812881](https://github.com/BeforeLanding/mini-DSH/actions/runs/36550812881) 四组 success。
- CD-01c：首次 CD 实际发布、版本/目录保持核验及回滚说明；done；[Deploy ECS 36550955877](https://github.com/BeforeLanding/mini-DSH/actions/runs/36550955877) 首次因服务器 GitHub 连接中断失败，重试 attempt2 success，服务器 check（65 文件）/test（107/107、无跳过）及 HEAD/REVISION/共享链接/目录身份均通过。操作说明三个 Bash 代码块语法及 git diff --check 通过，回滚仅说明未执行；独立文档提交后报告编号。
- 不将真实服务器地址、公钥、私钥、模型密钥或实际会话日志写入仓库。运行时功能和事件契约保持；发布不重启已有 CLI。
- CD-01d：用户启动核验收尾；用户提供的启动输出确认 launcher、固定工作区、持久会话目录及模型配置正常；仅记录摘要，不保存会话 ID/原始日志；git diff --check；独立文档提交。

## NX-14 结构化命令执行结果
- NX-14a：需求、决策与提交边界；git diff --check；done；33520cf。
- NX-14b：独立前台执行核心、两流有界采集与执行状态；正常用户权限 node scripts/build.js、node scripts/check-syntax.js（67 文件）、node --test dist/test/command-runner.test.js（2/2）、git diff --check；done；8cec028。
- NX-14c：Bash 结构化结果、错误分类与 cwd 审批/闸门；正常用户权限 node scripts/build.js、node scripts/check-syntax.js（68 文件）、node --test dist/test/*.test.js（111/111）、git diff --check；done；3f05f34。
- NX-14d：逐流大日志引用与元信息保留；正常用户权限 node scripts/build.js、node scripts/check-syntax.js（68 文件）、node --test dist/test/tool-results.test.js（6/6）、git diff --check；done；254008f。
- NX-14e1：取消/超时部分日志、终止信号和进程树清理；正常权限 build、syntax（68 文件）、command-runner 4/4、git diff --check；done；556f66a。
- NX-14e2：命令结果 JSONL 恢复、不重放与失败不等于 run 失败；正常权限 build、syntax（68 文件）、tool-results 7/7、git diff --check；done；557f27f。
- NX-14e3：README/路线与实际提交收尾；正常权限 pnpm check（68 文件）、pnpm test（115/115，无跳过）、pnpm fixtures:check（初始 0/3、参考 3/3）、git diff --check；557f27f 的 CI 36651228195 四组合均 success；done；本步文档提交后报告编号。

## NX-13 可靠编辑、冲突与变更交付
- 关联 R-16 / M6；状态：done（2026-09-29），patch 按需延后。
- NX-13a：需求、设计与分步边界；git diff --check；done；6081892。
- NX-13b：有界快照、指纹、唯一替换、原子替换和 diff 核心；pnpm check（62 文件）、node --test dist/test/file-edit.test.js（3/3）、git diff --check 通过；done；4b7cfd2。
- NX-13c：文件工具冲突保护与具体审批；pnpm check（63 文件）、pnpm test（101/101）、git diff --check 通过；done；489bcfa。
- NX-13d：持久基线、逐次结果和任务清单；pnpm check（65 文件）、pnpm test（105/105）、git diff --check 通过；done；97b7653。
- NX-13d2：复核原子替换的权限与内部软链目标稳定性；pnpm check（65 文件）、pnpm test（106/106）、git diff --check 通过；done；d802adc（先于 e）。
- NX-13e：CLI /changes /diff、结束清单与交付说明；pnpm check（65 文件）、pnpm test（107/107）、pnpm fixtures:check（初始 0/3，参考 3/3）、git diff --check 通过；done；4c9501c。
- NX-13f：最终实际提交清单、跨平台 CI 与文档收尾；git diff --check 与提交清单核验；done；仅文档，本步提交后报告编号。
- 每步均先验证、更新证据、独立提交并推送，再推进下一内容；补充的 d2 单独提交，保留全部历史。
- 最终功能提交 4c9501c 的 [CI 36545691239](https://github.com/BeforeLanding/mini-DSH/actions/runs/36545691239) 四组 Ubuntu/Windows × Node22/24 全部 success；本地 107/107 无跳过。核心 test/file-edit.test.ts、工具 test/file-tools.test.ts、持久记录 test/task-changes.test.ts、CLI/model test/cli.test.ts。无付费模型调用。

## NX-12 CI 修复：Windows 短路径 junction
- 状态：本地修复完成，提交后核验远端 CI（2026-09-29）。
- CI-12a / 统一真实路径解析，内部短路径 junction 不误报越界 / 本地复现、短路径及既有越界回归、pnpm check（54 文件）与 pnpm test（87/87，无跳过）、git diff --check 通过 / done / 本步独立提交后报告编号。
- 本步完成并提交后推送，核验 Ubuntu/Windows × Node 22/24 四组 CI；远端未通过前不报告修复已验收。

## NX-12 coding profile 与仓库上下文
- 关联：M6、R-14；依赖 NX-05a。
- 状态：done（2026-09-29）。
- NX-12a / 作用域与加载契约 / 核对 R-14 与 PLAN 的边界、来源、默认限制 / done（仅文档，git diff --check 通过）/ c5dd04b。
- NX-12b / general/coding 身份选择 / 配置、实际 prompt、无规则加载副作用和插件释放 / done（pnpm check 50 文件、pnpm test 75/75）/ 94ad6e0。
- NX-12c / 有界目录规则加载 / 祖先链与作用域、重新读取、超限/UTF-8/路径和软链 / done（pnpm check 52 文件、pnpm test 79/79）/ 3a18c8b。
- NX-12d / 显式项目配置与检查入口 / 最近配置、非 Git/缺失/非法/超限退化、不执行脚本 / done（pnpm check 52 文件、pnpm test 82/82）/ 20e8e3b。
- NX-12e / prompt 与按需工具集成 / 真实 Cordis 模型请求、其他目录查询、工作区边界与工具释放、完整回归 / done（pnpm check 54 文件、pnpm test 86/86）/ 本步提交后向用户报告编号。
- 每步验证并回填后立即提交，提交完成前不开始下一步。a～d 已分别核对提交，e 独立提交完成后报告最终编号；五项均有实际验收证据，不合并历史。

## 提交拆分要求

开始开发前必须在父任务下列出子步骤，每项写明独立结果、验收命令/标准及预计提交范围。每完成一个小内容并验证通过后立即提交，记录实际提交号，再开始下一项；一个父任务或一次用户请求不能代替这份拆分。具体规则见 [AGENTS](../../AGENTS.md) 和 [PLAN](PLAN.md)。

子步骤记录格式：`子步骤 ID / 单一结果 / 验收 / 状态 / 实际提交号`。父任务完成时核对每个子步骤都有实际证据与提交；未完成项保持未完成状态。

## 小内容即时提交规则强化
- 状态：done（2026-09-29，仅文档）。
- 行为：强化开发前拆分、提交后才开始下一步、diff 粒度检查及子步骤提交记录；明确 NX-05a 大提交为反例，保留现有提交历史。
- 验证：AGENTS / PLAN / 本清单规则一致；git diff --check。仅 Markdown 修改，不重跑功能测试。

## NX-05a 三个编程 fixture 与独立验收
- 关联：M6；依赖 NX-01～NX-03。
- 状态：done（2026-09-29）。
- 行为：提供边界修复、小功能扩展、跨文件接口修改的初始代码、中文任务、参考解；每次复制到独立临时目录，以工作区外的可信验收器核验实际文件行为。记录修改前基线并验证模拟模型经真实 Cordis 文件/Bash 工具执行失败→修改→重跑。
- 验证：三个初始状态均失败、三个参考解均通过；错误实现及篡改工作区测试不能伪造通过；重复运行、目录清理及完整回归。
- 证据：test/fixtures/coding 三套任务/初始代码/参考解/verify；scripts/coding-fixtures.ts / check-coding-fixtures.ts；test/coding-fixtures.test.ts 八条回归。正常用户权限 pnpm check（49 文件）、pnpm test（72/72，无跳过）、pnpm fixtures:check 与 git diff --check 通过。初始 0/3、参考 3/3、预设模拟模型工具流程 3/3；完整基线见 test/fixtures/coding/README.md。没有真实模型质量或本轮跨平台 CI 结论。

## F3 崩溃恢复的投影观测一致性
- 关联：R-08、R-11；NX-03、D-08。
- 状态：done（2026-09-29）。
- 行为：只重放当前 run 的 context/projection，去重归并 removedTaskIds，并保留最近一次候选投影的输入估算；不修改原事件，不执行模型或工具。
- 验证：多次投影后、model/start/usage 后及最终投影未发送时崩溃；正常终态恢复、reset 与同 task 新 run 隔离。
- 证据：test/store.test.ts 两条新增回归覆盖七个崩溃窗口、重复恢复、同 task 不同 run 和 reset；test/context.test.ts 核对 overflow 的投影估算；pnpm check（46 文件）、pnpm test（64/64，无跳过）、三个诊断及 git diff --check 通过。

## F2 最终持久化 deadline 与提交不确定性
- 关联：R-05、R-08、R-10；NX-02、D-05。
- 状态：done（2026-09-29）。
- 行为：回答及用量先在主动预算内确认，再提交唯一终态；终态确认受主动 deadline 和可配置收尾上界限制。超时或取消后不返回成功，提交不确定时阻止新 run；恢复以日志事实为准。
- 验证：最终 sync 跨 deadline、挂起、取消/完成竞态、失败和迟到完成；错误路径收尾有界。
- 证据：test/deadline.test.ts 四条新增回归及 test/integration.test.ts 的真实 Cordis/JSONL 恢复；pnpm check（46 文件）、pnpm test（62/62，无跳过）、诊断脚本与 git diff --check 通过。

## F1 输出额度与历史裁剪联动
- 关联：R-02、R-03、R-06、R-07；NX-01。
- 状态：done（2026-09-29）。
- 行为：每个候选完整历史集合先计算实际输出额度；仅在 token、输入目标或窗口不足时移除旧任务。
- 验证：完整历史可保留、窗口等号/差一、裁剪后重算和最低输出不足回归。
- 证据：src/core/context-runtime.ts / agent-loop-runtime.ts、test/context.test.ts；正常用户权限 pnpm check（46 文件）与 pnpm test（58/58，无跳过）通过。

状态：`todo` 待开始、`in_progress` 进行中、`blocked` 有明确阻塞、`done` 验收完成。每个任务完成时填写实际证据；验证方式不是通过证据。依赖项完成且关联决策定稿后再实施。

按 PLAN 的设计和初值实施；本清单只维护行为、验证、依赖、状态和实际证据。功能已实现；当前验收证据见各任务和 PROGRESS。

## CB-00 文档基线
- 关联：M0、D-01。
- 行为：建立仓库规则、专题需求/计划/任务入口与进度，记录源码基线及现有验证。
- 验证：相对链接可解析；需求、任务、决策相互对应；功能状态没有误标完成。
- 状态：done（2026-09-28）。
- 证据：本目录需求/计划/任务文档、根目录 AGENTS.md / PROGRESS.md、README 开发入口；[E-01 基线验证](../../PROGRESS.md)。

## CB-17 恢复开发基线
- 关联：M0.5 前置环境、CB-15。
- 依赖：CB-00。
- 行为：核验固定 pnpm、按锁文件安装依赖，区分沙箱访问限制与真实缺包；恢复完整核心/Cordis 测试基线，不调整版本或绕过签名。
- 验证：pnpm --version 为 11.22.0；pnpm install --frozen-lockfile、pnpm check、pnpm test；package.json/锁文件无非必要变更。
- 状态：done（2026-09-28）。
- 证据：正常用户权限下 pnpm --version 为 11.22.0；pnpm install --frozen-lockfile 退出码 0（Already up to date）；pnpm check 26 文件通过；pnpm test 22/22 通过，无跳过。package.json/锁文件无变更；详见 PROGRESS 的 E-02。

## CB-15 TypeScript 工具链与迁移
- 关联：R-13；M0.5；D-10。
- 依赖：CB-00、CB-17。
- 行为：核验并锁定 TypeScript/@types/node；建立 NodeNext / ES2022 / strict / noEmitOnError / sourceMap；分批迁移 src/test，编译产物运行；更新 CI、配置路径和命令说明。
- 验证：typecheck/build、编译后的 22 条原测试、无预算长循环、插件释放、动态 plugins.config 导入、cwd/.env 语义；Node 22/24 × Windows/Ubuntu；旧产物不能掩盖错误。
- 状态：done（2026-09-29）。
- 证据：四个迁移提交已推送；本地原 22/22 通过；GitHub CI 36504218629 的 Windows/Ubuntu × Node22/24 四组合成功。

## CB-01 配置与预算契约
- 关联：R-01、R-08、R-09；M1；D-03、D-06。
- 依赖：CB-00、CB-15。
- 行为：定稿配置优先级、默认值、零额度语义、状态接口和预算停止异常；run 开始校验并快照配置，成功字符串返回兼容。
- 验证：非法数字/边界、无预算长循环、单次覆盖、两次 run 隔离；校验失败前没有模型/工具请求；配置贯通插件与 send。
- 状态：done（2026-09-29）。
- 证据：调用>Agent>runtime默认的校验快照、有限整数/零额度、类型化BudgetStop、成功字符串；Cordis插件配置注入实际验证。pnpm check / test 42/42 通过。

## CB-02 执行状态与事件
- 关联：R-04、R-06、R-08；M1；D-05、D-06。
- 依赖：CB-01。
- 行为：建立 sessionId / taskId / runId、计数、用量来源和唯一终态；定义可版本化事件，派生聊天消息忽略状态事件。
- 验证：完成/错误/取消各一个终态；计数不会跨 run 泄漏；事件 seq 连续；reset 清理衍生状态；历史仍可派生。
- 状态：done（2026-09-29）。
- 证据：版本化事件、session/task/run ID、模型/工具调度计数、唯一终态与追加 reset 已实现；pnpm check / test 25/25 通过。事件副本隔离，最终文本保留 reasoning。

## CB-11 JSONL 事件存储
- 关联：R-10；M1；D-08、D-09。
- 依赖：CB-01、CB-02。
- 行为：定义存储接口，实现单写入者串行追加、序号/版本、关键事件落盘确认和错误传播；reset 追加事件。
- 验证：重启读取、尾部半条记录、中部损坏、重复/乱序事件、写盘失败后不再调度；日志只用模拟内容；追加成本使用实际样本测量。
- 状态：done（2026-09-29）。
- 证据：纯模拟1000次sync追加样本，约466KB；Windows Node24样本645.25ms，平均0.645ms/次，读取校验3.86ms。可复现脚本scripts/benchmark-store.ts；严格损坏/故障/恢复测试通过，单机样本不保证掉电耐久性。

## CB-03 模型 usage 与输出限制
- 关联：R-06、R-07；M1；D-04。
- 依赖：CB-01、CB-02。
- 行为：核验官方协议，归一化 usage/finishReason，支持可选输出 token 上限；无 usage 返回可解释估算。
- 验证：模拟 fetch/SSE 的完整、usage-only、缺失、重复、流中断；核对输出限制字段；残缺 tool JSON 不执行。
- 状态：done（2026-09-29）。
- 证据：官方 DeepSeek 协议（2026-09-29）+模型SSE模拟：usage-only/重复末包、max_tokens、reasoning不重复计，length/残缺JSON不执行；缺失及中断用统一估算。pnpm check / test 35/35 通过。

## CB-12 Session 重建与未知执行识别
- 关联：R-11；M1；D-08。
- 依赖：CB-02、CB-03、CB-11。
- 行为：从事件重建消息、任务、用量、模型和终态；重放不执行外部工作；识别 started 无结果的 unknown；保留 reasoning，区分不完整流。
- 验证：恢复前后状态比较；工具副作用完成但结果尚未落盘的崩溃样本不自动重试；reset 重启保持；版本不支持报错。
- 状态：done（2026-09-29）。
- 证据：严格事件恢复不重放工具；unknown/skipped、workspace校验、reset重启；流片段250ms或4KiB合并，不派生为完成答案；缺失usage恢复估算。pnpm check / test 35/35 通过。

## CB-04 请求 token 估算
- 关联：R-02、R-06；M2；D-04。
- 依赖：CB-01、CB-03。
- 行为：估算 system、messages、reasoning、schema 和开销；明确输出预留、安全余量和模型容量来源。
- 验证：中文/英文/代码/大 schema 固定样本；容量等号及超一边界；未知容量报配置问题；模型切换重新计算。
- 状态：done（2026-09-29）。
- 证据：完整请求估算+动态余量max(2048,input10%)；显式配置/适配器能力元数据，未知容量拒绝且无历史副作用；模型切换重算。pnpm check / test 39/39 通过。

## CB-05 上下文裁剪与输出投影
- 关联：R-02、R-03；M2；D-02。
- 依赖：CB-02、CB-04。
- 行为：分组完整旧任务/轮次，按目标移除最旧历史；保留当前 task 的所有 run、system 及调用配对；不截短当前过程；无法容纳则 context_overflow。
- 验证：多轮/多工具/reasoning/取消历史无孤立消息；事件原文深比较不变；重复投影确定；大 system、当前输入、当前调用组失败路径。
- 状态：done（2026-09-29）。
- 证据：投影后 input+输出预留+动态余量不超过窗口；必保留集合不容纳时 context_overflow 且零模型调度；原文不变。pnpm check / test 39/39 通过，含等号/超一、模型切换及大输入/system/schema。

## CB-06 步数与工具调用调度
- 关联：R-04、R-08；M3；D-03、D-06。
- 依赖：CB-01、CB-02。
- 行为：模型和工具调度前扣次数，达到限制不再调度；一批工具超额时补齐跳过结果，失败/拒批计入调度次数。
- 验证：0/1/N 步；最后一步完成；三工具剩余一额度；失败工具；下一次 run 恢复；无预算 20 调用回归保留。
- 状态：done（2026-09-29）。
- 证据：0/1/N 模型调度、最后完整回答、最后一步工具跳过；批量工具按额度顺序执行且全部配对，失败计次数；公共失败路径补齐结果。pnpm check / test 42/42 通过，原无预算20工具回归保留。

## CB-07 Deadline 与用户取消
- 关联：R-05、R-08；M3；D-05。
- 依赖：CB-01、CB-02、CB-06。
- 行为：按 PLAN 计单调主动时间，审批暂停且另限 5 分钟，模型请求另限 180 秒；组合 signal 并清理；迟到回调不覆盖终态。
- 验证：可控时钟下挂起模型、审批、工具；取消与超时竞态；超时后无新调度；多工具结果配对；释放后无遗留监听器；非协作工具限制明确。
- 状态：done（2026-09-29）。
- 证据：RunBudgetRuntime 可注入单调时钟、组合signal、主动deadline、模型独立超时、审批暂停与独立超时；阶段复查、资源清理、迟到流忽略，未知在途工具配对。pnpm check / test 45/45 通过；非协作工具仅停止等待，不能保证物理终止。

## CB-08 累计 token 预算接入
- 关联：R-02、R-06、R-07、R-08；M3；D-04、D-05。
- 依赖：CB-03、CB-04、CB-05、CB-06、CB-07。
- 行为：请求前判断剩余额度和输出预留，响应后结算；超限后不调度后续模型/工具，补齐已记录调用的结果。
- 验证：输入重复发送逐次计费；实际/估算两种来源；实际高于预估；失败/取消缺失 usage；零余额、最后额度、多个限制同时命中。
- 状态：done（2026-09-29）。
- 证据：请求前预留完整输入与最低输出、余额降低max_tokens；actual/estimated均累计重复输入，真实超估算停止后续调度并补齐结果；取消/失败保留不确定消耗。pnpm check / test 48/48 通过，验证次数/token/context停止优先级。

## CB-13 预算停止后的 /continue
- 关联：R-08、R-09、R-12；M3/M4；D-08。
- 依赖：CB-05、CB-06、CB-07、CB-08、CB-12。
- 行为：同 task 新 run，每段额度按 PLAN；未执行调用有 skipped 结果，模型重新规划；显示本段和任务累计用量；未知副作用不自动重试。
- 验证：预算停止→continue→完成；不重复用户输入/原工具；上下文保护跨 run；unknown 副作用不自动重试；context_overflow 不因额度刷新被忽略。
- 状态：done（2026-09-29）。
- 证据：续跑核心与CLI /continue实际串联，预算停止→继续→完成；task累计、跨run保护、completed/unknown/unchanged context明确反馈。pnpm check / test 52/52 通过。

## CB-09 CLI 与用户文档
- 关联：R-01、R-08、R-09；M4；D-05、D-06。
- 依赖：CB-05、CB-06、CB-07、CB-08。
- 行为：提供 `/budget`、用量来源和停止原因显示；更新帮助及环境配置说明；保留 /history、/prompt、/reset 语义。
- 验证：命令输出有效配置、最近状态和裁剪范围；模型切换、reset、流式部分输出、预算错误与用户取消区分；不泄漏密钥。
- 状态：done（2026-09-29）。
- 证据：真实Cordis CLI实现 /budget查看/JSON覆盖、/continue、run/task用量与裁剪范围；默认JSONL、session ID恢复、模型/预算设置持久化、reset追加与锁释放；README/.env.example更新。pnpm check / test 52/52 通过。

## CB-10 集成验收与交接
- 关联：R-01 至 R-13；M4。
- 依赖：CB-01 至 CB-09、CB-11 至 CB-13、CB-15。
- 行为：通过真实 Cordis 装配走通有预算 run、停止和恢复；审查配置入口、dispose 和旧契约；同步进度与风险。
- 验证：pnpm check/test；Windows/Ubuntu × Node 22/24 CI；需求逐项有证据；无需 API Key；保留 22 条原测试并增加有意义边界测试。
- 状态：done（2026-09-29）。
- 证据：R-01至R-13逐项证据见PROGRESS E-03；本地pnpm check/test 57/57；功能提交4600379的GitHub CI 36508829785四组合Windows/Ubuntu × Node22/24全部success。模拟模型、真实Cordis/Bash/文件及JSONL恢复；无付费API调用。

## CB-18 实习导向评估与后续规划

- 关联：R-02、R-05、R-09、R-11 的边界复核及后续开发方向。
- 行为：核对源码、测试、远程基线和 CI；复现交叉边界；产出求职导向的完成度、优先级及验收路线。
- 状态：done（2026-09-29，仅评估完成）。
- 证据：基线 ca1e2c4；pnpm check 46 文件、pnpm test 57/57；CI 36514313704 四组合 success；`node docs/context-budget/review-probes.mjs` 输出 F1～F3 诊断值。报告与新任务见 [完成度评估与后续路线](../INTERNSHIP_ROADMAP.md)。
- 后续：F1～F3 尚未修复；原 NX-01～NX-11 经 CB-19 按 coding agent 定位重排，并扩展至 NX-16，功能均为 todo。没有付费模型效果证据，不将规划标记为功能完成。

## CB-19 按 mini coding agent harness 定位修订路线

- 关联：用户明确的仿 DeepSeek Harness 项目定位；CB-18 后续规划。
- 行为：保留原评估及 F1～F3；将下一主线收敛到仓库上下文、可靠编辑、结构化命令结果、验证证据和编程评测；同步 README、需求/计划入口和进度。
- 状态：done（2026-09-29，仅文档修订完成）。
- 证据：核对 runtime-context 通用身份、files 编辑行为、Bash 文本结果及 Loop completed 路径；[开发路线](../INTERNSHIP_ROADMAP.md) 明确 M5～M9、NX-01～NX-16 的范围、依赖与验收。
- 验证：本轮仅 Markdown 变更，32 个本地链接、16 个父任务 ID、M5～M9 阶段及 `git diff --check` 均通过；未重跑功能测试，57/57 为 CB-18 基线结果。
- 后续：M5 加固后进入 M6 最小编程任务闭环；NX-05 先做 3 个 fixture，再扩至 12 个任务。运行时、prompt 和工具行为尚未改动。

## 新任务模板
- ID / 标题、关联需求 / 决策 / 里程碑、依赖。
- 行为：输入、输出、边界、失败与副作用。
- 验证：能观察到的结果及具体方法。
- 状态 / 日期、阻塞（如有）。
- 证据：实际命令、结果、源码 / 测试位置、日志或 CI 链接；没有执行则明确写“未执行”。

### CB-15 分步证据
- CB-15b：src/core/*.ts 与 utils/path.ts，pnpm check / test 成功；22/22 原回归通过，取消工具配对与软链检查保持。
- CB-15c：插件/模型/工具及入口迁移，Cordis Context 增强；pnpm check / test，22/22 原回归通过。
- CB-15d：allowJs=false；原测试及配置迁移，pnpm check / test 22/22 通过；CI 四组合保留，远程四组合已通过，最终功能验收 CI 36508829785。

## NX-07 有界代码读取、搜索与大结果回读
- 关联：M6、R-15；状态：done（2026-09-29）。
- NX-07a / 需求、参数与契约 / git diff --check / done（仅文档）/ 5ef5b2e。
- NX-07b / 分段文件读取 / pnpm check（56 文件）、pnpm test（89/89）/ done / 21ee528。
- NX-07c / 有界搜索和分页 / pnpm check（57 文件）、pnpm test（91/91）/ done / 04f5c4b。
- NX-07d / 持久结果存储与有界回读 / pnpm check（59 文件）、结果存储测试（2/2）/ done / dd45f75。
- NX-07e / 工具预览、Bash 采集及回读集成 / pnpm check（60 文件）、pnpm test（96/96）、pnpm fixtures:check / done / 6c03300。

NX-07b：done；src/core/bounded-text.ts 流式扫描和 src/tools/files.ts 分段读取；pnpm check（56 文件）、pnpm test（89/89，无跳过）通过。覆盖中文/CRLF、空文件、末行、输出/扫描上限、长行、非法编码、二进制、取消及非文件；NX-07a 提交 5ef5b2e。下一步搜索。

NX-07c：done；有界 glob/grep 返回 matches、nextOffset、eof、reason、扫描与跳过统计，支持 path/pattern/includeIgnored。目录流式遍历，条目/深度/单文件/累计扫描/输出有限额。pnpm check（57 文件）、pnpm test（91/91）及 git diff --check 通过。NX-07b 提交 21ee528；本步独立提交后推进结果存储。

NX-07d：done；ToolResultStore 使用 UUID、session 哈希、SHA-256、sync 和串行写入，保存有界采集并按字符边界分页回读；磁盘文件数/总字节有限额。pnpm check（59 文件）、node --test dist/test/tool-results.test.js（2/2）与 git diff --check 通过。覆盖重启、session 隔离、缺失/损坏、UTF-8 偏移、采集/磁盘额度、取消和失败后恢复；NX-07c 提交 04f5c4b。

NX-07e：done；结果投影可释放并保留错误状态，CLI 注册 read_tool_result，Bash 采集改为配置上限并标注超限；存储目录忽略提交。真实 Cordis 模型通过引用读取 40004 字节日志尾部，模型消息/事件只含有限预览；服务重建后同 session 可继续回读；错误日志、采集超限、无 session 兼容、存储失败与插件释放通过。pnpm check（60 文件）、pnpm test（96/96，无跳过）、pnpm fixtures:check（初始 0/3、参考 3/3）及 git diff --check 通过。本地 Windows Node24；未调用付费 API，远端 CI 提交后核验。NX-07d 提交 dd45f75。

- NX-07f / 最终提交与跨平台验收记录 / CI 36538591870 四组 success，提交清单核对与 git diff --check 通过 / done / 仅文档，本步提交后报告编号。

NX-07 最终验收：a 5ef5b2e、b 21ee528、c 04f5c4b、d dd45f75、e 6c03300，均在下一步开发前验证、独立提交并推送。最终功能提交 6c03300 的 [CI 36538591870](https://github.com/BeforeLanding/mini-DSH/actions/runs/36538591870) 四组 Ubuntu/Windows × Node22/24 全部 success。本地 check/test/fixtures 验收见 e；此收尾仅同步文档，无运行时改动，不重复功能测试。

---

## 首阶段实现总结（原 CHANGES）

更新：2026-09-29。开发范围为 `cfee2b5..7110917`，共 21 个独立提交，按用户指定顺序逐次推送到 `BeforeLanding/mini-DSH/main`。随后 `5969363` 清理项目注释。本文件按最终实现整理；逐步验证和历史失败记录见 [PROGRESS](../../PROGRESS.md)。

### 实现结果

项目从 JavaScript、内存会话和无固定预算的 Agent 循环，扩展为严格 TypeScript、可持久化恢复、可解释上下文投影和执行预算的 Agent Harness。CLI 可以查看预算及任务状态，显式续跑预算停止的任务。核心仍依赖服务契约，可替换模型、工具和存储；未注入预算的旧调用继续兼容。

已有 Bash、文件工具、路径/软链闸门、人工审批和 Cordis 插件生命周期保留。本次主要增加运行治理与恢复能力，没有新增自动摘要、自动重试或自动模型切换。

### 1. TypeScript 迁移与工具链

- 固定 TypeScript 7.0.2，增加 Node 类型；采用 ES2022、NodeNext、strict、noEmitOnError、verbatimModuleSyntax 和 sourceMap。
- 核心、插件、模型、工具、入口、插件配置与测试迁移到 `.ts`；`allowJs=false`。构建引导与产物语法检查脚本保留 JavaScript。
- 新增 [contracts.ts](../../src/core/contracts.ts)：明确消息、模型适配器、工具、Agent、执行上下文、回调和版本化事件接口；Cordis Context 使用类型增强。
- `pnpm typecheck` 只检查类型；`pnpm build` 先检查再清理固定 dist 目录并编译；start/test/check 使用编译产物。动态插件配置导入、启动工作目录和 `.env` 加载语义保留。
- CI 使用固定 pnpm 和锁文件，在 Ubuntu/Windows × Node22/24 执行类型、构建、语法与测试检查。

提交：`80bdffd` 工具链 → `a784b76` 核心 → `5104a99` 插件/模型/工具 → `79fb509` 测试与 CI。

### 2. 契约、状态、持久化与 usage

- [budget.ts](../../src/core/budget.ts) 校验未知字段、负数、非有限值和非安全整数。配置按 runtime 默认 → Agent → 单次调用覆盖，并在 run 开始时形成不可变快照；次数和总额度可以为 0。
- 区分 session、task、run；一次新输入开启 task，继续任务开启关联的新 run。记录模型/工具次数、输入/输出/总 token、主动时间、审批时间、裁剪任务 ID 和停止状态。
- 每个 run 只有一个终态；成功调用继续返回字符串，预算停止通过 `BudgetStop` 暴露原因和状态。终态写入未确认时不报告 completed；写盘失败报告错误并禁止新调度。
- [event-store.ts](../../src/core/event-store.ts) 实现带版本、唯一事件 ID 和递增 seq 的 JSONL；单写入者锁、串行追加和 sync。调度模型/工具前确认关键事件已写入，保存 usage、结果与终态后再推进。
- [session-runtime.ts](../../src/core/session-runtime.ts) 从事件恢复消息、状态、模型/预算设置与累计用量，不执行历史工具。reset 追加事件并切换可见历史，不删除原日志或更换 session ID。
- 未开始执行的历史调用补 skipped；已开始但没有确认结果的调用标 unknown，禁止自动续跑。恢复校验工作区、版本、结构、序号及请求生命周期；尾部半条记录须显式备份隔离，中部损坏不能静默跳过，损坏 UTF-8 尾部按原字节保留。
- [deepseek.ts](../../src/models/deepseek.ts) 支持 `max_tokens`、usage-only 流末包、finishReason 和完整响应判定；缓存/推理细分不重复计费，重复末包不重复结算。截断、残缺参数、无效响应或重复调用 ID 不进入工具执行。
- 供应商 usage 优先；缺失或中断使用统一估算，来源明确为 estimated/uncertain。流片段按 250ms 或 4KiB 合并记录，不作为完整 assistant 消息重复派生。

提交：`36f33c0` 配置 → `d024eb8` 生命周期 → `597df26` JSONL → `737f154` 恢复 → `8fe37eb` usage；`87f5941` 补估算与流式日志，`6b9d858` 加固失败边界。

### 3. 上下文管理

- [token-estimator.ts](../../src/core/token-estimator.ts) 估算完整请求，包含 system、历史、reasoning、调用 ID/参数、工具 schema 和协议封装；ASCII 字符按 0.3、其他 Unicode 码点按 1.0，加每消息 32、每请求 256 token 的工程近似。
- [context-runtime.ts](../../src/core/context-runtime.ts) 按完整 task 分组，包含该任务的所有 run；请求前优先移除最旧的完整已结束任务，工具调用/结果不能拆开。
- 保留 system、安全规则、当前用户输入及当前 task 的全过程。投影只改变发送给模型的消息集合，原始事件不变；状态记录被移除的 task ID。
- 输入必须满足输入目标，且输入估算 + 输出预留 + 安全余量不超过模型窗口；余量为 `max(配置下限, ceil(输入估算 × 10%))`。保护集合仍装不下时，以 context_overflow 停止，模型请求次数保持不变。
- 模型容量来自明确配置或适配器能力元数据；切换模型重新计算。官方 DeepSeek 端点默认模型提供保守 1,000,000 token 能力，自定义端点/模型需要显式容量。

提交：`87f5941` 估算 → `6111fcd` 分组 → `63ebe08` 投影 → `b1fb3a3` 容量停止。

### 4. 执行预算

- 模型次数包含最终回答请求和失败请求；工具次数按实际进入工具入口计，失败及拒批也计，skipped 不计。批量调用依序执行，超额度部分补齐结果；最后一次模型请求给完整纯文本可完成，若还要求工具则全部跳过后停止。
- [run-budget-runtime.ts](../../src/core/run-budget-runtime.ts) 使用可注入单调时钟，区分主动运行、审批等待、模型请求期限与用户取消。审批暂停主动计时，但有独立超时；模型和工具都接收组合 AbortSignal，结束清理计时器与监听器。
- 请求前从累计 token 余额预留输入和输出；余额变少时降低输出上限，无法保留最低输出时停止。响应后按 provider 或估算 usage 结算；重复发送的输入逐请求累计，实际超出估算时禁止后续调度。
- 停止状态包括 completed、max_steps、max_tool_calls、timeout、request_timeout、approval_timeout、token_budget、context_overflow、output_limit、cancelled、error。执行入口按取消、主动期限、对应次数、token、容量检查，竞态不产生多个终态。

提交：`c0fcdf6` 次数 → `ddcc2b0` 时间/取消 → `ac9f15a` 累计 token；`6b9d858` 修复工具取消传递与超长计时器边界。

### 5. 续跑、CLI 与恢复入口

- `agent.continue()` 和 `/continue` 在同 task 下创建新的 run，用当前有效配置刷新本段额度，保留任务累计；不追加重复用户输入、不重放已完成工具，模型根据 skipped 结果重新规划。
- completed 任务不能继续；unknown 需要先核验副作用后开始明确的新任务；context_overflow 在上下文配置与模型未变化时拒绝继续，避免仅刷新次数仍重复失败。
- [cli.ts](../../src/plugins/cli.ts) 新增 `/budget` 查看配置/状态和 `/budget {"maxModelRequests":8}` JSON 覆盖；显示 run、task 累计、usage 来源、停止原因和裁剪范围。`/model` 与 `/budget` 设置写入日志，恢复及 reset 保留当前设置。
- CLI 默认写入 `~/.mini-dsh/sessions/<sessionId>/events.jsonl` 并打印 session ID；设置 `MINI_DSH_SESSION_DIR` 覆盖目录，`MINI_DSH_SESSION_ID` 在同一规范化工作区恢复。退出等待写入并释放锁。
- 运行及审批中按 Esc 取消，方向键不会误取消；保留 `/tools`、`/models`、`/model`、`/history`、`/prompt`、`/reset`、`/exit`。
- `.env` 可配置 `MINI_DSH_BUDGET` JSON、`MINI_DSH_WORKSPACE`、`MINI_DSH_AUTO_APPROVE` 和可选 `CONTEXT7_API_KEY`。注释清理后环境示例仅保留实际默认赋值，可选项说明集中在 README 和本文件。

提交：`4c2ec65` 续跑 → `c86b895` CLI/默认持久化 → `4600379` 集成验收 → `7110917` CI 证据。

### CLI 默认值

- 每段模型请求 64 次，工具调用 128 次，主动时间 600,000ms，总 token 2,000,000。
- 输入目标 65,536，最大输出 16,384，最低输出预留 4,096；安全余量下限 2,048。
- 模型请求期限 180,000ms，审批期限 300,000ms；Bash 保留原有 30 秒期限与 32KiB 输出截断。
- 核心未注入次数/总预算时保留旧兼容行为；CLI 主动注入以上有限默认值。人工等待不扣主动时间，task 累计不随 /continue 清零。

### 验证结果与实际边界

- 原 22 条回归保留，增加 35 条有意义边界/集成测试，共 57/57，无跳过；本地类型、构建及 46 文件语法检查通过。
- 功能提交 `4600379`、交接提交 `7110917` 和注释清理提交 `5969363` 的 Ubuntu/Windows × Node22/24 CI 全部成功；[交接 CI](https://github.com/BeforeLanding/mini-DSH/actions/runs/36508994607)、[注释清理 CI](https://github.com/BeforeLanding/mini-DSH/actions/runs/36509575091)。注释清理后本地再次 57/57。
- 真实 Cordis/JSONL/文件工具集成：预算停止后关闭并重建实例再继续，文件 mtime 未改变，证明没有重复写入；任务总计模型 3 次、工具 1 次，内存和磁盘事件一致。
- [benchmark-store.ts](../../scripts/benchmark-store.ts) 可复现 1,000 次纯模拟 sync 追加：Windows Node24 单机约 645ms、每次约 0.645ms、读取校验约 3.86ms。结果是单机样本，不是吞吐或掉电耐久性承诺。
- 测试无需 API Key，模型请求使用模拟；Bash/文件/持久化为真实操作。未做付费模型任务质量实验；token 近似可能有误差，不能作为精确账单或严格费用上限。
- 不遵守 AbortSignal 的第三方工具可能继续执行，结果按 unknown 处理；恢复只重建事件状态，不恢复文件系统快照；失效 writer.lock 不自动清除。
- 未引入摘要、向量记忆、自动重试、费用预算或多 Agent 共享预算；Biome 暂不作为 CI 门槛。

### 本次追加的注释清理

`5969363` 删除已跟踪源码/测试/脚本中的行注释、块注释和行尾注释，同时清理 CI 版本旁注、`.env.example` 注释及 README 运行代码块注释。URL、正则和字符串内容、中文说明文档及实际 `.env` 保留。编译器生成的 sourceMappingURL 是既有调试映射指令，sourceMap 配置继续保留。

完整提交顺序可用 `git log --reverse --oneline cfee2b5..7110917` 查阅；具体设计参数见 [PLAN](PLAN.md)，逐项需求和证据见 [REQUIREMENTS](REQUIREMENTS.md)、[TASKS](TASKS.md)。
