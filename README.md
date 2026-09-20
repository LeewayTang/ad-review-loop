# ad-review-loop

**宿主无关的对抗式审查循环** —— 一个纯文本的 Agent Skill，加上一个零依赖的确定性内核。

让编码 agent 对代码变更执行迭代式对抗审查：每轮由**独立上下文**的子代理审查、修复、验证，直到收敛或触发硬停止。

```
审查（fresh 只读 × N 视角）
  → 记录（内核：归一化 / 去重 / 跨轮匹配 / 回归检测）
  → 判定（内核：收敛 / 继续 / 升级 / 硬停止）
  → 修复（fresh 可写，最小改动）
  → 验证（fresh 只读，含糊即判未修复）
  → 下一轮
```

---

## 为什么需要它

多数"对抗式审查"的 skill 都把「独立上下文」当成宿主的默认属性。实际上它不是——而且有两个具体的坑：

1. **继承式派生会静默破坏独立性。** Claude Code 的 `/subtask`（继承父会话上下文）、`/fork`（复制整段对话）、DSH 的 `fork` provider（用父日志做种子）——它们看起来都像"派个子代理"，但会让审查者继承主 agent 的倾向。名字还和正确的路径撞车（都叫 fork）。
2. **循环的收敛判定依赖记忆就会失效。** 循环要跑多轮、每轮报告都吃 token，编排者上下文随时可能被压缩。一旦压缩，"这个问题上轮修过吗"就变成猜测，收敛判定静默失效。

本仓库对这两点分别给出对策：**能力契约 + 派生凭据**（可审计），以及**状态外置的确定性内核**（可复现）。

---

## 结构

```
ad-review-loop/
├── SKILL.md                  # 协议本体（宿主无关）
└── scripts/
    ├── loop-state.mjs        # 确定性内核：状态机 + 收敛判定 + CLI
    └── selftest.mjs          # 内核自测（38 项）
```

要求：**Node ≥ 18**（无第三方依赖，纯标准库）。

---

## 确定性内核

循环的判定不该由模型"感觉差不多了"决定。内核把状态与判定外置为纯数据：

```bash
# 初始化：对象、基线、预算
node scripts/loop-state.mjs init .ad-review-loop/feat-x-state.json \
  --target feat/x --baseline a1b2c3d --max-rounds 3 --max-subagents 15

# 记录一轮（从 stdin 接管原始发现；归一化、去重、跨轮 id 复用、回归检测全在内核里）
echo '{"round":1,"receipts":[...],"findings":[...]}' \
  | node scripts/loop-state.mjs record .ad-review-loop/feat-x-state.json

# 判定（唯一出口；escalate / hard-stop 时退出码为 1）
node scripts/loop-state.mjs judge .ad-review-loop/feat-x-state.json

# 结算单条（--verify 缺省时不会自动通过，刻意的非对称）
node scripts/loop-state.mjs resolve .ad-review-loop/feat-x-state.json \
  --id F1 --fix fixed --verify fixed --note "已在 src/a.ts:14 加锁"

# 摘要
node scripts/loop-state.mjs show .ad-review-loop/feat-x-state.json
```

### 判定优先级（全部确定性，无主观空间）

| 顺序 | 判定 | 条件 |
|---|---|---|
| R1 | `hard-stop` | 子代理预算耗尽 |
| R2 | `escalate` | 存在未裁决的争议项（争议绝不静默合并） |
| R3 | `converge` | 本轮无阻塞性发现（全部为 nitpick / 理论风险 / 空） |
| R4 | `escalate` | **回归**：曾判定修复的发现再次出现 |
| R5 | `escalate` | **卡住**：连续 2 轮未解决 |
| R6 | `escalate` | **修复引入同级或更严重的新问题** |
| R7 | `hard-stop` | 达到 `maxRounds` 仍未收敛 |
| R8 | `continue` | 进入下一轮 |

### 记录阶段的丢弃规则（全部留痕于 `state.dropped`，绝不静默丢弃）

| 规则 | 处理 |
|---|---|
| 无位置（不是 `<文件:行>` 格式） | 丢弃 |
| 置信度低于阈值（默认 70） | 丢弃 |
| 轮内位置相近（同文件起始行相差 ≤3） | 合并，保留最高严重度 |
| 跨轮位置相近 | 复用同一 `id`，保留 `firstSeenRound` |
| 曾被判定 `fixed` 又出现 | 标记 `regressed`，`verify` 重置为 `unfixed` |
| 未知严重度 | 保守归一为 `P2`（仍阻塞收敛） |

跑自测：

```bash
node scripts/selftest.mjs   # 38 通过，0 失败
```

---

## 安装

skill 目录即本仓库根目录，直接 clone 即可：

```bash
# CodeBuddy
git clone <repo-url> ~/.codebuddy/skills/ad-review-loop

# Claude Code
git clone <repo-url> ~/.claude/skills/ad-review-loop

# Codex
git clone <repo-url> ~/.codex/skills/ad-review-loop

# DSH
git clone <repo-url> ~/.dsh/skills/ad-review-loop
```

`scripts/` 会被随仓库一起带来。若宿主无法运行 Node，skill 内含**降级路径**（手工维护状态文件并显式声明判定未经确定性复核）。

---

## 宿主适配

| 宿主 | 派生 fresh 子代理 | 只读强制 | 每角色模型 |
|---|---|---|---|
| **Claude Code** | `Agent` 工具。**禁用 `/subtask`、`/fork`** | agent frontmatter `tools` 白名单 + `PreToolUse` hook | `Agent` 工具 `model` 参数 / frontmatter `model` |
| **Codex** | 必须**显式下令**（"spawn N agents"）——Codex 不会自动拆 | agent TOML `sandbox_mode = "read-only"` | agent TOML `model` + `model_reasoning_effort` |
| **DSH** | `subagent` 工具，`provider: 'spawn'`。**禁用 `fork` provider** | 审查者 `toolFilter: { deny: [...] }` | `agentOptions.model`（需回读 `request/header` 自检） |

### 已知的宿主级坑

- **运行时权限会盖过静态配置。** Codex 中会话里临时改的 `/permissions`、`--yolo` 会重新套用到派生子代理，覆盖 agent TOML 的 `sandbox_mode`。
- **DSH 委托子代理的审批策略固定 `never`。** 修复者拿到写权限就是无审批写入——修复者的 `toolFilter` 必须 deny 破坏性命令，且只允许改 diff 相关文件。
- **并发是拒绝不是排队。** DSH 每 owner 默认 10 并发，满容量直接失败；Claude Code 每 Session ≤200 子代理、默认并发 20。默认 5 视角时本 skill 峰值并发为 7。
- **嵌套默认禁止。** 本 skill 是扁平的：编排者派生，子代理不再派生。
- **不要在同一个 owner 上并行跑两个 loop。**

---

## 设计取舍

**为什么每轮都用 fresh 审查者？** 复用上一轮的审查者会带着既定结论，形成确认偏误。fresh 不是妥协，是特性——顺带的好处是**本 skill 不需要宿主具备"续跑子代理"能力**，因此比两轮辩论式的审查设计更通用（辩论需要原评审者活着反驳，目前只有 DSH 原生支持）。

**为什么修复者的完成声明不可信？** 与审查者的发现一样，它是**待验证主张**。所以每条修复都要独立验证，且含糊一律判 `unfixed`（刻意的非对称）。

**为什么默认 `maxRounds = 3` 硬上限？** 只靠"自然收敛"作为唯一出口，在按 token 计费的宿主上是危险的。硬上限保证最坏情况下也有明确终局。

**确定性内核的边界在哪？** 它覆盖"能不能收敛"，不覆盖"该不该继续"。跨文件架构级改动、业务语义无法从代码判定的问题，仍需人工判断——skill 里单列了这三条升级条件。

---

## 许可

MIT
