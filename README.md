# ad-review-loop

**Claude Code 插件**：对代码变更执行**跨模型**的迭代式对抗审查。

```
审查（fresh 只读 × N 视角，模型 A）
  → 记录（内核：归一化 / 去重 / 跨轮匹配 / 缺席判定 / 回归检测）
  → 判定（内核：收敛 / 继续 / 升级 / 硬停止）
  → 修复（fresh 可写，模型 B，最小改动）
  → 下一轮审查     ← 下一轮审查同时就是验证
  → …直到某一轮无阻塞性发现
```

**没有独立的"验证者"角色**：下一轮的 fresh 审查者重新审当前完整 diff，某条发现未被复现即判已修复（**缺席即通过**），被复现即未修复，此前判修复又出现即**回归**（立刻升级人工）。

---

## 安装（直接用 git 地址）

```bash
# 1) 添加市场（三选一）
/plugin marketplace add LeewayTang/ad-review-loop
/plugin marketplace add https://github.com/LeewayTang/ad-review-loop.git
/plugin marketplace add /本地/路径/ad-review-loop        # 本地开发用

# 2) 安装插件（默认用户级；团队分发加 --scope project）
/plugin install ad-review-loop@ad-review-loop

# 3) 生效（无需重启会话）
/reload-plugins
```

CLI 等价写法：`claude plugin marketplace add LeewayTang/ad-review-loop`、`claude plugin install ad-review-loop@ad-review-loop`。

**升级**：本插件刻意**不在清单里声明 `version`**，因此 git 源的缓存键是 commit SHA——推一个新 commit 就是新版本，不需要手工 bump：

```bash
/plugin marketplace update ad-review-loop   # 先刷新市场本地副本
/plugin update ad-review-loop               # 再升级插件
```

**本地开发**：`/plugin marketplace add <本地目录>` 时，相对路径 source 是**原地加载**（不复制进缓存），改完 `/reload-plugins` 即生效；而 git 市场安装会被复制进 `~/.claude/plugins/cache/`。

---

## 插件内容

```
ad-review-loop/
├── .claude-plugin/
│   ├── marketplace.json      # 市场目录（git 安装入口）；source: "./" + 显式限定 skills 子集
│   └── plugin.json           # 插件清单（name / description / author…；刻意无 version）
├── skills/
│   └── ad-review-loop/
│       └── SKILL.md          # 协议本体：不变量、探测、预算、循环、报告模板、反模式
├── agents/
│   ├── reviewer.md           # 只读对抗审查者   model: opus   tools: Read, Grep, Glob
│   └── fixer.md              # 最小化修复者     model: sonnet tools: 含 Edit/Write/Bash
├── hooks/
│   └── hooks.json            # PreToolUse → 守卫脚本
└── scripts/
    ├── loop-state.mjs        # 确定性内核：状态机 + 收敛判定 + CLI
    ├── hook-guard.mjs        # 守卫：审查者只读、修复者禁 commit
    ├── selftest.mjs          # 内核自测（56 项）
    ├── selftest-hook.mjs     # 守卫自测（26 项）
    └── plugin-check.mjs      # 清单/路径/角色绑定校验
```

要求：**Node ≥ 18**（无第三方依赖，纯标准库）。`${CLAUDE_PLUGIN_ROOT}` 在插件内容里会被内联替换，所以协议文本里写 `node "${CLAUDE_PLUGIN_ROOT}/scripts/loop-state.mjs"` 是可靠的；注意它**不会**作为环境变量进入 Bash 工具，写成 shell 变量 `$CLAUDE_PLUGIN_ROOT` 无效。

### 跨模型角色绑定

`agents/reviewer.md` 与 `agents/fixer.md` 的 frontmatter 各钉一个模型，解析优先级是：

**单次调用的 `model` 参数 > agent frontmatter > `CLAUDE_CODE_SUBAGENT_MODEL` > 主对话模型**

所以协议里**明令禁止在 Agent 调用里传 `model`**——它优先级最高，会覆盖角色绑定（等于让被约束者自己挑约束）。改默认搭配只需改这两个文件里的一行。

只有两个模型可用时的推荐分配：审查者 = 强推理模型，修复者 = 便宜快的模型，**两者必须不同**（`npm run check` 会校验这一点）。

### 强制级别（哪些是"强制"、哪些只是"请求"）

| 不变量 | 强制手段 | 级别 |
|---|---|---|
| 审查者只读 | `tools` 白名单（Edit/Write/Bash 根本不在其中） | 结构性 |
| 审查者只读（兜底） | `hooks/hooks.json` 的 PreToolUse 守卫，按 `agent_type` 拦截 | 运行时 |
| 修复者不 commit / push / 改历史 | 同一个守卫脚本，识别破坏性命令并阻断 | 运行时 |
| 编排者不 commit / push | 协议约束 + 报告核对 | **仅提示词**（见下方说明） |
| fresh 独立上下文 | 宿主原语：非 fork 子代理不继承对话历史；协议禁止 `/subtask` 与 fork | 宿主 + 协议 |
| 收敛判定确定性 | 内核（56 项自测覆盖每条规则） | 确定性 |
| 扁平结构（子代理不再派生） | 两个角色的 `disallowedTools` 都移除 `Agent` | 结构性 |

**为什么编排者不受 hook 约束**：守卫按 `agent_type` 识别身份，而编排者就是主会话——与用户本人的操作无法区分。拦它会误伤你日常的 `git commit`。所以守卫的作用域是刻意收窄的：**只拦本插件的子代理**；编排者的"不 commit"靠协议 + 报告里的 `git log` 核对。这是已知的、有意识的边界。

---

## 确定性内核

循环的判定不该由模型"感觉差不多了"决定。内核把状态与判定外置为纯数据：

```bash
# 初始化：对象、基线、预算、验证模式
node "${CLAUDE_PLUGIN_ROOT}/scripts/loop-state.mjs" init .ad-review-loop/feat-x-state.json \
  --target feat/x --baseline a1b2c3d \
  --max-rounds 3 --max-subagents 18 \
  --verify-mode absence --stuck-after 2

# 记录一轮（从 stdin 接管原始发现与派生凭据）
cat <<'JSON' | node "${CLAUDE_PLUGIN_ROOT}/scripts/loop-state.mjs" record .ad-review-loop/feat-x-state.json
{"round":1,
 "receipts":[{"role":"reviewer","agentId":"rev-r1-correctness","provider":"agent-tool","fresh":true,"lens":"correctness","model":"opus"}],
 "findings":[{"lens":"correctness","severity":"P1","location":"src/a.ts:10-20","confidence":92,"triggerPath":"并发写入未加锁","evidence":"src/a.ts:14"}]}
JSON

# 判定（唯一出口；escalate / hard-stop 时退出码为 1）
node "${CLAUDE_PLUGIN_ROOT}/scripts/loop-state.mjs" judge .ad-review-loop/feat-x-state.json

# 摘要
node "${CLAUDE_PLUGIN_ROOT}/scripts/loop-state.mjs" show .ad-review-loop/feat-x-state.json
```

### 两种验证模式（`rules.verifyMode`）

| 模式 | 语义 | 用在哪 |
|---|---|---|
| `explicit`（默认） | 修复结果必须由**独立的验证者**显式确认（`resolve --verify` 缺省即判未修复，刻意的非对称） | 有验证者角色的循环 |
| `absence` | **无验证者**：某条发现"上一轮出现过 + 本轮未被复现 + 本轮覆盖了它的 lens"→ 判为已修复 | 本插件 |

`absence` 模式的三条边界（都由内核确定性执行，且全部留痕）：

- **必须覆盖视角**：本轮若少跑一个视角，该视角的发现**不会被关闭**（避免"没看就等于修好了"），并在该发现的 `note` 里留痕；
- **必须真有审查**：本轮没有任何带 `lens` 的审查者凭据时，缺席判定整体不应用；
- **回归不放过**：被判修复的发现一旦再次出现 → `regressed`，直接触发 R4 升级。

### 判定优先级（全部确定性，无主观空间）

| 顺序 | 判定 | 条件 |
|---|---|---|
| R1 | `hard-stop` | 子代理预算耗尽 |
| R2 | `escalate` | 存在未裁决的争议项（争议绝不静默合并） |
| R3 | `converge` | 本轮无阻塞性发现（全部为 nitpick / 理论风险 / 空） |
| R4 | `escalate` | **回归**：曾判定修复的发现再次出现 |
| R5 | `escalate` | **卡住**：连续 `--stuck-after` 轮未解决（默认 2） |
| R6 | `escalate` | **修复引入同级或更严重的新问题** |
| R7 | `hard-stop` | 达到 `maxRounds` 仍未收敛 |
| R8 | `continue` | 进入下一轮 |

### 记录阶段的丢弃规则（全部留痕于 `state.dropped`，绝不静默丢弃）

| 规则 | 处理 |
|---|---|
| 凭据不完整（缺 role / agentId / `fresh !== true`） | 丢弃，**不计入预算与覆盖** |
| 无位置（不是 `<文件:行>` 格式） | 丢弃 |
| 置信度低于阈值（默认 70） | 丢弃 |
| 轮内位置相近（同文件起始行相差 ≤3） | 合并，保留最高严重度 |
| 跨轮位置相近 | 复用同一 `id`，保留 `firstSeenRound` |
| 曾被判定 `fixed` 又出现 | 标记 `regressed`，`verify` 重置为 `unfixed` |
| 未知严重度 | 保守归一为 `P2`（仍阻塞收敛） |

---

## 跨模型：怎么验证它真的成立

有三处会让跨模型**静默失效**，探测不到就等于没跨：

| 抹平源 | 表现 |
|---|---|
| `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` | 忽略所有 agent 的 `model` 字段，单次传参也无效 |
| 企业 `availableModels` 白名单 | 被挡的模型**静默回退**到 fallback（只在交互界面提示模型名） |
| `fallbackModel` 链 | 过载时子代理换模型继续，会话模型不变 |

对策：派生凭据里必须如实填写 `model`（声明值；能从 `/tasks` 读到实际值就填实际值，不一致要在报告里标注）。`state.rounds[].receipts[].model` 可在 `show` 的 `models` 字段里汇总看到。

---

## 自测与校验

```bash
npm test     # 内核 56 项 + 守卫 26 项
npm run check   # 插件清单 / 路径 / 技能 frontmatter / 角色绑定（含"reviewer 与 fixer 不得同模型"）
```

`plugin-check.mjs` 专门拦**静默失败**：market 条目的 `skills` 路径写错不会报错、而是回退成"扫描全部技能"；skill 文本引用不存在的脚本要到运行时才炸；`plugin.json` 与 market 条目同时写 `version` 会静默以 `plugin.json` 为准。

### 未实测项（诚实清单）

本机没有 `claude` CLI，因此以下几条是按官方文档实现、但**尚未在真实宿主上验证**的：

- `claude plugin validate` 未跑（用 `npm run check` 作替代）；`/plugin install` 全流程未跑；
- **hook 实际传入的字段名**（`agent_type`、`tool_name`、`tool_input`）来自文档，未实测。装好后先验证一次：
  ```bash
  AD_REVIEW_LOOP_GUARD_DEBUG=1 claude    # 守卫会把收到的事件键名打到 stderr
  ```
  再造一次真实拦截（临时给 `reviewer.md` 的 `tools` 加上 `Write`，让它尝试写文件，确认被阻断后把 `Write` 去掉）；
- **仓库根同时作为市场根与插件根**（`source: "./"` 且 `.claude-plugin/` 内同时放 `marketplace.json` 与 `plugin.json`）。官方明确支持 `source: "./"` 这个用法，但这种"根目录合一"的形态未实测；
- `omitClaudeMd: true`（审查者不加载被审仓库的 CLAUDE.md，让 fresh 更彻底）需 Claude Code **v2.1.271+**；旧版本若忽略该字段，审查者会带上项目级倾向。

---

## 已知的宿主级坑

- **并发是拒绝不是排队。** 默认 20 个运行中子代理，超限直接失败并提示不要重试；`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` 可调。默认 5 视角时峰值并发 6，安全。**不要在同一个会话里并行跑两个 loop。**
- **嵌套默认是允许的（3 层）**，不是禁止。本插件靠 `disallowedTools: Agent` 保证扁平。
- **插件子代理会忽略 `hooks`、`mcpServers`、`permissionMode` 三个字段**——只读只能靠 `tools` 白名单 + 插件根 `hooks/hooks.json`。
- **插件级 hook 是会话级、启用即生效**，没有 per-skill 范围；我们的守卫按身份收窄，避免干扰日常编辑。
- **git 市场安装会被复制进版本化缓存**，插件不能引用自身目录之外的文件。本插件的内核就在插件内，安全。
- **状态文件与报告写在被审仓库**（`.ad-review-loop/`），记得加进那个仓库的 `.gitignore`——不要提交。

---

## 其他宿主（未实现，缺口已留好）

CodeBuddy 的插件规范与 Claude Code 兼容（元数据目录优先级 `.codebuddy-plugin/` > `.workbuddy-plugin/` > `.claude-plugin/`，并兼容 `${CLAUDE_PLUGIN_ROOT}`），所以理论上只需补一个 `.codebuddy-plugin/marketplace.json` 就能同时被两个宿主消费。**当前未实现，也未实测。**

本仓库此前是"宿主无关的通用 skill"（含 Codex / DSH 的适配要点），那份协议正文仍可取回：

```bash
git show HEAD:SKILL.md
```

---

## 设计取舍

**为什么每轮都用 fresh 审查者？** 复用上一轮的审查者会带着既定结论，形成确认偏误。fresh 不是妥协，是特性——顺带的好处是**不需要宿主具备"续跑子代理"能力**。

**为什么去掉独立验证者？** 验证的目的是"确认修复真的成立"。下一轮 fresh 审查者面对的是**真实代码**，而验证者面对的是"修复者的说法 + 代码"；前者证据更硬、少一个角色、少一份预算。代价是"漏报"与"已修复"会被合并——所以内核要求视角覆盖完整才允许缺席通过，并把回归检测作为兜底。

**为什么修复者的声明不进状态？** 与审查者的发现一样，它是**待验证主张**。所以它只出现在报告的"声称"列，判定由下一轮独立做出。

**为什么默认 `maxRounds = 3` 硬上限？** 只靠"自然收敛"作为唯一出口，在按 token 计费的宿主上是危险的。硬上限保证最坏情况下也有明确终局。

**确定性内核的边界在哪？** 它覆盖"能不能收敛"，不覆盖"该不该继续"。跨文件架构级改动、业务语义无法从代码判定的问题，仍需人工判断——协议里单列了这三条升级条件。

---

## 许可

MIT
