# P1 工单 · S0-3 会话鉴权(上线前唯一硬缺口)

> 状态:待开发(Maestro 拟单,创始人已 OK)。负责人:Forge / 工程师。审核:Maestro 逐行审。合并:创始人拍板。
> 来源:本工单直接消除 Maestro 独立代码审计(提交 d05fee5)发现的 3 条,以及仓库代码里工程师自标的 `TODO(S0-3)`。

## 背景与现状(先读)
开工前先读并理解现状:
- `docs/01`(§8 角色)、`docs/04`(小程序 API 契约与 auth TODO)、`docs/06`(S1-1)、根 `README` 的 `TODO(S0-3)`。
- 关键现状代码:`packages/api/src/tenant/tenant.guard.ts`、`packages/api/src/reports/reports.repository.ts`、`packages/api/src/database/tenant-context.ts`、`packages/api/db/migrations/0004_rls_and_roles.sql`。

现状:多租户隔离(RLS)已扎实、已测试;但**还没有真正的登录**。今天诊所(tenant)与员工(staff)身份都靠请求头/请求体自报——开发期用合成数据无妨,但接真实诊所前必须补上。

## 目标
诊所与员工身份都来自**认证会话**;生产环境**拒绝**客户端自报身份。一次性消除三处隐患:
1. 登录缺失(生产没有可用的会话鉴权);
2. 员工身份可伪造(`reports.repository.ts` 里 `staffHandle` 取自请求体、无门控);
3. 应用可能以超级用户连库,绕过 RLS(仅在注释里提到 `clearview_login`,未强制)。

## 范围
1. **员工端(微信小程序)登录**:`wx.login` 拿 code → 服务端 `code2session` 换 openid/session_key → 签发服务端会话令牌,绑定 `{tenantId, staffId}`。`/reports`、`/uploads` 等端点**从会话取 tenant + staff**,**忽略**请求体里的 `staffHandle`。openid→Staff 的映射存服务端。
2. **管理端(Web)登录**:经理登录(先用邮箱魔法链接或简单口令,SSO 以后)→ 会话绑定 `{tenantId, role, managerId}`;Web/API 从会话取 tenant。
3. **改造 TenantGuard**:生产必须有有效会话;`X-Tenant-Id` / `staffHandle` 仅保留**严格 NODE_ENV 门控**的 dev 垫片用于本地测试,生产一律拒绝客户端自报身份。
4. **运维硬化**:应用改用**非超级用户**登录角色 `clearview_login`(member of `clearview_app`)连库;加**启动自检**——若以超级用户/属主或 BYPASSRLS 连库则**拒绝启动**并报错。`withTenant()` 仍是唯一数据通道。

## 验收标准(Definition of Done)
- [ ] 生产模式下,无有效会话的请求一律 401;请求体/请求头里的 tenant、staff 身份被忽略。
- [ ] 员工身份来自微信会话(openid),经理租户来自经理会话。
- [ ] 新增测试:**伪造他人 tenant/staff 无效**;跨租户隔离测试仍全绿;以超级用户连库时**启动被拒**。
- [ ] append-only 的 events / verification_ledger 不受影响;RLS 测试仍通过。
- [ ] `withTenant()` 仍是唯一业务数据通道,无新增旁路直查。

## 依赖(需创始人提供,先别卡住)
真实微信流程需要**小程序 AppID + AppSecret**,生产 API 域名可能需 **ICP 备案**。开发/测试阶段先做**严格 dev 门控(仅非生产)的模拟登录**跑通链路,用合成数据即可;真上线再接真实微信 + ICP。请把这条作为 TODO/阻塞明确标出。

## 不做(避免镀金,留后续)
完整 SSO / 第三方 OAuth、细粒度 RBAC 扩展、动作回写(S4)。

## 交付与铁律
- 新开分支(建议 `p1-session-auth`),分层小步提交,开 PR,**不直接合并 main**(人在环:Maestro 评审、创始人合并)。
- 多租户 + RLS;只用合成数据、不碰真实 PHI。
- 汇报:说清做了什么、改了哪些文件、迁移加了什么、生产/开发两种模式行为、测试断言了什么、有无未覆盖项与风险;诚实标 TODO,不要用「全绿」掩盖缺口。
- Maestro 评审重点:生产是否**真的**拒绝自报身份、伪造测试是否**真断言**、连库角色启动自检是否生效。
