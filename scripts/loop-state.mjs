#!/usr/bin/env node
/**
 * ad-review-loop 确定性内核
 *
 * 为什么需要它：对抗式审查循环会跑多轮，而编排者自己的上下文随时可能被压缩或截断。
 * 一旦压缩，「这个问题上轮修过吗」就变成猜测，收敛判定随之静默失效。
 * 本脚本把「状态 + 判定」外置为纯数据，使收敛判定可复现、可审计、与宿主无关。
 *
 * 纯 Node 标准库，零依赖。Node >= 18。
 *
 * 命令：
 *   init    <state>  --target <id> [--baseline <sha>] [--max-rounds 3] [--max-subagents 15]
 *                    [--verify-mode explicit|absence] [--stuck-after 2]
 *   record  <state>  --round <n>          # 从 stdin 读 {"receipts":[],"findings":[]}
 *   resolve <state>  --id <F1> [--fix fixed|unfixed|false-positive] [--verify fixed|unfixed|disputed] [--note "..."]
 *   judge   <state>  [--json]
 *   show    <state>
 *
 * 验证模式（rules.verifyMode）：
 *   explicit —— 默认。修复结果必须由独立的验证者显式确认（--verify 缺省即判未修复）。
 *   absence  —— 无独立验证者的闭环（审查 → 修复 → 复审…）。缺席即通过：某条发现若"上一轮出现过"
 *               且"本轮未被复现"，且本轮审查者凭据覆盖了该发现的 lens，则判定为已修复。
 *               日后再次出现 → 内核按回归处理（R4 升级）。视角未覆盖时判定不应用，并留痕于该发现的 note。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// ---------------------------------------------------------------- 常量与工具

/** 严重度序数：越大越严重。未知严重度一律按阻塞处理（保守）。 */
export const SEV_RANK = { P0: 3, P1: 2, P2: 1, nitpick: 0, theoretical: 0 }

/** 达到该序数即视为「阻塞性发现」，参与收敛判定。 */
export const BLOCKING_MIN = 1

export const SEV_NAME = ['(空)', 'P2', 'P1', 'P0']

const rank = (sev) => (sev in SEV_RANK ? SEV_RANK[sev] : BLOCKING_MIN)
const sevName = (r) => SEV_NAME[r] ?? `rank${r}`

/** 合法的子代理角色。凭据上的 role 必须落在其中，否则视为无效凭据。 */
export const VALID_ROLES = ['reviewer', 'fixer', 'verifier']

/** 验证模式：见文件头注释。 */
export const VERIFY_MODES = ['explicit', 'absence']

/**
 * 凭据校验：role / agentId / fresh 三者齐备才算一条可核验凭据。
 * 无凭据或凭据不完整者视为未执行——不计入覆盖，也不计入预算。
 */
export function validReceipt(r) {
  return Boolean(
    r && typeof r === 'object'
      && typeof r.role === 'string' && VALID_ROLES.includes(r.role)
      && typeof r.agentId === 'string' && r.agentId.trim()
      && r.fresh === true,
  )
}

const appendNote = (f, text) => {
  f.note = f.note ? `${f.note} | ${text}` : text
}

/** 解析 `<文件路径>:<起始行>[-<结束行>]`。用贪婪匹配取最后一个冒号，兼容 Windows 路径。 */
export function parseLocation(loc) {
  const m = /^(.+):(\d+)(?:\s*-\s*(\d+))?$/.exec(String(loc ?? '').trim())
  if (!m) return null
  const start = Number(m[2])
  const end = m[3] ? Number(m[3]) : start
  return { file: m[1].trim(), start, end: Math.max(start, end), raw: String(loc).trim() }
}

/** 同一文件且起始行相差 ≤ tol 视为同一问题。 */
export function sameIssue(a, b, tol = 3) {
  if (!a || !b) return false
  return a.file === b.file && Math.abs(a.start - b.start) <= tol
}

// ---------------------------------------------------------------- 状态构造

export function createState({
  target,
  baseline = '',
  maxRounds = 3,
  maxSubagents = 15,
  minConfidence = 70,
  dedupeLines = 3,
  verifyMode = 'explicit',
  stuckAfterRounds = 2,
} = {}) {
  if (!target) throw new Error('init 需要 --target')
  if (!VERIFY_MODES.includes(verifyMode)) {
    throw new Error(`未知 verifyMode：${verifyMode}（可选 ${VERIFY_MODES.join(' / ')}）`)
  }
  if (!Number.isInteger(stuckAfterRounds) || stuckAfterRounds < 2) {
    throw new Error(`stuckAfterRounds 需为 ≥2 的整数，收到 ${stuckAfterRounds}`)
  }
  return {
    version: 1,
    target,
    baseline,
    createdAt: new Date().toISOString(),
    budget: { maxRounds, maxSubagents, subagentsUsed: 0 },
    rules: { minConfidence, dedupeLines, verifyMode, stuckAfterRounds },
    seq: 0,
    findings: {},
    rounds: [],
    dropped: [],
  }
}

// ---------------------------------------------------------------- 记录一轮

/**
 * 记录一轮审查结果。做三件事：
 *   1. 轮内归一化 + 去重（位置相近合并，保留最高严重度）
 *   2. 丢弃不合格发现（无位置 / 置信度低于阈值）并留痕，绝不静默丢弃
 *   3. 跨轮匹配：复用 id；曾被判 fixed 又出现则标记 regressed（回归）
 */
export function recordRound(state, payload) {
  const round = Number(payload?.round)
  if (!Number.isInteger(round) || round < 1) throw new Error('record 需要 --round <正整数>')
  if (state.rounds.some((r) => r.round === round)) throw new Error(`第 ${round} 轮已记录，不可重复写入`)

  const tol = state.rules.dedupeLines
  const minConf = state.rules.minConfidence
  const notes = []

  // 0) 凭据校验：无凭据不计入覆盖，也不计入预算（绝不静默）
  const rawReceipts = Array.isArray(payload.receipts) ? payload.receipts : []
  const receipts = []
  for (const r of rawReceipts) {
    if (validReceipt(r)) receipts.push(r)
    else state.dropped.push({ round, reason: 'invalid-receipt', detail: r ?? null })
  }
  const invalidReceipts = rawReceipts.length - receipts.length
  if (invalidReceipts) {
    notes.push(`丢弃 ${invalidReceipts} 份无效凭据（需 role ∈ ${VALID_ROLES.join('/')} + agentId + fresh=true），未计入预算与覆盖`)
  }

  // 1) 归一 + 轮内去重
  const norm = []
  for (const raw of Array.isArray(payload.findings) ? payload.findings : []) {
    const loc = parseLocation(raw?.location)
    if (!loc) {
      state.dropped.push({ round, reason: 'no-location', detail: raw?.location ?? null, severity: raw?.severity ?? null })
      continue
    }
    if (typeof raw.confidence === 'number' && raw.confidence < minConf) {
      state.dropped.push({ round, reason: 'low-confidence', detail: raw.confidence, location: loc.raw })
      continue
    }
    const severity = raw.severity in SEV_RANK ? raw.severity : 'P2'
    const dup = norm.find((x) => sameIssue(x.loc, loc, tol))
    if (dup) {
      if (rank(severity) > rank(dup.severity)) dup.severity = severity
      dup.confidence = Math.max(dup.confidence ?? 0, raw.confidence ?? 0)
      state.dropped.push({ round, reason: 'in-round-duplicate', detail: loc.raw, mergedInto: dup.loc.raw })
      continue
    }
    norm.push({
      lens: raw.lens ?? 'unspecified',
      severity,
      loc,
      location: loc.raw,
      triggerPath: raw.triggerPath ?? '',
      evidence: raw.evidence ?? '',
      confidence: raw.confidence ?? null,
    })
  }

  // 2) 跨轮匹配
  const pool = Object.values(state.findings).sort((a, b) => b.lastSeenRound - a.lastSeenRound)
  const findingIds = []
  for (const item of norm) {
    const match = pool.find((f) => sameIssue(f.loc, item.loc, tol))
    if (match) {
      match.severity = item.severity
      match.lens = item.lens
      match.triggerPath = item.triggerPath || match.triggerPath
      match.evidence = item.evidence || match.evidence
      match.confidence = item.confidence ?? match.confidence
      match.lastSeenRound = round
      match.seenRounds = [...new Set([...match.seenRounds, round])]
      if (match.verify === 'fixed' || match.fix === 'fixed') {
        // 曾被判定修复，现在又出现了 → 回归。这是硬升级信号。
        match.regressed = true
        match.fix = 'unfixed'
        match.verify = 'unfixed'
        match.note = `回归：第 ${match.firstSeenRound} 轮发现并曾判定修复，第 ${round} 轮再次出现。${match.note ? ' ' + match.note : ''}`
      } else {
        match.verify = 'unfixed'
        match.fix = 'unfixed'
      }
      findingIds.push(match.id)
    } else {
      const id = `F${(state.seq += 1)}`
      state.findings[id] = {
        id,
        lens: item.lens,
        severity: item.severity,
        loc: item.loc,
        location: item.location,
        triggerPath: item.triggerPath,
        evidence: item.evidence,
        confidence: item.confidence,
        firstSeenRound: round,
        lastSeenRound: round,
        seenRounds: [round],
        fix: 'pending',
        verify: 'pending',
        regressed: false,
        note: '',
      }
      findingIds.push(id)
    }
  }

  // 3) 缺席即通过（仅 verifyMode='absence'；且必须有上一轮可比对）
  const prev = state.rounds[state.rounds.length - 1]
  if (state.rules.verifyMode === 'absence' && prev) {
    const covered = new Set(
      receipts
        .filter((r) => r.role === 'reviewer' && typeof r.lens === 'string' && r.lens.trim())
        .map((r) => r.lens),
    )
    const reported = new Set(findingIds)
    const closed = []
    const skipped = []
    for (const f of Object.values(state.findings)) {
      if (reported.has(f.id)) continue            // 本轮又被报出 → 未修复，走跨轮匹配分支
      if (f.lastSeenRound !== prev.round) continue // 只处理"上一轮还出现过"的发现
      if (f.verify === 'fixed') continue
      if (!covered.size) {
        skipped.push(`${f.id}(本轮无带 lens 的审查者凭据)`)
        continue
      }
      if (!covered.has(f.lens)) {
        // 视角未覆盖 → 缺席不构成证据。留痕并保持未修复（后续会触发 R5 升级，不静默）。
        skipped.push(`${f.id}(本轮未覆盖 lens=${f.lens})`)
        appendNote(f, `第 ${round} 轮未覆盖 lens=${f.lens}，缺席判定未应用`)
        continue
      }
      f.fix = 'fixed'
      f.verify = 'fixed'
      f.closedBy = { round, rule: 'absence' }
      appendNote(f, `第 ${round} 轮未被复现（缺席判定）；若后续轮次再次出现则记为回归`)
      closed.push(f.id)
    }
    if (closed.length) {
      notes.push(`缺席判定：${closed.join(', ')} 在本轮未被复现，判定为已修复`)
    }
    if (skipped.length) notes.push(`缺席判定未应用：${skipped.join(', ')}`)
  }

  state.rounds.push({
    round,
    findingIds,
    receipts,
    notes,
    recordedAt: new Date().toISOString(),
  })
  state.budget.subagentsUsed += receipts.length
  return state
}

// ---------------------------------------------------------------- 结算单条

export function resolveFinding(state, { id, fix, verify, note } = {}) {
  const f = state.findings[id]
  if (!f) throw new Error(`找不到发现 ${id}`)
  if (fix) f.fix = fix
  if (verify) f.verify = verify
  if (note) f.note = f.note ? `${f.note} | ${note}` : note
  // 刻意的不对称：含糊一律判未修复，因此 verify 缺省时保持 unfixed 而非通过
  if (!verify && f.fix === 'fixed') f.verify = 'unfixed'
  return f
}

// ---------------------------------------------------------------- 收敛判定

/**
 * 唯一的出口判定。规则严格按优先级排序，全部确定性、无主观空间。
 * 返回 { decision, round, reason, ids? }
 *   converge   — 本轮无阻塞性发现，可收工
 *   escalate   — 升级人工（争议 / 回归 / 卡住 / 修复引入新严重问题）
 *   hard-stop  — 硬停止（预算耗尽 / 达到 maxRounds 仍未收敛）
 *   continue   — 进入下一轮
 */
export function judge(state) {
  const rounds = state.rounds
  if (!rounds.length) {
    return { decision: 'continue', round: 0, reason: '尚未记录任何审查轮次；先执行第 1 轮审查。' }
  }

  const cur = rounds[rounds.length - 1]
  const curRound = cur.round
  const F = state.findings

  // R1 预算（先于一切：没钱了就不要再看别的）
  if (state.budget.subagentsUsed >= state.budget.maxSubagents) {
    return {
      decision: 'hard-stop',
      round: curRound,
      reason: `子代理预算耗尽（${state.budget.subagentsUsed}/${state.budget.maxSubagents}）。`,
    }
  }

  // R2 争议项绝不静默合并
  const disputed = Object.values(F).filter((f) => f.verify === 'disputed')
  if (disputed.length) {
    return {
      decision: 'escalate',
      round: curRound,
      ids: disputed.map((f) => f.id),
      reason: `存在 ${disputed.length} 条未裁决的争议项：${disputed.map((f) => f.id).join(', ')}。争议绝不静默合并。`,
    }
  }

  const active = cur.findingIds.filter((id) => rank(F[id].severity) >= BLOCKING_MIN)

  // R3 收敛
  if (active.length === 0) {
    return {
      decision: 'converge',
      round: curRound,
      reason: `第 ${curRound} 轮无阻塞性发现（本轮 ${cur.findingIds.length} 条，全部为 nitpick / 理论风险）。`,
    }
  }

  // R4 回归：曾判定修复又出现
  const regressed = active.filter((id) => F[id].regressed)
  if (regressed.length) {
    return {
      decision: 'escalate',
      round: curRound,
      ids: regressed,
      reason: `检测到回归：${regressed.map((id) => `${id}(${F[id].location})`).join(', ')} 曾被判定修复但再次出现，说明修复无效或引入了反复。`,
    }
  }

  // R5 卡住：同一发现跨轮仍未解决，达到 stuckAfterRounds 阈值
  const stuckAfter = state.rules.stuckAfterRounds ?? 2
  const stuck = active.filter((id) => {
    const f = F[id]
    return f.verify !== 'fixed' && curRound - f.firstSeenRound + 1 >= stuckAfter
  })
  if (stuck.length) {
    const span = Math.max(...stuck.map((id) => curRound - F[id].firstSeenRound + 1))
    return {
      decision: 'escalate',
      round: curRound,
      ids: stuck,
      reason: `连续 ${span} 轮未解决（阈值 stuckAfterRounds=${stuckAfter}）：${stuck
        .map((id) => `${id}(${F[id].location})`)
        .join(', ')}。循环不收敛，升级人工。`,
    }
  }

  // R6 修复引入同级或更严重的新问题
  if (curRound > 1) {
    const prev = rounds[rounds.length - 2]
    const maxFixed = Math.max(0, ...prev.findingIds.map((id) => F[id]).filter((f) => f.fix === 'fixed').map((f) => rank(f.severity)))
    const fresh = cur.findingIds.map((id) => F[id]).filter((f) => f.firstSeenRound === curRound)
    const maxNew = Math.max(0, ...fresh.map((f) => rank(f.severity)))
    if (maxNew >= 2 && maxNew >= maxFixed) {
      return {
        decision: 'escalate',
        round: curRound,
        ids: fresh.filter((f) => rank(f.severity) === maxNew).map((f) => f.id),
        reason: `修复引入了同级或更严重的新问题（本轮新增最高 ${sevName(maxNew)}，上一轮已修最高 ${sevName(maxFixed)}）。`,
      }
    }
  }

  // R7 硬停止：达到轮次上限
  if (curRound >= state.budget.maxRounds) {
    return {
      decision: 'hard-stop',
      round: curRound,
      ids: active,
      reason: `已达 maxRounds=${state.budget.maxRounds} 且仍有 ${active.length} 条阻塞性发现，未收敛。如实报告未收敛。`,
    }
  }

  // R8 继续
  return {
    decision: 'continue',
    round: curRound,
    ids: active,
    reason: `第 ${curRound} 轮仍有 ${active.length} 条阻塞性发现，进入第 ${curRound + 1} 轮。`,
  }
}

// ---------------------------------------------------------------- 摘要

export function summarize(state) {
  const F = state.findings
  const all = Object.values(F)
  const bySeverity = {}
  for (const f of all) bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1
  return {
    target: state.target,
    baseline: state.baseline,
    rounds: state.rounds.length,
    maxRounds: state.budget.maxRounds,
    subagentsUsed: state.budget.subagentsUsed,
    maxSubagents: state.budget.maxSubagents,
    verifyMode: state.rules.verifyMode,
    stuckAfterRounds: state.rules.stuckAfterRounds,
    findings: all.length,
    bySeverity,
    unresolved: all.filter((f) => f.verify !== 'fixed' && rank(f.severity) >= BLOCKING_MIN).map((f) => f.id),
    verifiedByAbsence: all.filter((f) => f.closedBy?.rule === 'absence').map((f) => f.id),
    models: [...new Set(state.rounds.flatMap((r) => r.receipts.map((x) => x.model).filter(Boolean)))],
    regressed: all.filter((f) => f.regressed).map((f) => f.id),
    disputed: all.filter((f) => f.verify === 'disputed').map((f) => f.id),
    dropped: state.dropped.length,
    roundsDetail: state.rounds.map((r) => ({
      round: r.round,
      receipts: r.receipts.length,
      findings: r.findingIds.length,
      notes: r.notes ?? [],
    })),
  }
}

// ---------------------------------------------------------------- CLI

function load(p) {
  if (!existsSync(p)) throw new Error(`状态文件不存在：${p}（先跑 init）`)
  return JSON.parse(readFileSync(p, 'utf8'))
}

function save(p, state) {
  mkdirSync(dirname(resolve(p)), { recursive: true })
  writeFileSync(p, JSON.stringify(state, null, 2) + '\n')
}

function readStdin() {
  try {
    return readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

function main() {
  const argv = process.argv.slice(2)
  const cmd = argv.shift()
  const flags = {}
  const positional = []
  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i]
    if (tok.startsWith('--')) {
      const key = tok.slice(2)
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next
        i += 1
      } else {
        flags[key] = true
      }
    } else {
      positional.push(tok)
    }
  }

  const statePath = positional[0]
  const num = (v, d) => (v === undefined ? d : Number(v))

  try {
    switch (cmd) {
      case 'init': {
        if (!statePath) throw new Error('init 需要 <state> 路径')
        const state = createState({
          target: flags.target,
          baseline: flags.baseline ?? '',
          maxRounds: num(flags['max-rounds'], 3),
          maxSubagents: num(flags['max-subagents'], 15),
          minConfidence: num(flags['min-confidence'], 70),
          dedupeLines: num(flags['dedupe-lines'], 3),
          verifyMode: flags['verify-mode'] ?? 'explicit',
          stuckAfterRounds: num(flags['stuck-after'], 2),
        })
        save(statePath, state)
        console.log(`已初始化 ${statePath}`)
        console.log(`  对象=${state.target} 基线=${state.baseline || '(未指定)'}`)
        console.log(`  预算 maxRounds=${state.budget.maxRounds} maxSubagents=${state.budget.maxSubagents}`)
        console.log(`  规则 置信度阈值=${state.rules.minConfidence} 同问题行距=${state.rules.dedupeLines}`)
        console.log(`  验证模式=${state.rules.verifyMode} 卡住阈值=${state.rules.stuckAfterRounds} 轮`)
        break
      }

      case 'record': {
        const state = load(statePath)
        const raw = readStdin()
        if (!raw.trim()) throw new Error('record 需要从 stdin 传入 JSON，形如 {"receipts":[],"findings":[]}')
        const payload = JSON.parse(raw)
        payload.round = payload.round ?? Number(flags.round)
        recordRound(state, payload)
        save(statePath, state)
        const r = state.rounds[state.rounds.length - 1]
        console.log(`已记录第 ${r.round} 轮：${r.findingIds.length} 条发现，${r.receipts.length} 份派生凭据`)
        if (r.findingIds.length) console.log(`  ${r.findingIds.map((id) => `${id}[${state.findings[id].severity}] ${state.findings[id].location}`).join('\n  ')}`)
        const dropped = state.dropped.filter((d) => d.round === r.round)
        if (dropped.length) console.log(`  丢弃 ${dropped.length} 条（${[...new Set(dropped.map((d) => d.reason))].join(', ')}）`)
        for (const n of r.notes ?? []) console.log(`  · ${n}`)
        break
      }

      case 'resolve': {
        const state = load(statePath)
        if (!flags.id) throw new Error('resolve 需要 --id <F1>')
        const f = resolveFinding(state, {
          id: flags.id,
          fix: flags.fix,
          verify: flags.verify,
          note: flags.note,
        })
        save(statePath, state)
        console.log(`已结算 ${f.id}：fix=${f.fix} verify=${f.verify}${f.note ? ` note="${f.note}"` : ''}`)
        break
      }

      case 'judge': {
        const state = load(statePath)
        const verdict = judge(state)
        save(statePath, state)
        if (flags.json) {
          console.log(JSON.stringify(verdict, null, 2))
        } else {
          const icon = { converge: '✅', escalate: '⛔', 'hard-stop': '⛔', continue: '➡️' }[verdict.decision] ?? '?'
          console.log(`${icon} decision = ${verdict.decision}`)
          console.log(`   ${verdict.reason}`)
          if (verdict.ids?.length) console.log(`   涉及：${verdict.ids.join(', ')}`)
        }
        if (verdict.decision === 'escalate' || verdict.decision === 'hard-stop') process.exitCode = 1
        break
      }

      case 'show': {
        const state = load(statePath)
        console.log(JSON.stringify(summarize(state), null, 2))
        break
      }

      default:
        console.log(readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0] + '*/')
        process.exitCode = 2
    }
  } catch (err) {
    console.error(`error: ${err.message}`)
    process.exitCode = 2
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) main()
