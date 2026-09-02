# GitLab Access Service

这是一个无前端的 Docker Service，用于集中处理 GitLab 访问认证、调用方鉴权和受控的 Windows Pipeline 操作。

当前实现阶段：阶段 2，调用方认证和业务权限。

本阶段只包含：

- 阶段 0 的请求和响应类型；
- 阶段 0 的 `build`、`test` 模式校验；
- 阶段 0 的 `rust`、`unit`、`e2e` 到 GitLab Job 的固定映射；
- 阶段 0 的 Git ref 安全校验；
- Docker Service HTTP Server；
- Docker Secret 配置读取；
- GitLab HTTPS Client；
- `/health/live` 和 `/health/ready`；
- 配置、TLS 参数和健康检查测试。
- RS256 Bearer Token 校验；
- 调用方 issuer、audience、subject、有效期和权限校验；
- `/v1/access/check` 的认证和权限保护。

本阶段不包含：

- Pipeline 创建和轮询；
- manual Job 启动；
- Trace 和 Artifact 下载。

## 本地验证

```powershell
pnpm install
pnpm typecheck
pnpm test
```

接口契约位于：

```text
docs/openapi.yaml
```

## 阶段 1 本地验证

```powershell
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

容器部署模板位于：

```text
Dockerfile
compose.yaml
```

不要把真实 Token 或 CA 放入仓库。Compose 预期从以下本地文件读取 Secret：

```text
secrets/gitlab-token
secrets/gitlab-ca.crt
secrets/auth-jwt-public-key.pem
```

Compose 还需要配置 JWT 的发行方和 audience：

```text
AUTH_JWT_ISSUER
AUTH_JWT_AUDIENCE
```

本阶段只验证外部签发的 RS256 JWT，不实现登录页面、用户名密码或
Token 签发。下一阶段将实现 GitLab API Adapter。
