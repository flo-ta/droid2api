# Docker 部署指南

## 本地 Docker 部署

### 1. 准备环境变量

创建 `.env` 文件（从 `.env.example` 复制）：

```bash
cp .env.example .env
```

编辑 `.env` 文件，配置认证：

```env
# 必填：Factory API 密钥（fk- 开头），永不过期
FACTORY_API_KEY=your_factory_api_key_here

# 可选：上游 x-factory-org-id 使用的 Factory 侧组织 ID
FACTORY_ORG_ID=your_factory_org_id

# 必填：客户端独立 API Key（酒馆 / AI harness 使用）
request_auth_token=your_private_request_token_here
```

### 2. 使用 Docker Compose 启动

```bash
docker-compose up -d
```

查看日志：

```bash
docker-compose logs -f
```

停止服务：

```bash
docker-compose down
```

### 3. 使用原生 Docker 命令

**构建镜像：**

```bash
docker build -t droid2api:latest .
```

**运行容器：**

```bash
docker run -d \
  --name droid2api \
  -p 3000:3000 \
  -e FACTORY_API_KEY="your_factory_api_key_here" \
  -e FACTORY_ORG_ID="your_factory_org_id" \
  -e request_auth_token="your_private_request_token_here" \
  droid2api:latest
```

**查看日志：**

```bash
docker logs -f droid2api
```

**停止容器：**

```bash
docker stop droid2api
docker rm droid2api
```

## 云平台部署

### Render.com 部署

1. 在 Render 创建新的 Web Service
2. 连接你的 GitHub 仓库
3. 配置：
   - **Environment**: Docker
   - **Branch**: docker-deploy
   - **Port**: 3000
4. 添加环境变量：
   - `request_auth_token`: 独立客户端 API Key（必需，名称为小写）
   - `FACTORY_API_KEY`: Factory API 密钥（必需）
   - `FACTORY_ORG_ID`: Factory 侧组织 ID（可选）
5. 点击 "Create Web Service"

### Railway 部署

1. 在 Railway 创建新项目
2. 选择 "Deploy from GitHub repo"
3. 选择分支：docker-deploy
4. Railway 会自动检测 Dockerfile
5. 添加环境变量：
   - `request_auth_token`: 独立客户端 API Key（必需，名称为小写）
   - `FACTORY_API_KEY`: Factory API 密钥（必需）
   - `FACTORY_ORG_ID`: Factory 侧组织 ID（可选）
6. 部署完成后会自动分配域名

### Fly.io 部署

1. 安装 Fly CLI：
   ```bash
   curl -L https://fly.io/install.sh | sh
   ```

2. 登录：
   ```bash
   fly auth login
   ```

3. 初始化应用（在项目目录）：
   ```bash
   fly launch
   ```

4. 设置环境变量：
   ```bash
   fly secrets set FACTORY_API_KEY="your_factory_api_key_here" request_auth_token="your_private_request_token_here"

   # 可选
   fly secrets set FACTORY_ORG_ID="your_factory_org_id"
   ```

5. 部署：
   ```bash
   fly deploy
   ```

### Google Cloud Run 部署

1. 构建并推送镜像：
   ```bash
   gcloud builds submit --tag gcr.io/YOUR_PROJECT_ID/droid2api
   ```

2. 部署到 Cloud Run：
   ```bash
   gcloud run deploy droid2api \
     --image gcr.io/YOUR_PROJECT_ID/droid2api \
     --platform managed \
     --region us-central1 \
     --allow-unauthenticated \
     --set-env-vars FACTORY_API_KEY="your_factory_api_key_here",FACTORY_ORG_ID="your_factory_org_id",request_auth_token="your_private_request_token_here" \
     --port 3000
   ```

### AWS ECS 部署

1. 创建 ECR 仓库
2. 推送镜像到 ECR
3. 创建 ECS 任务定义
4. 配置环境变量：
   - `request_auth_token`（必需）
   - `FACTORY_API_KEY`（必需）
   - `FACTORY_ORG_ID`（可选）
5. 创建 ECS 服务

## 健康检查

容器启动后，可以通过以下端点检查服务状态：

```bash
curl http://localhost:3000/
curl -H "Authorization: Bearer $request_auth_token" http://localhost:3000/v1/models
```

根路径健康检查无需 Token；模型列表及所有生成接口均需鉴权。上述模型列表示例需要先在当前 shell 导出 `request_auth_token`。

## 环境变量说明

| 变量名 | 必需 | 说明 |
|--------|------|------|
| `request_auth_token` | 是 | 独立客户端密钥，可打印 ASCII 且不含空白或逗号；修改后重启服务 |
| `FACTORY_API_KEY` | 是 | Factory API 密钥（fk- 开头），永不过期 |
| `FACTORY_ORG_ID` | 否 | 上游 `x-factory-org-id` 头使用的 Factory 侧组织 ID |
| `NODE_ENV` | 否 | 运行环境，默认 production |

## 故障排查

### 容器无法启动

查看日志：
```bash
docker logs droid2api
```

常见问题：
- 未设置或留空 `FACTORY_API_KEY` / `request_auth_token`
- API 密钥无效
- 端口 3000 已被占用

### API 请求返回 401

**解决**：
1. 入口返回 `invalid_api_key` 时，客户端 API Key 必须等于 `request_auth_token`，使用 Bearer 或 `x-api-key`；同时发送两种头时必须都正确。
2. 若上游 Factory 返回 401，检查服务端 `FACTORY_API_KEY` 是否有效。
3. 修改环境变量后重建容器：`docker-compose up -d --force-recreate`。

客户端无需持有 Factory 密钥或组织 ID，它们始终由服务端配置提供。

### API 请求返回 403

**解决**：检查 `FACTORY_ORG_ID` 是否为正确的 Factory 侧组织 ID

### 容器频繁重启

检查健康检查日志和应用日志，可能是：
- 内存不足
- 配置文件错误

## 安全建议

1. **不要将 `.env` 文件提交到 Git**
2. **使用 secrets 管理敏感信息**（如 GitHub Secrets、Docker Secrets）
3. **定期更新 API 密钥**
4. **启用 HTTPS**（云平台通常自动提供）
5. **限制访问来源**（通过防火墙或云平台配置）

## 性能优化

### 多阶段构建（可选）

```dockerfile
# 构建阶段
FROM node:24-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci

# 生产阶段
FROM node:24-alpine
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]
```

### 资源限制

在 docker-compose.yml 中添加：

```yaml
services:
  droid2api:
    deploy:
      resources:
        limits:
          cpus: '1'
          memory: 512M
        reservations:
          cpus: '0.5'
          memory: 256M
```

## 监控和日志

### 查看实时日志

```bash
docker-compose logs -f
```

### 导出日志

```bash
docker logs droid2api > droid2api.log 2>&1
```

### 集成监控工具

可以集成：
- Prometheus + Grafana
- Datadog
- New Relic
- Sentry（错误追踪）
