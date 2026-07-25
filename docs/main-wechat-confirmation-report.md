# Main + WeChat 后端确认报告

> 状态：**Production 服务上线 PASS；GitHub Production Watch BLOCKED**
>
> 后端源码、PR 门禁、Railway Production 三服务、真实 QR smoke 和观察窗口
> 均已通过。GitHub 定时 Production Watch 仍缺少由 Railway Project 管理员创建的
> 最小权限 Project Token；这不影响当前 ACTIVE 服务，但自动监控尚未恢复。

## 1. 候选版本

| 项目 | 值 |
| --- | --- |
| 审计日期 | 2026-07-25 |
| 仓库 | `toMeetADX/TOMEET_Backend` |
| 候选分支 | `fix/backend-only-wechat-confirmation` |
| 候选基线 `origin/main` | `f771c7b851c1dd06d05f0c87f6a9060ca8fb5c0a` |
| WeChat 来源分支 | `origin/feat/wechat-channel` |
| WeChat 来源 SHA | `06e7b71a8c1519e9248696b50924d0511090bedc` |
| 候选源码提交 SHA | `67c97769489cbfb7a7d58d6038013a1437b4ee60` |
| 首次后端-only 合并 SHA | `0970cc1bf904326b8935ccdd7167770825d27b16` |
| Production 实际发布 SHA | `1907608a5f552396a3d97c025fdd274765699064` |
| 最终确认标签 | `confirmed-main-wechat-v1` |

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
| 保留全部 `/agent/*` 后端路由；实际 Production 使用共享 API + 两个 Worker | PASS |

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
| workflow / OpenAPI / QR smoke 脚本测试 | PASS，17/17 |
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
| 本候选 PR #17 | MERGED（校验完成前由仓库所有者合并） | <https://github.com/toMeetADX/TOMEET_Backend/pull/17> |
| PR #17 `Main Validation / validate-pr` | CANCELLED（合并取消了运行中的 `pnpm check`） | <https://github.com/toMeetADX/TOMEET_Backend/actions/runs/30151988410> |
| 合并后 Release | FAIL CLOSED（配置校验发现 Staging Environment 全空，部署前停止） | <https://github.com/toMeetADX/TOMEET_Backend/actions/runs/30151991077> |
| docs-only 补证 PR #19 | PASS | <https://github.com/toMeetADX/TOMEET_Backend/pull/19> |
| PR #19 `Main Validation / validate-pr` | PASS | <https://github.com/toMeetADX/TOMEET_Backend/actions/runs/30152241752> |
| QR smoke 修复 PR #20 | PASS | <https://github.com/toMeetADX/TOMEET_Backend/pull/20> |
| PR #20 `Main Validation / validate-pr` | PASS | <https://github.com/toMeetADX/TOMEET_Backend/actions/runs/30152867187> |
| Production API ready/health | PASS，HTTP 200 | `https://api.tomeet.chat/ready`、`/health` |
| Production QR smoke | PASS | Origin `https://tomeet.chat`；匿名创建、CORS、Header 鉴权、SSE、状态查询 |
| Production 观察窗口 | PASS | 10 分钟以上；单次 Railway 控制面超时后复核并补充 150 秒、8 轮连续通过 |
| Production error/HTTP | PASS | API/Intelligence 最近窗口 error 0；API 5xx 0；WeChat 最近 10 分钟 error 0 |
| GitHub Production Watch | BLOCKED | Railway 项目成员无权创建 Project Token；不能使用个人广域 OAuth Token 替代 |

本次按仓库所有者的最新指令直接验证并发布实际 Production；未使用先前创建但
从未部署的 `TOMEET-staging` 项目，因此 Staging 发布证据为 `NOT RUN`。

### Railway Production

| 项目 | 值 |
| --- | --- |
| Project | `TOMEET` (`f7668ac0-8aae-483b-9d0c-066906b4d5b3`) |
| Environment | `production` (`4881843d-edd6-4097-9fab-57a4f01b26d1`) |
| GitHub source | `toMeetADX/TOMEET_Backend` / `main` |
| Deployment teardown | 三服务 overlap `30s`、draining `30s` |

| Service | Deployment ID | 终态 |
| --- | --- | --- |
| `@tomeet/intelligence-worker` | `90dd020e-6f1a-4496-8229-5720d326f70a` | `SUCCESS` |
| `@tomeet/api` | `07f0760c-4e97-40f5-85a3-bdd742972f95` | `SUCCESS` |
| `@tomeet/wechat-ilink-worker` | `6ba9f322-1a44-4a61-a92c-f463cb2b9dc1` | `SUCCESS` |

WeChat Worker 启动后曾记录一次 `wechat_reauth_required`（iLink `-14`），
表示某个既有微信连接需要重新扫码，不是进程崩溃；此后最近 10 分钟 error
为 0。旧 deployment 同窗口有 3 次 batch flush error，因此没有回滚到旧版。

### 回滚与确认标签

| 标签 | SHA | 状态 |
| --- | --- | --- |
| `prod-web-previous` | `0970cc1bf904326b8935ccdd7167770825d27b16` | 已建立 |
| `prod-intelligence-previous` | `8df357c08fc236419ea88f7d77526364c86e011f` | 已建立 |
| `prod-wechat-previous` | `86071da0659dd827e8b3a8c1e530db021f7e758c` | 已建立 |
| `prod-web-stable` | `1907608a5f552396a3d97c025fdd274765699064` | 已推进 |
| `prod-intelligence-stable` | `1907608a5f552396a3d97c025fdd274765699064` | 已推进 |
| `prod-wechat-stable` | `1907608a5f552396a3d97c025fdd274765699064` | 已推进 |
| `confirmed-main-wechat-v1` | `1907608a5f552396a3d97c025fdd274765699064` | annotated tag 已创建 |

## 7. 最终判定

- 源码完整性：**PASS**
- 后端-only 边界：**PASS**
- 本地质量门禁：**PASS**
- 远端 PR 门禁：**PASS**
- Railway Production 三服务：**PASS**
- Production QR smoke：**PASS**
- Production 观察窗口：**PASS**
- Staging：**NOT RUN（仓库所有者直接 Production 指令）**
- GitHub Production Watch：**BLOCKED（等待 Project 管理员 Token）**
- Production 确认版本：**`confirmed-main-wechat-v1`**

当前服务上线判定为 **PASS**。剩余自动化待办不会影响当前运行实例：由
`4Fe_Andy` Railway Workspace 的 Project 管理员创建 Production Project
Token，并将其写入 GitHub `production` Environment 的 `RAILWAY_TOKEN`。
