# 阿里云 CLI 部署与自动发布

适用于当前已配置的 Alibaba Cloud Linux 4 x86_64 服务器。mini-DSH 是交互式终端程序；在服务器终端登录 `deploy` 用户后运行，不提供网页入口。

## 日常启动

```bash
~/bin/mini-dsh
```

启动时确认 `Sandbox workspace` 为 `/home/deploy/workspaces/default`。输入 `/exit` 退出。新启动使用 `current` 指向的版本，已运行的 CLI 使用原版本；发布不会重启正在进行的任务。

## 发布流程

向 GitHub 仓库 `main` 推送提交后，打开仓库的 Actions 页面：先查看 **CI**，再查看 **Deploy ECS**。四组 Ubuntu/Windows、Node22/24 的 CI 全部成功后才发布；失败或取消时跳过部署。手动 **ECS SSH Check** 只检查连接和环境，不发布版本。

Deploy ECS 使用 CI 的 `head_sha`，通过严格主机密钥校验的 SSH 调用服务器 `~/bin/deploy-mini-dsh`。服务器脚本创建独立版本目录、安装锁定依赖、执行 `pnpm check` 和 `pnpm test`，成功后原子切换 `current`。如果 main 已有更新提交，旧发布跳过版本切换。工作流串行执行；服务器脚本另使用 `flock` 锁，避免并行切换。

触发机制使用 GitHub 官方的 [workflow_run](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run)；工作流限定同仓库、main、push 和成功结论。没有从 PR 直接发布的入口。

服务器需要保留以下布局：

- `~/apps/mini-DSH/releases/`：独立版本目录，初始安装为 `bootstrap`。
- `~/apps/mini-DSH/current`：当前版本软链接。
- `~/apps/mini-DSH/shared/.env`：共享模型配置，权限 600，版本中的 `.env` 链接到此文件。
- `~/workspaces/default`：固定工作区。
- `~/.mini-dsh/sessions`：持久会话记录。
- `~/bin/mini-dsh`：加载 nvm Node24、解析 current、进入实际版本目录并启动构建产物。
- `~/bin/deploy-mini-dsh`：已手动安装的发布脚本，权限 700；更换服务器时需要重新安装。

共享 `.env` 中设置 `MINI_DSH_WORKSPACE=/home/deploy/workspaces/default` 与 `MINI_DSH_SESSION_DIR=/home/deploy/.mini-dsh/sessions`。服务器已有 nvm Node24 与 pnpm11.22.0，以及 Git、Bash、`flock`。模型密钥只保存在共享配置中。

GitHub 的 `production` Environment 保存五项 Secrets：`ECS_HOST`、`ECS_PORT`、`ECS_USER`（deploy）、`ECS_SSH_KEY`、`ECS_KNOWN_HOSTS`。部署密钥的公钥位于服务器 `~/.ssh/authorized_keys`；KNOWN_HOSTS 使用已核验的服务器 ED25519 主机公钥。真实密钥和地址不写入仓库。

## 查看版本

在服务器 `deploy` 终端执行：

```bash
readlink -f ~/apps/mini-DSH/current
cat ~/apps/mini-DSH/current/REVISION
```

第一次自动发布前，bootstrap 没有 REVISION。发布日志会显示完整提交 SHA。部署后工作流核验实际 Git HEAD、REVISION、共享配置链接、构建入口，以及共享配置/工作区/会话目录的身份；这不等于交互式模型任务验收，也不扫描会话内容。

发布失败时先打开 Actions 中的失败步骤。构建/测试失败发生在版本切换前，仍可使用原版本。版本切换后的核验失败需先查看 `current` 与日志，再决定回滚。不要删除旧版本目录；已有 CLI 可能仍在使用它们。

如果失败日志是服务器下载 GitHub 时连接中断，可在该运行页面点击 **Re-run jobs → Re-run failed jobs** 重试。首次发布曾遇到这一错误，重试成功；构建或测试错误应先修复再发布。

## 回滚到上一版本

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

重新运行 `~/bin/mini-dsh` 使用回滚版本。后续 main 的成功 CI 仍会触发自动发布；回滚后需要同时修复造成故障的提交。
