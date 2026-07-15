# 27 · 测试矩阵(铁律 × 层 × 脚本)

> T-11 收口产物。目的:让「八条铁律是否被完整覆盖」在一处可审计,任何一条被破坏都在本矩阵对应脚本里显式失败。
> 本矩阵不是补测——各层原本已有集成脚本;T-11 把散落在 ~25 个脚本里的原则断言收敛成一张可读表,并补上此前缺失的「跨端闭环」与「i18n 三语对齐」两个维度。

## 一、八条铁律

| # | 铁律 | 一句话不变式 |
|---|---|---|
| 1 | 员工端提交不驳回 | 任何合法 claim / scan 都成功落库;只有输入格式错误才 4xx,绝无业务驳回 |
| 2 | AI 输出只给经理参考 | 员工面向投影只含 claim 字段;verification 判断永不出现在员工视图 |
| 3 | claim / verification / world-state 三层分离 | 写入 verification 判断不改动 claim,也不改动投影世界状态 |
| 4 | attention 是待关注列表,非裁决入口 | 队列只读:生成它不改世界状态、不产生员工可见事件 |
| 5 | SSE 只做播报 | 事件流只广播,不承载裁决/写回 |
| 6 | claim vs verified 命名一致 | 员工侧用 `claimedStatus`;verification 侧用 `verificationResult`,两套词汇不混用 |
| 7 | 租户隔离(RLS 贯穿) | 一个租户的 board / attention 永不出现另一租户员工 |
| 8 | 审计写入层永不去重,去重只在展示查询层 | 写入层对每条候选都落审计;折叠同 (employee, kind) 只发生在展示路径,严格晚于审计写入 |

> 第 8 条由阶段 3 的实现细节(`attention-dedup.ts` DISPLAY-LAYER only)升格为正式铁律,单独锁定——因其最易被未来改动无意破坏。

## 二、层 × 脚本覆盖

| 层 | 脚本 / 命令 | 覆盖铁律 |
|---|---|---|
| 后端·铁律矩阵(收口) | `test:principles` → `test/principles-matrix-integration.ts` | 1·2·3·4·6·7·8 |
| 后端·跨端闭环(收口) | `test:e2e-loop` → `test/e2e-employee-manager-loop-integration.ts` | 1·2·3·4 + 裁决单一归属 + S2 护城河 |
| 后端·claim 层 | `test:empstatus` → `employee-status-integration.ts` | 1·2·3·6 |
| 后端·scan 层 | `test:pscan` → `patient-scan-integration.ts` | 1(scan 中立无判断) |
| 后端·attention | `test:attention` → `attention-integration.ts` | 4·7·8 |
| 后端·裁决/flow | `test:flow` → `flow-decision-integration.ts` | 裁决单一归属·S2 护城河(decide 永不改 `verified_state`) |
| 后端·SSE/播报 | `test:http-smoke` + SSE 集成 | 5 |
| 后端·RLS 隔离 | `test:rls`(经 `db:test`) | 7 |
| Web·护栏矩阵(收口) | `principles-ui-matrix.test.ts` | 2(员工零泄露)·4/裁决单一归属(经理只读)· i18n 三语对齐 |
| Web·员工零泄露 | `employee-noverdict.test.ts` | 2 |
| Web·经理只读 | `attention-readonly.test.ts` | 4 |

## 三、CI 收口

三个核心 job(见 `.github/workflows/ci.yml`),两个新后端脚本已接入 `test:integration` 链,CI 自动覆盖,无需新增 job:

1. **Lint · Build · Unit tests** — `pnpm test`(含 web `principles-ui-matrix.test.ts` 的 i18n 三语对齐)。
2. **DB migrations · RLS isolation · Integration** — `pnpm db:test` + `pnpm --filter @clearview/api test:integration`(链内含 `test:principles` 与 `test:e2e-loop`)。
3. **Full-app HTTP smoke** — `node packages/api/test/http-smoke.mjs`。

## 四、本地一键复现

```bash
# 后端集成链(含 T-11 两个新脚本)
pnpm db:test && pnpm --filter @clearview/api test:integration
# 单跑收口脚本
pnpm --filter @clearview/api test:principles
pnpm --filter @clearview/api test:e2e-loop
# HTTP smoke
node packages/api/test/http-smoke.mjs
# Web 单元(含护栏矩阵)
pnpm --filter @clearview/web test
```
