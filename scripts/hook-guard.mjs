#!/usr/bin/env node
/**
 * 插件级守卫（PreToolUse hook）
 *
 * 为什么需要它：技能文本只能"请求"模型守规矩；hook 才能"强制"。
 * 本脚本把两条不变量从提示词升级为强制：
 *   1. 审查者只读 —— 审查者角色不得调用任何写工具或 Bash；
 *   2. 绝不 commit / push / 改历史 —— 修复者不得执行破坏性命令。
 *
 * 作用域（刻意收窄）：只拦本插件的子代理（按 agent_type 识别）。
 *   编排者是主会话，无法与用户本人的操作区分——拦它会误伤日常编辑，
 *   因此对编排者仍是提示词约束 + 报告核对（见 SKILL.md 的反模式清单）。
 *
 * 失败取向：识别不出身份就放行。审查者另有 tools 白名单兜底，
 *   而"拦错"会直接打断用户干活，代价更高。
 *
 * 契约：stdin = hook 事件 JSON；exit 0 = 放行；exit 2 = 阻断（stderr 回给模型）。
 * 自测：node scripts/selftest-hook.mjs
 *
 * 环境变量 AD_REVIEW_LOOP_GUARD_DEBUG=1 时把收到的事件打到 stderr（不阻断），
 *   用于核实宿主实际传的字段名（agent_type 是否如文档所述）。
 */

import { readFileSync } from 'node:fs'

const REVIEWER = /(^|:)reviewer$/i
const FIXER = /(^|:)fixer$/i

const WRITE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit', 'NotebookWrite'])

/** 破坏性 / 不可逆命令：修复者也不该跑。 */
const DESTRUCTIVE = [
  [/\bgit\s+(?:commit|push|reset|rebase|cherry-pick|revert|clean|stash|tag|switch|checkout)\b/, 'git 写操作（提交/推送/改历史/丢弃改动）'],
  [/\bgit\s+branch\s+-[dD]\b/, 'git 删除分支'],
  [/\brm\s+(?:-[a-zA-Z]*[rf][a-zA-Z]*\s+)+/, '递归/强制删除'],
  [/\bnpm\s+(?:publish|unpublish)\b/, 'npm 发布'],
  [/\b(?:truncate|shred|mkfs)\b/, '破坏性系统命令'],
  [/\bdd\s+if=/, 'dd 直写设备'],
  [/\bchmod\s+(?:-R\s+)?777\b/, '危险权限'],
  [/\|\s*(?:sudo\s+)?(?:ba|z|k)?sh\b/, '管道执行远端脚本'],
  [/>\s*\/dev\/(?:sd|disk)/, '写裸设备'],
]

const deny = (reason) => {
  process.stderr.write(`[ad-review-loop] 已阻断：${reason}\n`)
  process.exit(2)
}

function main() {
  let raw = ''
  try {
    raw = readFileSync(0, 'utf8')
  } catch {
    return
  }
  if (!raw.trim()) return

  let ev = {}
  try {
    ev = JSON.parse(raw)
  } catch {
    return // 解析不了就不拦
  }
  if (!ev || typeof ev !== 'object') return

  if (process.env.AD_REVIEW_LOOP_GUARD_DEBUG === '1') {
    process.stderr.write(`[ad-review-loop] guard event keys=${Object.keys(ev).join(',')} agent_type=${ev.agent_type ?? ev.agentType ?? '(none)'}\n`)
  }

  const agentType = String(ev.agent_type ?? ev.agentType ?? '')
  const toolName = String(ev.tool_name ?? ev.toolName ?? '')
  const input = ev.tool_input ?? ev.toolInput ?? {}
  const cmd = typeof input?.command === 'string' ? input.command : ''

  if (REVIEWER.test(agentType)) {
    if (WRITE_TOOLS.has(toolName) || toolName === 'Bash') {
      deny(`审查者是只读角色（agent_type=${agentType}），不允许调用 ${toolName}。请只输出发现，不要改代码。`)
    }
  }

  if (FIXER.test(agentType) && toolName === 'Bash') {
    for (const [re, label] of DESTRUCTIVE) {
      if (re.test(cmd)) {
        deny(`修复者不得执行${label}：${cmd.slice(0, 120)}。修复只改工作区，不 commit / 不 push / 不改历史。`)
      }
    }
  }
}

main()
