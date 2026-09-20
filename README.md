# 无障碍问题抑制规则工作台（仅样例）

本地审阅工作台：为无障碍样例快照中的问题创建“抑制规则”，并按服务端优先级评估每条问题为何被抑制（或未被抑制）。**只使用静态样例快照，不连接线上系统。**

- 启动：`npm install`，然后 `npm run dev`（服务 :4174，前端 :4173）
- 测试：`npm test`　类型检查+构建：`npm run build`

## 规则作用域与字段

一条规则可限定（均可选，缺省即通配）：

- 页面路径：精确串或通配（`*` 不跨 `/`，`**` 跨 `/`），如 `/reports/*`
- 组件指纹：跨快照稳定的组件 id
- 规则代码：如 `color-contrast`
- 节点属性约束：`equals / notEquals / contains / exists / absent`，多条之间 AND
- 到期时间 `expiresAt`（留空=永久）与必填的原因；可启用/禁用

结构非法的规则（缺原因、路径非法、到期时间非 ISO、属性约束缺值等）会被持久化但标记 `valid=false`，**永不抑制**，评估时单独解释为“规则无效”。

## 匹配与结论

服务端按以下顺序对“作用域命中”的规则排序：

1. 特异度降序，元组 `(属性约束数, 组件指纹, 规则代码, 路径)`，路径维度 `精确(2) > 通配(1) > 缺省(0)`
2. 特异度相同则按**创建顺序**（`createdSeq` 升序，编辑不改变创建顺序）
3. 再相同按 ruleId 兜底

单条问题的结论严格区分：`suppressed`（已抑制）/ `expired`（规则过期）/ `invalid`（规则本身无效）/ `disabled`（规则禁用）/ `unsuppressed`（无规则）。

- 只有“合法 + 启用 + 未过期”的命中规则能抑制；其中排序最前者为生效规则（winner）。
- 其余**可生效但更靠后**的活动规则标记 `shadowed`，并给出被覆盖原因（首个拉开差距的特异度列；打平则注明按创建顺序）。
- 过期/无效/禁用规则即使排在最前也不会抑制，也不会“挡住”后面有效的规则；它们仍出现在候选列表里被解释。
- 到期边界包含：`now == expiresAt` 即视为过期。即时评估可用 `POST /snapshots/:id/evaluate {"at":"<iso>"}` 或 `?at=` 固定时钟。

## Revision 与历史回放

- 规则采用**追加式**存储：每次编辑/禁用都新增一份不可变 revision（`PUT /rules/:id` 需带 `expectedRevision`，冲突返回 409）。`createdSeq/createdAt` 终身不变。
- 批量重评估在**启动瞬间**固化全部规则 revision（`ruleRevisionPins`）与单个评估时钟（`evaluatedAt`），运行期间的并发编辑不影响本批。
- 已完成批量生成自包含的历史报告（含 pins、时钟、逐问题决策）。`POST /reports/:id/replay` 用固化 pins + 当时时钟重新推导，即使规则此后被改/禁用/过期，也与已存结论逐字段一致，从而解释“当时为何被抑制”。

## 批量、取消与 SSE 去重

- `POST /batches` 启动顺序重评估；事件经 `GET /batches/:id/events`（SSE）推送：`started / item / completed / canceled`，每个事件带单调 `id`。
- 每个 item 只处理一次，`item` 事件携带**权威全量累计统计 `cumulative`**。客户端必须以其覆盖本地计数，而不是累加。
- 重连依赖 `Last-Event-ID`（浏览器 EventSource 自动；测试可用 `?lastEventId=`），服务端只重放该序号之后的事件，因此重放不会重复计数；客户端另有按 seq 去重的双保险。
- `POST /batches/:id/cancel`：取消幂等。取消后不再处理后续 item，状态为 `canceled`，**不产生 `completed`、不写入任何最终统计/报告**（`canceled` 事件刻意不含累计值，前端清零）。

## 代码结构

- `src/shared/model.ts`、`src/shared/matcher.ts`：前后端同构类型与纯匹配逻辑
- `src/server/evaluator.ts`：三态判定、winner 选择、覆盖原因
- `src/server/store.ts`：追加式 revision 规则存储 + 快照存储
- `src/server/batch.ts`：固化 revision/时钟、取消状态机、可重连事件缓冲
- `src/server/reports.ts`：历史报告存储与回放
- `src/server/routes.ts` / `index.ts`：HTTP/SSE 与组装
- `src/client/*`：规则编辑、样例预览（命中节点 + 覆盖原因高亮）、批量与历史面板
- `test/*`：匹配器、评估器、批量管理器（含取消/重连）、HTTP/SSE 集成
