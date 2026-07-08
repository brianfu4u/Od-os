# OD 运营系统 · 工程师交接包 (Handoff v1)

## 1 · 一页速览 + 关键链接

**项目一句话:** 面向眼科/视光(OD)诊所的**实时运营操作系统**。经理是「指挥」;系统傅听员工↔经理的**沟通 + 上传的文档/照片**(非传感器),由 LLM **交叉验证任务是否真完成**,并在六大域(员工/患者/财务/营销/设备/库存)给经理建议。**本体优先(Palantir 式)**、**多租户**,将作为标准产品卖给其他诊所。

**可直接打开的演示链接(合成数据、无隐私风险):**
- 🖥️ **指挥官命令中心 UI 原型(三语)**：https://hyperagent.com/s/Mp6B_aWzyOrH4OAyHERxrA
- 🧭 **架构可视化(本体图 / 七阶段循环图 / 分层图,三语)**：https://hyperagent.com/s/XCitBYifouAb81oRt8h4yA

> 两个页面右上角可切 EN / 中文 / 日本語。原型就是前端的「设计事实来源」。

## 2 · 随附文档(详细规格)

以下三份是完整规格(Markdown,可直接丢进代码仓 /docs),已生成公开链接:

1. **核心结构设计**(本体 / 交叉验证 / agentic loop / 多租户)：https://pub.hyperagent.com/api/published/pbf01KWX93C03_9CQGR296QM1GCKD8/01-structure-design.md
2. **工程开发计划与分工**(技术栈 / workstream / 排期)：https://pub.hyperagent.com/api/published/pbf01KWX93CGT_7CSVDWW6SGPE31MS/02-dev-plan.md
3. **Sprint 0–1 工单**(14 张，含验收标准)：https://pub.hyperagent.com/api/published/pbf01KWX93CTJ_DHGDJ5DQ28JYAMAT/03-sprint-0-1-tickets.md

**对 S0-2 本体 schema 最相关:** 结构设计 §2(本体)+ §4(交叉验证)+ 架构图页的对象-关系图 + 工单 S0-2。

**阅读顺序:** 先看本交接包 → 开两个页面链接感受产品 → 读工单开工 → 需要深入时查结构设计与开发计划。

## 3 · 技术栈(照此执行)

- **Monorepo**(Turborepo 或 pnpm workspaces):包 `web` / `api` / `shared`。
- **前端:** Next.js (App Router) + TypeScript + Tailwind + next-intl(三语 中/EN/日,**默认中文**)。
- **后端:** NestJS (TypeScript)。
- **数据库:** PostgreSQL + 行级安全(RLS,多租户)+ pgvector。
- **CI:** GitHub Actions。**部署:** 前端 Vercel,后端容器 + 托管 Postgres。

## 4 · 现在就开工:Sprint 0 首两张工单

**S0-1 · 仓库 / CI·CD / 环境(立刻开始)** — 负责人 E1
- Monorepo(web / api / shared);一条命令本地起前后端;PR 自动 lint+构建+单测并阻断失败;合并主干自动部署 staging。
- **完成 =** 本地能跑、CI 绿、staging 可访问。

**S0-2 · 本体核心数据库 schema(地基)** — 负责人 E1
- `objects`(id, tenant_id, type, properties JSONB, **状态三元组** expected/claimed/verified + confidence + 时间戳);`links`;**append-only** 的 `events` 与 `verification_ledger`。
- 每表带 tenant_id 并启用 **RLS**(跨租户互不可见)。
- **完成 =** 迁移可重复执行 + 种子数据 + 跨租户隔离测试通过。

> 其余 12 张(S0-3…S1-7)见《工单》文档。**关键路径:** S0-2 → S1-1 → S1-4 → S1-5。

## 5 · 铁律(不可让步)

- **多租户从第一天起**(每张数据表 tenant_id + RLS)。
- **只用合成、隐私安全数据** — 开发阶段绝不接真实患者数据(PHI)。
- **人在环**:AI 只提议,经理拍板;MVP 不做高风险自动化。
- **范围窄**:MVP 只做 5 个任务类型(诊室整理、预检完成、散瞳开始、库存补货、设备校准)。
- **UI 三语默认中文**;`localStorage` 必须包 try/catch(嵌入/沙箱环境会禁用),保证不崩溃。
- **2 周一个 sprint**;每周向创始人演示一次;每个 PR 评审后合并。

## 6 · 完整启动指令(可直接粘贴给工程师 / AI 编程工具)

```text
PROJECT KICKOFF — "Clearview OD" Real-Time Clinic Operating System
(You are the founding engineer. Start Sprint 0 today.)

1) WHAT WE'RE BUILDING
A real-time operating system for an optometry (OD) eye clinic. The clinic
manager is the "conductor." The system listens to staff↔manager
communications plus uploaded documents and photos (NOT physical sensors);
an LLM cross-verifies whether tasks are actually completed, then advises the
manager across six domains: staff, patients, financial, marketing,
equipment, inventory. It is ONTOLOGY-FIRST (Palantir-style) and will be sold
to other clinics as a MULTI-TENANT product. A trilingual UI prototype, a
structure-design doc, an architecture-diagram page, and full ticket specs
already exist — use them as the source of truth (links provided by founder).

2) TECH STACK (use exactly this)
- Monorepo (Turborepo or pnpm workspaces): packages web / api / shared.
- Frontend: Next.js (App Router) + TypeScript + Tailwind + next-intl
  (trilingual 中文/English/日本語, DEFAULT Chinese).
- Backend: NestJS (TypeScript).
- Database: PostgreSQL with Row-Level Security (multi-tenant) + pgvector.
- CI: GitHub Actions. Deploy: frontend on Vercel, backend container + managed Postgres.

3) SPRINT 0 GOAL (2 weeks): a deployable skeleton + the ontology data core.
  S0-1 — Repo, CI/CD, environments (START NOW)
  - Monorepo with web (Next.js), api (NestJS), shared (TS types).
  - One command runs web+api locally; document in README.
  - GitHub Actions: PR runs lint + build + unit tests, blocks merge on
    failure; merge to main auto-deploys to staging.
  DONE WHEN: dev runs web+api locally; CI green on a sample PR; staging loads.

  S0-2 — Ontology core DB schema (the foundation everything builds on)
  - objects(id, tenant_id, type, properties JSONB, + STATE TRIPLET:
    expected_state, claimed_state, verified_state, confidence, timestamps).
    Types: Task, Communication, Document, Snapshot, Verification, Staff,
    Room, InventoryItem.
  - links(from_object, to_object, relation)  // assignedTo, partOf, uses,
    consumes, references, verifies …
  - events (APPEND-ONLY) and verification_ledger (APPEND-ONLY).
  - EVERY table has tenant_id; enable Row-Level Security so one tenant can
    never read another tenant's rows.
  DONE WHEN: migrations run repeatably; a seed script inserts sample objects;
  a test proves cross-tenant isolation.

4) GROUND RULES (non-negotiable)
- Multi-tenant from day one (tenant_id + RLS on every data table).
- Synthetic, privacy-safe data ONLY — never real patient data (PHI) in dev.
- Human-in-the-loop: the AI proposes; the manager approves. No risky
  automation in the MVP.
- MVP covers only 5 task types (room turnover, pretest done, dilation
  started, inventory reorder, equipment calibration).
- UI trilingual (中/EN/日), default Chinese. Wrap localStorage in try/catch
  (embedded/sandboxed views block it) so the app never crashes.
- 2-week sprints; short demo to the founder every Friday; every PR reviewed.

5) YOUR FIRST ACTION TODAY
Create the monorepo (S0-1) and open a draft PR "S0-1 project skeleton." In
parallel, start the S0-2 migration. Ask the founder for the structure-design
doc, ticket specs, and the UI prototype as your API/design contract. List any
questions or blockers at the end of day 1.
```

## 7 · 节奏与联系

- **节奏:** 2 周一个 sprint;每周五向创始人(指挥)短演示。
- **遇到阻塞:** 当天末列出问题清单。产品/架构疑问 → 找创始人(背后有 Maestro 架构顾问可产出逐票实现说明、脚手架代码与测试数据)。
- **第一周交付预期:** 可部署骨架(S0-1)+ 本体核心 schema(S0-2)初版。
