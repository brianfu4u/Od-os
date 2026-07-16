# 外部数据处理供应商 — 现状与合规降级开关

> **文档性质**：本文件记录 Clinic OS 当前对外部数据处理供应商的**代码层现状**，并说明 P1-6-c 引入的合规降级开关。
> **⚠️ 重要边界**：文中所有涉及供应商**数据保留策略 / 零保留(ZDR) / opt-out / DPA / 日本 APPI 合规**的条目，均为 **【待商务/法务确认】占位内容**，尚未由懂日本 APPI 的顾问核实供应商的数据处理协议条款。**开发团队无权对这些条款下合规结论**——请勿将本文档任何部分当作已核实的合规认定。

---

## 1. 现状：本系统使用的外部数据处理供应商

| 用途 | 供应商 | 适配器 | 触发条件 | 送出的数据 |
|---|---|---|---|---|
| LLM1（终端报告语义分析/分类） | DeepSeek（OpenAI 兼容 API） | `listener/deepseek-listener.ts` | `DEEPSEEK_API_KEY` 已设置且未 pin heuristic | 员工提交的文本/转写内容 |
| STT（语音转写） | OpenAI Whisper | `transcription/openai-whisper.transcriber.ts` | `STT_API_KEY` 已设置且 provider=openai | 上传的语音音频字节 |

**代码层已保证的事项（可由开发团队认定）：**
- API key 仅从环境变量读取，**从不写入日志**，也从不落入转写/事件负载。
- 无 key 时自动退回本地 keyless 路径：LLM1→`HeuristicListener`（确定性关键词分析，零外部依赖）；STT→`NullTranscriber`（标记 `unavailable`、**绝不编造文本**、绝不送出音频）。
- STT 与 LLM1 是**相互独立**的供应商，`STT_API_KEY` 与 `DEEPSEEK_API_KEY` 不复用。

## 2. 【待商务/法务确认】供应商侧数据保留 / 合规条款

> 以下条目**均未经核实**，为后续与懂日本 APPI 合规的顾问核对供应商 DPA / 数据处理条款时的**占位清单**，不代表当前结论。

- **【待确认】** DeepSeek 对经其 API 送出的输入/输出是否留存、留存期限、是否用于模型训练、是否提供 opt-out / 零保留(ZDR)模式。
- **【待确认】** OpenAI（Whisper API）对音频与转写文本的留存策略、是否适用其 API 数据不用于训练的政策、是否可签署 ZDR/DPA。
- **【待确认】** 上述供应商是否与我方签署满足**日本 APPI（个人情报保护法）**要求的数据处理协议(DPA)，跨境传输（数据可能出境至供应商所在地）是否满足 APPI 对第三方提供/越境提供的告知与同意要求。
- **【待确认】** 是否需要在患者知情同意 / 隐私政策中披露上述外部处理方。

**责任归属**：以上属**商务/法务/产品决策层**范围（对应 P1-6 master 决策点 D-3 DPA）。需单独委托懂日本 APPI 的顾问核实供应商协议条款后，再回填本节结论并移除占位标记。**开发团队不对上述条款作合规判断。**

## 3. 合规降级开关（P1-6-c，代码层已实现）

在尚未取得上述合规确认、或需要临时满足"零外部处理"合规姿态时，可用**单一环境开关**在**保留 key 的前提下**一键关停全部外部处理：

```
COMPLIANCE_EXTERNAL_PROVIDERS=off
```

命中 `off` 时，两处 boot 工厂强制退回本地路径（即使 key 存在）：

| 层 | 开关 off 时的行为 | 影响 |
|---|---|---|
| LLM1 | 强制 `HeuristicListener` | 语义分析退化为确定性关键词规则；**无文本送出至 DeepSeek** |
| STT | 强制 `NullTranscriber` | 转写标记 `unavailable`（可在关闭开关后重试）；**无音频送出至 OpenAI**；绝不编造文本 |

- 取值判定：仅当值（去空格、忽略大小写）等于 `off` 时禁用；缺省或任何其它值维持现有行为（fail-open 到今天的行为，绝不静默关停）。
- Boot 日志会打印"compliance downgrade: external … disabled"警告（**不打印任何 key**）。
- 实现：纯函数 `resolveExternalProviders(env)` 位于 `packages/api/src/config/security.ts`，由 `listener.module.ts` 与 `transcription.module.ts` 的 boot 工厂读取。

**开关不改变的事项**：数据流向、claim/verification 三层分离、attention 队列、SSE 播报、世界状态写入均不受影响；开关只决定"用哪个引擎"，且 `off` 状态严格更保守。

## 4. 后续事项（TODO，归商务/法务/产品）
- [ ] 【待商务/法务确认】委托日本 APPI 合规顾问核实 DeepSeek / OpenAI 数据处理条款与留存策略。
- [ ] 【待商务/法务确认】签署满足 APPI 的 DPA（P1-6 决策点 D-3）。
- [ ] 【待产品确认】在患者知情同意/隐私政策中披露外部处理方（如核实后确需）。
- [ ] 上述确认完成后，回填第 2 节结论、移除占位标记。
