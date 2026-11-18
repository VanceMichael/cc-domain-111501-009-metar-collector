# 机场观测电报的缺测标识与更正采集

Node.js 22.23.4 ESM 资料接入服务。legacy 模式提供单文件预览、原始字节留存和重复导入；managed 模式把 METAR/SPECI 接成带原始组、限定符和来源位置的结构化记录，并按传输窗口解析跨月观测时刻、管理 COR 修订与各类未决。`docs/protocol.md`说明获授权来源的资料范围、引用语义和修订行为，`fixtures/raw`是极小本地合成原件，不含真实机构账号或个人数据。本服务不做气象预报，也不输出任何适航结论。

## 环境与可执行命令

只需要Linux、Node.js 22.23.4和npm，无第三方包。package-lock.json与源码共同保存，安装、测试和运行不下载任何资料或依赖。

```sh
npm run build
npm test
npm run demo
```

build逐个检查src、simulator、scripts、test、acceptance内的ESM语法；test验证旧版预览、来源HTTP缓存与故障响应、存储重开。demo当场创建空目录并启动真实回环HTTP服务、调用采集器后打印取得的记录、来源证据和请求列表；结束时关闭服务并清理临时目录。它不是日志回放，也不会把预览结果说成完整接入。固定小样本预计数秒，可在90秒内现场展示。

## 调用边界

`collect({base,repository,mode})`是采集入口，默认旧预览模式；`mode:'managed'`供上层请求结构化接入。返回值延续imported和complete，complete只能表示协议下已核对的完成状态，不可由HTTP200或预览成功推断：任一文档临时失败、缺件，或存在时间未决、身份冲突、未解释组时 complete 均为 false。`Repository`中的records、evidence、cursors、notes是现有持久化接口，可为业务一致性扩展结构及事务；旧记录和原始字节应继续可读。

### managed 模式的解释边界

- 身份 `id=站点:完整UTC时刻:METAR|SPECI`。完整时刻只由来源传输窗口与电报日时分（DDhhmmZ）枚举月份候选得到，不读取本机时钟；窗口内候选不唯一或无候选时进入 `OBSERVATION_TIME_UNRESOLVED` 待核对，不生成业务身份。
- `CAVOK` 记为 `visibility.kind='cavok'`，不虚构云层或能见度零值；斜杠组（`////`、`VV///`、`R../////`、`Q////` 等）是传感器/来源未报，统一带 `notReported:true` 且无数值；真零值（`00000KT`、`0000`、`VV000`、`R../0000`）照常解析为 0。字段整组缺失为 `null`，与“未报”区分。
- 风、能见度、跑道视程（含跑道号与 U/D/N 趋势，不折算成地面能见度）、云况、天气、温度、修压均保留原始组与字段级来源（文档、摘要、报告序号、token 序号）。profile 之外的未知组隔离进 `unknownGroups` 并挂 `UNEXPLAINED_GROUPS`，记录 `interpreted=false`，不得称作已解释。
- COR 同站同类型同时次追加为新修订，旧更正前原文与字节摘要在 `revisions` 中仍可查；常规 METAR 与 SPECI 时刻再接近也保持独立身份。非 COR 的不同原文不覆盖，挂 `IDENTITY_CONFLICT`。
- `NIL` 报是 `status='nil'` 的记录；来源 404 缺件是文档级 `DOCUMENT_PENDING`（missing），503/网络错误是 fetch-failed，三者分别留痕；分段补发后只重解释受影响文档并补齐来源依据。
- 两阶段分别落盘：原始字节先 `retain`，解释关系后提交；边界终止后重启按持久化索引续做，不重复留存、不膨胀身份。

`createSource({scenario:'legacy'|'feature'})`创建本地来源，提供base/state/requests/close；legacy只含首个文件，feature开放整组关联资料。测试用state.round、failDoc、missingDoc驱动来源变动，采集端只经HTTP观察这些变化，不读取模拟器内部数据。详细字段及公开行为矩阵见协议。

## 特性验收与恢复

```sh
npm run acceptance
```

acceptance与基线回归分开。套件覆盖协议验证矩阵：跨文件分组与限定符采集、跨月观测时间候选（含无法唯一定位时挂起）、重投与存储重开的身份不膨胀、COR 修订留痕且 SPECI 独立、NIL 与缺件/线路失败的区分、分段补发补齐原组、非 COR 冲突不覆盖、未知组隔离、以及字节已留存而关系未提交时的进程终止恢复。资料未齐时保留可解释未决，不为“通过”填充不存在的源值；断言不固定输出样本答案，原始证据与规范化结果通过摘要和字段级来源对齐。

## 离线容器

```sh
docker build --pull=false -t metar-collector:local .
docker run --rm --network none metar-collector:local npm test
docker run --rm --network none metar-collector:local npm run demo
```

Dockerfile使用node:22.23.4-bookworm-slim，不安装额外依赖。镜像准备好后正式命令禁网运行，来源和接入器在同一应用容器中通过回环HTTP协作，无需浏览器、设备、外部数据库或额外容器。
