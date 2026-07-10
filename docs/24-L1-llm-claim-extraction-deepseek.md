# L1 工单 · LLM 语义/声称抽取(DeepSeek)—— 终端模块 Phase 1 的智能层

> 状态:待开发(创始人已定:终端模块 Phase 1 需 LLM 介入;已有 DeepSeek API 密钥)。负责人:外部工程师。审核:Maestro 逐行审。合并:创始人授权。
> 依赖:S1-2 上报、S2 交叉验证、S0-7 任务配置;与 P7(语音转文字)衔接。参考 docs/08、docs/11、docs/04。
> 定位:终端模块 Phase 1 = 浏览器员工终端把 loop 跑通,并让 LLM 介入"理解"。本票是那层"理解"。

## 核心原则(护城河底线,不可破)
**LLM 只产出「声称」,绝不产出「裁定」。** 抽取结果只写 `claimed_state`(声称),真相仍由**确定性交叉验证**(声称 ↔ 独立证据)判定。LLM 抽错/幻觉不可能造出"已验证"。低置信/歧义 → 标记 pending / 待人工确认,**不自动改状态**。

## 目标
读员工上报的**文字(打字或语音转写)**,用 DeepSeek 抽取结构化**声称 + 场景语义**,喂入既有"声称→交叉验证"管线,让"员工随口一说/一拍"就能驱动 loop。

## 范围
1. **可插拔 LLM 适配器**:抽象 `ClaimExtractor` 接口(与既有 scorer seam 一致的可插拔风格)。首个实现接 **DeepSeek**(OpenAI 兼容:`base_url=https://api.deepseek.com`,`model=deepseek-chat`,密钥 `DEEPSEEK_API_KEY` 走环境变量、**不进 git**)。provider 可换。
2. **抽取**:输入=Communication 文本(打字上报或 STT 转写)+ 上下文(该租户候选对象/任务、S0-7 任务类型)。输出=结构化 `references[{objectClue, claimedState, subject, kind, confidence}]` + 可选场景摘要/严重度线索。**严格 JSON、做校验**;解析失败/低置信明确标记。
3. **接回管线**:抽取 → 实体解析(clue→具体对象,复用 pgvector/规则)→ 更新目标 Task 的 `claimed_state`(+claimedBy/At)→ **触发交叉验证**(既有 S2:声称↔证据 → verified/conflict/pending)。异步、不阻塞上报返回;发事件走 SSE,命令中心实时可见。
4. **三语**:中/日/英上报都能抽取(默认中文)。
5. **可解释/可审计**:抽取的提示词版本、原文、输出、置信度入日志(便于回溯与调优);多租户隔离不破(全程 withTenant)。

## 验收标准(DoD)
- [ ] 在浏览器终端 `/zh/console` 打字或上传语音(经 STT)"3号房已为下一位患者备好" → DeepSeek 抽出 `{room_turnover, 3号房, claimed=ready}` → 对应 Task.claimed 更新 → 交叉验证运行 → 命令中心显示 **冲突@0.50**(缺快照);随后上传整理快照 → **已验证@0.855**。**端到端、经浏览器终端 + LLM**。
- [ ] LLM **只写 claimed,不写 verified**;低置信/歧义标 pending,不自动改状态(有测试断言)。
- [ ] 中/日/英均可抽取;JSON 解析失败有兜底、不臆造。
- [ ] DeepSeek 走可插拔适配器 + 环境变量密钥;异步;抽取过程可审计入日志。
- [ ] 只用合成数据、不碰真实 PHI;多租户隔离不破。

## 依赖(创始人)
- **DeepSeek API 密钥**(已有)——配到后端环境变量 `DEEPSEEK_API_KEY`。

## 不做(留后续)
- LLM 当"裁定打分器"(裁定仍确定性;LLM 只理解声称)——如需可后续作可插拔评分器实验。
- 模型微调、跨店语料训练。

## 交付与铁律
- 新开分支(建议 `l1-llm-claim-extraction`),小步提交,PR,不直接推 main;Maestro 评审 + 创始人授权合并。
- 复用既有契约与 withTenant;PR 写清:接了 DeepSeek 哪个端点、提示词、JSON 校验与失败兜底、如何只写 claimed 不写 verified、低置信如何处理、测试断言、密钥如何配置(不入库)、成本/延迟与异步策略。
- Maestro 评审重点:**LLM 是否绝不直接写 verified**、低置信是否不乱改、抽取是否异步不阻塞、是否可审计、跨租户隔离、密钥不入库。
