# P0 · 回退重提 (Resubmission) 闭环设计笔记

> 闭环第 6 步「回退重提」是 9 步中唯一缺失的一环。本设计以**最小化、不越权、遵守护城河与审计铁律**为准则,把"验证不通过"从一个瞬时结果,变成员工可见、可追溯、可闭合的任务状态。

## 一、现状(代码核实)

- verify 得出 `verifiedState ∈ {unverified, conflict, pending}` 时,`verification.repository.verify()` 已经:更新 `objects.verified_state`、写 append-only `verification_ledger`、发 `object.state.verified` 事件、triggers 触发时建 Alert。
- S3 域 agent(`agents.ts`)在 `verifiedState === 'conflict'` / overdue-pending 时会给**经理**生成 cue。
- **员工补交证据 → 重新验证的链路已存在**:`reports.service.ingest()` 对每个 attachment/scan 目标调用 `verification.verifyObject()`,S2 重跑,证据够即转 verified。
- **缺口**:验证不通过时,没有一个**面向员工**的显式"被打回、要求重提、缺哪些证据"的信号。员工端 `/tasks/mine` 只透出 `verifiedState`,不含"缺什么/为何被打回/第几次重提"。

## 二、最小化设计

**核心思想**:引入一个纯派生(derived)的 resubmission 视图字段,不新增可变状态、不新增迁移、不碰 S2 裁定权。

### 1. 触发与留痕(在既有 verify 事务内)
verify 得出**非 verified 且 (requiredMissing 非空 或 conflict 触发)** 时,在既有 events 表追加一条 `task.resubmission.requested` 事件(actor='verification'),payload 含 `{ verifiedState, requiredMissing, reason, attempt }`。
- 复用既有 append-only events 表 → **无需迁移**。
- `attempt` = 该 object 已有的 `task.resubmission.requested` 事件计数 + 1(重提次数,可追溯)。
- 不改 `verified_state`(S2 独占),不写任何 world state。只加一条审计事件。

### 2. 员工可见(读投影,只读)
`MyTaskSummary` 增加只读派生字段:
- `needsResubmission: boolean` — 最近一次 verify 为非 verified 且要求重提。
- `requiredMissing: string[]` — 还缺哪些证据类型(从最近一条 verification_ledger / resubmission 事件读)。
- `resubmissionCount: number` — 被打回过几次。
- `lastResubmissionReason: string | null` — 最近打回原因(人话)。

这些**全部从既有 events / verification_ledger 派生**,不引入新可变列。`/tasks/mine` 的 SQL 增加一个 LATERAL 子查询读最近的 resubmission 事件。

### 3. 重提后闭合(已存在,无需改)
员工补交证据 → `reports.service` 触发 `verifyObject` → S2 重跑 → 证据够则 `verified_state='verified'`,`task.resubmission.requested` 不再新增 → `needsResubmission` 派生为 false → 闭环合上。

## 三、遵守的铁律

1. **多租户隔离**:所有读写都在 `withTenant()` 内,RLS 兜底。
2. **规则/模型解耦**:resubmission 由确定性规则(requiredMissing/conflict)触发,LLM 不参与、不写 verified_state。
3. **全程审计**:打回 = 一条 append-only 事件,含 attempt 计数、缺失证据、原因,可倒查。
4. **最小闭环**:不新增迁移、不新增可变状态、不碰 SSE/CI/审批执行器,只加"派发打回事件 + 员工端只读派生"。

## 四、不做什么(明确边界)

- 不新增 DB 迁移(复用 events 表)。
- 不改 S2 scorer / verified_state 语义。
- 不碰 c67a904 SSE、CI 配置、action-executor 审批执行。
- 不做经理手动"打回"按钮(本工单只做**系统自动**因证据不足而触发的重提;经理手动打回可作后续工单)。
- 不做前端 UI 大改(仅在 MyTaskSummary 契约与 /tasks/mine 投影透出字段;员工端组件消费为后续增量)。

## 五、改动文件清单(预估)

1. `packages/shared/src/api/objects.contract.ts` — MyTaskSummary 增 4 个只读派生字段。
2. `packages/api/src/verification/verification.repository.ts` — verify 事务内,非 verified + (requiredMissing|conflict) 时追加 `task.resubmission.requested` 事件(含 attempt 计数)。
3. `packages/api/src/tasks/tasks.repository.ts` — `/tasks/mine` SQL 增 LATERAL 读最近 resubmission 事件 + attempt 计数;mapTask 透出新字段。
4. `packages/api/test/resubmission-integration.ts` — 新增全链路集成测试。

回滚:全部改动可 `git revert` 单个 commit;新增事件类型不影响既有读者(未知 event_type 被忽略);MyTaskSummary 新字段为增量,旧前端忽略即可。
