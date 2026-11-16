# 机场观测电报的缺测标识与更正采集

Node.js 22.23.4 ESM 资料接入服务。服务提供两种入口：旧版单文件预览（原始字节留存与重复导入）与 `mode:'managed'` 结构化接入，后者把 METAR/SPECI 原文规范化为可核对的业务身份与字段来源。`docs/protocol.md`说明获授权来源的资料范围、引用语义和修订行为，`fixtures/raw`是极小本地合成原件，不含真实机构账号或个人数据。

## 环境与可执行命令

只需要Linux、Node.js 22.23.4和npm，无第三方包。package-lock.json与源码共同保存，安装、测试和运行不下载任何资料或依赖。

```sh
npm run build
npm test
npm run demo
```

build逐个检查src、simulator、scripts、test、acceptance内的ESM语法；test覆盖旧版预览、来源HTTP缓存与故障响应、存储重开、METAR/SPECI解析与跨月时间候选。demo当场创建空目录并启动真实回环HTTP服务、调用managed采集后打印身份记录、来源文档状态、人工诊断notes和请求列表；结束时关闭服务并清理临时目录。固定小样本预计数秒，可在90秒内现场展示。

## 结构化接入边界

`collect({base,repository,mode})`是采集入口，默认旧预览模式；`mode:'managed'`调用`src/managed.mjs`的结构化管线。返回值延续`imported`和`complete`，`complete`只在本轮无来源缺件/线路失败、无待核对时次、无身份冲突、无部分解释时成立，不能由HTTP 200或预览成功推断。

### 身份与字段

* 输出身份 `id=station:完整UTC时刻:METAR或SPECI`。常规观测与临时特报即使时刻接近也是不同身份，互不覆盖。
* 风、能见度、跑道视程（RVR）、云层、温度、QNH 每个字段都保留原始组（`raw`）、限定符（阵风、趋势U/D/N、P/M修饰、CAVOK、NDV、单位等）和来源位置（文档、报告序号、token序号）。
* 三类“空值”严格分开：`CAVOK` 记为 `visibility.kind='cavok'` 且不虚构云层零值；传感器未报（`/////KT`、`////`、`///`、`//`、`Q////`）保留 `missing:true` 且数值为 `null`；真实零值（`00000KT`、`0000`）保留数值 `0`。
* RVR 始终独立保留跑道号、单位与趋势，不折算成普通地面能见度。
* profile 之外的未知组隔离在 `unknownGroups` 并把报告标为 `partial`，不能称作已解释；畸形报告带位置写入 notes，不丢弃整份文档。
* 只描述报文内容，不做天气预报，也不替飞行员作适航判断。

### 观测时间

报文只有日时分。完整 UTC 时刻由网关目录给出的传输窗口（`transmissionWindow`）确定月份候选，不读取本机时钟：窗口跨越的每个月构造一个候选，候选时刻必须落在窗口内且日历日合法；零个或多个候选时记录 `status='pending'` 并保留候选列表，等待人工核对，绝不硬猜。

### 更正、NIL 与来源故障

* `COR` 与同站同类型同观测时刻的原报归为同一身份，追加为新解释版本；旧文本、来源文档和字节摘要始终可在 `versions`/`sources` 与原始证据中检索。源端修订（`state.round=2`）只重新解释受影响文档。
* `NIL` 是已送达报文的 `status='nil'`，不合成任何观测组；目录在列但取件 404 记为来源缺件（`deliveryStatus='missing'`），503 等记为线路失败（`deliveryStatus='failed'`），两者与 NIL 分开留痕。已确认内容不会因后续取件失败而消失。
* 同身份出现两份不同且均未标 COR 的文本时标记 `conflict`，不静默合并。

### 持久化与恢复

`Repository`在原有 `records/evidence/cursors/notes` 之外扩展 `documents`、`interpretations` 与 `meta`。目录索引、原始字节、解释版本与字段来源分阶段原子落盘；进程在原始资料已留存而关系未提交时终止，重开后能识别待完成工作并继续。记录由持久化证据重建，重复投递与存储重开不会使身份膨胀，旧记录和原始字节继续可读。

## 来源模拟器

`createSource({scenario:'legacy'|'feature'})`创建本地来源，提供base/state/requests/close；legacy只含首个文件，feature开放整组关联资料。测试用state.round、failDoc、missingDoc驱动来源变动，采集端只经HTTP观察这些变化，不读取模拟器内部数据。详细字段及公开行为矩阵见协议。

## 特性验收与恢复

```sh
npm run acceptance
```

acceptance与基线回归分开，覆盖协议验证矩阵：跨文件分组与限定符、跨月观测时间候选、重复投递与重开、COR 修订与 SPECI 独立性、NIL 与缺件/漏收区分、身份冲突、未知组隔离，以及原始证据留存后终止进程的恢复。不能删断言、固定输出样本答案或让原始证据与规范化结果错位。

## 离线容器

```sh
docker build --pull=false -t metar-collector:local .
docker run --rm --network none metar-collector:local npm test
docker run --rm --network none metar-collector:local npm run demo
```

Dockerfile使用node:22.23.4-bookworm-slim，不安装额外依赖。镜像准备好后正式命令禁网运行，来源和接入器在同一应用容器中通过回环HTTP协作，无需浏览器、设备、外部数据库或额外容器。
