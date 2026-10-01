# 需求与验收

### R-19 请求追踪与编程结果报告（NX-06，已实现并通过本地/四组合 CI）
对当前 task 的已确认事件生成只读、可分页的请求 trace。每条记录关联 session/task/run/request，模型与请求序号、请求前上下文投影、估算及实际/回退 usage、完成状态、后续回答或工具调用，以及工具结果状态。工具调用只展示稳定标识和结果分类；文件变更通过 changeId、验证命令通过 verificationId 关联原始持久事件，不在 trace 中复制提示词、推理、工具参数、正文或命令日志。

编程结果报告在 R-18 文件版本与命令证据之上补齐 session/task/current run、全部续跑段、模型、每段状态/停止原因、每段及任务累计用量。running 与已结束状态分开；completed 仍只表示 run 正常结束，acceptance 仍为 not_asserted。查询只读取当前 reset epoch 的 confirmedEvents，不写新事件、不重放模型/工具；分页不是固定快照，后续事件可能改变总数与页内容。

验收：纯回答、单/批工具、失败/skipped/unknown、重复 toolCallId、缺失 model/end 或 usage、预算停止后续跑、JSONL 恢复、reset 隔离、请求分页与参数上界；模型工具和 CLI 均能查看 trace，报告可核对文件 hash、verificationId、命令退出状态、provider/estimated usage 与停止原因。输出有界，原始 `/history` 继续作为完整审计入口。

### R-18 编程验证与交付（NX-15，已实现并通过本地/四组合 CI）
通过 Bash 显式声明 verification.files（工作区相对路径）启动检查，记录 command/cwd、关联 task/run/tool call、检查前文件 SHA-256/真实位置及结构化命令结果。意图先确认落盘再执行；无结果为 unknown，恢复不重放。普通 Bash 与模型回答不自动成为验证证据。每次检查独立保留，不以最新成功掩盖其他失败。

交付查询结合已确认文件变更与验证记录，区分 passed/failed/unknown、版本 stale/unavailable、未覆盖的变更文件和 run 状态。passed 只表示显式命令成功且所声明文件检查前后版本一致；不声称完整仓库覆盖或任务验收。CLI /report 和结束报告、模型 task_report 可查询同 task 跨续跑/重启记录，reset 隔离。查询输出有界、分页明确。

验收：成功、失败、检查中修改、后续修改、缺失/超限/路径错误、拒批无执行、写入失败无执行、意图未知、JSONL 非法/重复/跨 scope 拒绝、恢复无副作用、续跑/reset、真实工具与 CLI 交付。

状态：R-01 至 R-13 已实现，本地 57/57 与跨平台四组合 CI 通过；证据见 PROGRESS。参数、技术决策和依据统一维护在 [PLAN](PLAN.md)。更新：2026-09-29。

R-14 / R-15 / R-16 亦已实现；NX-13 最终本地 107/107 回归与 Windows/Ubuntu × Node22/24 CI 通过，分步提交和新增验收证据见 TASKS/PROGRESS。57/57 为首阶段历史基线。

R-17（NX-14）已实现：本地 115/115 回归、编程 fixture 基线与最终功能提交 557f27f 的四组合 CI 通过（2026-09-30）。NX-15 独立验证记录与交付报告已实现；本地 123/123 和 87360a1 的四组合 CI 36653379987 通过，分步提交与证据见 TASKS/PROGRESS。

R-19（NX-06）已实现：request_trace、task_report run/usage/停止原因扩展和 CLI `/trace` 本地 `pnpm check`、150/150 回归及 12 项 fixture 基线通过；最终功能提交 08158b9 的 CI 36661121345 在 Windows/Ubuntu × Node22/24 四组合全部通过。

## 目标
让长会话的模型输入可控，让单次执行能按明确预算停止；停止后保留可追溯历史和可继续使用的会话。开发者和 CLI 用户应能解释本次保留了哪些上下文、消耗了多少预算、为何结束。

项目定位为仿 DeepSeek Harness 的 mini coding agent harness；本专题为代码定位、编辑、运行检查及修复迭代提供运行时底座。后续范围见 [编程 Harness 开发路线](../INTERNSHIP_ROADMAP.md)。R-01～R-13 保持首阶段语义：当前 completed 表示 run 完成，尚不表示代码验收通过；独立验证状态、工具结果引用和任务压缩须在对应功能开发前补充契约与验收，不能视为本专题已实现能力。

## 首阶段范围
- 请求上下文投影、旧完整任务/轮次裁剪；当前任务过程不截短。
- 单次 `agent.send()` 的模型请求次数、实际工具调度次数、总运行时间、累计 token 预算。
- 模型输出 token 上限、usage 归一化、估算与实际用量区分。
- 停止原因、执行状态、事件证据及 CLI 可见性。
- 保持现有无预算调用兼容，并用模拟模型完成边界验证。
- JSONL 持久化、session 历史和状态恢复；预算停止后 `/continue`。崩溃后未知工具先检查，不自动重放。
- 先建立 TypeScript 工具链并分批迁移源码/测试，迁移与功能实现分开验收。

## 暂不纳入
模型生成摘要、长期记忆、向量检索、多 Agent 共享预算、费用/币种预算、自动重试及自动模型切换、Web 界面、任意程序位置的精确续执行、未知副作用工具的自动恢复。首阶段裁剪可能丢失旧信息，必须明确展示裁剪范围。

## 需求及可验证行为

### R-01 配置与隔离
预算策略在 run 开始时校验并形成快照，优先级为单次调用 > Agent 配置 > runtime 默认。底层无策略注入的旧调用保持兼容，CLI 注入 PLAN 的有限默认策略。负值、NaN、非有限数和非法整数在发请求前拒绝；次数/累计额度显式 0 表示零额度。单次 run 从零开始计数，task 累计持续记录。输出上限须为正整数，未知端点需明确容量配置。

验收：无预算模式完成现有长循环；零额度不发对应请求或执行工具；相同配置在两次 run 中独立计数；非法配置没有外部副作用。

### R-02 上下文容量
每次模型请求前估算完整载荷，覆盖 system、消息、reasoning、工具 schema 和协议开销；预留输出额度及安全余量。按 `estimatedInputTokens + reservedOutputTokens + safetyMargin <= contextWindowTokens` 检查。模型容量通过明确配置提供，不凭名称猜测。

验收：模拟不同容量、中文、代码和大工具 schema；验证边界及模型切换后的重新计算。估算方法和安全余量可解释，不承诺供应商精确 token 等价。

### R-03 裁剪与协议完整性
优先移除最旧的完整已结束任务/轮次。完整保留 system、安全规则、当前用户请求和当前 task 的所有 run；调用及结果成组保留，不截短当前过程，不自动摘要。投影不修改事件原文；必保留集合无法容纳时 context_overflow 停止，不发请求。

验收：派生消息无孤立 tool/result 或缺失结果，重复投影不修改事件；旧轮次按顺序移除；单个超大当前用户输入、system 或当前工具组无法容纳时明确停止。

### R-04 步数与工具次数
`maxModelRequests` 计模型请求调度次数（含最终回答请求，失败请求也计一次）；`maxToolCalls` 计实际进入工具执行入口的调用，拒批及执行失败也计，预算跳过的调用不计。每次调度前检查，额度用完后不再调度。批量工具按现有顺序执行，超额部分补齐预算跳过结果。

验收：N 步最多调度 N 次；一批三个工具、剩余额度一且仍有模型额度时只调度第一个，其余各有结果；最后允许的一步给纯文本答案可完成，若要求工具则标 skipped 后停止。

### R-05 时间与取消
`maxActiveDurationMs` 计单调主动时间，包含组装、持久化、模型和工具执行，人工审批等待暂停计时。单次审批另限 5 分钟；模型请求另限 180 秒，均见 PLAN。组合 AbortSignal 中止在途工作；阶段返回后复查，结束清理资源。区分 run timeout、approval_timeout、request_timeout 与 cancelled；单工具超时保留原语义。

验收：模拟挂起模型、审批与可取消工具，时间到停止且不再调度；用户取消和超时竞态只记录一个终态；说明不遵守 signal 的第三方工作无法保证被物理终止。

最终提交确认也受主动 deadline 和可配置收尾上界约束；确认超时/取消不得返回成功。已开始终态写入的不确定结果单独暴露并阻止新 run，不能追加第二个终态；重启依据完整日志判断结果。计时快照与提交等待观测的边界见 D-05。

### R-06 Token 核算
`maxTotalTokens` 为单次 run 的累计输入加输出 token。每次请求前根据已核算消耗、输入估算及预留输出额度判断是否能调度；适配器有真实 usage 时据此结算，没有时按同一估算策略回退。请求失败、流中断或取消而缺失 usage 时记录估算及不确定性，不记作零。

验收：完整、缺失、重复及 usage-only 流事件不会漏计或重复计数；请求结束超过限额则停止后续模型/工具调度。估算偏差可导致真实用量超出阈值，不将该预算宣传为严格计费上限。

### R-07 输出额度
通过适配器将输出 token 上限传给模型请求；依据配置及剩余 token 额度限制预留值。供应商字段、reasoning token 是否占输出额度须依据实现时的官方协议确认。

验收：模拟 fetch 核对请求参数；保留现有流式解析、工具 JSON 完整性；长度结束或不完整 tool arguments 不执行残缺工具调用。

### R-08 停止与恢复
终态区分 completed、max_steps、max_tool_calls、timeout、token_budget、context_overflow、cancelled、error，另标 approval_timeout、request_timeout 和 output_limit 等细分原因。记录 sessionId/taskId/runId、有效限制、用量、累计量及裁剪信息。已记录调用有匹配真实/skipped/unknown 结果；预算结束不伪造模型答案。

验收：每次 run 仅一个终态；停止后下一次输入可继续正常请求，`/reset` 清理会话衍生状态但保留 session id。多个限制同时命中的优先级按 PLAN 的 D-05 验证。

### R-09 可观察与回归
CLI 展示预算停止原因和用量，提供 `/budget` 命令查看有效配置与最近执行状态；`/history` 保留原始事件，`/prompt` 保持查看 system 的现有含义。原 `agent.send()` 成功时返回字符串的契约保留，元信息通过事件/状态接口获得。

验收：纯文本答案、流式回调、审批、取消、模型切换、reset 和 Cordis 插件释放均通过回归；新测试不需要 API Key。命令帮助、README 与实际行为一致。

### R-10 JSONL 事件持久化
单 session 单写入者，串行追加带版本及序号的消息、工具、预算和生命周期事件；关键边界等待可靠写入，写入失败停止后续调度。存储后端与 Session 契约分离。reset 通过追加事件改变可见历史，不删除日志或复用序号。

验收：写入后重启可读；顺序和唯一 ID 可校验；写入故障没有后续工具副作用；尾部半条事件与中部损坏明确区分；测试数据不含真实凭证。

### R-11 状态恢复
重放仅重建状态和消息，不执行工具或模型；识别 completed、skipped、unknown。工具已开始但结果缺失时标记 unknown，不能当成未执行。保留适配器所需 reasoning；部分流式内容不伪装为完成响应。

验收：恢复前后任务、消息、计数和状态一致；崩溃窗口样本不重复写文件；版本不支持或中间损坏时明确报错；reset 在重启后仍生效。

### R-12 预算后继续
`/continue` 继续同一 task，建立关联的新 run，不重放完成工具；预算停止时补齐明确未执行结果，继续由模型重新规划。显示本段及任务累计用量。完整当前过程跨续跑保留；上下文不足不会因续跑自动解决。

验收：达到次数预算→停止→继续→完成；新段分配 PLAN 额度，任务持续累计；不重复用户输入或旧工具；跨 run 保护当前任务；unknown 不自动重试；completed 和配置未调整的 context_overflow 有明确反馈。

### R-13 TypeScript 基线
新开发使用 TypeScript，tsc strict 检查并编译 ESM，由 Node 运行产物；分批迁移现有源码及测试，迁移时不改预算行为。JSONL/模型/工具输入仍运行时校验。

验收：typecheck/build 成功，生成入口和配置路径正确，现有 22 条行为测试保留并通过；Node 22/24 × Windows/Ubuntu；无隐式 any 掩盖核心事件/状态契约；计划命令落地后同步 README/AGENTS。

### R-14 编程身份与仓库上下文（NX-12）

通过可配置 coding profile 注入编程行为：检查相关代码和已有改动，遵循目录规则，作必要修改，按任务选择检查，依据真实结果交付。通用模式保留。工作区是读取边界；当前目录必须位于其中，不向工作区外加载父目录规则。

初始上下文只查询工作区至当前目录的祖先链，不递归扫描。AGENTS.md 按父目录到子目录加载，标注相对路径、作用域和加载来源；深层规则只影响其子树。编辑其他目录前可按需查询该目录上下文，不改变文件/Bash 工具的实际 cwd。规则是项目指导，不能扩大 Harness 权限或替代审批。

显式 package.json 配置、tsconfig.json/锁文件存在性及检查脚本可发现并标注来源；不执行包管理器、脚本或 Git 命令。非 Git/无配置/无规则目录可正常退化；不猜测检查已通过。加载错误和体积超限须可解释，不能把部分规则静默当完整规则。

验收：coding/general 选择与释放；根/子目录作用域、来源与动态重新读取；越界/外指软链拒绝；规则超限明确失败；配置缺失、损坏或超限明确退化；真实 Cordis 请求包含上下文且零脚本自动执行。原有预算、审批、事件与成功返回契约保持。

### R-16 可靠编辑与任务变更（NX-13）
read_file 对可编辑大小的文件返回完整字节 SHA-256；edit_file/write_file 支持 expectedHash（新建用 missing），审批前及提交前核验版本。拒绝重复匹配、非法 UTF-8、二进制、超限、取消和非普通文件；保持 CRLF、Unicode、权限，以同目录临时文件替换，失败不留下半写目标。审批提供具体范围、有界 diff 和指纹；不承诺文件系统级比较交换或跨文件事务。

Session 按 task 持久记录相关文件的首次观察基线、编辑意图与逐次结果。意图先落盘再写文件；未确认结果标 unknown，恢复不重放。任务 diff 从首次观察或首次编辑前的现场内容计算，保留用户已有修改；外部变化、失败与 unknown 分别展示，不将 Git 全工作区 diff 归到 Agent。非 Git 目录同样工作；Bash/外部工具修改不自动归到文件工具。CLI 提供 /changes 与 /diff，运行结束展示清单；截断明确。

验收：审批冲突、读取后冲突、覆盖/新建竞态、CRLF/Unicode、取消、写入失败、逐文件部分成功、同 task 续跑/重启/reset、已有 dirty 内容和非 Git 目录；模型闭环和 CLI 可见性。patch 暂不增加。

## 发布验收
### R-17 结构化前台命令（NX-14）
Bash 返回 command、经过路径闸门的 cwd、status、exitCode/signal、durationMs、timedOut/cancelled 以及分别采集的 stdout/stderr（text、bytes、truncated）。非零退出、启动失败、超时和取消均保留已采集日志并标为工具错误；拒批、非法输入或路径拒绝仍为执行前工具错误，不伪造进程结果。审批展示实际 cwd，审批后复查真实路径。

单次前台执行默认 30 秒、两流合计采集 8 MiB，配置可调整；截断后继续排空管道。大日志各流使用 session 隔离的不透明引用，命令元信息始终留在模型/事件内容中；采集、预览和存储截断分别明确，存储失败保留执行结果并报告日志不可用。恢复只重建既有结果，未知命令不自动重放。保留取消和进程树清理，不增加后台服务、交互终端或 NX-15 验证状态。

验收：成功/非零/信号/启动失败，两流及 Unicode 截断，合法子目录/越界/软链/审批换址，拒批无副作用，超时/取消部分日志和子进程清理，引用回读/重启/隔离/存储失败，模拟模型与 JSONL 恢复闭环。

### R-20 命令策略闸门（NX-17、NX-19、NX-24、NX-26）
命令策略在 Bash 执行前做词法检查，拒绝 sudo/su、递归删除、`curl`/`wget` 管道进 shell、`..` 逃逸、系统路径（`/etc`、`/dev`、`/proc`、`/sys`、`/root`、`/boot`）、工作区外路径与软链越界、反斜杠 UNC 形状（`\\server\share`、`\\?\C:\…`、`\\.\pipe\…`），以及不在 allowHosts 内的出网目标。分词按 shell 语义处理引号，双引号内的 `\"` 不提前闭合，闸门只检查 shell 实际会交给程序的 token。判据取形状与能力，不取出现位置：`/` 开头的 token 只有可能寻址时才算路径操作数（单个 `/` 是真实根操作数并继续拒绝，`//` 这类纯分隔符串与「首个路径分量含空白」的任意前导斜杠形态不算）；`echo`/`printf` 只写标准输出，其参数里的 URL 是数据，仅当该段标准输出接到下游命令时才按出网拦截。

命令整串交给 `bash -lc` 执行，因此 NX-19 起出网检查覆盖 shell 真正会执行的嵌套文本：单引号之外、未被反斜杠转义的 `$(...)` 与反引号内容；shell（`sh`／`bash`／`zsh`／`dash`／`ksh`，含 `env`／`nice`／`xargs` 等包装形式）的 `-c` 参数（跳过 `--`，只取紧随的那一个参数）；`eval` 的拼接参数。三者作为独立片段递归检查，理由带来源前缀（`in command substitution:`、`in backtick substitution:`、`in shell -c argument:`、`in eval argument:`），且递归保留 allowHosts 等**全部**语义——不得见到取网工具即拒绝。取网工具集在 `curl`／`wget` 之外扩展为一份**尽力而为、不承诺完整**的清单（`nc`、`netcat`、`ncat`、`telnet`、`ssh`、`sftp`、`scp`、`rsync`、`ping`、`dig`、`nslookup`、`host`），各自按**操作数模型**取目标：`curl`／`wget` 只看形状像目标的位置参数；`ssh`／`nc`／`ping` 这类取第一个非旗标位置参数（其后的位置参数是远端命令，不检查）；`scp`／`rsync` 只认 `[user@]host:path`，裸文件名不是目标。取网工具中「取值不是网络目标」的旗标（`curl -o`、`wget -O`、`ssh -i` 等）之后的 token 不做主机判定，但仍做路径判定。递归深度上限 3、单次命令片段数上限 32，**超限即拒绝并给独立理由**，不与出网拒绝共用理由串。

NX-24 起环境展开按 shell 的**引号与转义**语义进行，不再是对整串做一次引号盲的替换：单引号内不展开（`echo '$HOME'`）、`\` 之后的下一个字符不参与展开（`\$NAME` 是字面量，而 `\\$NAME` 里的 `$` 仍是裸的、仍展开）；双引号内**照旧展开**（`cat "$HOME/.ssh/id_rsa"` 必须继续被拒——展开是特性）。`~` 走同一趟扫描。同一条命令串里由 shell 自己绑定的名字**优先于** `process.env`：`for NAME in <词表>` 与命令段起点的 `NAME=<字面量>` 会被收集并替换；`for` 的候选值必须**逐项**通过形状判定（不是绝对路径或盘符、不含 `..` 分量、不含会被 shell 再解释的字符），任一项不通过即整条拒绝，**理由与「未定义环境变量」不同串**。`read NAME` 的取值静态不可知，不绑定；两者都没有的名字仍按未定义环境变量拒绝。

NX-26 起**命令段起点的判定认 shell 的保留字**：`if`／`elif`／`while`／`until`／`do`／`then`／`else` 之后**紧随的一个** token 也按命令词处理，取网工具的操作数模型在那里同样生效。保留字只在**自身处于命令段起点**、且是**原样未被引用、不含路径分隔符的字面词**时才算数——`echo do curl example.com` 里的 `do` 是实参，`"do"` 与 `./do` 都不是保留字。该前视只作用于**紧随的一个 token**，因此 `<保留字> <rest>` 与把 `<rest>` 写在首 token 位置判定完全一致：本项不引入比顶层更强的检查。闭集以外一律不算（终结符 `fi`／`done`／`esac` 之后没有新命令，`case` 后面的词是主语，`in`／`!`／`time` 不引入命令位）。

验收：`..`、系统路径、工作区外路径、软链、递归删除与 `sudo` 在放宽前后均被拒绝；归一化后仍越界的双斜杠路径、UNC 路径、`curl`/`wget` 的 URL 与裸主机名操作数、`git clone <url>`、接进管道的惰性输出仍被拒绝；注释形状的 `//`、带转义引号的内联脚本、`echo`/`printf` 的 URL 参数被放行；allowHosts 语义不变。另加（NX-19）：`-c`／`eval` 内取网（含单引号形式与 `env`／`nice`／`xargs` 包装）、`$(...)` 与反引号内取网、`nc`／`ssh`／`scp`／`rsync`／`ping`／`dig` 的裸主机或 `[user@]host:port`／`host:path` 操作数、反斜杠 UNC 均被拒绝；`curl -o <文件名> <已授权主机>`、`wget -O <文件名> <已授权主机>`、`ssh -i <密钥文件> <已授权主机>`、`nc -l <端口>`、单引号内的 `$(...)`、被反斜杠转义的 `$(`、`$((...))` 算术与 `printf '\n'` 被放行；嵌套片段内的 allowHosts 语义与顶层一致；超深或超量的嵌套按上限理由拒绝。另加（NX-24）：`echo '$HOME'`、`node --input-type=module -e '… $c …'`（单引号内）、`echo \$HOME`、`echo "\$HOME"`、`sed -n "…,\$p" …`（转义）、`for f in src/*.mjs; do echo "=== $f ==="; cat "$f"; done`、`for n in 07 08 09 10; do node tmp-verify-$n.mjs > r$n.log 2>&1; done`、`kind=local; echo $kind`、`echo '~'` 被放行；`node -e "show('a: b$ad')"`（双引号内未转义、未在本串绑定，bash 真的会展开成空串）、`cat $MINI_DSH_UNSET_VAR/file`、`read x; echo $x`、`for f in a /etc/passwd; do cat $f; done`（理由 `/unsafe for loop value/`）、`X=/etc/passwd; cat $X`（理由 `/unsafe assigned value/`）仍被拒绝；`cat "$HOME/.ssh/id_rsa"`、`cat $MINI_DSH_TEST_ROOT/../etc/passwd`、`echo ../secret`、`ls /`、`ls //etc`、`cat //home/user/.ssh/id_rsa`、`cat //server/share/secret`、`node -e "//comment"` 的判定逐条不变；`awk '/^## 11/,/^## 12/' f`、`sed -n '/^## *9/,/^## *10/p' f`、`awk '/stage(7|7)|phase 7/{f=1} f' f` 被放行，`cat "/Program Files/secret"` 是本轮**接受的连带**（首分量含空白的 POSIX 根路径不再算路径操作数，与既有 `//` 形态同一取舍）。另加（NX-26）：`for f in a b; do curl example.com; echo $f; done`、`if curl example.com; then echo ok; fi`、`if true; then curl example.com; fi`、`if true; then echo a; else curl example.com; fi`、`while curl example.com; do echo x; done`、`until curl example.com; do echo x; done`、`echo a | for f in b; do curl example.com; done`、`for f in a; do curl -o out.txt example.com; done`、`do curl example.com` 均被拒绝（理由 `/unauthorized outbound request/`）；`echo do curl example.com`、`printf do curl example.com`、`echo "do curl example.com"`、`"do" curl example.com`、`./do curl example.com`、`/usr/bin/do curl example.com`、`case a in a) echo hi;; esac` 被放行；`for f in a; do echo https://example.com; done` 与 `for f in a; do echo bash -c "curl https://evil/x"; done` 由拒绝变放行（**两条记录在案的净放宽**：`commandWord` 从此是 `echo`，与顶层同形状判定一致）；`for f in a; do echo https://example.com | cat; done`、`for f in a; do echo $(curl https://evil/x); done`、`for f in a; do bash -c "curl https://evil/x"; done`、`do bash -c "curl http://x"` 仍被拒绝；循环体内的 allowHosts 语义与顶层一致；`X=do; $X curl example.com` 是本轮**接受的过拒**（展开先于分词，展开出的关键字被当保留字）。

已知覆盖边界：`..` 判定仍是整串正则，引号内的惰性文本同样命中（NX-18）。出网拦截是**形状启发式，不是完备解析**，以下结构性不在覆盖内：`node -e`／`python -c` 等程序字符串里的取网、脚本文件内容（`bash script.sh`）、管道解码后再执行的形态（`echo <base64> | base64 -d | sh`）、here-doc 正文、未列入工具集的取网程序。此外，「整 token 恰为 URL 即拦截」的既有规则不区分该 URL 是请求目标还是数据（NX-23，同一条语义两种写法结果相反即其证据）；here-doc 正文仍被当命令词（NX-25，`cat <<'EOF'` 的正文在 shell 里是纯文本）；子 shell 与分组 `( … )`／`{ …; }`、`case … in X)` 的臂体、以及 `exec` 与赋值／重定向前缀仍不引入命令段起点（NX-30，与 NX-26 同一个「未跟踪算子」机制，NX-26 只补了保留字这一支）；Git Bash 的 `/tmp` 与 `node:path` 的解析不一致，`/tmp/...` 在 win32 上被判为工作区外（NX-27）；被引号成词的正文以 `<字母>:\` 开头时会被当成盘符路径（NX-28）；正则字面量（`assert.match(x, /missing/)` 里的 `/missing`）与真实绝对根路径形状完全相同，没有任何可用判据——闸门在这里与 shell 一致，只是拒因不够明确（NX-29）。另须写明：NX-24 只放宽到「shell 不会展开它」为止——**双引号内未转义的未定义变量照旧拒绝**，因为 bash 会把它们变成空串、静默改坏命令。NX-26 另有一处**接受的过拒**：环境展开先于分词，因此由**本串内刚绑定**的字面量展开出来的保留字（`X=do; $X curl example.com`）会被当成保留字，而 bash 不会在展开后重新识别保留字——方向是过拒，与 `cat "/Program Files/secret"` 同一处置。命令策略用于防止误操作，审批负责确认执行，两者都不是操作系统隔离。

### R-21 评测对照的有效性条件（NX-08）
真实模型对照用于比较上下文策略，不用于宣称行业泛化。对照成立必须同时满足两个条件，缺一即两臂等价、不得出具结论：

- **会话组成**：被比较的差异必须出现在两臂实际会产生差异的位置。裁剪只移除同一会话中更早结束的任务，当前 task 与 `/continue` 的续跑段恒受保护（R-03、R-12）。因此「全历史 vs 现有裁剪」（对照 A）要求会话中存在**已结束且可裁剪的旧任务**——单任务会话无论上下文多大，两臂的请求投影完全相同。
- **规模**：这些旧任务的累计估算输入必须足以让容量判定为假，裁剪才会实际发生。

对照另有下列强制约束：两臂共用同一模型、同一 prompt、同一任务初始状态、同一验收器与同一单次 run 预算（请求数是约束，token 总额是兜底）；整批请求/token 上限必须在开跑前预注册，开跑后只能整体重跑，不得单独调整某一臂或某次重复，调整须在报告中说明；报告必须给出原始分子/分母、重复间波动、失败案例、provider 与 estimated 用量分列，以及不可行项。每成功任务的有效 token 只在成功次数非零时计算，避免「提前失败所以更便宜」被读成优化。

验收：选定任务前先实测该任务集能否满足上述两个条件；不满足时不得开跑对照，应如实记为不可行或先改造任务集。同一批推送中两臂的事件日志、`runs.jsonl` 与 `report.json` 可复核。改变「当前 task 完整保护」契约须先修订 R-03 与 D-02，不得作为评测副作用顺带实施。

状态：触发条件与预注册要求已固化（2026-09-30）；NX-08e／f／g 尚未开跑，尚无对照结论。

R-01 至 R-13 均有真实测试证据；类型检查、构建、check/test 通过；CI 四种组合通过后才能声称跨平台验证完成。旧契约及新增停止、恢复、继续均覆盖。

## 开发基线与后续核验
参数、估算、存储、计时和续跑语义见 PLAN，按用户授权采用。具体 TS/@types/node 版本、依赖类型兼容和协议回归在工具链/适配器任务核验；真实任务实验调整输入规模与预算，不要求用户逐项选初值。

### R-15 有界读取、搜索与结果回读（NX-07）
文件读取支持起始行和行数，输出带行号、续读位置及截断原因；内存读取和扫描字节均有限额。搜索支持目录、匹配模式和分页，限制遍历条目、单文件/累计扫描字节、匹配数和输出字节；默认忽略 .git、node_modules、dist，允许显式包含。二进制/非法 UTF-8 文件明确跳过，越界路径仍拒绝，取消及时生效。

大工具结果以有限预览和不透明引用进入模型/事件；完整采集内容另存，按 session 隔离并支持重启后有界回读。采集超过上限须明确标记，不能宣称保留全部无限输出。回读不可递归生成引用。原事件不删除，tool/result schema 与 run completed 语义不变。

验收：长行、多字节、分页、空/末行、扫描上限、忽略目录、取消、路径/软链；引用隔离、重启、缺失/损坏、存储失败；真实 Cordis 模拟模型获取 Bash 测试日志引用并回读，原预算/恢复回归通过。
