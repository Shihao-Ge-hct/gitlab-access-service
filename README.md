# GitLab Access Service

这是一个无前端的 Docker Service，用于集中处理 GitLab 访问认证、调用方鉴权和受控的 Windows Pipeline 操作。

当前实现阶段：阶段 0，冻结接口契约和参数基线。

本阶段只包含：

- 请求和响应类型；
- `build`、`test` 模式校验；
- `rust`、`unit`、`e2e` 到 GitLab Job 的固定映射；
- Git ref 安全校验；
- 上游 GitLab HTTP 状态映射；
- OpenAPI 初始契约；
- Contract Test。

本阶段不包含：

- HTTP Server；
- Dockerfile；
- 真实 GitLab 请求；
- Token 和 CA 读取；
- 调用方 JWT 验证；
- Pipeline 轮询和 Artifact 下载。

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

下一阶段将实现 Docker Service 骨架、Secret 读取和 GitLab TLS 就绪检查。

