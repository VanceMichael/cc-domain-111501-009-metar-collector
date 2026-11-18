# 机场观测电报的缺测标识与更正采集接入约定

## 来源获取

获授权供应方网关 `/bulletin` 返回文件目录、相对path、原始格式、修订号与href。GET `/raw/路径` 获得原始字节，ETag与内容绑定，条件请求304不带正文。legacy只开放第一项，feature开放完整本地资料；不需要访问真实机构或下载生产数据。目录不是完成性证明，文件可有503或404，源缺件和字段未决分别记录。真实格式范围以本文profile为准，不要求实现所引标准所有未使用扩展。

## 数据解释

目录由获授权网关提供传输窗口2026-10-31T23:00:00Z至2026-11-01T01:00:00Z，按窗口为日时分确定月份候选，不借本机时钟；若窗口太宽导致不唯一则未决。ZAAA/ZBBB为虚构标识。输出id=station:完整UTC时刻:METAR或SPECI，COR修订同站同类型同观测时刻，保留旧电报；NIL记录status=nil，CAVOK保存visibility.kind=cavok，不虚构云层零值。SPECI的RVR带趋势U及跑道号09，不转换成普通地面能见度。每个字段保留原始组和来源位置。

## 修订和补件

本地测试可用 `source.state.round=2` 驱动一次修订：更正报中10006KT变成11007KT，只修订ZAAA该时次METAR，SPECI保持独立。 `state.failDoc`、`state.missingDoc`可设为目录document.id，分别模拟临时失败与缺件，清空后恢复。采集端只能经HTTP观察，不允许读取source.state或fixture.expectedIds作为采集结果。fixture.expectedIds仅是公开验收对照。原始资料及解释版本需要可核对；失败不能使已确认内容凭空消失。把已取得的文件索引、源端修订、规范化记录及字段来源协同持久化；存储结构可扩展，不规定实现架构。

完整性至少区分取得文件与解释关系两个层次；已隔离的未知字段不能被称作已解释。notes为现有人工诊断入口，可扩展结构，但信息应包含具体资料位置和未决原因。文件级原始证据由Repository.retain保留。legacy的人工预览入口继续可用；managed模式负责结构化接入。

## 验证矩阵

1. 按样本跨文件完成 电报分组与限定符采集 与 跨月观测时间候选，不以读取目录或预览摘要代替。
2. 对同一原始资料重复投递及重开存储，规范化身份不膨胀，来源证据仍可追溯。
3. COR与常规/特报身份 不因缺件或顺序改变而被默认值掩盖；补件后只重解释受影响对象。
4. 使用round=2比较新旧解释，说明 NIL和缺测/漏收区分 如何留痕。
5. 在原始资料已保存、关系尚未提交等边界终止进程，再启动能识别待完成工作；不得靠固定样本答案实现。

`acceptance/managed.test.mjs`仅覆盖关键正例及重启重投，改动时需按以上矩阵增加适合方案的异常和来源变化测试。资料未齐时保留可解释未决，不为“通过”填充不存在的源值。

## 实现落点

- `src/metar.mjs`：纯函数解析，无网络无时钟。`parseReport`保留每个字段的原始组与来源位置，并以 `notReported` 区分斜杠未报与数值零；`resolveObservationTime` 仅按传输窗口枚举月份候选，`ambiguous`/`outside-window` 均不产生业务身份。
- `src/managed.mjs`：managed 采集。阶段一按目录留存字节并登记 fetched/missing/fetch-failed；阶段二只解释已留存字节，COR 追加修订、非 COR 异文挂 `IDENTITY_CONFLICT`、NIL 独立成记录、未知组挂 `UNEXPLAINED_GROUPS`。`managed` 索引每步落盘，重启后只续做未完成文档。
- `src/repository.mjs`：`evidence` 保存文件级原始字节与 ETag/修订元数据，`state.managed` 保存文档索引、报告修订与 pending，`notes` 保存带资料位置的人工诊断；旧版无 managed 槽位的 state 打开时自动补齐。
- 输出记录中 `revisions[].observedRaw` 与 digest 可回溯到 `raw/<digest>` 原件；便利字段（wind/visibility/rvr/clouds 等）与字段级来源同源，不产生预报或适航判断。
