# 微信传输层决策

状态：已采用
日期：2026-07-24

## 决策

TOMEET 的生产微信通道直接实现腾讯
`@tencent-weixin/openclaw-weixin` 2.4.6 同源的 iLink HTTP 协议，由
`@tomeet/wechat-ilink-worker` 承载多账号长轮询、消息幂等、连接租约和
Railway 健康检查。

不使用 Photon Spectrum、`agent-wechat` 桌面容器或完整 OpenClaw runtime。
旧的 Photon gateway、SDK 和 Docker compose 已从仓库删除。

## 原因

- 腾讯上游公开维护扫码授权、多账号和消息协议。
- 直接对接减少桌面微信、VNC、Docker 端口和额外消息映射层的故障点。
- iLink 凭证仅在 TOMEET 服务端加密保存，可原子绑定 Supabase profile。
- 数据库 lease 允许 Railway worker 横向扩展，不依赖某一台 Windows PC。

## 边界

- TOMEET 只实现所需的 iLink wire protocol，不嵌入 OpenClaw 的插件宿主。
- 微信风控、二维码安全验证、上游限流和协议变更仍属于外部风险。
- 上游升级前必须回归二维码状态、`getUpdates`、`sendMessage`、
  `context_token` 和错误码 `-14`。
- 当前稳定版接收文本和已有转写文本的语音，输出文本；图片、文件、视频及
  原始 SILK/CDN 解密不在本版本范围。

## 生产入口

- API 扫码路由：`apps/api/src/wechat-routes.ts`
- iLink 协议适配：`packages/wechat-ilink`
- Railway worker：`apps/wechat-ilink-worker`
- Railway 配置：`railway.wechat.toml`
- 默认本地命令：`pnpm dev:wechat`
