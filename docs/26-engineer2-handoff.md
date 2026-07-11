# 交接包 · 2号外部工程师上手(Engineer #2 Onboarding)

> 一句话:发这份给新工程师即可开工。项目已高度文档化,仓库 `docs/`(01→25,见 `docs/README`)是权威规格。你负责按工单实现,Maestro(架构师)逐票逐行代码评审,创始人授权合并。

## 1 · 项目速览
Clearview OD —— 眼科诊所实时运营系统(AI 驱动)。经理是"指挥",系统听员工↔经理沟通 + 上传证据,交叉验证任务是否真完成,在六大域给带证据的建议;人在环。技术栈:pnpm + Turborepo monorepo;`packages/web`(Next.js App Router + Tailwind + next-intl,中/英/日)、`packages/api`(NestJS)、`packages/shared`(TS 类型);Postgres(RLS + pgvector)。

## 2 · 现状快照(2026-07-11)
- **已上线 staging(合成数据)**:网页 https://od-os-web.vercel.app ,API https://od-os.onrender.com(/health OK)。DB=Neon、API=Render、Web=Vercel(push main 自动重部署)。
- **已合并到 main**:S0–S8 主线(感知→交叉验证→建议→执行→学习、六大域)、P1 会话鉴权、P2 动作回写、P3 命令中心接真数据、P4 学习环、P5 部署脚手架、**T1 员工终端移动化+staging 员工登录+相机**、**LLM1「听」层(DeepSeek + 启发式回退)**。
- **在途(已下发、待你接手做 PR)**:**P7 批次** = T4 语音转文字(STT)+ T2 真摄像头扫码 + P5.1 安全硬化(见 `docs/22`)。
- **待下发**:T3 终端录音、T5「我的任务」、T6「申请支援」(见终端模块计划 `docs/23`)。
- **建议优先接手顺序**:先 **T4 语音转文字**(创始人已明确"一定要做";密钥见 §7)→ T2 真扫码 → P5.1 → 再按 `docs/23` 往下。

## 3 · 权威资料(都在仓库 docs/)
- `docs/README` 索引;`docs/01` 结构设计、`docs/04` 小程序/终端 API 契约、`docs/08` S2 交叉验证(护城河)、`docs/11` S0-7 任务配置。
- `docs/23` 终端模块计划与时间表(T1–T8);`docs/24` LLM1「听」层;`docs/25` T1;`docs/22` P7 批次;`docs/16/20` 会话鉴权与部署;`docs/DEPLOY.md` 部署运行手册。

## 4 · 铁律(不可破)
1. **多租户**:每表 tenant_id;所有查询走 `withTenant()`;运行时以非超级用户 `clearview_login` 连库;绝不绕过 RLS。
2. **护城河**:LLM 只产"声称/分类/候选建议",**绝不写 verified**;裁定由确定性交叉验证独占;低置信→pending 不改状态。
3. **人在环**:AI 只提议,经理批准;高风险动作不自动执行。
4. **只用合成数据、不碰真实 PHI**;生产身份来自会话,不信任客户端自报(dev 垫片仅 NODE_ENV 门控)。
5. **append-only**:events/verification_ledger/action_log/llm_analysis_log 只可 INSERT。
6. **密钥不进 git**;走环境变量。

## 5 · 本地跑起来
```
corepack enable            # pnpm 10
pnpm install
cp .env.example .env
docker compose up -d       # 本地 Postgres(pgvector)
pnpm db:migrate            # 可重复
pnpm db:seed               # 合成数据(两个租户)
pnpm db:test               # 跨租户 RLS 隔离测试
pnpm dev                   # web + api
```
测试:`pnpm test`(单测)、`pnpm --filter @clearview/api test:integration`(DB 集成)、http-smoke。提交前务必本地全绿。

## 6 · 工作流
- 每票**开分支 → 小步提交 → 开 PR**;**不直接推 main**。
- **Maestro 逐行代码评审**(重点盯:护城河/租户隔离/鉴权/append-only/测试是否真断言);**创始人授权合并**;合并到 main 后 Vercel 自动重部署 staging。
- PR 里如实写:改了什么、测试断言了什么、未覆盖项与风险、密钥如何配(不入库);安全待办用大写 TODO。

## 7 · 你需要的访问(创始人授予)
- **GitHub**:把你加为 `brianfu4u/od-os` 的**协作者**(仓库 Settings → Collaborators),接受邀请后即可推分支/开 PR。
- **DeepSeek 密钥(用于 LLM1/T4)**:创始人会在 **Render 环境变量 `DEEPSEEK_API_KEY`** 配置;本地开发你用自己的 DeepSeek key 放 `.env`(不提交),或不配则跑启发式回退。
- **部署平台(Neon/Render/Vercel)**:一般不需要——Maestro 评审、创始人合并、Vercel 自动部署;仅当明确要你动部署时再由创始人授予。

## 8 · 从上一位工程师接收(创始人协助确认)
- 确认有无 **P7 未完成的分支/本地未提交代码**(T4/T2/P5.1);有就让其推上来或打包给你,没有则你从头做 P7。
- 让其**归还/作废**任何本地持有的密钥或凭证(如 DeepSeek、staging 口令);创始人可轮换 staging 登录口令。
- main 是唯一事实来源;以 main + docs/ 为准,不依赖上一位的本地状态。

## 9 · 首要任务(建议)
接手 **T4 语音转文字(STT)** 作为第一票(创始人优先级);读 `docs/22`,开分支 `p7-voice-to-text`(或按你习惯拆),对着已上线的 staging API 开发,PR 交 Maestro 评审。
