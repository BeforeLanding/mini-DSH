# NX-42 V2 候选隔离运行环境

本地验证环境为 Windows 主机、WSL2 `Ubuntu`、bubblewrap 0.11.1 与 Linux Node 22.22.1。V2 的候选 Bash 由主机 `wsl.exe` 启动，在 bubblewrap 的独立用户、挂载、PID、网络等命名空间中执行；只把该题临时工作区读写挂到 `/workspace`，把锁定的 Node 运行时只读挂到 `/runtime`，公共 `/usr/bin`、`/usr/lib` 只读挂载。`--clearenv` 清除主机变量，容器内只设 HOME、PATH、LD_LIBRARY_PATH；模型适配器及密钥始终在宿主进程。文件工具继续受工作区真实路径检查约束，Bash 不能绕过它读取 WSL 主机路径。旧 CLI 装配不使用这条命令执行路径。

在 WSL 的 Ubuntu `resolute` 仓库可用时，从仓库根运行：

```sh
sh scripts/eval-v2-prepare-runtime.sh /mnt/d/Agent/tmp/nx42-runtime
```

脚本按 [锁文件](../../scripts/eval-v2-runtime.sha256)下载固定版本的 `.deb`，逐包验证 SHA-256 并解压到参数目录下的 `unpack`，不安装到 WSL 系统。执行探针时将 Windows 路径 `D:\Agent\tmp\nx42-runtime\unpack` 传为 `MINI_DSH_V2_RUNTIME`。锁文件固定的是本地已验证镜像，若 Ubuntu 仓库不再提供该版本，需获取相同字节的包；不得静默换新版本继续沿用原实验批次。

隔离验收命令：

```powershell
$env:MINI_DSH_V2_RUNTIME='D:\Agent\tmp\nx42-runtime\unpack'
node scripts/build.js
node --test dist/test/eval-v2-isolation.test.js
```

探针从 Bash 和 Node 两条路径读取已知的工作区外诱饵，均确认不可见；正常 `node`、`cat`、公开检查和工作区回读可用；文件工具越界探针被拒；取消后检查延迟写入没有发生。V2 episode 只有提供隔离配置才能启动。每阶段快照在候选挂载之外，运行结束后先关闭会话/Agent，再复制末态到独立验收副本；隐藏 `verify.mjs` 与 reference 仅由宿主在该副本上运行，不在候选挂载中。

Linux 运行时目前依赖 WSL `Ubuntu` 发行版提供的系统 `/usr/bin` 和 `/usr/lib`；正式批次冻结时还需记录 WSL 发行版与这些公共依赖的版本/哈希，以及隔离配置与题目目录哈希。隔离探针是读写边界证据，不能替代正式批次的成本授权或题目合同门禁。
