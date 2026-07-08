# OD 眼科诊所实时运营系统 — 核心结构设计 (v1)

> 结构设计师视角的系统蓝图:Palantir 式本体模型、交叉验证引擎、agentic loop、多租户产品化架构。这是工程团队的「设计事实来源」。

## 0 · 概览与设计哲学

**这是什么。** 一套面向 OD(视光/眼科)诊所的**实时运营操作系统(Operating System)**:把诊所里真实发生的运营,变成一个可被**感知 → 验证 → 推理 → 协调**的闭环。经理是**乐团指挥**,系统是他的「乐谱 + 耳朵」,让员工、患者、财务、营销、设备、库存六个声部准时、专业地演奏;AI 是指挥身边的**副驾**,随时提示、纠偏、给出带证据的建议。目标是做成**可对外销售的标准产品**,能复制到任意诊所。

**五条设计原则(贯穿全文):**

1. **本体优先(Ontology-first)。** 先有一个统一的「语义世界」(对象/关系/动作),所有功能都在它之上读写。这层本体也是「可复制」的根源。
2. **交叉验证即真相(Cross-Verification = truth)。** 不相信任何单一来源;任务是否完成,由多路证据相互印证得出,并带**置信度**。
3. **沟通即信号(Communication as signal)。** 触发来自员工与经理之间**真实的沟通**(消息/汇报)+ 附带的文档、快照,**不依赖物理传感器**。
4. **人在环的智能体循环(Agentic loop, human-in-the-loop)。** 系统持续循环运转;AI 只给带理由的建议,**高风险动作由经理拍板**。
5. **可复制的产品(Reproducible product)。** 标准本体模板 + 各诊所配置化上线;数据、验证模型、SOP 库成为跨诊所复用的资产。

## 1 · 系统总体架构(分层)

自下而上分六层,数据向上流动、动作向下回写:

| 层 Layer | 职责 | 关键组件 |
|---|---|---|
| ⑥ 呈现层 Presentation | 指挥官命令中心 + 各角色视图,三语(中/英/日) | 命令中心、下钻页、移动端上报 |
| ⑤ 动作/回写层 Action & Write-back | 执行经批准的动作,写回本体 | 动作网关、审批闸门、ActionLog |
| ④ 智能体层 Agent Layer | 六个域 agent + 指挥 Orchestrator,LLM 推理 | 域 agent、编排器、Co-Pilot |
| ③ 交叉验证引擎 Cross-Verification | 声称 ↔ 证据核对,产出验证状态与置信度 | 验证器、置信度模型、验证账本 |
| ② 本体与数据层 Ontology & Data | 语义世界(对象/关系/动作)+ 多租户存储 | 本体服务、对象库、事件流 |
| ① 接入层 Ingestion | 采集沟通、文档、快照与外部事件 | IM 连接器、上传、POS/EHR Webhook |

**要点:** 第②层(本体)是「地基」;第③层(交叉验证)是产品的「护城河资产」;第④层(agentic loop)是「发动机」;第⑥层(命令中心)是指挥的「驾驶舱」。

## 2 · 本体模型(Ontology · Palantir 式)

借鉴 Palantir Foundry 的 Ontology:用五种构件把「现实运营世界」建模成机器可推理、可动作的语义层。

**五种构件:** 对象 Objects / 属性 Properties / 关系 Links / 动作 Actions(会改变对象状态的写回,即 kinetic)/ 函数 Functions(派生计算)。

**★ 关键设计:每个运营对象都自带「状态三元组」**,这让交叉验证成为本体的原生能力:

```
expectedState / expectedBy   // 应该是什么、什么时候该完成(来自 SOP)
claimedState  / claimedBy    // 谁声称它是什么(来自沟通)
verifiedState / confidence   // 交叉验证后的真相 + 置信度
```

**对象目录(按六大域):**

| 域 | 对象 Object Types |
|---|---|
| 人员 | Staff(员工·角色)、Patient(患者) |
| 就诊 | Visit(就诊)、JourneyStage(流程阶段)、Task(任务)、Appointment(预约) |
| 资产/设备 | Room·Chair(诊室·椅位)、Equipment(OCT/验光仪/视野…)、InventoryItem(库存项) |
| 业务 | Invoice(账单)、Claim(理赔)、Payment(收款)、Campaign(营销活动)、Lead(线索)、Review(评价) |
| 信号 | Communication(沟通)、Document(文档)、Snapshot(快照)、Observation(外部事件) |
| AI/治理 | Verification(验证)、Alert(告警)、Recommendation(建议)、ActionLog(动作日志)、LoopRun(循环运行) |
| 配置/租户 | Tenant·Clinic(租户·诊所)、SOP·WorkflowTemplate(流程模板)、KPIThreshold(阈值)、Role(角色) |

**示例对象(Task · 诊室整理):**

```
Task {
  id, tenantId, type: "room_turnover",
  links: { forVisit, assignedStaff, usesEquipment?, consumesInventory? },
  expectedState: "ready", expectedDurationMin: 6,
  claimedState: "ready", claimedBy: Communication#123, claimedAt: 09:20,
  verifiedState: "conflict", confidence: 0.50,
  requiredEvidence: ["snapshot"],           // 该任务类型必须的证据
  startedAt, dueBy, tags
}
```

**关系 Links(节选):**

| 关系 | 含义 |
|---|---|
| Staff —assignedTo→ Task | 谁负责该任务 |
| Task —partOf→ Visit | 任务属于某次就诊 |
| Task —uses→ Equipment / —consumes→ InventoryItem | 占用设备 / 消耗库存 |
| Visit —forPatient→ Patient · Invoice —forVisit→ Visit | 就诊/账单归属 |
| Lead —convertsTo→ Appointment | 营销线索转预约 |
| Communication —references→ *(任意对象) | 沟通中「提及」某对象(实体解析) |
| Verification —verifies→ Task/任意 · Recommendation —addresses→ Alert | 验证/建议的指向 |

**动作 Actions(写回,含审批要求):**

| 动作 | 效果 | 是否需批准 |
|---|---|---|
| MarkTaskComplete | 置 verifiedState=done | 证据充分则自动/一键 |
| ReassignStaff | 改 Staff↔Task 指派 | 一键(低风险) |
| ReorderInventory | 生成补货单 | 一键 |
| BlockEquipment | 停用设备并改路由 | 一键 |
| AdjustSchedule | 调整预约/顺序 | 经理批准 |
| DraftReviewReply | 生成评价回复草稿 | 经理批准后发布 |
| EscalateAlert | 升级/通知 | 自动 |

**函数 Functions:** predictWaitTime、detectBottleneck、scoreVerification、forecastStockout、prioritizeTriage、computeOperatingTempo、reviewSentiment。

**为什么本体 = 可复制产品:** 对象/关系/动作/函数是一套**标准模板**;每家诊所只需实例化并配置自己的 SOP、角色、设备目录、库存目录、KPI 阈值。**新开一家诊所 = 克隆模板 + 配置,而不是重做系统。**

## 3 · 信号层(沟通 / 文档 / 快照)

**触发不是传感器,而是真实工作流中的沟通。** 系统的「事实来源」是非结构化沟通;信号层负责采集、解析、映射到本体对象。

三类信号:**Communication(沟通,主要「声称」来源)** / **Document(文档,主要「证据」来源)** / **Snapshot(快照,强证据)**。

**从原始信号到本体(实体解析 Entity Resolution):**

```
原始消息:「3 号房已为下一位患者备好」(Lena, 09:20)
  → LLM 抽取:{ 对象: Room#3, 声称状态: ready, 主体: Staff:Lena, 时间: 09:20 }
  → 生成/更新:Task(room_turnover, forRoom=3).claimedState = ready
  → 触发交叉验证(见 §4)
```

**Communication 对象结构:**

```
Communication {
  id, tenantId, channel: "wecom|slack|...", author: Staff,
  text, attachments: [Document|Snapshot], at,
  references: [ {object, assertedState, kind: "claim|report|question"} ]  // LLM 解析
}
```

**接入方式(生产):** 企业微信/WhatsApp/Slack/Teams 等 IM 连接器、App 内上报、POS 与 EHR 的 Webhook 事件(旁证)。原型阶段用合成数据模拟。

## 4 · 交叉验证引擎(核心资产)

把「**声称**(claim)」与「**证据**(evidence)」相互印证,产出一条 **Verification**,并沉淀为可查询的「已验证运营真相」账本。

**证据类型(多路、相互独立):** 旁证沟通 / 文档 / 快照 / 关联系统事件(EHR、POS、日历)/ 时间预期(是否符合 SOP 用时)/ 跨对象一致性。

**验证状态:** `Verified 已验证` / `Conflict 冲突` / `Pending 待定(证据不足)` / `Unverified 未验证(仅有声称)`。

**置信度模型(概念式):**

```
confidence = base
  + Σ(evidence_weight × source_trust × recency)   // 佐证越多、越独立、越新 → 越高
  − conflict_penalty                               // 存在矛盾证据/状态
  − missing_required_penalty                       // 缺少该任务「必需证据」
  − timing_anomaly_penalty                         // 偏离 SOP 用时
clamp → [0,1]
// 规则:若「必需证据」缺失,状态最多为 Pending;出现矛盾则为 Conflict
```

每个任务类型可声明**必需证据**(如 room_turnover 必须有 snapshot),把「凭一句话就算完成」堵死。

**★ 触发规则(以交叉验证为触发):** 触发在以下情况**才**发火,而非单次读数——(a) 检测到**冲突**;(b) 置信度低于任务阈值;(c) **必需证据**超期仍缺失;(d) 对象超过 `expectedBy` 仍未完成。

**验证账本(Verification Ledger)作为资产:** 每条验证**不可变追加**,沉淀为:① 运营的唯一可信状态源;② 每位员工/任务/诊所的 SOP 遵从度档案;③ 改进模型的训练数据;④ 跨诊所基准(可对外的壁垒)。

**贯穿示例(3 号房):**

```
09:20 声称:Room#3 = ready(仅沟通)
  核对:必需 snapshot 缺失 + 上位患者 2 分钟前才结账(<6 分 SOP,时间异常)
  → Verification: Conflict, conf 0.50 → 触发 → Co-Pilot 提示「要求拍照确认」
09:34 新证据:Lena 上传整理照片
  → 重新打分:Verified 0.855 → 账本追加一条 → Learn 阶段更新该员工/任务的先验
```

## 5 · Agentic Loop 与多智能体

系统以闭环持续运转(事件驱动 + 周期巡检)。

| # | 阶段 | 做什么 | 触及对象 |
|---|---|---|---|
| 1 | Sense 感知 | 采集沟通/文档/快照/事件 | Communication, Document, Snapshot, Observation |
| 2 | Map 映射到本体 | 实体解析,把信号落到对象与状态 | Task, Room, Equipment… |
| 3 | Cross-Verify 交叉验证 | 声称↔证据核对,出状态+置信度 | Verification |
| 4 | Reason 推理/发现 | 运行各域函数(预测/拥堵/断货/情绪) | Alert |
| 5 | Recommend 建议 | 生成带理由与证据的指挥提示 | Recommendation |
| 6 | Act 执行(经批准) | 写回本体,记录动作 | ActionLog, + 目标对象 |
| 7 | Learn 学习 | 观察结果,更新预期/阈值/先验 | SOP, KPIThreshold, 模型 |

**多智能体:** 六个域 agent(员工/患者流/财务/营销/设备/库存)各自 sense→reason→propose;交叉验证服务被共享调用;**指挥 Orchestrator** 汇总去冲突、排序建议、维护全局节拍,作为对经理的唯一出口。

**风险分级动作(人在环):** 低风险/可逆 → 一键或自动;高风险/不可逆/对外 → 经理批准;每个动作 → ActionLog → 观察结果 → 反哺 Learn。

## 6 · 经理副驾:从触发到协调(人在环)

**一条指挥提示(Cue)的构成:**

```
Recommendation {
  title,               // 一句话结论
  why,                 // 推理理由(可读)
  evidence: [...],     // 证据 chips(💬沟通/📄文档/📷快照/📅排班/📈模型)
  confidence,          // 置信度
  actions: [{ label, actionType, riskTier, needsApproval }],
  sourceAgent          // 由哪个域 agent 提出
}
```

**链路:** 触发 → 域 agent 生成候选建议 → 编排器去冲突+排序 → Co-Pilot 呈现给经理 → 经理一键批准/忽略/改写 → 动作层写回 → Learn。

**协调示例:** 预检拥堵 → 建议「调 Jordan 支援预检 20 分」;编排器发现会让配镜空档 → 附带「建议同时把线上预约提醒延后」。经理视角:全局配平,而非头痛医头。

## 7 · 多租户产品化架构(可扩展·可复制)

核心是**模板 + 配置 + 隔离**。

| 共享(标准资产) | 每租户(配置/隔离) |
|---|---|
| 本体模板(对象/关系/动作/函数) | 该诊所对象数据(严格租户隔离) |
| 交叉验证模型与规则引擎 | 自定义 SOP 库、KPI 阈值 |
| 匿名化跨诊所基准 | 角色/权限、员工与设备/库存目录 |
| 呈现层与三语框架 | 品牌主题(白标)、语言默认值 |

**新诊所上线:** ① 克隆本体模板 → ② 配置 SOP/角色/设备/库存/阈值 → ③ 接入 IM 与 POS/EHR → ④ 导入员工 → ⑤ 设语言与品牌 → ⑥ 上线(先只读+建议,再逐步开放动作)。

**技术要点:** 租户级隔离(tenant-scoped / 行级安全);配置驱动而非改代码;审计由 ActionLog + 验证账本承担。产品壁垒 = 数据网络效应。

## 8 · 角色与视图 / 权限

| 角色 | 主视图 | 关键动作 |
|---|---|---|
| 经理 Manager | 360° 指挥官命令中心 | 批准建议、全局协调、看节拍与账本 |
| 前台 Front Desk | 到店/候诊/诊室就绪 | 上报到店、上传整理快照 |
| 技师 Tech | 预检队列/阶段流转 | 标记阶段完成、上传结果 |
| 验光师 OD | 我的患者/延误 | 更新就诊状态、请求支援 |
| 配镜 Optical | 取镜/库存 | 上报库存、完成交付 |
| 收费 Billing | 未入账/理赔缺件 | 入账、补齐理赔资料 |

**RBAC:** 按角色限定可见对象与可执行动作;高风险动作仅经理;所有动作留痕。

## 9 · 数据、隐私与合规

- 合规基线:视部署地对齐 HIPAA / 中国 PIPL / 日本 APPI;数据最小化、按角色访问、可审计、可删除。
- 审计:ActionLog + 验证账本天然构成审计轨迹。
- 数据驻留:按租户区域部署;跨诊所基准仅用匿名化聚合。
- 当前阶段:原型使用逼真但合成、隐私安全的数据,不接真实 EHR。
- LLM 安全:沟通/文档脱敏后再送模型;区分「可自动执行」与「需人工」的动作边界。

## 10 · 落地路线图(MVP → 规模化)

| 阶段 | 目标 | 范围 |
|---|---|---|
| Phase 0(已完成) | 看得见的原型 | 三语命令中心 UI + 合成数据 |
| Phase 1 · MVP | 单店跑通闭环 | 接 1 条 IM;对 ~5 个关键任务类型做交叉验证;命令中心「只读 + 建议」,动作靠人工 |
| Phase 2 · 可用产品 | 打开动作与学习 | 写回动作(审批闸门)、覆盖六大域、Learn 自校准 |
| Phase 3 · 规模化 | 变成标准产品 | 多租户、自助上线、白标、跨诊所基准 |

## 11 · 术语表(中/英)

| 术语 | 含义 |
|---|---|
| Ontology 本体 | 统一语义世界:对象/属性/关系/动作/函数 |
| 状态三元组 State triplet | expected(应为)/ claimed(声称)/ verified(已验证)+ 置信度 |
| Claim 声称 | 从沟通抽取的「某对象达到某状态」断言 |
| Evidence 证据 | 佐证声称的独立来源 |
| Cross-Verification 交叉验证 | 声称↔证据相互印证,产出状态+置信度 |
| Verification Ledger 验证账本 | 不可变追加的已验证真相记录(核心资产) |
| Trigger 触发 | 冲突/低置信/缺必需证据/超时 时发火 |
| Agentic Loop | 感知→映射→验证→推理→建议→执行→学习 的闭环 |
| Orchestrator 编排器 | 汇总去冲突、排序、对经理发声的「指挥」agent |
| Human-in-the-loop 人在环 | 高风险动作由经理批准 |
| Multi-tenant 多租户 | 一套系统服务多诊所,数据隔离、配置化 |
| SOP | 标准作业流程(定义 expected 状态与用时、必需证据) |
