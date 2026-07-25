# Main + WeChat 后端确认报告

> 状态：**源码候选 PASS；上线确认 PENDING**
>
> 本报告先记录可重复验证的源码与本地门禁证据。只有同一 `main` 合并 SHA 的
> Staging、Production、QR smoke 和观察窗口全部通过后，才会把最终结论更新为
> `PASS` 并创建 `confirmed-main-wechat-v1`。

## 1. 候选版本

| 项目 | 值 |
| --- | --- |
| 审计日期 | 2026-07-25 |
| 仓库 | `toMeetADX/TOMEET_Backend` |
| 候选分支 | `fix/backend-only-wechat-confirmation` |
| 候选基线 `origin/main` | `f771c7b851c1dd06d05f0c87f6a9060ca8fb5c0a` |
| WeChat 来源分支 | `origin/feat/wechat-channel` |
| WeChat 来源 SHA | `06e7b71a8c1519e9248696b50924d0511090bedc` |
| 候选提交 SHA | 合并前待补 |
| `main` 合并 SHA | 待补 |
| Production 实际部署 SHA | 待补 |
| 最终确认标签 | 待创建：`confirmed-main-wechat-v1` |

候选版本在从最新 `origin/main` 创建的独立干净 worktree 中完成。原工作区
`fix/staging-release-bootstrap` 的 `docs/wechat-ilink-deployment.md` 和
`supabase/config.toml` 未提交修改没有被覆盖或带入本候选版本。

## 2. WeChat 业务完整性

- `git merge-base --is-ancestor origin/feat/wechat-channel origin/main`：PASS。
- `origin/feat/wechat-channel...origin/main` 提交计数：来源分支独有 `0`，
  `main` 独有 `19`。
- 对 `apps/api/src/wechat-routes.ts`、`apps/wechat-ilink-worker`、
  `packages/wechat-ilink`、`packages/data`、`packages/contracts` 和
  `supabase/migrations` 执行来源分支到候选基线的文件差异检查：无差异。
- 本次候选修改没有更改上述 WeChat 运行时代码；只增强了 QR 契约、测试、
  smoke 和发布门禁。

关键 Git 对象校验：

| 路径 | `feat/wechat-channel` | 候选基线 | 结果 |
| --- | --- | --- | --- |
| `apps/api/src/wechat-routes.ts` | `686224fd69c933805bfa0e3b49f2d084a17eb655` | `686224fd69c933805bfa0e3b49f2d084a17eb655` | 相同 |
| `apps/wechat-ilink-worker` | `27fbab4138d518895502cbc92d1c94fa0430414c` | `27fbab4138d518895502cbc92d1c94fa0430414c` | 相同 |
| `packages/wechat-ilink` | `53332531e6616b802bd1427ebe1bfd34087ee03c` | `53332531e6616b802bd1427ebe1bfd34087ee03c` | 相同 |
| `packages/data` | `3c982252a923d0ac776daf499e4fbac11c1cfe2d` | `3c982252a923d0ac776daf499e4fbac11c1cfe2d` | 相同 |
| `packages/contracts` | `b682a026c10b74fe1fa2bf9654c946ed1face470` | `b682a026c10b74fe1fa2bf9654c946ed1face470` | 相同 |
| `supabase/migrations` | `554c8b463394e9a8573d8a7db60a185643d66807` | `554c8b463394e9a8573d8a7db60a185643d66807` | 相同 |

结论：`main` 已完整包含 `feat/wechat-channel` 的 WeChat QR、iLink Worker、
共享数据层、契约、迁移和后端 Agent 逻辑。

## 3. 后端边界

| 检查 | 结果 |
| --- | --- |
| 删除仓库内 `apps/web` 及所有可部署前端 | PASS |
| 删除 Next.js、React 和 Next ESLint 依赖及 lockfile 条目 | PASS |
| 删除 `NEXT_PUBLIC_*` 示例变量 | PASS |
| `dev` 只启动 API | PASS |
| `dev:all` 启动 API、Intelligence Worker、WeChat Worker | PASS |
| 保留 `FRONTEND_ORIGIN` 供仓库外前端 CORS 调用 | PASS |
| 删除 agent sync 脚本、配置、测试和 package 命令 | PASS |
| 删除会推送或同步分支的 workflow | PASS |
| 新增只校验 PR 的 `Main Validation / validate-pr` | PASS |
| 保留双 API Service、两个 Worker 和全部 `/agent/*` 后端路由 | PASS |

仓库外部前端的当前边界仅为 WeChat 扫码登录界面；它不负责 Agent Layer
运行逻辑，也不要求 `main` 与 `wechat-channel` 分支同步。

## 4. 公共 QR API 契约

| 方法与路径 | 鉴权 | 关键行为 |
| --- | --- | --- |
| `POST /wechat/connect/sessions` | 匿名；可选 Bearer 兼容 | 仅创建响应返回 `sessionToken`、`qrCodeContent`；`Cache-Control: no-store` |
| `GET /wechat/connect/sessions/{sessionId}` | `X-WeChat-Session-Token` | 返回状态；不返回二维码、token 或加密凭据 |
| `GET /wechat/connect/sessions/{sessionId}/events` | `X-WeChat-Session-Token` | 使用 `fetch` 读取 SSE；token 不进入 URL |
| `POST /wechat/connect/sessions/{sessionId}/verify` | `X-WeChat-Session-Token` | 只接受 4–12 位数字验证码 |

固定状态为 `pending`、`scanned`、`verification_required`、`active`、
`expired`、`failed`。OpenAPI、接入文档和自动测试已同步。

## 5. 本地门禁证据

执行环境：Windows / Node.js 22 兼容工作区 / pnpm 10.14.0。

| 命令或检查 | 结果 |
| --- | --- |
| `pnpm install --frozen-lockfile` | PASS |
| `pnpm agent:migrations:check -- --all` | PASS，15 个迁移 |
| `pnpm check` | PASS |
| ESLint | PASS |
| TypeScript | PASS |
| 全仓库后端测试 | PASS |
| 全仓库后端构建 | PASS |
| WeChat QR 定向测试 | PASS，20/20 |
| workflow / OpenAPI / QR smoke 脚本测试 | PASS，16/16 |
| `git diff --check` | PASS |
| 活跃配置中的前端依赖残留 | 无 |
| 活跃实现中的 agent sync 残留 | 无 |

覆盖点包括允许/拒绝 Origin、CORS 自定义 Header、匿名创建、状态与 SSE、
终态、GET fallback、验证码校验、429 与 `Retry-After`，以及二维码、
session token、bot token、加密凭据不泄漏。真实 QR smoke 会检查 `/ready`、
OPTIONS、匿名创建、错误/正确 Header、SSE 首事件和状态查询；敏感 token
只保存在进程内存且不打印。

## 6. CI、部署与回滚证据

| 门禁 | 状态 | 证据 |
| --- | --- | --- |
| 历史 PR #15 | PASS | <https://github.com/toMeetADX/TOMEET_Backend/pull/15> |
| 历史 PR 校验 | PASS | <https://github.com/toMeetADX/TOMEET_Backend/actions/runs/30150588175> |
| 历史 main Release | FAIL（Staging 缺少 `RAILWAY_PROJECT_ID`） | <https://github.com/toMeetADX/TOMEET_Backend/actions/runs/30150591470> |
| 本候选 PR | PENDING | 待补 |
| `Main Validation / validate-pr` | PENDING | 待补 |
| Staging 四服务部署 | PENDING | 待补部署 ID |
| Staging cross-channel smoke | PENDING | 待补 |
| Staging QR smoke | PENDING | 待补 |
| Staging 5 分钟观察 | PENDING | 待补 |
| Production 四服务部署 | PENDING | 待补部署 ID |
| Production cross-channel smoke | PENDING | 待补 |
| Production QR smoke | PENDING | 待补 |
| Production 10 分钟观察 | PENDING | 待补 |

回滚点必须从 Railway 当前成功部署反查真实 Git SHA 后再建立：

| 标签 | SHA | 状态 |
| --- | --- | --- |
| `prod-web-stable` | 待反查 | PENDING |
| `prod-wechat-stable` | 待反查 | PENDING |

在可靠 SHA、Production GitHub Autodeploy 关闭、overlap/draining 配置和
Supabase 备份/PITR 均得到验证前，Production 发布保持关闭。

## 7. 最终判定

- 源码完整性：**PASS**
- 后端-only 边界：**PASS**
- 本地质量门禁：**PASS**
- 远端 PR 门禁：**PENDING**
- Staging：**PENDING**
- Production：**PENDING**
- 最终确认版：**PENDING**

如果任一 CI、部署、健康检查、smoke、日志、指标或观察窗口失败，本版本
不得标记为确认版；如 Production 已开始变更，则必须使用真实 stable 标签
回滚全部四个服务。
