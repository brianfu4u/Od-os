# S0-7 配置 · 5 个关键任务的 SOP / 必需证据 / 权重(for engineer)

## 说明(如何读与集成)

创始人已确认。这是喂给 S2 交叉验证引擎的真实配置,替换占位默认值;同时内含 Q1(a) 的 per-task evidenceWeights。

**集成方式:** 落入 TaskSopConfig(按租户可覆盖)。全局默认(base / sourceTrust / penalties)沿用 S2;每个任务可覆盖 requiredEvidence / confidenceThreshold / evidenceWeights / 时间参数。

**★ requiredEvidence 语义(对 S2 门槛的一点小增强):** 它是一个组的列表——组与组之间是 AND,组内是 OR。每个组都至少有 1 项证据才算满足;任一组未满足则最多判 pending。
- 例:[[snapshot]] = 必须有照片。
- 例:[[snapshot, qr_scan]] = 照片或扫码,有其一即可。
- 例:[[document],[qr_scan]] = 既要文档又要扫码。

> S2 原本把 requiredEvidence 当扁平列表;请扩展为组语义(小改动)。

## 配置(YAML · 可直接落地)

```yaml
# TaskSopConfig — S0-7 (创始人确认 2026-07-07)。按租户可配置。
# requiredEvidence: 组的列表;组间 AND、组内 OR。任一组缺失 -> 最多 pending。

globalDefaults:
  base: 0.50
  sourceTrust: { snapshot: 1.0, qr_scan: 1.0, document: 0.9, corroborating_comm: 0.6 }
  penalties:   { conflict: 0.40, missing_required: 0.50, timing_anomaly: 0.20 }

taskTypes:
  - taskType: room_turnover        # 诊室整理
    expectedState: ready
    expectedDurationMin: 6
    requiredEvidence: [[snapshot]]
    confidenceThreshold: 0.85
    evidenceWeights: { snapshot: 0.35, qr_scan: 0.25, document: 0.20, corroborating_comm: 0.15, cross_object: 0.15, timing_within_sop: 0.10 }

  - taskType: pretest_done         # 预检完成
    expectedState: done
    expectedDurationMin: 8
    requiredEvidence: [[snapshot, qr_scan]]      # 结果截图 或 扫患者码
    confidenceThreshold: 0.80
    evidenceWeights: { qr_scan: 0.30, snapshot: 0.30, document: 0.20, corroborating_comm: 0.15, cross_object: 0.15, timing_within_sop: 0.10 }

  - taskType: dilation_started     # 散瞳开始
    expectedState: started
    expectedDurationMin: null                    # 即时事件;记开始时刻
    dilationWaitMin: 25                          # 散瞳等待时长;驱动下一阶段触发
    requiredEvidence: [[qr_scan]]                # 扫患者就诊码
    confidenceThreshold: 0.80
    evidenceWeights: { qr_scan: 0.45, snapshot: 0.20, document: 0.10, corroborating_comm: 0.15, cross_object: 0.15, timing_within_sop: 0.10 }

  - taskType: inventory_reorder    # 库存补货
    expectedState: ordered
    dueBy: end_of_day
    requiredEvidence: [[document, snapshot]]     # 补货单 或 货架照片
    confidenceThreshold: 0.85
    evidenceWeights: { document: 0.30, snapshot: 0.25, qr_scan: 0.15, corroborating_comm: 0.15, cross_object: 0.15, timing_within_sop: 0.05 }

  - taskType: equipment_calibration  # 设备校准
    expectedState: calibrated
    expectedDurationMin: 15
    calibrationValidDays: 30                     # 超期后扫码使用会被标记
    requiredEvidence: [[document], [qr_scan]]    # 校准记录 且 扫设备标签
    confidenceThreshold: 0.90
    evidenceWeights: { document: 0.30, qr_scan: 0.30, snapshot: 0.15, corroborating_comm: 0.15, cross_object: 0.15, timing_within_sop: 0.10 }
```

## 对照表与备注(人读)

| 任务 | 应达状态 | 用时 | 必需证据 | 门槛 | 最强证据 |
|---|---|---|---|---|---|
| 诊室整理 | ready | 6 分 | 照片 | 0.85 | 📷 |
| 预检完成 | done | 8 分 | 照片或扫码 | 0.80 | 📱/📷 |
| 散瞳开始 | started | 即时 | 扫患者码 | 0.80 | 📱 |
| 库存补货 | ordered | 当天 | 单据或货架照 | 0.85 | 📄 |
| 设备校准 | calibrated | 15 分 | 记录 + 扫标签 | 0.90 | 📄+📱 |

**几个我替你填的默认值(随时可改):**
- 散瞳等待 dilationWaitMin: 25 分——用于散瞳够时长后可接诊的下一阶段提醒。你们实际等多久?
- 设备校准有效期 calibrationValidDays: 30 天——超期后用该设备会被标记为结果可能存疑。你们的周期是?
- 库存补货 dueBy: end_of_day(当日内完成)。

> 这些都是可调参数;如需改,告诉我或直接让工程师改 YAML 即可。

## 给工程师的集成说明

1. 把上述 YAML 落入 TaskSopConfig(按租户可覆盖的默认集)。
2. 把 S2 的占位 SOP 默认值换为这份。
3. 将验证器的 requiredEvidence 门槛扩展为组语义(组间 AND / 组内 OR)。
4. 评分时采用每任务 evidenceWeights(即 Q1(a),无需单开 PR,随此集成)。
5. dilationWaitMin / calibrationValidDays / dueBy 作为时间类触发的参数(供 S2 sweep 与 S3 使用)。
6. Room-3 校准不变:room_turnover 仅声称+缺 snapshot+时间异常 → conflict ≈ 0.76;补上照片 → verified ≈ 0.93。

**可发给工程师:**
```text
S0-7 is confirmed — here is the real TaskSopConfig (YAML above). Replace the S2
placeholder SOP with it, and fold in per-task evidenceWeights here (Q1(a), no
separate PR). One small change: requiredEvidence is now a list of GROUPS
(AND across groups, OR within a group) — extend the required-evidence gate
accordingly. Keep the Room-3 calibration (conflict ~0.76 -> verified ~0.93).
dilationWaitMin / calibrationValidDays / dueBy are timing params for the S2
sweep and S3.
```
