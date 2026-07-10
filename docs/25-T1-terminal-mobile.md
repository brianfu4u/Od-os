# T1 工单 · 终端移动化 + staging 鉴权 + 打卡 + 真相机拍照(终端模块 Phase 1)

> 状态:待开发。负责人:外部工程师。审核:Maestro 逐行审。合并:创始人授权。
> 依赖:staging 已上线;后端 /reports(clock_in/clock_out/event/task_update/scan,幂等)、/uploads(照片/截图/语音/文档)就绪。参考 docs/23(终端模块计划)、docs/04(契约)、docs/16(会话鉴权)。
> 目标里程碑:T-M1「采集端可用」。与 LLM1、P7 可并行(本票不需 DeepSeek 密钥)。

## 目标
把浏览器员工终端 `/console` 变成**手机可用**、并**在 staging(生产模式)能真正鉴权提交**,支持打卡与**真相机拍照**,让员工在手机上就能跑通"上报/拍照 → 命令中心实时看到 → 驱动 loop(并喂给 LLM1)"。

## 关键坑(必须解决)· staging 鉴权
staging 为 `NODE_ENV=production`,**开发期 X-Tenant-Id 请求头身份被拒(401)**。现有 `/console` 依赖该 dev 垫片,直接上 staging 会**上报/上传失败**。
- 本票必须让**员工终端在 staging 也能取得会话身份**再调 /reports、/uploads:复用 staging 登录口令机制(或加一个**员工 staging 会话**),会话驱动租户/员工。
- 生产不放开无鉴权 dev-login;dev 本地仍可用垫片(NODE_ENV 门控)。

## 范围
1. **移动化外壳**:`/console` 响应式、手机优先,能在**手机浏览器 + 微信内置浏览器**里正常用;localStorage 走安全封装(禁用不白屏)。(可选:PWA manifest,支持"添加到主屏"。)
2. **staging 鉴权**(见上):终端登录取会话 → 之后所有 /reports、/uploads 带会话;确认 staging 上真的能提交成功(非 401)。
3. **打卡上下班**:上/下班按钮 → `/reports {reportType: clock_in|clock_out}`;显示当前状态与时间。
4. **真相机拍照**:用 `<input type=file accept="image/*" capture="environment">` 调**后置相机**拍照 → `/uploads`(可关联所选对象);手机上验证可用。
5. **打磨现有控件**:上报、上传、扫码证据、运行扫描、重新核实——改成触控友好;三语(默认中文)。

## 验收标准(DoD)
- [ ] 在**手机浏览器打开 staging 网页**(含微信内置浏览器),员工能**登录/取得会话** → 打卡 → 提交一条**带真实照片**的上报 → 该上报与证据**实时出现在 staging 命令中心**(驱动 loop、可被 LLM1 监听)。
- [ ] staging(生产模式)下提交**不再 401**;生产未放开无鉴权 dev-login。
- [ ] 相机拍照走后置相机、上传成功并可关联对象;打卡状态正确。
- [ ] 手机布局可用、三语、禁用 localStorage 不白屏。
- [ ] 只用合成数据、不碰真实 PHI;多租户隔离不破。

## 不做(留后续)
真·摄像头扫码(T2)、终端内录音(T3)、语音转文字(P7/T4)、我的任务(T5)、申请支援(T6)、真微信小程序(T8)。

## 交付与铁律
- 新开分支(建议 `t1-terminal-mobile`),小步提交,PR,不直接推 main;Maestro 评审 + 创始人授权合并(合并后 Vercel 自动重部署 staging)。
- 复用既有契约与 withTenant;PR 写清:staging 终端如何鉴权、移动化改了什么、拍照/打卡如何接、三语与 storage 兜底、未覆盖项与风险。
- Maestro 评审重点:**staging 生产模式下终端能鉴权提交且不放开无鉴权路径**、相机上传可用、手机可用、跨租户隔离。
