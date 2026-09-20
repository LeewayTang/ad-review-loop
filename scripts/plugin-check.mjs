#!/usr/bin/env node
/**
 * 插件清单校验器（零依赖）。
 *
 * 为什么自带：本机没装 claude CLI，跑不了官方的 `claude plugin validate`。
 * 它专门拦"静默失败"类问题——插件生态里路径写错通常不报错：
 *   · market 条目的 skills 路径写错 → 不报错，回退成扫描全部技能；
 *   · skill 文本引用了不存在的脚本 → 不报错，运行到那一步才炸；
 *   · plugin.json 与 market 条目同时写 version → plugin.json 静默胜出，市场里改的版本被忽略。
 *
 * 运行：node scripts/plugin-check.mjs   （npm run check）
 * 退出码：有 error 即 1；只有 warning 仍为 0。
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MANIFEST_DIR = join(ROOT, '.claude-plugin')
const SKIP_DIRS = new Set(['.git', 'node_modules', '.ad-review-loop'])

const errors = []
const warnings = []
const ok = (m) => console.log(`ok    ${m}`)
const err = (m) => {
  errors.push(m)
  console.log(`FAIL  ${m}`)
}
const warn = (m) => {
  warnings.push(m)
  console.log(`warn  ${m}`)
}
const rel = (p) => relative(ROOT, p) || '.'

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'))

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.') && name !== '.claude-plugin') continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) {
      if (!SKIP_DIRS.has(name)) walk(p, out)
    } else {
      out.push(p)
    }
  }
  return out
}

/** 极简 frontmatter 解析（YAML 子集，够用且零依赖）。 */
function frontmatter(file) {
  const text = readFileSync(file, 'utf8')
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (!m) return null
  const out = {}
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line)
    if (kv) out[kv[1]] = kv[2].trim()
  }
  return out
}

// ---------------------------------------------------------------- 清单存在性

const pluginPath = join(MANIFEST_DIR, 'plugin.json')
const marketPath = join(MANIFEST_DIR, 'marketplace.json')

if (!existsSync(pluginPath)) err('缺少 .claude-plugin/plugin.json')
if (!existsSync(marketPath)) err('缺少 .claude-plugin/marketplace.json（git 安装的入口）')
if (errors.length) {
  console.log(`\n${errors.length} 个错误`)
  process.exit(1)
}

let plugin
let market
try {
  plugin = readJson(pluginPath)
  ok('plugin.json 可解析')
} catch (e) {
  err(`plugin.json 解析失败：${e.message}`)
}
try {
  market = readJson(marketPath)
  ok('marketplace.json 可解析')
} catch (e) {
  err(`marketplace.json 解析失败：${e.message}`)
}
if (!plugin || !market) {
  console.log(`\n${errors.length} 个错误`)
  process.exit(1)
}

// ---------------------------------------------------------------- plugin.json

if (!/^[a-z0-9-]+$/.test(plugin.name ?? '')) err(`plugin.json 的 name 必须是 kebab-case：${plugin.name}`)
else ok(`plugin.json name=${plugin.name}`)
if (!plugin.description) warn('plugin.json 缺 description（插件管理器里会显示为空）')
if (plugin.version) {
  warn(`plugin.json 声明了 version=${plugin.version}：此后每次发版都必须手工 bump，否则用户看不到变更。`)
}
if (plugin.hooks) warn('plugin.json 声明了 hooks：默认位置 hooks/hooks.json 已足够，重复声明容易漂移')

// ---------------------------------------------------------------- marketplace.json

const RESERVED = new Set([
  'claude-code-marketplace', 'claude-code-plugins', 'claude-plugins-official', 'claude-plugins-community',
  'claude-community', 'anthropic-marketplace', 'anthropic-plugins', 'agent-skills', 'anthropic-agent-skills',
  'knowledge-work-plugins', 'life-sciences', 'claude-for-legal', 'claude-for-financial-services',
  'financial-services-plugins', 'first-party-plugins', 'claude-tag-plugins', 'healthcare',
  'npm', 'pip', 'uv', 'cargo', 'github', 'gh',
])

if (!/^[a-z0-9-]+$/.test(market.name ?? '')) err(`marketplace.json 的 name 必须是 kebab-case：${market.name}`)
else if (RESERVED.has(String(market.name).toLowerCase())) err(`市场名 ${market.name} 是保留名，第三方不可用`)
else ok(`marketplace.json name=${market.name}`)
if (!market.owner?.name) err('marketplace.json 缺 owner.name（必填）')
else ok(`marketplace owner=${market.owner.name}`)
if (!Array.isArray(market.plugins) || !market.plugins.length) err('marketplace.json 的 plugins 必须是非空数组')

const entries = Array.isArray(market.plugins) ? market.plugins : []
for (const entry of entries) {
  const tag = `[${entry?.name ?? '?'}]`
  if (!entry?.name) err(`插件条目缺 name`)
  if (!entry?.source) err(`${tag} 缺 source`)
  if (!entry?.description) warn(`${tag} 缺 description`)

  // source：相对路径的基准是「市场根目录」（含 .claude-plugin/ 的那层），不是 .claude-plugin/ 本身
  if (typeof entry?.source === 'string') {
    if (!entry.source.startsWith('./')) err(`${tag} 相对路径 source 必须以 ./ 开头：${entry.source}`)
    const srcDir = resolve(ROOT, entry.source)
    if (!srcDir.startsWith(ROOT)) err(`${tag} source 越出市场仓库：${entry.source}`)
    else if (!existsSync(srcDir)) err(`${tag} source 指向不存在的目录：${entry.source}`)
    else ok(`${tag} source=${entry.source} → ${rel(srcDir) || '.'}`)
  }

  // 组件路径：写错会被静默回退成"扫描全部"，必须拦
  for (const field of ['skills', 'commands', 'agents']) {
    const list = entry?.[field]
    if (!list) continue
    if (!Array.isArray(list)) {
      err(`${tag} 的 ${field} 必须是数组`)
      continue
    }
    for (const p of list) {
      const target = resolve(ROOT, p)
      if (!existsSync(target)) err(`${tag} 的 ${field} 指向不存在的路径：${p}（宿主会静默回退到全量扫描）`)
      else ok(`${tag} ${field}=${p}`)
    }
  }

  // version 双写：plugin.json 静默胜出
  if (entry?.version && plugin.version) {
    err(`${tag} 同时在 plugin.json 与 market 条目声明了 version —— plugin.json 会静默胜出，市场里的版本被忽略`)
  }
}

// ---------------------------------------------------------------- 技能

const skillsDir = join(ROOT, 'skills')
const skillDirs = existsSync(skillsDir) ? readdirSync(skillsDir).filter((d) => statSync(join(skillsDir, d)).isDirectory()) : []
if (!skillDirs.length) err('skills/ 下没有技能目录')
for (const d of skillDirs) {
  const skillFile = join(skillsDir, d, 'SKILL.md')
  if (!existsSync(skillFile)) {
    err(`skills/${d}/ 缺 SKILL.md`)
    continue
  }
  const fm = frontmatter(skillFile)
  if (!fm) err(`skills/${d}/SKILL.md 缺 frontmatter`)
  else {
    if (fm.name !== d) err(`skills/${d}/SKILL.md 的 name=${fm.name} 与目录名不一致（宿主按目录名发现技能）`)
    if (!fm.description) err(`skills/${d}/SKILL.md 缺 description（模型靠它决定是否触发）`)
    if (fm.description && fm.description.length < 40) warn(`skills/${d}/SKILL.md 的 description 偏短，触发可靠性会下降`)
    if (fm.name === d && fm.description) ok(`技能 ${d} frontmatter 完整`)
  }
}

// ---------------------------------------------------------------- 子代理角色绑定

const agentsDir = join(ROOT, 'agents')
const agentFiles = existsSync(agentsDir) ? readdirSync(agentsDir).filter((f) => f.endsWith('.md')) : []
if (!agentFiles.length) err('agents/ 下没有角色定义（本插件依赖 reviewer / fixer 两个角色）')
const roles = {}
for (const f of agentFiles) {
  const fm = frontmatter(join(agentsDir, f))
  const tag = `agents/${f}`
  if (!fm) {
    err(`${tag} 缺 frontmatter`)
    continue
  }
  if (!fm.name) err(`${tag} 缺 name`)
  if (fm.name?.includes(':')) err(`${tag} 的 name 不能含 ':'（保留给插件作用域前缀）`)
  if (!fm.description) err(`${tag} 缺 description`)
  if (!fm.model) err(`${tag} 缺 model（跨模型绑定靠它）`)
  else ok(`${tag} model=${fm.model}`)
  roles[fm.name ?? f.replace(/\.md$/, '')] = fm
}

const listOf = (v) => String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean)

const reviewer = roles.reviewer
if (!reviewer) err('缺少 roles.reviewer（agents/reviewer.md）')
else {
  const tools = listOf(reviewer.tools)
  const leaked = tools.filter((t) => ['Edit', 'Write', 'NotebookEdit', 'Bash'].includes(t))
  if (leaked.length) err(`reviewer 的 tools 含写/执行工具（${leaked.join(', ')}）——只读白名单破了`)
  else ok(`reviewer 工具白名单只读：[${tools.join(', ')}]`)
  const disallowed = listOf(reviewer.disallowedTools)
  if (!disallowed.includes('Agent')) warn('reviewer 未在 disallowedTools 里移除 Agent —— 子代理可能再派生子代理，破坏扁平结构')
}

const fixer = roles.fixer
if (!fixer) err('缺少 roles.fixer（agents/fixer.md）')
else {
  const tools = listOf(fixer.tools)
  if (!tools.includes('Edit') && !tools.includes('Write')) err('fixer 的 tools 里没有 Edit/Write —— 它无法修复')
  const disallowed = listOf(fixer.disallowedTools)
  if (!disallowed.includes('Agent')) warn('fixer 未在 disallowedTools 里移除 Agent —— 子代理可能再派生子代理，破坏扁平结构')
}

if (reviewer?.model && fixer?.model && reviewer.model === fixer.model) {
  err(`reviewer 与 fixer 绑定了同一个模型（${reviewer.model}）—— 跨模型对抗不成立`)
}

// ---------------------------------------------------------------- hooks

const hooksPath = join(ROOT, 'hooks', 'hooks.json')
if (!existsSync(hooksPath)) err('缺 hooks/hooks.json（只读与禁 commit 的强制层）')
else {
  try {
    const hooks = readJson(hooksPath)
    const pre = hooks?.hooks?.PreToolUse
    if (!Array.isArray(pre) || !pre.length) err('hooks.json 里没有 PreToolUse 钩子')
    else {
      ok(`hooks.json 可解析，PreToolUse ${pre.length} 条`)
      for (const [i, group] of pre.entries()) {
        if (!group.matcher) warn(`PreToolUse[${i}] 缺 matcher —— 会在所有工具调用上触发`)
        for (const h of group.hooks ?? []) {
          if (h.type !== 'command') warn(`PreToolUse[${i}] 用了非 command 型钩子（${h.type}）`)
          if (!h.command) err(`PreToolUse[${i}] 的钩子缺 command`)
        }
      }
    }
  } catch (e) {
    err(`hooks.json 解析失败：${e.message}`)
  }
}

// ---------------------------------------------------------------- 插件内引用与脚本语法

let refChecked = 0
let refMissing = 0
for (const f of walk(ROOT).filter((p) => /\.(md|json)$/.test(p))) {
  const text = readFileSync(f, 'utf8')
  // 排除转义反斜杠与省略号：JSON 里的 \" 结尾、文档正文里的 … 都不是真实路径
  for (const m of text.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^\s"'`\\…)]+)/g)) {
    const p = m[1].replace(/[.,。：:;；]+$/, '')
    if (!p) continue
    refChecked += 1
    if (!existsSync(join(ROOT, p))) {
      refMissing += 1
      err(`${rel(f)} 引用了不存在的插件内路径：${p}`)
    }
  }
}
if (!refMissing) ok(`插件内 \${CLAUDE_PLUGIN_ROOT}/… 引用全部存在（${refChecked} 处）`)

for (const f of walk(ROOT).filter((p) => p.endsWith('.mjs'))) {
  const r = spawnSync('node', ['--check', f], { encoding: 'utf8' })
  if (r.status !== 0) err(`${rel(f)} 语法检查失败：${(r.stderr || '').split('\n')[0]}`)
}
ok('全部 .mjs 语法检查通过')

// ---------------------------------------------------------------- 汇总

console.log(`\n${errors.length} 个错误，${warnings.length} 个警告`)
process.exitCode = errors.length ? 1 : 0
