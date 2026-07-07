# OD 运营系统 · Sprint 0–1 工单 (Ticket Specs)

## 说明与约定

- **负责人:** E1 平台与数据 · E2 智能与验证 · E3 体验与前端;「全员」= 协作完成。
- **估时:** 单位为人日(1 名工程师 1 天)。单个 sprint 约 8–9 人日/人,估时为指示性。
- **阶段:** Sprint 0 = W1–2(地基);Sprint 1 = W3–4(接入与抽取)。里程碑 M1·可用 MVP 在 ~W12。
- **关键路径:** S0-2 本体核心 → S1-1 对象 API → S1-4 抽取 → S1-5 实体解析。前端(E3)从第一天起基于原型 + mock 并行,不等后端。

## Sprint 0 · 地基(W1–2)

### S0-1 · 初始化 monorepo、CI/CD 与环境
- **负责人:** E1　**估时:** 2 人日
- **描述:** 建单仓(前端 Next.js + 后端 NestJS + 共享 types 包),配置 lint/format/test、GitHub Actions CI,以及 dev/staging 两套环境与部署流水线(前端 Vercel,后端容器 + 托管 Postgres)。
- **验收标准:**
  - [ ] 一条命令本地起前后端
  - [ ] PR 自动跑 lint+构建+单测,失败阻断合并
  - [ ] main 合并后自动部署到 staging 且可访问
  - [ ] README 写明启动与环境变量
- **依赖:** 无(最先做)

### S0-2 · 本体核心数据库 schema(对象 + 状态三元组 + 事件账本 + 多租户)
- **负责人:** E1　**估时:** 3 人日
- **描述:** 用 Postgres 建本体核心:通用对象表(objects,含 type、tenant_id、properties JSONB、expected/claimed/verified 状态三元组 + confidence + 时间戳)、links 表、append-only 的 events 与 verification_ledger 表;所有表带 tenant_id 并启用行级安全(RLS)。附迁移脚本与种子。
- **验收标准:**
  - [ ] 迁移可重复执行,含 Task/Communication/Document/Snapshot/Verification/Staff/Room/InventoryItem 等类型
  - [ ] 每个运营对象含 expected/claimed/verified + confidence
  - [ ] events 与 verification_ledger 为 append-only(仅插入)
  - [ ] RLS 生效:跨 tenant 查不到彼此数据(有测试证明)
- **依赖:** S0-1

### S0-3 · 认证与 RBAC 骨架
- **负责人:** E1　**估时:** 2 人日
- **描述:** 实现登录/会话与基于角色的访问控制骨架(角色:manager/front_desk/tech/OD/optical/billing);中间件按 tenant + role 限制 API。先用邮箱魔法链接或简单口令,后续可换 SSO。
- **验收标准:**
  - [ ] 登录后会话带 tenant_id + role
  - [ ] API 中间件按 role 拦截(至少 2 个角色有单测)
  - [ ] 未授权请求返回 401/403
- **依赖:** S0-1、S0-2

### S0-4 · 对象 API 契约(供前端并行)
- **负责人:** E1(+全员评审)　**估时:** 2 人日
- **描述:** 定义对象读写与实时订阅的 API 契约(OpenAPI + 共享 TypeScript 类型),覆盖 Task/Communication/Verification/Recommendation 等;提供 mock server 或 fixtures,让前端不等后端即可开发。契约即前后端「合同」。
- **验收标准:**
  - [ ] 共享 types 包发布,前后端均引用
  - [ ] OpenAPI/契约文档可访问
  - [ ] 提供 mock 数据/fixtures,前端可跑通
- **依赖:** S0-2

### S0-5 · 三语命令中心原型移植进前端壳
- **负责人:** E3　**估时:** 5 人日
- **描述:** 把现有三语「指挥官命令中心」原型移植进 Next.js + Tailwind + next-intl 前端壳;保留三语切换(默认中文)与沙箱安全的存储封装(localStorage try/catch 兜底);数据先接 S0-4 的 mock。关键区块组件化(六域面板、cues、验证账本、沟通流、loop 条)。
- **验收标准:**
  - [ ] 命令中心在前端壳内运行,三语可切换、默认中文
  - [ ] 禁用 localStorage 时不报错、不白屏
  - [ ] 页面数据来自 mock API(非硬编码)
  - [ ] 关键区块已组件化,便于接真数据
- **依赖:** S0-4

### S0-6 · LLM 声称抽取技术预研(spike)
- **负责人:** E2　**估时:** 3 人日
- **描述:** 预研从一条沟通消息抽取「声称」的可行性:给定中/英/日消息,LLM 输出 {对象类型, 引用对象线索, 声称状态, 主体, 时间}。产出提示词雏形 + 10–20 条评测样例 + 准确率初判。不接生产。
- **验收标准:**
  - [ ] 有可运行的抽取脚本 + 提示词
  - [ ] 三语各 ≥5 条样例的抽取结果与人工标注对比
  - [ ] 一页结论:可行性、失败模式、对 Sprint 1 的建议
- **依赖:** 无(可与 S0-1 并行)

### S0-7 · 冻结 5 个关键任务类型 + SOP 与「必需证据」
- **负责人:** 产品负责人 + Maestro 协助　**估时:** 1 人日(工作坊)
- **描述:** 与诊所一起敲定 MVP 的 5 个关键任务类型(建议:诊室整理、预检完成、散瞳开始、库存补货、设备校准),为每个定义:expected 状态与用时、判定完成所需的「必需证据」(如整理必须有快照)、触发阈值。产出结构化配置。
- **验收标准:**
  - [ ] 5 个任务类型定稿(名称、expected 用时、必需证据、触发条件)
  - [ ] 以结构化配置(JSON/YAML)入库
  - [ ] 团队评审通过
- **依赖:** 无(但阻塞 Sprint 1 的验证逻辑)

## Sprint 1 · 接入与抽取(W3–4)

### S1-1 · 对象 CRUD 服务与 API 落地
- **负责人:** E1　**估时:** 4 人日
- **描述:** 把 S0-4 契约落地为真实后端:Task/Communication/Document/Snapshot/Staff/Room/InventoryItem 的 CRUD 与查询;状态三元组读写;变更写入 events 表;WebSocket/SSE 推送对象变更给前端。
- **验收标准:**
  - [ ] 契约中读写端点全部实现并通过集成测试
  - [ ] 对象变更产生 event 记录
  - [ ] 前端可通过 WebSocket/SSE 订阅到变更
  - [ ] 多租户隔离在 API 层校验
- **依赖:** S0-2、S0-4

### S1-2 · IM 连接器(单渠道)接收消息 → Communication
- **负责人:** E2　**估时:** 3 人日
- **描述:** 接入 1 个即时通讯渠道(建议企业微信/Slack/Telegram 之一)的 webhook,把员工↔经理消息(含发送者、时间、文本、附件引用)标准化存为 Communication 对象。附渠道配置与重试。
- **验收标准:**
  - [ ] 渠道消息实时进库为 Communication
  - [ ] 含发送者映射到 Staff、时间、文本、附件引用
  - [ ] Webhook 校验与重试;失败可观测
- **依赖:** S1-1

### S1-3 · 文件/快照上传 → Document / Snapshot
- **负责人:** E1　**估时:** 2 人日
- **描述:** 实现文件与图片上传(对象存储),生成 Document/Snapshot 对象并可关联到 Communication/Task。前端/移动端可一键拍照上传。
- **验收标准:**
  - [ ] 上传返回可访问的存储引用,生成对应对象
  - [ ] 可关联到指定 Communication 或 Task
  - [ ] 大小/类型校验 + 基础安全
- **依赖:** S1-1

### S1-4 · LLM 声称抽取(生产版)
- **负责人:** E2　**估时:** 3 人日
- **描述:** 基于 S0-6 结论,把抽取做成服务:Communication 入库即触发抽取,产出结构化 references[{对象线索, 声称状态, 主体, kind}]。三语支持。低置信标记待人工。
- **验收标准:**
  - [ ] 新 Communication 自动触发抽取并落库 references
  - [ ] 中/英/日消息均可抽取
  - [ ] 低置信/无法解析的有明确标记,不误写状态
- **依赖:** S1-1、S0-6

### S1-5 · 实体解析 v1 → 更新 Task.claimedState
- **负责人:** E2(+E1)　**估时:** 3 人日
- **描述:** 把抽取到的对象线索(如"3号房""Maria""护理液")解析到具体本体对象(pgvector 语义 + 规则/别名表),据此创建或更新对应 Task 的 claimedState 与 claimedBy/claimedAt。歧义时不臆断,标记待确认。
- **验收标准:**
  - [ ] 「消息 → 正确 Task 的 claimed 状态更新」在合成数据上跑通
  - [ ] 解析歧义时标记 pending,不误更新
  - [ ] 有 ≥10 条合成用例的通过记录
- **依赖:** S1-4、S0-2

### S1-6 · 命令中心接入真实沟通流与 claimed 状态
- **负责人:** E3　**估时:** 4 人日
- **描述:** 把命令中心的「实时沟通」面板与相关对象从 mock 切到真实后端(WebSocket/SSE);消息实时出现,并显示 LLM 抽取/解析结果(声称了什么、更新了哪个 Task 的 claimed)。保持三语。
- **验收标准:**
  - [ ] 真实消息实时出现在沟通流
  - [ ] 展示抽取到的声称与被更新的 Task
  - [ ] 三语正常;断线自动重连
- **依赖:** S1-1、S1-2、S1-4

### S1-7 · 合成数据集 + Sprint 1 演示
- **负责人:** 全员(E2 主)　**估时:** 1 人日
- **描述:** 构造一套逼真的三语合成沟通+文件数据(seed 脚本),用于演示「消息→Task.claimed」全链路;Sprint 1 结束向指挥演示。
- **验收标准:**
  - [ ] 一键 seed 合成数据
  - [ ] 端到端演示:发消息 → 抽取 → 解析 → 命令中心显示 claimed
  - [ ] 演示反馈记录进 backlog
- **依赖:** S1-5、S1-6

## 通用完成定义(DoD)与备注

**每张工单进入「完成」均需满足:**
- 代码合并前通过 CI(lint + 构建 + 单测),且至少一人 + Maestro 评审。
- 涉及数据的改动都带 tenant 隔离与测试。
- 不接真实 PHI,只用合成数据。
- 接口/配置改动同步更新到共享契约与 README。
- 面向功能的工单结束时能在 staging 演示。

**备注:**
- 关键路径:S0-2 → S1-1 → S1-4 → S1-5;任一延误会顺延。
- Sprint 1 的目标是跑通一条细链路(消息→claimed),还不包含交叉验证(那是 Sprint 2)。
