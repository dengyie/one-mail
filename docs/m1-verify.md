# M1 验证记录 — one-mail 基座端到端收信

日期：2026-08-18（UTC）

## 链路

外部 SMTP（163）→ Cloudflare Email Routing（mangoqwq.cc.cd catch-all）→ one-mail Worker → D1 `raw_mails`

## 配置

- Worker: `one-mail` @ https://one-mail.601560588.workers.dev
- Zone: mangoqwq.cc.cd = `98257ad774e8bae767c44b5048af59e9`
- Email Routing: `enabled: true`, `status: ready`（此前为 `unconfigured`，经 `POST /email/routing/enable` 修复，CF 自动补 MX route1/2/3.mx.cloudflare.net）
- catch-all 规则：matchers=all → action=worker `one-mail`，enabled（此前已配置）
- SPF TXT: `v=spf1 include:_spf.mx.cloudflare.net ~all`
- 既有 cf-temp-mail 服务（mangoqwq.com / mango9502.cc.cd / mangoq.ccwu.cc）未做任何改动

## 验证

1. 通过 163 SMTP（smtp.163.com:465，mango9502@163.com + 授权码）向 `test123@mangoqwq.cc.cd` 发送主题 `one-mail-m1-test-2`。
   （第一次发送时 zone 路由还是 `unconfigured`，邮件被退信——这是根因；enable 后重发成功。）
2. D1 查询确认落库：

```
id=1  source=mango9502@163.com  address=test123@mangoqwq.cc.cd
message_id=<6A84D937.4F479F.00001@m16.mail.163.com>  created_at=2026-08-18 22:14:19
```

结论：M1 基座收信链路端到端 ✅。
