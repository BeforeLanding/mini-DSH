# 阿里云 CLI 部署与自动发布

适用于当前已配置的 Alibaba Cloud Linux 4 x86_64 服务器。mini-DSH 是交互式终端程序；在服务器终端登录 `deploy` 用户后运行，不提供网页入口。

## 日常启动

```bash
~/bin/mini-dsh
```

启动时确认 `Sandbox workspace` 为 `/home/deploy/workspaces/default`。输入 `/exit` 退出。新启动使用 `current` 指向的版本，已运行的 CLI 使用原版本；发布不会重启正在进行的任务。

## 发布流程

普通 `main` 推送不会发布生产版本。候选提交的四组 Ubuntu/Windows、Node22/24 CI 全部成功后，由用户创建并推送 `vMAJOR.MINOR.PATCH` 标签触发 **Deploy ECS**。工作流也保留手动入口，要求明确填写 tag、分支或提交 SHA；目标提交必须可从 `main` 到达。手动 **ECS SSH Check** 只检查连接和环境，不发布版本。

Deploy ECS 在 GitHub runner 检出标签或手动指定的精确提交，确认提交属于 `main` 历史后打包为完整 Git bundle，通过严格主机密钥校验的 SSH/SCP 传送 bundle 和该版本的 scripts/deploy-ecs-bundle.sh。服务器从本地 bundle 导入精确提交，创建独立版本目录、安装锁定依赖、执行 `pnpm check` 和 `pnpm test`，成功后才原子切换 `current`。工作流串行执行；服务器脚本另使用 `flock` 锁。服务器发布代码时无需连接 github.com；安装依赖仍需要访问包注册表。

bundle 保留 Git 提交与 HEAD，可离线校验；依据见 [Git 官方 bundle 文档](https://git-scm.com/docs/git-bundle)。临时传包目录位于 `~/apps/mini-DSH/incoming`，传输文件在运行结束时清理，旧版本目录保留。

触发机制使用 GitHub 官方的 [tag push](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#push) 与 [workflow_dispatch](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_dispatch)。标签名在工作流内再次校验为 `vMAJOR.MINOR.PATCH`；普通分支推送和 PR 不触发生产部署。

## 版本标签与发布锚点

生产标签严格使用 `vMAJOR.MINOR.PATCH`，三个分量都是非负十进制整数，例如 `v1.0.0`、`v1.2.3`。首版不使用 `latest`、日期、milestone、预发布后缀或可移动标签；需要预发布流程时先单独补充工作流和规范。推荐 annotated tag，标签说明使用 `release: vMAJOR.MINOR.PATCH`。

每个生产标签必须满足：目标提交已在 `main`，该精确 SHA 的四组 CI 全部成功，版本号未被使用，工作树干净且本地 main 与 origin/main 一致。先只读核对候选提交和 CI：

```bash
git fetch --prune origin
git status --short
test "$(git rev-parse main)" = "$(git rev-parse origin/main)"
release_sha="$(git rev-parse origin/main)"
git merge-base --is-ancestor "$release_sha" origin/main
gh run list --commit "$release_sha" --workflow ci.yml --limit 5
git tag --list 'v*'
```

人工确认精确 SHA 的最新 CI 为 success 后，再由用户创建并推送标签。以下命令只是操作模板，本仓库自动化不会代替用户执行：

```bash
version=v1.2.3
release_sha="$(git rev-parse origin/main)"
test -z "$(git tag --list "$version")"
git tag -a "$version" "$release_sha" -m "release: $version"
git show --no-patch --decorate "$version"
git push origin "$version"
```

标签 push 触发 Deploy ECS。工作流解析最终 commit SHA、确认它属于 main 历史，并将该 SHA 写入服务器发布目录的 `REVISION`；因此 tag → commit SHA → REVISION → release 目录构成可审计的部署与回滚锚点。标签一旦推送不得删除、强推或改指向；错误标签保留审计记录，修复后递增版本号创建新标签。

Deploy ECS 成功后可选择创建同名 GitHub Release，用于发布说明，不改变部署目标，也不再次触发部署：

```bash
gh release create v1.2.3 --verify-tag --generate-notes --title v1.2.3
```

`workflow_dispatch` 是受控恢复入口，不替代版本发布。Actions 页面运行 Deploy ECS 时填写已存在 tag（推荐）或明确 commit SHA；CLI 等价命令如下，其中 `--ref main` 选择默认分支上的工作流定义，`ref` 输入才是部署目标：

```bash
gh workflow run deploy-ecs.yml --ref main -f ref=v1.2.3
```

手动目标仍须属于 main 历史，并在服务器重新执行锁定依赖安装、`pnpm check` 和 `pnpm test`。若用于回滚，优先填写已发布的旧版本标签，使 Actions 记录、Git tag 和服务器 REVISION 可以相互核对。

服务器需要保留以下布局：

- `~/apps/mini-DSH/releases/`：独立版本目录，初始安装为 `bootstrap`。
- `~/apps/mini-DSH/current`：当前版本软链接。
- `~/apps/mini-DSH/shared/.env`：共享模型配置，权限 600，版本中的 `.env` 链接到此文件。
- `~/workspaces/default`：固定工作区。
- `~/.mini-dsh/sessions`：持久会话记录。
- `~/bin/mini-dsh`：加载 nvm Node24、解析 current、进入实际版本目录并启动构建产物。
- `~/bin/deploy-mini-dsh`：初期手动安装的 GitHub 拉取脚本，新 CD 已改为随 bundle 传送仓库发布脚本，不再调用此入口。

共享 `.env` 中设置 `MINI_DSH_WORKSPACE=/home/deploy/workspaces/default` 与 `MINI_DSH_SESSION_DIR=/home/deploy/.mini-dsh/sessions`。服务器已有 nvm Node24 与 pnpm11.22.0，以及 Git、Bash、`flock`。模型密钥只保存在共享配置中。

GitHub 的 `production` Environment 保存五项 Secrets：`ECS_HOST`、`ECS_PORT`、`ECS_USER`（deploy）、`ECS_SSH_KEY`、`ECS_KNOWN_HOSTS`。部署密钥的公钥位于服务器 `~/.ssh/authorized_keys`；KNOWN_HOSTS 使用已核验的服务器 ED25519 主机公钥。真实密钥和地址不写入仓库。

## 查看版本

在服务器 `deploy` 终端执行：

```bash
readlink -f ~/apps/mini-DSH/current
cat ~/apps/mini-DSH/current/REVISION
```

第一次标签发布前，bootstrap 没有 REVISION。发布日志会显示完整提交 SHA。部署后工作流核验实际 Git HEAD、REVISION、共享配置链接、构建入口，以及共享配置/工作区/会话目录的身份；这不等于交互式模型任务验收，也不扫描会话内容。

发布失败时先打开 Actions 中的失败步骤。构建/测试失败发生在版本切换前，仍可使用原版本。版本切换后的核验失败需先查看 `current` 与日志，再决定回滚。不要删除旧版本目录；已有 CLI 可能仍在使用它们。

可在运行页面点击 **Re-run jobs → Re-run failed jobs** 重试临时 SSH/包注册表故障。旧工作流曾因服务器访问 GitHub 超时失败；新工作流通过 runner 传包解决这一下载依赖。构建或测试错误应先修复再发布。

## 回滚

若目标旧版本有生产标签，优先通过 `workflow_dispatch` 填写该标签重新部署。这样会重新安装、构建和测试旧提交，并留下 Actions 审计记录；完成后核对服务器 `REVISION` 等于该标签解析出的 commit SHA。

需要立即切回服务器已保留的直接上一版本时，可使用下列本地回滚。它不创建新的 Actions 记录，因此操作后须单独记录当前 tag、目标 SHA、执行人和原因。

确认需要回滚后，在服务器 `deploy` 终端粘贴以下完整代码块。它与发布脚本共用锁，仅切换 current，不改变共享配置、工作区或会话。首次发布的上一版本是 bootstrap。若发布脚本没有记录有效上一版本，命令会停止。

```bash
bash <<'ROLLBACK'
set -euo pipefail
base="$HOME/apps/mini-DSH"
exec 9>"$base/deploy.lock"
flock -w 120 9
current="$(readlink -f "$base/current")"
previous="$(cat "$current/PREVIOUS_RELEASE")"
test -n "$previous"
previous="$(readlink -f "$previous")"
case "$previous" in
  "$base/releases/"*) ;;
  *) echo '上一版本路径无效'; exit 1 ;;
esac
test -d "$previous"
test -f "$previous/dist/src/index.js"
test "$(readlink -f "$previous/.env")" = "$base/shared/.env"
next="$base/current.rollback.$$.next"
test ! -e "$next" && test ! -L "$next"
trap 'rm -f -- "$next"' EXIT
ln -s "$previous" "$next"
mv -Tf "$next" "$base/current"
printf '已回滚到：%s\n' "$previous"
ROLLBACK
```

重新运行 `~/bin/mini-dsh` 使用回滚版本。后续普通 main CI 不会覆盖回滚结果；只有新的版本标签或人工触发才会再次发布。回滚后仍需要修复造成故障的提交。
