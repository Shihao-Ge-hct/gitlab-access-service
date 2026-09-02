# GitLab Access Service 部署

本文说明如何用 Docker Compose 在一台内网服务器上启动无前端的 GitLab Access Service。
Service 集中保存 GitLab Token 和 GitLab CA，默认使用 `network-trust` 内网受信模式，
因此调用方不需要配置 JWT、GitLab Token 或 GitLab CA。

## 1. 准备目录和配置

在 Service 仓库根目录执行：

```powershell
Copy-Item .env.example .env
New-Item -ItemType Directory -Force secrets | Out-Null
```

编辑 `.env`，至少确认以下配置：

```text
SERVICE_BIND_ADDRESS
SERVICE_PORT
GITLAB_BASE_URL
GITLAB_PROJECT
GITLAB_PIPELINE_REF
AUTH_MODE
SERVICE_NETWORK_NAME
SERVICE_DOCKER_SUBNET
```

默认配置为：

```text
AUTH_MODE=network-trust
```

`SERVICE_BIND_ADDRESS` 默认是 `127.0.0.1`，只允许本机访问。要让其他内网机器调用，
应改成服务器的内网 IP，或者按公司网络策略使用 `0.0.0.0`，同时在服务器防火墙上只
允许公司内网或 VPN 网段访问 `SERVICE_PORT`。不要直接暴露到公网。

Compose 使用独立的显式 Docker bridge network，默认网段为 `10.254.0.0/24`。
如果该网段和服务器已有 Docker 或内网网段冲突，应在 `.env` 中修改
`SERVICE_DOCKER_SUBNET`，并确保 `SERVICE_NETWORK_NAME` 唯一。

## 2. 准备 Docker Secrets

基础 `network-trust` 模式只需要以下两个文件：

```text
secrets/gitlab-token
secrets/gitlab-ca.crt
```

文件要求：

- `gitlab-token` 只包含 Service 访问 GitLab 项目所需的 Token；
- `gitlab-ca.crt` 是签发 GitLab HTTPS 证书的内部 CA 证书，必须是有效的 X.509 PEM；
- 两个文件都不要提交到 Git，也不要写入 Dockerfile、`.env` 或日志。

## 3. 校验 Compose 配置

先检查变量替换、Secret 路径和最终容器配置：

```powershell
docker compose --env-file .env config
```

基础模式不需要 JWT issuer、audience 或公钥文件。

如果需要启用 JWT 模式，准备：

```text
secrets/auth-jwt-public-key.pem
```

并配置：

```text
AUTH_JWT_ISSUER=https://sso.example.internal
AUTH_JWT_AUDIENCE=gitlab-access-service
```

JWT 模式必须显式叠加 Compose 文件：

```powershell
docker compose `
  --env-file .env `
  -f compose.yaml `
  -f compose.jwt.yaml `
  config
```

## 4. 构建并启动

默认内网受信模式：

```powershell
docker compose --env-file .env build
docker compose --env-file .env up -d
docker compose --env-file .env ps
```

JWT 模式：

```powershell
docker compose `
  --env-file .env `
  -f compose.yaml `
  -f compose.jwt.yaml `
  build

docker compose `
  --env-file .env `
  -f compose.yaml `
  -f compose.jwt.yaml `
  up -d
```

默认构建使用 Node 24 和 pnpm 10.34.5。容器以非 root 的官方 `node` 用户运行。
Compose 的本地 file Secret 即使保持宿主机 `600` 权限，也能被容器内的 Service
读取；不要为了绕过权限问题把 Token 文件改成全局可读。

如果服务器暂时无法拉取 Node 24，但已经缓存了满足项目 `engines.node >=20` 的
`node:20-slim`，可以先用显式基础镜像完成验证：

```powershell
docker build --pull=false --build-arg NODE_IMAGE=node:20-slim --tag gitlab-access-service:local .
```

确认容器状态为 `healthy`。查看启动日志：

```powershell
docker compose --env-file .env logs --tail=100 gitlab-access-service
```

## 5. 验收健康状态和远程调用

检查进程存活：

```powershell
Invoke-WebRequest "http://127.0.0.1:8080/health/live"
```

检查 GitLab 连接、Token、CA 和目标项目：

```powershell
Invoke-WebRequest "http://127.0.0.1:8080/health/ready"
```

调用方在 `network-trust` 模式下不需要配置任何 Token：

```powershell
Set-Location D:\code\gitkrab
$env:GITLAB_ACCESS_SERVICE_URL = "http://10.80.1.251:18081"
node scripts/windows-remote-ci.mjs check
```

然后可以执行：

```powershell
node scripts/windows-remote-ci.mjs test --only=unit --ref main
node scripts/windows-remote-ci.mjs build --ref main
```

如果 Service 使用 JWT 模式，则客户端需要设置：

```text
GITLAB_ACCESS_SERVICE_TOKEN
```

这里的 Token 是调用方 JWT，不是 GitLab Token。GitLab Token 和 GitLab CA 永远只保存在
Service 服务器。

## 6. 停止、更新和回滚

停止基础模式 Service：

```powershell
docker compose --env-file .env down
```

更新代码并重新构建：

```powershell
git pull --ff-only
docker compose --env-file .env build
docker compose --env-file .env up -d
```

更新 Secret 后重启容器：

```powershell
docker compose --env-file .env up -d --force-recreate
```

回滚时应使用已验证的 Git commit 或镜像 tag，再执行同样的 build 和 up 命令。
不要通过关闭 TLS 校验、把 Token 写入 URL 或把 Secret 复制进镜像来处理部署问题。
