# 开发进度
### NX-15d1 交付查询（2026-09-30）
task_report 分页展示文件变更/验证、未覆盖文件和 run 状态；从所有已确认检查计算当前文件覆盖，检查声明的其他依赖变化也使覆盖失效。失败保留、修改后改回仍过期，不自动断言任务验收；日志留在原验证事件/Bash 结果，摘要不重复日志。正常权限 pnpm check（72 文件）、报告/验证/变更 7/7 与 git diff --check 通过。c 已提交 6744816；d 拆分 d1 查询与 d2 CLI 两个独立结果，推送仍待授权。
### NX-15c 显式 Bash 验证（2026-09-30）
Bash 增加 verification.files 与可配置文件/字节限额；审批展示范围，审批后取版本，意图确认后执行并持久记录命令结果及后版本。普通 Bash 不产生验证，拒批/非法范围/超限/意图落盘失败均无执行；超时/取消保留真实结果，结果写入失败为 unknown。正常权限 pnpm check（71 文件）、Bash/记录 7/7 和 git diff --check 通过。b 已提交 4d1ea34；顺带纠正上一步误替换的 CI-12a 历史文档行。推送仍受自动审批阻止。
### NX-15b 验证记录核心（2026-09-30）
新增显式验证 start/result、文件指纹/位置、检查结果与当前版本分离、失败保留、分页和 unknown 恢复；JSONL 拒绝非法负载、重复、跨 scope 和命令/路径不配对。正常权限 pnpm check（70 文件）、pnpm test（117/117，fail0/skipped0）与 git diff --check 通过。a 已提交 0a6383f；自动审批拒绝推送到未明确授权的远端，继续本地验收与独立提交，推送/CI 待授权。
### NX-15a 开发范围（2026-09-30）
已补 R-18、显式文件版本验证、意图先落盘及交付报告决策；拆分 a～e 五个独立验收/提交边界。a 仅文档，git diff --check 通过；运行时开发待 b。每步提交并推送后推进下一项。
### NX-14 完成与验收（2026-09-30）
已交付结构化前台 Bash：command/cwd、退出码/信号、单调时长、timeout/cancel 状态、两流有界日志和逐流持久引用；保留审批、路径闸门和进程树清理。失败/截断/存储失败可解释，JSONL 恢复不重放副作用；run 先停止等待时仍保守为 unknown。未增加 NX-15 验证记录、后台服务或交互终端。
实际小步提交均已独立验收推送：a 33520cf → b 8cec028 → c 3f05f34 → d 254008f → e1 556f66a → e2 557f27f；e3 本步仅文档/验收记录，提交后报告编号。没有合并或改写历史。
正常用户权限 pnpm check（68 文件）、pnpm test（115/115，fail0/skipped0）、pnpm fixtures:check（初始 0/3、参考 3/3）及 git diff --check 全部通过。最终功能提交 557f27f 的 [CI 36651228195](https://github.com/BeforeLanding/mini-DSH/actions/runs/36651228195) Windows/Ubuntu × Node22/24 四组均 success。新增 8 条测试覆盖核心输出/失败/Unicode、cwd 审批与链接、逐流引用失败、取消/超时/进程树、JSONL 模型恢复；全部使用模拟模型，无付费 API 请求。
e3 同步 README 参数/回读/限制、TASKS 实际提交、路线和需求状态。应用路径策略不承诺 OS 隔离；主动脱离进程树的程序和外部换址竞态不在严格保证范围。下一主线 NX-15。
### NX-14e2（2026-09-30）
真实 Cordis 模拟模型执行退出 7 与挂起超时命令，模型收到两流引用及实际 timeout 信息；事件 isError=true，而模型结束后的 run 仍 completed，交付文本明确检查失败。JSONL 重启逐字恢复两个结果，回读原 stderr，已执行的追加文件只保留一次。
正常权限 build、syntax（68 文件）、tool-results 7/7、git diff --check 通过。e1 提交 556f66a 已推送；下一步只同步使用说明、核验全量回归和最终 CI。
### NX-14e1（2026-09-30）
独立增加真实超时/取消边界：两流部分日志保留，POSIX 核对实际 SIGKILL/SIGTERM，取消后等待超过子进程副作用定时器并确认没有写入。Windows 使用实际 taskkill /T /F；预取消不启动。正常权限 build、syntax（68 文件）、command-runner 4/4、git diff --check 通过。
细化 e1（进程边界）→ e2（持久化恢复）→ e3（文档验收）提交。保留 Loop 的既有 unknown 语义：run 停止等待早于进程 close 时不冒称已收到结构化结果，恢复不重跑。d 提交 254008f 已推送。
### NX-14d（2026-09-30）
大 Bash 日志分别投影 stdout/stderr，每流保留 text 预览、bytes/采集截断、previewTruncated、ref/storedBytes/storageTruncated。命令、cwd、status、exitCode 等始终保留在事件/模型的 JSON 中。存储失败保留执行元信息并标 storageError/isError，不丢失非零退出证据。
模拟模型真实 Bash 40KB 回读与重启隔离、两流分离、采集/存储截断和存储失败通过。正常用户权限 build、syntax（68 文件）、tool-results 6/6 与 git diff --check 通过；c 提交 3f05f34 已推送。
### NX-14c（2026-09-30）
Bash 接入结构化核心，ToolDefinition.output.isError 可将非零/超时/取消标为工具错误而保留 value。cwd 默认工作区，允许现存子目录，审批展示真实目录并复核路径/链接；拒批和非法 cwd 不启动命令。迁移原 fixture 的文本错误断言为实际 exitCode/stdout；新增 Cordis 路径、链接换址、拒批和释放测试。
正常用户权限等价命令 build、syntax（68 文件）、全量 111/111（无失败/跳过）与 git diff --check 通过。b 提交 8cec028 已推送。大结果暂沿用整体投影，下一步独立增加逐流引用与元信息保留。
### NX-14b（2026-09-30）
新增独立 command-runner，保留实际退出/信号、两流日志、共享采集额度、单调时长、超时/取消状态与进程树清理。真实 Node 子进程覆盖两流、退出 7、启动失败、Unicode/共享截断和空输出。Windows ENOENT close 返回负内部错误码，已归一化 spawn_error.exitCode=null，避免误认为命令退出码。
固定 pnpm 11.22.0 与 Cordis 正常权限导入核验通过，原基线 107/107 通过；沙箱无法解析依赖且 pnpm 引导挂起，后续使用 AGENTS 允许的等价 Node 命令并在正常用户权限执行。build、syntax（67 文件）、核心 2/2 与 diff --check 通过；尚未接入 Bash。
### NX-14a（2026-09-30）
已补充 R-17、结构化命令/逐流日志决策，列出 a～e 五个独立验收与提交边界。git diff --check 通过；仅文档，运行时尚未实现。不增加 NX-15 验证状态、后台服务或交互终端。

### CD-02c 传包 CD 实测验收（2026-09-29）
修复按 a 8df3beb（离线脚本）→ b c9f452c（工作流接入）独立验证提交并推送。[CI 36573968144](https://github.com/BeforeLanding/mini-DSH/actions/runs/36573968144) 四组全部 success；[Deploy ECS 36574173979](https://github.com/BeforeLanding/mini-DSH/actions/runs/36574173979) 实际 success。Linux runner 的 bundle 导入、错误 SHA/路径/REVISION 拒绝、真实 flock/软链原子激活、PREVIOUS_RELEASE/共享配置 fixture 通过；服务器构建语法 65 文件、测试 107/107（fail0/skipped0），实际发布 c9f452cf47732ffc6be91bfd300b15af4d23d017，HEAD/REVISION、共享 .env 与持久目录身份核验通过。该服务器发布没有请求 GitHub 拉取源码，旧网络阻塞已由 runner 下载与 SSH 传包消除；安装依赖仍访问包注册表。
本步仅记录必要摘要，不保存敏感日志、私钥或会话内容；git diff --check 通过。最终记录提交后继续检查最新 main 的 CI/CD，最终编号及运行结果在用户回复中报告，避免因追加验收记录无限生成提交。

### CD-02b Actions 传包接入（2026-09-29）
CD-02a 8df3beb 已独立提交推送；Deploy ECS checkout CI head_sha（完整历史、禁用保留凭据），在 Linux runner 执行 bundle 发布 fixture，生成完整 Git bundle 并通过 SSH/SCP 传送到随机 incoming 目录，使用该提交的脚本 prepare。构建成功后 runner 再通过 GitHub API 核验 main，仍匹配才 activate；版本切换前后核验持久目录身份、共享配置链接与实际 HEAD/REVISION。运行结束清理明确的传输文件，保留版本目录。不再调用服务器旧的 GitHub clone 脚本。
本地 YAML、CI 触发门槛、精确 checkout SHA/完整历史、两次 main 核验、runner/prepare/activate Bash 语法与 git diff --check 通过；本步只改工作流与说明，应用回归沿用 a 的 107/107，实际四组 CI、Linux fixture 和服务器发布待推送后验证。

### CD-02a 离线传包发布脚本（2026-09-29）
19f4ec9 的部署 36551890832 在服务器 git clone 时连接 github.com:443 超时，current 未切换。新增 scripts/deploy-ecs-bundle.sh：prepare 校验本地完整 bundle 与精确 SHA、构建/测试后写 receipt，activate 校验 receipt/HEAD/REVISION/共享 .env/产物，持锁保存上一版本并原子切换。服务器侧没有 GitHub 下载操作。MINI_DSH_DEPLOY_BASE 用于临时 fixture，默认沿用已有服务器布局。
新增 scripts/test-ecs-bundle.sh，本地真实 Git bundle 导入与错误 SHA/路径/REVISION 拒绝通过；Git Bash 缺少 flock 时仅 fixture 使用替身，Linux 原子激活场景留待下一步在 Actions 执行，不报告本地已覆盖。两个脚本 bash -n、pnpm check（65 文件）、pnpm test（107/107、无跳过）、git diff --check 通过。当前脚本尚未接入 CD，远端修复待 b。

### CD-01d 用户启动核验收尾（2026-09-29）
用户通过服务器 ~/bin/mini-dsh 成功进入交互 CLI，输出确认固定工作区 /home/deploy/workspaces/default、持久会话目录 ~/.mini-dsh/sessions 与所选模型配置正常。启动证据来自用户，本地代理未执行新模型请求；先前 bootstrap 的模型请求验证独立保留。CD-01 部署与 CD 设置完成；c 操作交付提交为 f02f567，已推送。本步仅同步摘要与任务状态，不保存真实会话 ID 或日志；git diff --check 通过，不重复运行应用测试。

### CD-01c 首次实际发布与操作交付（2026-09-29）
提交 a632121 的 [CI 36550812881](https://github.com/BeforeLanding/mini-DSH/actions/runs/36550812881) 四组全部 success，自动触发 [Deploy ECS 36550955877](https://github.com/BeforeLanding/mini-DSH/actions/runs/36550955877)。attempt1 在服务器 git clone 阶段因 GitHub 连接中断失败，未切换 current；重试 attempt2 实际 success，服务器语法 65 文件、测试 107/107（fail0/skipped0）。current 已切换到 a632121c0d928d0b18604fdef5f4b3462a11a2fb，实际 HEAD/REVISION、共享 .env 链接、构建入口及配置/工作区/会话目录身份核验均通过。没有读取配置或会话内容；目录身份核验不宣称全部数据内容逐字节校验。
交付 docs/ECS_DEPLOYMENT.md 与 README 入口，包含日常启动、Secrets/服务器前置条件、发布状态、固定目录、版本核验及带锁的原子回滚说明。三个 Bash 代码块的 bash -n 与 git diff --check 通过；回滚未执行。CD-01a 73988b5、b a632121 均已推送；本步为独立文档提交。新版本实际交互启动待用户在服务器运行 ~/bin/mini-dsh；先前用户模型验证来自 bootstrap，不混记为新版本模型验收。

### CD-01b 自动发布工作流（2026-09-29）
CD-01a 已提交并推送 73988b5；[公网 SSH 预检 36550421451](https://github.com/BeforeLanding/mini-DSH/actions/runs/36550421451) 实际 success，确认 GitHub 托管 runner 的连接与部署前置环境。
新增 Deploy ECS，通过 workflow_run 仅接受同仓库 main push 的 CI 全部成功结果，以 head_sha 调用用户已安装的发布脚本；production Secrets、严格主机密钥校验、无交互 SSH、串行发布且不中途取消。发布后核验实际 Git HEAD/REVISION、共享 .env 链接、构建入口和配置/工作区/会话目录身份；过期 main 提交跳过，应用版本与 CI SHA 必须一致。未读取任何密钥或会话内容。
本地 YAML/门槛/SHA/并发核验、runner/remote Bash 语法、pnpm check（65 文件）、pnpm test（107/107，无跳过）及 git diff --check 通过。首次自动发布仍待本步推送后的 CI/CD 真实运行，未提前标记发布成功。

### CD-01a 公网连接预检（2026-09-29）
用户已确认云服务器手动 check、107/107 测试、真实模型请求、固定工作区与启动入口、部署密钥本机 SSH、公钥身份核验、production 五项 Secrets 以及服务器发布脚本 bash -n。这些是用户提供的远端证据，未由本地代理重复执行或读取密钥。
仓库增加手动触发 ECS SSH Check，限定 main/production；通过严格主机密钥校验与无交互 SSH 检查用户、Node24/pnpm11.22.0、目录和发布脚本语法，不执行发布、不读取 .env 内容、不修改应用数据。公网连接尚待真实 Actions 运行确认；a 提交后再推进 b 自动部署。
本地验证：Python/PyYAML 解析及手动/main/production 门槛核验通过；提取 runner 与 remote 脚本分别使用 Git Bash bash -n 通过；git diff --check 通过。本步仅修改工作流与文档，未重复运行应用测试，公网验收仍待执行。

### NX-13 完成与跨平台验收（2026-09-29）
NX-13 已完成可靠编辑、乐观冲突检测、可恢复任务变更清单和 unified diff；模型 task_changes 与 CLI /changes /diff 可查询逐文件成功、失败、unknown 及外部变化，运行结束自动展示清单。用户首次观察前已有修改保留，跨编辑的用户变更不归入 Agent diff；patch 按需延后。
实际顺序与提交：a 契约 6081892 → b 核心 4b7cfd2 → c 工具 489bcfa → d 持久记录 97b7653 → d2 权限/软链边界 d802adc → e CLI/交付 4c9501c。均独立验收并推送；首次推送自动审查要求具体远端授权，用户明确授权 origin 后正常推送，未绕过审查。
本地 Windows Node24：pnpm check（65 文件）、pnpm test（107/107，无跳过）、pnpm fixtures:check（初始 0/3，参考 3/3）通过。最终功能提交 4c9501c 的 [CI 36545691239](https://github.com/BeforeLanding/mini-DSH/actions/runs/36545691239) 四组 Windows/Ubuntu × Node22/24 全部 success。11 条新增测试覆盖指纹/编码、冲突/取消、权限/软链、dirty Git/非 Git、落盘故障/恢复/续跑及 CLI/模型交付。
f 收尾仅核对提交清单、同步 TASKS/路线/需求状态并运行 git diff --check；无运行时改动，不重复已有功能检查。未调用付费模型 API；记录只覆盖受控文件工具，最终指纹检查与 rename 之间仍有外部进程竞态，不承诺文件系统级比较交换或跨文件事务。下一主线 NX-14/NX-15。

### NX-13e（2026-09-29）
CLI 运行结束展示当前 task 变更清单；/changes 按文件分页，/diff 按文件和 UTF-8 字节分页，显示 confirmed diff、失败次数和外部变更标记。coding 身份提示使用 expectedHash、冲突后重新读取以及交付前检查 task_changes；README 同步参数、覆盖范围和已知限制。
新增真实 Cordis CLI/模拟模型闭环：读取指纹、编辑、失败尝试、新建文件、模型读取任务 diff、终态清单、中文/emoji 大 diff 续读、unknown 和 reset；核对原用户行保持。pnpm check（65 文件）、pnpm test（107/107）、pnpm fixtures:check（初始 0/3、参考 3/3）和 git diff --check 通过；全部使用模拟提示和模型，无付费 API。软链/权限修复 d802adc 已推送，本步提交后核验最终 CI。

### NX-13d2（2026-09-29）
独立复核修复：快照保存真实 location，提交检查内部目录/文件软链指向稳定，向真实文件替换以保留软链；显式恢复原权限，避免 umask 降低权限；rename 后临时清理错误不倒置成功结果。新增同内容目录软链重新指向冲突与权限保持测试，POSIX 另验文件软链保持。
pnpm check（65 文件）、pnpm test（106/106）和 git diff --check 通过。任务记录提交 97b7653 的 CI 36544870349 已 success；本步独立提交后推进 CLI。

### NX-13d（2026-09-29）
新增基线/观察/编辑意图/逐次结果事件与 task_changes。任务首次现场基线固定，重新读取刷新预期指纹；同 task 续跑和 JSONL 重启保留清单，reset 隔离。只用确认落盘事件生成清单；写盘意图失败不修改文件，结果写盘失败/崩溃显示 unknown，继续执行拒绝自动处理未知编辑。
真实临时 Git 仓库已有 staged/dirty 内容、非 Git、读取后冲突、用户两次编辑间的变化、逐文件成功/失败、分页、事件损坏、取消后的迟到失败记录和文件额度均覆盖。中间用户修改改用逐次编辑 diff，不归到 Agent。首次回归发现 Cordis 禁止未声明服务属性访问，改用官方 ctx.get 可选查询以保留无 session 调用。
pnpm check（65 文件）、pnpm test（105/105，无跳过）和 git diff --check 通过；工具提交 489bcfa 已推送。下一步 CLI 展示与最终验收。

### NX-13c（2026-09-29）
read_file 返回完整文件指纹；edit/write 接入快照、expectedHash、具体范围与有界审批 diff、最终冲突检查及原子替换；成功返回结构化 diff/hash，无变化不请求审批。同一实例拒绝并发编辑同一路径，超限读取注明指纹不可用。
初次回归暴露新测试缺少 systemPrompt 导致 sandbox 未装配，以及旧测试仍断言 wrote 文本；修正装配和结构化结果断言后 pnpm check（63 文件）、pnpm test（101/101）和 git diff --check 通过。核心提交 4b7cfd2 已推送；下一步任务持久记录。

### NX-13b（2026-09-29）
file-edit.ts 增加有界字节快照、SHA-256、唯一替换、单 hunk unified diff 和同目录 sync/rename 提交。拒绝非法文本、超限、版本冲突、取消和路径变化，失败清理临时文件。pnpm check（62 文件）、核心测试 3/3 和 git diff --check 通过。尚未接入工具与任务记录；契约提交 6081892。

### NX-13a（2026-09-29）
已定义 R-16 与编辑/任务记录契约，拆成文档、核心、工具、持久记录、CLI 五个提交边界。git diff --check 通过；仅文档，功能未开始。不增加 patch，不承诺跨文件事务或文件系统级比较交换。

### NX-12 Windows CI 短路径修复（2026-09-29）

失败运行 36536233812：Ubuntu Node 22/24 通过，Windows 两组均在内部 junction 规则读取时误报越界。本地用真实 8.3 路径复现：fs.realpathSync 保留 junction 目标的短路径，而 fs.promises.realpath 返回长路径；原本相同目录因此比较失败。路径闸门统一使用 fs.realpathSync.native，与异步加载器一致，不放宽工作区边界。

新增跨平台目录别名回归，Windows 通过系统 ShortPath 构造 junction，验证规则加载、规范化来源和未创建文件的内部路径；外部 junction 及其未创建子路径继续拒绝。pnpm check（54 文件）、pnpm test（87/87，无跳过）与 git diff --check 通过。本步独立提交并推送后再核验四组 CI；提交时尚无远端修复成功结论。

### NX-12e 项目上下文集成与 NX-12 完成（2026-09-29）

新增依赖实际 sandbox 工作区的 project-context 插件，动态 system 提示词及只读 project_context 工具共用有界加载器，标注权限、作用域、脚本未验证及查询不改变工具 cwd。CLI 默认 coding，可用 MINI_DSH_PROFILE=general 保留通用身份；MINI_DSH_PROJECT_DIRECTORY 只控制初始上下文目录。注册前校验，释放时移除上下文和工具；README 与示例环境同步使用方式。

四条真实 Cordis/模拟模型集成覆盖模型收到来源/目录规则、其他目录查询、规则动态刷新、真实文件读 cwd、脚本不执行、审批/越界不放宽、释放与初始失败；容量和动态规则超限均在模型调用前停止。pnpm check（54 文件）、pnpm test（86/86，无跳过）通过，提交前核对 diff。未调用付费 API，未核验本轮跨平台 CI。

NX-12 按五步完成：a c5dd04b、b 94ad6e0、c 3a18c8b、d 20e8e3b；e 本步独立提交后报告编号。每步测试通过并提交后才进入下一步；下一开发主线可推进 NX-07 有界读取/搜索。

### NX-12d 显式项目元数据（2026-09-29）

只查看目标祖先链，选择最近 package.json 的包管理器、Node 要求和 test/check/typecheck/lint/build 字符串入口，标注来源；Git、TS、锁文件和 README 只发现标记，不读取 README 正文。脚本仅作为数据，不执行。缺失、非法或过大配置给出明确退化信息；最近配置无效时不冒用父配置。元数据使用剩余总字节预算，规则保持完整。

三条新增回归验证最近配置、动态更新、不执行带副作用脚本、非 Git/缺失/错误配置、预算和越界配置。pnpm check（52 文件）、pnpm test（82/82，无跳过）通过；提交前检查 diff。规则步骤已提交 3a18c8b；本步提交后再开始 NX-12e。

### NX-12c 有界目录规则加载（2026-09-29）

新增 ProjectContextRuntime，只查询工作区至目标目录的祖先链，父规则在前；返回路径、真实来源、目录作用域、原文及字节数。每次重新读取；读取/总内容/祖先层数可配置，规则超限、非文件、无效 UTF-8 和越界明确失败，缺失规则退化为空列表。工作区内目录别名按真实目录应用规则。

四条新增回归覆盖根/子/兄弟/工作区外父规则、更新删除、中文字节等号/超限、非法配置、目录类型和软链。Windows 普通文件软链创建遇到 EPERM，已用 junction 验证真实路径和越界；Linux 保留文件软链分支，本地不声称 Linux 验证。pnpm check（52 文件）、pnpm test（79/79，无跳过）、git diff --check 通过。身份步骤已提交 94ad6e0；本步提交后再开始 NX-12d。

### NX-12b 可配置编程身份（2026-09-29）

runtime-context 新增 general/coding 身份选择，底层默认 general；coding 身份要求检查代码和用户已有改动、遵循目录规则、保留权限/审批、按真实检查结果报告，并使用用户语言。无效配置在注册前拒绝；本步未接入仓库扫描或修改 CLI 默认。

test/coding-profile.test.ts 三条回归覆盖 general 兼容、coding 行为约束、配置拒绝与插件释放。pnpm check（50 文件）、pnpm test（75/75，无跳过）与 git diff --check 通过。契约步骤已提交 c5dd04b；本步提交后再开始 NX-12c。

### NX-12a 目录与加载契约（2026-09-29）

开始 NX-12，按 a 契约、b 编程身份、c 规则加载、d 项目元数据、e 插件/工具集成拆成五次独立提交。R-14 与 PLAN 明确工作区边界、祖先链加载、目录作用域、来源标注和可配置体积/深度限制；规则读取失败不静默截短，配置发现不授权执行脚本。底层 general 兼容，CLI 后续默认 coding。

本步仅文档，git diff --check 与契约一致性核对通过，未重跑功能测试。NX-12b～e 尚未实现；每一步提交后再开展下一步。

### 小内容即时提交规则强化（2026-09-29）

按用户要求强化 AGENTS、PLAN 和 TASKS：开发前列出子步骤及验收/提交边界，每完成一个小内容验证通过后立即提交，提交后才开始下一个内容。每次 diff 只能包含一个独立结果及其直接相关测试/证据，父任务完成时核对实际子步骤提交。

NX-05a 的 f06cbfb 包含多个可分别验收的内容，作为粒度过大的反例保留；后续 fixture、公共支撑、工具闭环和额外失败边界须逐步提交，不自动重写已有历史。本轮仅修改提交规则和记录，git diff --check 与规则一致性检查通过；未重跑功能测试，72/72 为此前 NX-05a 的结果。

### NX-05a 编程 fixture 与独立验收完成（2026-09-29）

新增 boundary、options、interface 三个无依赖编程任务，包含中文任务、完整初始代码、源码参考解和工作区外的行为验收器。每次运行新建临时目录，只复制初始代码；提供受保护文件完整性核验、10 秒/32 KiB 的可配置验收上界和经路径确认的目录清理。runner 使用 TypeScript，fixture 输入使用可直接运行的 Node ESM，避免引入额外安装/编译依赖。

新增 pnpm fixtures:check 命令：三项初始状态均退出 1（0/3），参考解均退出 0（3/3）；基线记录于 [fixture 说明](test/fixtures/coding/README.md)。真实 Cordis + 文件/Bash 的预设模拟模型流程均通过（3/3），其中 options 演示修复不完整→失败检查→再次编辑→通过。run completed 和独立行为验收分别断言，没有修改生产运行状态/验证事件契约。

八条新增回归覆盖基线/参考解、独立临时目录和清理、真实工具闭环、公开测试篡改、跨文件部分修改、导入提前退出、挂起超时及输出超限。正常用户权限 pnpm check（49 文件）、pnpm test（72/72，无失败或跳过）、pnpm fixtures:check（退出 0）与 git diff --check 通过。模拟模型使用已知参考修改，不代表自主编程成功率；未调用付费 API，尚未核验本次跨平台 CI。下一主线为 NX-12 仓库规则/检查入口上下文和 NX-07 有界读取搜索，NX-05b 与 NX-15 仍未实现。

### F3 崩溃恢复投影信息修复（2026-09-29）

latestRun 在未完成 run 的事件重放中处理 context/projection：按发生顺序去重合并裁剪任务 ID，恢复最近一次输入估算。Loop 在记录候选投影时更新估算，即使 context_overflow 未调度模型也保持观测一致；候选投影不冒充实际请求或 usage。正常终态快照优先，reset 和同 task 的其他 run 不混入。

pnpm check（46 文件）、pnpm test（64/64，无跳过）与 git diff --check 通过；test/store.test.ts 覆盖七个崩溃位置、重复恢复、终态及 reset，test/context.test.ts 验证 overflow 输入观测。诊断脚本三个输出均符合修复结果：F1 保留旧历史、3 条消息和 100 输出额度；F2 报 timeout、20ms、提交 uncertain；F3 恢复 synthetic-old-task 与输入估算 1234。原始事件不改写，没有付费模型调用；本轮尚未核验跨平台 CI。F1～F3 / NX-01～NX-03 已完成，后续路线状态同步。

### F2 最终持久化 deadline 修复（2026-09-29）

答案与用量先在主动预算内确认；唯一终态提交等待也受主动 deadline 及 finalizationTimeoutMs（默认 5000ms）限制，返回前复查。错误收尾独立有界并保留原停止原因。终态写入已开始后的超时/取消/失败暴露 terminalCommit=uncertain，包含提交等待的实际观测时间；阻止继续、新任务及 reset，迟到确认不覆盖当前状态。重新读取日志按完整持久化事实恢复，不追加冲突终态；提交前计时快照和重启后无法重建的 sync 时间已在 R-05/D-05/README 明确。

pnpm check（46 文件）、pnpm test（62/62，无跳过）、node --check docs/context-budget/review-probes.mjs 与 git diff --check 通过。四条新增回归覆盖跨 deadline、挂起、取消/完成竞态、失败、迟到完成、有界错误收尾以及终态已/未落盘两种恢复；真实 Cordis/JSONL 集成继续通过。诊断 F2 返回 timeout、主动时间 20ms、提交 uncertain；F1 保留全部历史，F3 待修复。尚未核验本轮跨平台 CI。

### F1 输出额度与历史裁剪联动修复（2026-09-29）

每个候选历史集合依据当前 run 已消耗 token、输入估算和最低输出计算实际额度，再检查输入目标与窗口；不足时才移除最旧完整任务并重新计算。完整历史输入 754、余额 854、窗口 2902 的样例保留全部历史并发送 100 输出额度。原始事件保持不变，当前 task、system/schema 仍不可裁剪。

正常用户权限 pnpm check（46 文件）、pnpm test（58/58，无跳过）和 git diff --check 通过。新增交叉边界回归见 test/context.test.ts；F2、F3 待依次修复。

### mini coding agent harness 定位修订（2026-09-29）

按用户明确的“仿 DeepSeek Harness 的 mini coding agent harness”定位更新 [开发路线](docs/INTERNSHIP_ROADMAP.md) 及 README、需求/计划入口。保留 F1～F3 及原预算评估；新主线为 M5 边界收尾 → M6 仓库上下文/代码定位/可靠编辑/执行验证 → M7 编程评测，M8 长任务增强按证据选择，M9 求职展示随开发积累。

保留 NX-01～NX-11，新增 NX-12～NX-16；全部功能项仍为 todo。特别区分 run completed 与代码验证通过，现有通用身份、prompt、事件 schema 和工具行为没有修改。本轮仅文档，未重跑功能测试；57/57 与四组合 CI 是此前评估基线，不能作为新规划的验收证据。

本轮验证：32 个本地 Markdown 链接存在性检查、16 个父任务编号（NX-05 拆为 a/b 两步）及 M5～M9 阶段检查通过；`git diff --check` 通过。

### 实习导向评估与路线（2026-09-29）

基于与 origin HEAD 一致的 ca1e2c4 完成 [完成度评估与后续路线](docs/INTERNSHIP_ROADMAP.md)。正常用户权限下重新运行 pnpm check（46 文件）和 pnpm test（57/57，无跳过）；只读核验基线 CI [36514313704](https://github.com/BeforeLanding/mini-DSH/actions/runs/36514313704)，Windows/Ubuntu × Node22/24 四组合 success。

新增离线诊断 `node docs/context-budget/review-probes.mjs`，复现 F1 输出额度收缩前提前裁剪、F2 最终提交超 deadline 仍 completed、F3 恢复遗漏投影观测。三个问题尚未修复；未改运行时功能、未调用付费 API。后续 NX-01～NX-11 均为 todo，按边界加固→评测/工具输出治理→求职展示推进。评估完成不代表后续功能完成。

文档与诊断检查：22 个本地 Markdown 链接存在性检查通过，`node --check docs/context-budget/review-probes.mjs` 和 `git diff --check` 通过。功能检查使用上述本次基线结果，文档变更后不重复执行不受影响的全量测试。

### 功能梳理（2026-09-29）
新增 [本次改动与实现功能](docs/context-budget/CHANGES.md)，按用户五阶段顺序归纳 21 个开发提交、模块职责、CLI/恢复入口、默认值、回归证据和实际边界；README 增加入口。本步仅文档变更，沿用注释清理后的 pnpm check / test 57/57 结果。

### 注释清理（2026-09-29）
按用户要求删除已跟踪源码、测试、脚本、CI、环境示例及 README 运行代码块中的注释；URL、正则、字符串和 Markdown 说明保留，实际 .env 未改动。pnpm check 类型/构建/46 文件语法通过，pnpm test 57/57，无跳过；git diff --check 通过。构建产物的 sourceMappingURL 属于调试映射指令，保留既有 sourceMap 配置。

更新：2026-09-29。五阶段功能已实现并逐步提交推送；本地 57/57 回归通过。功能提交 4600379 的跨平台 CI 四组合全部通过。

当前状态：严格 TS 迁移、契约/持久化、上下文管理、执行预算、续跑/CLI 已完成；原 22 条测试保留。历史基线及失败记录保留在下文，当前验收以末尾 E-03 为准。

## 已完成
- 仓库规则、需求、计划及任务清单已建立；TypeScript / Node ESM、Cordis、node:test、JSONL、请求投影和同 task 新 run 的 /continue 路线已确定。
- 用户给定 64 次模型请求、128 次工具调用、10 分钟，并授权调研确定其余默认值；统一保存在 [计划](docs/context-budget/PLAN.md)，工程初值待任务实验评估。
- 当前任务全部过程保留，无法容纳明确停止；预算触顶直接报告，不自动摘要、收尾或重试未知工具。
- 文档整理：选型、参数、官方依据合入计划，基线验证合入本文件；删除重复专题入口、选型、默认值和独立基线记录；已完成的文档准备任务合入本节，未开发的功能任务保留原 ID。
- 需求 R-01 至 R-13 对应任务清单；文档基线已在 43e3829（确认开发文档）提交。尚未安装 TS 工具链、迁移源码或实现预算功能。
- 用户已要求每个完成的小步骤创建本地提交；已将拆分、验证、证据回填和提交报告规则写入 AGENTS/PLAN。本步只修改开发流程文档。
- CB-17：正常用户权限下确认固定 pnpm、锁文件依赖、语法及完整核心/Cordis 测试通过；源码和依赖版本无须改动，补充沙箱访问限制的排查说明。

## 验证与阻塞
### 开发前基线 E-01（2026-09-28）
环境：Windows / Node v24.16.0；本地 main / c5fc9c4，未拉取或核验远程最新提交。
- node scripts/check-syntax.js：退出码 0，syntax ok: 26 files。
- node --test test/*.test.js：退出码 1；20 条核心测试通过，集成文件加载失败，汇总 tests 21 / pass 20 / fail 1；两条集成测试未执行，不是原 22 条全部通过。
- 错误：ERR_MODULE_NOT_FOUND，无法解析 node_modules/@deepseek-ai/cordis/index.js。目录存在但依赖不可用，阻塞完整集成基线。
- pnpm --version：引导 pnpm 11.22.0 失败，registry signature could not be verified，包 fetch failed；不能据此断言包被篡改。pnpm check/test 未取得结果，未绕过校验。
- 核心测试覆盖事件/reasoning、reset、服务释放、模型路由、无预算 20 次工具调用、流回调、取消配对、SSE/JSON、路径/软链、审批和文件匹配。未来通过结果另记，不覆盖本次失败。

### 文档检查
整理后六份文档的 17 个本地链接检查通过；13 项需求、11 项决策及 15 项任务引用有效；无已删除文档残留引用；文档空白和 git diff --check 通过。本次仅改文档，未重跑功能测试；没有真实模型、预算功能、TypeScript 构建或跨平台 CI 验证。

开发流程规则更新后，17 个本地链接、文档空白及 git diff --check 再次通过；本步只有 AGENTS、PLAN、PROGRESS 变更，不重跑功能测试，既有依赖阻塞仍保留。

### 开发基线恢复 E-02（2026-09-28）
环境：Windows / Node v24.16.0；以 9f74a33 为本次仓库起点。检测开始时已有 CB-17 的任务/进度改动，保留并补齐本任务验证。
- 同一检出中，沙箱下 Cordis 导入仍报 ERR_MODULE_NOT_FOUND；正常用户权限下解析到 .pnpm 内的 lib/index.js 并导入成功。此项确认历史失败与访问环境有关，不能直接视为真实缺包。
- 正常用户权限执行 pnpm --version：11.22.0，退出码 0。
- pnpm install --frozen-lockfile：Already up to date，退出码 0；未降级 pnpm、绕过签名或修改锁文件。
- pnpm check：syntax ok: 26 files，退出码 0。
- pnpm test：tests 22 / pass 22 / fail 0 / skipped 0，退出码 0；包括真实 Bash/文件工具、Cordis 全栈和可选/必需插件失败测试。
- package.json、pnpm-lock.yaml 和运行源码无变更。本次恢复属于环境核验与记录，不引入无必要代码修补。
- 本地完整基线阻塞解除；未触发或核验远程 CI，未调用真实模型。后续沙箱不可访问依赖/缓存时需在正常用户权限核验，不绕过校验。
- 本步 18 个本地文档链接、文档空白和 git diff --check 通过；CB-17 标记 done，CB-15 保持 todo。

## 下一步
原首阶段开发及验收已完成；优先修复 F1～F3（M5），随后按 [编程 Harness 开发路线](docs/INTERNSHIP_ROADMAP.md) 的 M6 建立最小代码修改与验证闭环，以 3 个编程 fixture 贯穿开发，再扩展 M7 真实模型评测。NX-01～NX-16 均未开始功能开发。

## 更新规则
本文件只保存当前状态、重要验证/失败、阻塞和下一步；任务级行为/证据维护在 [TASKS](docs/context-budget/TASKS.md)。参数和设计维护在 PLAN，验收维护在 REQUIREMENTS。done 必须有真实验收证据，设计完成不等于功能完成。

### CB-15a（2026-09-29）
已建立 TypeScript 7.0.2、Node 24 类型、strict NodeNext 编译链；过渡阶段 allowJs。start/test 使用 dist 产物，构建先类型检查再清理固定 dist，plugins.config 路径保持。pnpm check / test 通过，原 22/22 回归通过。下一步迁移核心。推送被自动审批要求确认具体 origin 目的地，等待确认。

### CB-15b（2026-09-29）
核心和路径闸门迁移 TypeScript，增加消息/工具/服务契约，strict 无隐式 any。pnpm check / test 成功，原 22/22 通过。CB-15a 已推送 origin，用户已确认 BeforeLanding/mini-DSH 为具体目的地。下一步插件、模型、工具。

### CB-15c（2026-09-29）
入口、Cordis 服务、DeepSeek、文件/Bash 工具迁移 TS；使用 Cordis Context 类型增强，保留注册释放。pnpm check / test 成功，原 22/22 通过；配置动态导入路径保持。修正 dist 忽略规则换行。下一步测试和 CI。

### CB-15d（2026-09-29）
原 22 条测试与 plugins.config 迁移 TS，关闭 allowJs；CI 使用类型/构建/产物检查，README/AGENTS 同步。pnpm check / test 通过，22/22 无跳过；Windows Node 24 本地通过。远程 Node22/24 × Ubuntu/Windows 矩阵尚待核验，未宣称跨平台通过。下一步配置契约。

### CB-01 配置快照（2026-09-29）
配置快照、覆盖和零额度校验已实现；pnpm check / test 24/24 通过，非法配置无事件或模型副作用。调度限制待后续阶段。

### CB-02 任务与终态（2026-09-29）
版本化事件、session/task/run ID、模型/工具调度计数、唯一终态与追加 reset 已实现；pnpm check / test 25/25 通过。事件副本隔离，最终文本保留 reasoning。

### CB-15 迁移验收（2026-09-29）
四个迁移提交已推送；本地原 22/22 通过；GitHub CI 36504218629 的 Windows/Ubuntu × Node22/24 四组合成功。

### CB-11 JSONL写入（2026-09-29）
JsonlStore 单写入者锁、串行 append+sync、序号检查、调度前 flush；写入故障无后续模型副作用。pnpm check / test 28/28 通过；尾部半条、中部损坏和重复序号有独立测试。恢复载荷校验待下一步。

### CB-12 Session恢复（2026-09-29）
恢复仅派生状态/消息并补齐 unknown/skipped；工作区不匹配拒绝执行，reset 重启生效；严格版本/载荷/序号校验和尾部原文隔离。pnpm check / test 30/30 通过。usage/流式恢复待适配器小步。

### CB-11 损坏恢复（2026-09-29）
JSONL 串行 sync、单写入者锁与写入故障屏障；严格载荷/序号/版本、半条尾部拒绝并提供显式备份隔离；pnpm check / test 30/30 通过。CLI 持久化入口待后续。

### CB-03 usage与输出协议（2026-09-29）
2026-09-29 核验 https://api-docs.deepseek.com/api/create-chat-completion/；max_tokens、include_usage、usage-only/重复末包归一化，reasoning 为输出子集；截断/残缺调用不执行。pnpm check / test 33/33 通过；缺失 usage 的统一估算在 CB-04 接入。

### CB-04 完整请求估算（2026-09-29）
token-estimator 按 PLAN ASCII0.3/其他Unicode1.0、每消息32/请求256，覆盖 system/reasoning/工具schema及协议；缺失/失败/中断 usage 标 estimated+uncertain；pnpm check / test 35/35 通过。容量判断在下一步。

### CB-03 usage结算（2026-09-29）
官方 DeepSeek 协议（2026-09-29）+模型SSE模拟：usage-only/重复末包、max_tokens、reasoning不重复计，length/残缺JSON不执行；缺失及中断用统一估算。pnpm check / test 35/35 通过。

### CB-12 流式恢复（2026-09-29）
严格事件恢复不重放工具；unknown/skipped、workspace校验、reset重启；流片段250ms或4KiB合并，不派生为完成答案；缺失usage恢复估算。pnpm check / test 35/35 通过。

### CB-05 历史分组（2026-09-29）
groupHistory 按完整 task 聚合，当前 task 与缺失结果组受保护；工具调用/结果完整性检查；原事件不变。pnpm check / test 36/36 通过。请求投影和容量停止待下一步。

### CB-05 请求投影（2026-09-29）
完整历史分组后按目标移除最旧完整任务，当前task/工具协议受保护；投影确定且不改原文，context/projection 记录移除任务。pnpm check / test 37/37 通过。容量停止下一小步接入。

### CB-05 容量停止（2026-09-29）
投影后 input+输出预留+动态余量不超过窗口；必保留集合不容纳时 context_overflow 且零模型调度；原文不变。pnpm check / test 39/39 通过，含等号/超一、模型切换及大输入/system/schema。

### CB-04 容量边界（2026-09-29）
完整请求估算+动态余量max(2048,input10%)；显式配置/适配器能力元数据，未知容量拒绝且无历史副作用；模型切换重算。pnpm check / test 39/39 通过。

### CB-06 次数限制（2026-09-29）
0/1/N 模型调度、最后完整回答、最后一步工具跳过；批量工具按额度顺序执行且全部配对，失败计次数；公共失败路径补齐结果。pnpm check / test 42/42 通过，原无预算20工具回归保留。

### CB-01 配置贯通（2026-09-29）
调用>Agent>runtime默认的校验快照、有限整数/零额度、类型化BudgetStop、成功字符串；Cordis插件配置注入实际验证。pnpm check / test 42/42 通过。

### CB-07 主动时间与取消（2026-09-29）
RunBudgetRuntime 可注入单调时钟、组合signal、主动deadline、模型独立超时、审批暂停与独立超时；阶段复查、资源清理、迟到流忽略，未知在途工具配对。pnpm check / test 45/45 通过；非协作工具仅停止等待，不能保证物理终止。

### CB-08 累计token（2026-09-29）
请求前预留完整输入与最低输出、余额降低max_tokens；actual/estimated均累计重复输入，真实超估算停止后续调度并补齐结果；取消/失败保留不确定消耗。pnpm check / test 48/48 通过，验证次数/token/context停止优先级。

### CB-13 续跑核心（2026-09-29）
agent.continue 同task新run关联previousRunId，每段独立计数，task累计及续跑数；不重复用户输入/旧工具；跨run上下文保护，completed/unchanged context/unknown拒绝。修复复用call ID的按发生顺序配对。pnpm check / test 50/50 通过；CLI入口下一步。

### CB-09 CLI状态与恢复（2026-09-29）
真实Cordis CLI实现 /budget查看/JSON覆盖、/continue、run/task用量与裁剪范围；默认JSONL、session ID恢复、模型/预算设置持久化、reset追加与锁释放；README/.env.example更新。pnpm check / test 52/52 通过。

### CB-13 CLI继续（2026-09-29）
续跑核心与CLI /continue实际串联，预算停止→继续→完成；task累计、跨run保护、completed/unknown/unchanged context明确反馈。pnpm check / test 52/52 通过。

### CB-11 CLI持久化验收（2026-09-29）
JSONL串行sync、单写入者锁、写入故障停止、尾部隔离和严格恢复；CLI默认持久化并在退出释放锁。pnpm check / test 52/52 通过，日志全为模拟内容。性能样本在最终回归记录。

### CB-10 持久化与取消边界加固（2026-09-29）
写盘失败禁止后续调度，未确认终态不报告completed；损坏UTF-8原字节隔离；模型载荷/重复调用校验；工具组合signal与Esc审批取消、超长timer回归通过。pnpm check / test 57/57通过，含待单独提交的持久化集成样本；最终CI待核验。

## 最终集成验收 E-03（2026-09-29）
- Windows / Node v24.16.0：pnpm check 类型/构建/46 文件语法通过；pnpm test 57/57，无跳过；全部模型请求为模拟，无 API Key 或付费请求。
- 真实 Cordis + JSONL + 文件工具：预算停止后关闭服务、重新读取日志并装配新实例，/continue 同 task 新 run；已写文件的 mtime 不变，任务累计模型 3 次/工具 1 次，内存/磁盘规范化事件一致。
- R-01/R-04：test/budget.test.ts 覆盖非法/零/N 额度、优先级、快照、最后回答与批量跳过；旧无预算 20 次工具回归保留。
- R-02/R-03：test/context.test.ts 覆盖完整请求估算、中文/schema/reasoning、容量等号/超界、模型切换、完整任务投影、原始事件不变与当前任务保护。
- R-05：test/deadline.test.ts 和 test/cli.test.ts 覆盖单调主动时间、审批暂停/超时、请求超时、取消竞态、Esc 取消审批、超长 timer 及监听器释放。
- R-06/R-07：test/model.test.ts、context/budget 覆盖 usage-only/重复末包、max_tokens、实际/估算结算、重复输入、截断与无效调用不执行。
- R-08/R-09：budget/cli/core/integration 覆盖唯一终态、run/task 状态、预算/裁剪范围、模型路由、插件释放与原始回归。
- R-10/R-11：test/store.test.ts 覆盖 sync 屏障、单写入者、写盘错误停止、严格版本/载荷/序号、尾部原字节备份、unknown/skipped、reset/workspace 与恢复无副作用。
- R-12：test/continue.test.ts、cli/integration 覆盖新 run 额度、已完成调用不重放、跨 run 保护与 unknown/unchanged context 拒绝。
- R-13：strict NodeNext/noEmitOnError/allowJs=false；源码、插件配置、测试和性能脚本 TS 化，编译产物运行；CI 四组合执行相同 check/test。
- 性能命令：pnpm build 后 node dist/scripts/benchmark-store.js 1000；每个事件 flush+sync，使用纯模拟 256 字符载荷；结果记录于 CB-11。仅代表单机样本，不承诺设备掉电保证。
- 已知限制：估算器不等于供应商 tokenizer；非协作第三方工具只能停止等待；unknown 副作用需要外部核验，writer.lock 不自动清除；Biome 尚未作为门槛（README 已说明）。

### CB-11 JSONL性能验收（2026-09-29）
纯模拟1000次sync追加样本，约466KB；Windows Node24样本645.25ms，平均0.645ms/次，读取校验3.86ms。可复现脚本scripts/benchmark-store.ts；严格损坏/故障/恢复测试通过，单机样本不保证掉电耐久性。

### E-03 跨平台验收结论
功能提交 4600379：GitHub CI [36508829785](https://github.com/BeforeLanding/mini-DSH/actions/runs/36508829785) 完成且 success；Windows/Ubuntu × Node22/24 四 job 均 success，编译检查和 57 条回归通过。最终加固提交 6b9d858 的 CI 36508694746 亦 success。本次所有功能步骤按用户顺序独立提交并逐次推送到确认的 origin。

### CB-10 集成验收完成（2026-09-29）
R-01至R-13逐项证据见PROGRESS E-03；本地pnpm check/test 57/57；功能提交4600379的GitHub CI 36508829785四组合Windows/Ubuntu × Node22/24全部success。模拟模型、真实Cordis/Bash/文件及JSONL恢复；无付费API调用。

### NX-07a（2026-09-29）
已补 R-15 和有界工具决策，拆为契约、读取、搜索、持久结果存储、工具/Bash 集成五个独立提交边界。当前仅文档，git diff --check 通过；功能尚未实现。

### NX-07b（2026-09-29）
read_file 增加 startLine/maxLines、行号、nextLine/eof 和截断原因，固定块读取并限制扫描/行长/输出；非法 UTF-8、二进制、非文件和取消明确失败。pnpm check（56 文件）、pnpm test（89/89）通过；diff 核对及 git diff --check 通过。契约提交 5ef5b2e 已推送，读取独立提交后推进搜索。

### NX-07c（2026-09-29）
搜索改为有界、可分页的结构化结果，默认忽略生成目录和 .mini-dsh，跳过软链/二进制/非法编码/过大文件并记录原因。新增分页、缩小范围、扫描/遍历/深度/输出额度与取消测试。pnpm check（57 文件）、pnpm test（91/91）通过；更新原 Cordis glob 契约断言，diff 核对通过。读取提交 21ee528 已推送。

### NX-07d（2026-09-29）
持久结果存储完成，UUID 引用只按同 session 读取，验证版本/哈希/文件大小，按 UTF-8 字节边界返回 nextOffset/eof/captureTruncated。保存限制采集大小、磁盘总额及 1000 文件（可配置），容量耗尽或写入失败明确报错。pnpm check（59 文件）及结果存储 2/2 边界测试通过，diff 核对通过；尚未集成工具预览。搜索提交 04f5c4b 已推送。

### NX-07e（2026-09-29）
工具结果投影与 CLI 集成完成：大输出保存后只记录预览/引用，read_tool_result 同 session 有界回读；Bash 成功/非零退出日志均可回读，采集超限明确标注。真实 Cordis 模拟模型读取超过旧 32 KiB 限额的日志尾部，重建服务继续回读；错误状态、存储失败、无 session 兼容和释放已验证。README/忽略规则同步。

首次验证因测试误用 RunState.stopReason 字段未编译；已改为实际 status 后重新通过 pnpm check（60 文件）、pnpm test（96/96）、pnpm fixtures:check（初始全部失败、参考全部通过）。diff 核对及 git diff --check 通过，未调用付费 API。结果存储提交 dd45f75 已推送；本步提交后核验远端 CI 并回填实际提交清单。

### NX-07 完成与跨平台验收（2026-09-29）
NX-07 已完成：有界分段读取、有界搜索分页、持久结果引用与同 session 回读、Bash 日志采集和模型/事件预览。子步骤提交 a 5ef5b2e、b 21ee528、c 04f5c4b、d dd45f75、e 6c03300 均已逐步验证并推送；TASKS 已回填实际编号和 done 状态。

本地 pnpm check（60 文件）、pnpm test（96/96，无跳过）、pnpm fixtures:check（初始 0/3、参考 3/3）通过。最终功能提交 6c03300 的 [CI 36538591870](https://github.com/BeforeLanding/mini-DSH/actions/runs/36538591870) 已完成且 success，Windows/Ubuntu × Node22/24 四组全部通过。未调用付费 API；结果采集及扫描仍有明确上限，不代表无限输出保留；多进程共享目录没有全局配额锁。

本步 NX-07f 仅核对提交清单并回填最终验收证据，git diff --check 通过，不重复不受影响的运行时测试。下一主线可推进 NX-13 可靠编辑或 NX-14 独立执行验证；NX-05b、NX-15 尚未实现。
