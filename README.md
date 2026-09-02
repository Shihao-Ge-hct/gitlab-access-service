# GitLab Access Service

这是一个无前端的 Docker Service，用于集中处理 GitLab 访问认证、调用方鉴权和受控的 Windows Pipeline 操作。

当前实现阶段：阶段 4，受控远程执行流程。

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
- 创建和查询受控 Pipeline；
- 查询 Windows 测试和构建 Job；
- 启动白名单中的 manual Job；
- 读取 Job Trace；
- 下载 Job Artifact；
- 将 GitLab CI 配置 ref 与用户选择的 GitHub 源码 ref 分开处理。
- 封装创建 Pipeline、启动 manual Job 和轮询最终状态的执行流程；
- 提供远程执行任务的状态查询和取消监控接口；
- 提供轮询间隔、执行超时和取消状态配置。

本阶段不包含：

- GitLab 远程 Pipeline 的强制取消；
- 远程脚本和 Skill 迁移。

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

## 阶段 4 本地验证

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

GitLab Pipeline 配置分支通过 `GITLAB_PIPELINE_REF` 指定，用户真正要构建或测试的 GitHub 版本通过请求中的 `ref` 指定。两者默认都可以是 `main`，但含义不同。

本阶段只验证外部签发的 RS256 JWT，不实现登录页面、用户名密码或
Token 签发。

远程执行接口会在 Service 内部完成以下流程：

```text
创建 Pipeline
    -> 等待目标 Job 出现
    -> 启动 manual Job
    -> 轮询所有目标 Job
    -> 返回 success、failed、canceled 或 timed_out
```

取消操作只停止 Service 对该任务的继续监控，不会调用 GitLab 的 Pipeline
取消接口，也不代表远程 Job 已经停止。

下一阶段将实现远程测试和远程打包脚本到 Service API 的迁移。
