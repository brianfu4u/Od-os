# P5 工单 · 上线部署(staging 长期在线可点)

> 状态:待开发(Maestro 拟单,创始人已 OK 推进)。负责人:工程师(应用改造 + 运行手册);创始人(开账号 + 贴密钥)。审核:Maestro。合并:创始人授权。
> 依赖:S0–S8 已合并进 main。基于根 README(S0-1 部署段)、docs/16(会话鉴权)、docs/13。

## 目标
把当前产品部署成一个**长期在线、可点击**的 staging 环境:一个公开 Web 网址打开命令中心,连着在线 API + 托管 Postgres(合成数据),经理能登录、看六域、批准/撤销、看下钻。**只用合成数据、不接真实 PHI。**

## 关键约束(必须遵守)
- **绕开 GitHub Actions 工作流**:本仓库 token 无法推 `.github/workflows/*`。**用平台自带的 Git 部署**——Web 用 Vercel 连仓库自动部署;API 用 Render/Railway/Fly 之一连仓库部署;DB 用 Neon/Supabase 托管 Postgres(需 pgvector)。都在各平台后台配置,不写 GitHub 工作流。
- **生产安全不降级**:API 必须以**非超级用户** `clearview_login` 连库(`APP_DATABASE_URL`),启动自检 `assertRuntimeRoleSafe()` 必须通过;`NODE_ENV=production` 下 `X-Tenant-Id`/`staffHandle` 自报身份被拒。

## 范围(工程师)
1. **DB**:在托管 Postgres(pgvector)上跑 `db:migrate`(含 0004 角色、0007 clearview_login、0009)与 `db:seed`(合成数据);确认 `clearview_login` 已建且为非超级用户;产出其连接串给 API。
2. **API**:容器化部署(Dockerfile 已有);设 `NODE_ENV=production` + `APP_DATABASE_URL`(clearview_login);健康检查 `/health`;CORS 允许 Web 域名;确认启动自检通过。
3. **Web**:Vercel 部署 `packages/web`;设 `NEXT_PUBLIC_API_BASE_URL` 指向已部署 API;确认三语、SSE 在线可用。
4. **staging 经理登录**:当前 dev-login 在 prod 为 404。为让 staging 能演示,加一个**最小、安全、可开关的 staging 登录**(如 env flag 控制的单一经理账号 / 一次性令牌),或实现邮箱魔法链接的最小版;**不得**在 prod 重新放开无鉴权 dev-login。
5. **环境模板 + 运行手册**:更新 `.env.example` 补齐所有生产变量(APP_DATABASE_URL、NODE_ENV、NEXT_PUBLIC_API_BASE_URL、可选 WX_*、上传存储等);写一份 `docs/DEPLOY.md` 手把手运行手册,并**明确列出创始人需要在各平台后台设置的账号与密钥清单**。

## 验收标准(DoD)
- [ ] 一个公开 Web 网址打开命令中心,数据来自在线 API + 托管 Postgres 的合成数据(非 mock)。
- [ ] 经理能在 staging 登录,看六域、批准低风险→已执行、批准高风险→被拦、撤销→回退、点进域看下钻/时间线。
- [ ] API 以 `clearview_login`(非超级用户)连库,启动自检通过;prod 下自报身份被拒;跨租户隔离仍有效。
- [ ] 三语可用;SSE 实时;`/health` 绿。
- [ ] `docs/DEPLOY.md` 完整,`.env.example` 补齐;创始人凭清单即可复现部署。

## 不做(留后续)
真实微信小程序客户端(需 AppID+ICP)、真实外部集成(供应商/理赔/患者推送/支付)、自定义域名+ICP 备案、白标/自助上线/跨店基准——留产品化阶段。真实 PHI 一律不接。

## 交付与铁律
- 应用改造与手册走分支 + PR + Maestro 评审;不直接推 main。平台后台配置(连仓库、贴密钥)由创始人操作,工程师在手册里写清每一步。
- 只用合成数据;PR 里如实写清:选了哪些平台、如何跑迁移+seed、staging 登录方案、环境变量全集、未覆盖项与风险。
- Maestro 评审重点:prod 是否仍以非超级用户连库且自报身份被拒、staging 登录是否安全(不是重新放开无鉴权)、是否只用合成数据。
