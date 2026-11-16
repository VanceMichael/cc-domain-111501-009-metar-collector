# 机场观测电报的缺测标识与更正采集接入约定

## 来源获取

获授权供应方网关 `/bulletin` 返回文件目录、相对path、原始格式、修订号与href。GET `/raw/路径` 获得原始字节，ETag与内容绑定，条件请求304不带正文。legacy只开放第一项，feature开放完整本地资料；不需要访问真实机构或下载生产数据。目录不是完成性证明，文件可有503或404，源缺件和字段未决分别记录。真实格式范围以本文profile为准，不要求实现所引标准所有未使用扩展。

## 数据解释

目录由获授权网关提供传输窗口2026-10-31T23:00:00Z至2026-11-01T01:00:00Z，按窗口为日时分确定月份候选，不借本机时钟；窗口跨越的每个月构造一个候选，候选时刻必须落在窗口内且日历日合法，窗口太宽导致不唯一（或无候选）则记录`status='pending'`并保留候选列表待人工核对。ZAAA/ZBBB为虚构标识。输出id=station:完整UTC时刻:METAR或SPECI，COR修订同站同类型同观测时刻，作为新解释版本追加，保留旧电报；NIL记录status=nil且不合成观测组，CAVOK保存visibility.kind=cavok，不虚构云层零值。传感器未报（/////KT、////、///、//、Q////）保留missing=true与null数值，真实零值（00000KT、0000）保留数值0。SPECI的RVR带趋势U及跑道号09，不转换成普通地面能见度。每个字段保留原始组、限定符和来源位置（文档、报告序号、token序号）；profile外未知组进入unknownGroups并标记partial。

## 修订和补件

本地测试可用 `source.state.round=2` 驱动一次修订：更正报中10006KT变成11007KT，只修订ZAAA该时次METAR（追加为第三解释版本，前两版文本与字节摘要保留），SPECI保持独立。 `state.failDoc`、`state.missingDoc`可设为目录document.id，分别模拟临时失败（deliveryStatus=failed）与缺件（deliveryStatus=missing），清空后恢复；这两类来源故障与已送达的NIL报文（status=nil）分别留痕。采集端只能经HTTP观察，不允许读取source.state或fixture.expectedIds作为采集结果。fixture.expectedIds仅是公开验收对照。原始资料及解释版本需要可核对；失败不能使已确认内容凭空消失。把已取得的文件索引（documents）、源端修订、规范化记录（records）、解释版本（interpretations）及字段来源协同持久化；存储结构可扩展，不规定实现架构。

同身份出现两份不同且均未标COR的文本标记conflict并写入notes，不静默合并；COR链不视为冲突。完整性至少区分取得文件与解释关系两个层次；已隔离的未知字段不能被称作已解释。notes为现有人工诊断入口，每条含具体资料位置和未决原因，重复轮询不重复书写同一位置的诊断。文件级原始证据由Repository.retain保留。legacy的人工预览入口继续可用；managed模式负责结构化接入。

## 验证矩阵

1. 按样本跨文件完成 电报分组与限定符采集 与 跨月观测时间候选，不以读取目录或预览摘要代替。
2. 对同一原始资料重复投递及重开存储，规范化身份不膨胀，来源证据仍可追溯；条件请求命中304时不重复解释。
3. COR与常规/特报身份 不因缺件或顺序改变而被默认值掩盖；补件后只重解释受影响对象，METAR与SPECI时刻接近也互不覆盖。
4. 使用round=2比较新旧解释，说明 NIL和缺测/漏收区分 如何留痕（nil状态、missing/failed文档状态、missing标记三类分开）。
5. 在原始资料已保存、关系尚未提交等边界终止进程（测试经onPhase阶段钩子模拟），再启动能识别待完成工作；不得靠固定样本答案实现。
6. 窗口宽到同一日时分出现多个月份候选时保持pending待核对；无候选、非法日历日、窗口缺失同样pending，不回退本机月份。
7. 未标COR的竞争文本标记identity-conflict；未知组隔离为partial并带token位置，畸形报告带位置入notes而不丢整份文档。

`acceptance/managed.test.mjs`覆盖关键正例、重启重投及上述异常和来源变化；`test/metar.test.mjs`与`test/timewindow.test.mjs`覆盖字段级缺测/零值/限定符与时间候选纯函数。资料未齐时保留可解释未决，不为“通过”填充不存在的源值。
