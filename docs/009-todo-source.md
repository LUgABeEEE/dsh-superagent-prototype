# 009 Todo Source：把全局待办接成 dsh-superagent 的事件源

> 设计稿（2026-11-03）。实现在 `src/sources/todo.ts`，按 [008 Cookbook](008-cookbook.md) 的四个职责组织：
> 翻译事件、接收与授权规则、回复与上下文、轮询循环。本文件只描述映射与契约，不重复接口细节。

## 为什么不是 GitHub

上游原型的 Source 是「一个 GitHub 仓库里的 issue 评论」。本部署的工作面是**跨目录的待办清单**，
没有单一仓库，也没有「谁 @ 了机器人」这种显式信号。所以改造的核心是换 Source，而不是改 Worker：
Worker、Ticket、Eval、Policy、Outbox 全部照用。

「有人请求工作」在待办里的对应物是：**一条记录被打了 `可自动` 标签**。这既是人的显式授权，
也正是 `lib/gate.js` 的闸门已经在用的那个标记——两边用同一个词，才不会出现「清单说可以派、
superagent 说没人请求」这种自相矛盾。

## 领域映射

| superagent 概念 | 待办里的对应物 |
| --- | --- |
| Trigger | 一条 `status` 为 open/doing、带 `可自动` 标签、且当前没有在跑会话的记录 |
| Trigger id | `todo:<id>:<updatedAt>` —— 记录被改动后重新触发；未改动时重复轮询是幂等的 |
| Thread | 一条记录 = 一个 Thread（`notes[]` + `activity[]` 就是完整线程史） |
| Actor | `todo.createdBy`（`human` / `agent`），Policy 只放行 `human` |
| Channel address | `{ todoId }`：回复写进这条记录的 note |
| Receiving scope | 标签 `可自动` 且 `originDir` 非空（与闸门同一条规则） |
| 回复 | `POST /api/global-todo/note`（进展）；完成仍走 `global_todo_done`（要人点头） |

## 四条不变量

1. **不自动 done。** Worker 只能写 note / status；完成必须由人确认——这是清单本身的规矩，
   superagent 的 Worker 也不例外。
2. **幂等靠 note 账本，不靠状态文件。** 与 `lib/router.js` 同一个原则：一条 note 带日期前缀，
   重复读取不会重复回复。
3. **轮询只读 HTTP 接口，不直接读 `todos.json`。** 写操作全部走 API，锁在服务端。
4. **目录安全与预算仍在清单侧。** Source 只负责「有人请求」；能不能派、派几条，仍由
   `lib/gate.js` 与 `routerDailyCap` 决定。superagent 的 Eval 是第二道，不是替代品。

## 配置

```yaml
# 面板 → Sources → 待办清单
kind: todo
config:
  endpoint: http://127.0.0.1:3080     # 全局待办所在的 DSH
  tag: 可自动                          # 谁被允许发起工作
  pollSeconds: 60
  includeDoing: false                 # 进行中的是否也算请求
```

Policy：`allowed: [{ id: human }]`——只有人打的标签才算请求，agent 自己写的记录不触发。

## Worker 的输入与产出

prepare 命令只负责准备目录（`originDir`），Worker 的指令里给出：

- 这条记录的标题/描述/步骤/链接（等价于 `dispatchPrompt()` 的内容）；
- 做完后调用 `global_todo_done`，带 `summary` 与 `artifacts`；
- 做不完就写 note 说明卡在哪，**不要**标完成。

## 分阶段落地

1. **只读观察（observe）**：Source 只产出 Trigger，Eval 记录「本来会派哪条」，不建 Ticket。
   跑一周，对照 `wouldDispatch` 与人的判断。
2. **单目录受控**：只对白名单目录开 Ticket，日上限 2，与清单预算共用计数。
3. **再谈自动**：只有在 1 和 2 的数据一致时才打开，且仍不自动 done。

## 与已有实现的关系

`lib/triage.js` / `lib/gate.js` / `lib/router.js` 是**清单侧的分诊与闸门**，它们回答「今天该动哪三条、
能不能派」。这个 Source 回答「有人请求了哪条」。两者共享同一个标签与同一条目录规则，
但一个在清单进程里跑（零 token），一个在 superagent 进程里跑（会建会话）。
不要让它们互相调用——共享的是**约定**，不是代码。
