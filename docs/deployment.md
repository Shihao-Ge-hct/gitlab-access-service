# GitLab Access Service 部署

本文说明如何用 Docker Compose 在一台内网服务器上启动无前端的 GitLab Access Service。
Service 负责保存 GitLab Token、GitLab CA 和 JWT 公钥；调用方只需要访问 Service 并携带
调用方 JWT。

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
AUTH_JWT_ISSUER
AUTH_JWT_AUDIENCE
SERVICE_NETWORK_NAME
SERVICE_DOCKER_SUBNET
```

`SERVICE_BIND_ADDRESS` 默认是 `127.0.0.1`，只允许本机访问。要让其他内网机器调用，
应改成服务器的内网 IP，或者按公司网络策略使用 `0.0.0.0`，同时在服务器防火墙上只
允许受信任的调用方访问 `SERVICE_PORT`。不要直接暴露到公网。

Compose 使用独立的显式 Docker bridge network，默认网段为 `10.254.0.0/24`。
如果该网段和服务器已有 Docker 或内网网段冲突，应在 `.env` 中修改
`SERVICE_DOCKER_SUBNET`，并确保 `SERVICE_NETWORK_NAME` 唯一。

## 2. 准备 Docker Secrets

把以下三个文件放入 `secrets/`：

```text
secrets/gitlab-token
secrets/gitlab-ca.crt
secrets/auth-jwt-public-key.pem
```

文件要求：

- `gitlab-token` 只包含 Service 访问 GitLab 项目所需的 Token；
- `gitlab-ca.crt` 是签发 GitLab HTTPS 证书的内部 CA 证书，必须是有效的 X.509 PEM；
- `auth-jwt-public-key.pem` 是调用方 JWT 签名公钥，必须与调用方使用的 RS256 私钥匹配；
- JWT 私钥只能保存在调用方的安全环境，不要复制到 Service 服务器或仓库；
- 三个文件都不要提交到 Git，也不要写入 Dockerfile、`.env` 或日志。

如果需要生成一组测试用的 RS256 密钥，可以在安全的密钥目录执行：

```powershell
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out auth-jwt-private-key.pem
openssl rsa -pubout -in auth-jwt-private-key.pem -out secrets/auth-jwt-public-key.pem
```

生产环境应使用公司统一的身份系统和密钥管理流程，不要把生成的测试私钥用于生产。

## 3. 校验 Compose 配置

先检查变量替换、Secret 路径和最终容器配置：

```powershell
docker compose --env-file .env config
```

这个命令只校验 Compose 配置，不会启动容器。若提示 `AUTH_JWT_ISSUER must be set`，
说明 `.env` 尚未配置完整。

## 4. 构建并启动

```powershell
docker compose --env-file .env build
docker compose --env-file .env up -d
docker compose --env-file .env ps
```

默认构建使用 Node 24 和 pnpm 10.34.5。Dockerfile 已经固定 pnpm 版本，不会因为
Corepack 发布了新版本而改变构建结果。

容器以非 root 的官方 `node` 用户运行。Compose 的本地 file Secret 即使保持
宿主机 `600` 权限，也能被容器内的 Service 读取；不要为了绕过权限问题把
Token 文件改成全局可读。

如果服务器暂时无法拉取 Node 24，但已经缓存了满足项目 `engines.node >=20` 的
`node:20-slim`，可以先用显式基础镜像完成验证：

```powershell
docker build --pull=false --build-arg NODE_IMAGE=node:20-slim --tag gitlab-access-service:local .
```

这只是部署环境兼容性验证；恢复正常的镜像拉取后，正式部署仍建议使用默认的
Node 24 基础镜像。

确认容器状态为 `healthy`。首次启动或镜像更新后，Service 需要先通过容器自身的
`/health/live` 健康检查。

查看启动日志：

```powershell
docker compose --env-file .env logs --tail=100 gitlab-access-service
```

## 5. 验收健康状态和 GitLab 访问

检查进程存活：

```powershell
Invoke-WebRequest "http://127.0.0.1:8080/health/live"
```

检查 GitLab 连接、Token、CA 和目标项目：

```powershell
Invoke-WebRequest "http://127.0.0.1:8080/health/ready"
```

如果 `.env` 中把 `SERVICE_PORT` 改成了其他宿主机端口，将命令中的 `8080` 替换为该端口。
`/health/live` 成功只表示 Node 进程正在运行；`/health/ready` 成功才表示 Service
已经可以通过 CA 和 GitLab Token 访问目标项目。`/health/ready` 返回 `503` 时，应先
检查 Secret 内容、CA 链、GitLab 地址、Token 权限和服务器网络。

调用方 JWT 的权限链路可以通过 GitKrab 的 `check` 命令验证：

```powershell
node scripts/windows-remote-ci.mjs check
```

GitKrab 客户端需要配置：

```text
GITLAB_ACCESS_SERVICE_URL
GITLAB_ACCESS_SERVICE_TOKEN
```

这里的 Token 是调用方 JWT，不是 GitLab Token。GitLab Token 和 GitLab CA 不应出现在
GitKrab 客户端环境、Skill、命令行参数或日志中。

## 6. 停止、更新和回滚

停止 Service：

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
