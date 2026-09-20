#!/usr/bin/env node
/**
 * ad-review-loop 确定性内核自测。
 *
 * 覆盖收敛判定的每一条规则，以及记录阶段的每一条丢弃规则。
 * 判定逻辑必须可复现——这个文件就是它的证据。
 *
 * 运行：node scripts/selftest.mjs
 */

import {
  createState,
  recordRound,
  resolveFinding,
  judge,
  parseLocation,
  sameIssue,
} from './loop-state.mjs'

let pass = 0
let fail = 0

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) {
    pass += 1
    console.log(`ok    ${name}`)
  } else {
    fail += 1
    console.log(`FAIL  ${name}\n        期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
  }
}

const R = (lens, severity, location, confidence = 90) => ({ lens, severity, location, confidence })
const receipt = (role, id, fresh = true) => ({ role, agentId: id, provider: 'spawn', fresh })

// ---------------------------------------------------------------- 位置解析

check('解析单行位置', parseLocation('src/a.ts:42'), { file: 'src/a.ts', start: 42, end: 42, raw: 'src/a.ts:42' })
check('解析区间位置', parseLocation('src/a.ts:42-58'), { file: 'src/a.ts', start: 42, end: 58, raw: 'src/a.ts:42-58' })
check('解析带空格区间', parseLocation('src/a.ts:42 - 58'), { file: 'src/a.ts', start: 42, end: 58, raw: 'src/a.ts:42 - 58' })
check('解析 Windows 路径', parseLocation('C:\\proj\\src\\a.ts:10'), {
  file: 'C:\\proj\\src\\a.ts', start: 10, end: 10, raw: 'C:\\proj\\src\\a.ts:10',
})
check('无位置返回 null', parseLocation('src/a.ts'), null)
check('空值返回 null', parseLocation(null), null)

check('同一问题：同行', sameIssue(parseLocation('a.ts:10'), parseLocation('a.ts:10'), 3), true)
check('同一问题：差 3 行', sameIssue(parseLocation('a.ts:10'), parseLocation('a.ts:13'), 3), true)
check('不同问题：差 4 行', sameIssue(parseLocation('a.ts:10'), parseLocation('a.ts:14'), 3), false)
check('不同问题：不同文件', sameIssue(parseLocation('a.ts:10'), parseLocation('b.ts:10'), 3), false)

// ---------------------------------------------------------------- 场景 1：正常收敛

{
  const s = createState({ target: 'feat/x', baseline: 'abc123' })
  recordRound(s, {
    round: 1,
    receipts: [receipt('reviewer', 'agent-1'), receipt('reviewer', 'agent-2')],
    findings: [R('correctness', 'P1', 'src/a.ts:10-20'), R('security', 'P2', 'src/b.ts:5')],
  })
  check('S1 第1轮 → continue', judge(s).decision, 'continue')
  check('S1 发现数', Object.keys(s.findings).length, 2)

  resolveFinding(s, { id: 'F1', fix: 'fixed', verify: 'fixed' })
  resolveFinding(s, { id: 'F2', fix: 'fixed', verify: 'fixed' })

  recordRound(s, { round: 2, receipts: [receipt('reviewer', 'agent-3')], findings: [] })
  check('S1 第2轮空 → converge', judge(s).decision, 'converge')
}

// ---------------------------------------------------------------- 场景 2：卡住 → 升级

{
  const s = createState({ target: 'feat/y' })
  recordRound(s, { round: 1, receipts: [receipt('reviewer', 'a1')], findings: [R('correctness', 'P1', 'src/a.ts:10')] })
  check('S2 第1轮 → continue', judge(s).decision, 'continue')

  // 同一位置再次出现（未修复）
  recordRound(s, { round: 2, receipts: [receipt('reviewer', 'a2')], findings: [R('correctness', 'P1', 'src/a.ts:12')] })
  const v = judge(s)
  check('S2 卡住 → escalate', v.decision, 'escalate')
  check('S2 复用 id 而非新建', Object.keys(s.findings).length, 1)
  check('S2 3 行容差内识别为同一问题', s.findings.F1.seenRounds, [1, 2])
  check('S2 firstSeenRound 保持', s.findings.F1.firstSeenRound, 1)
}

// ---------------------------------------------------------------- 场景 3：回归 → 升级

{
  const s = createState({ target: 'feat/z' })
  recordRound(s, { round: 1, receipts: [receipt('reviewer', 'a1')], findings: [R('correctness', 'P1', 'src/a.ts:10')] })
  resolveFinding(s, { id: 'F1', fix: 'fixed', verify: 'fixed' })
  recordRound(s, { round: 2, receipts: [receipt('reviewer', 'a2')], findings: [R('correctness', 'P1', 'src/a.ts:10')] })
  const v = judge(s)
  check('S3 回归 → escalate', v.decision, 'escalate')
  check('S3 标记 regressed', s.findings.F1.regressed, true)
  check('S3 verify 重置为 unfixed', s.findings.F1.verify, 'unfixed')
}

// ---------------------------------------------------------------- 场景 4：maxRounds 硬停止

{
  const s = createState({ target: 'feat/w', maxRounds: 1 })
  recordRound(s, { round: 1, receipts: [receipt('reviewer', 'a1')], findings: [R('correctness', 'P1', 'src/a.ts:10')] })
  const v = judge(s)
  check('S4 达上限 → hard-stop', v.decision, 'hard-stop')
  check('S4 理由说明未收敛', /未收敛/.test(v.reason), true)
}

// ---------------------------------------------------------------- 场景 5：预算耗尽

{
  const s = createState({ target: 'feat/v', maxSubagents: 1 })
  recordRound(s, { round: 1, receipts: [receipt('reviewer', 'a1')], findings: [] })
  const v = judge(s)
  check('S5 预算耗尽 → hard-stop', v.decision, 'hard-stop')
  check('S5 预算优先于收敛判定', /预算耗尽/.test(v.reason), true)
}

// ---------------------------------------------------------------- 场景 6：修复引入同级新问题

{
  const s = createState({ target: 'feat/u', maxRounds: 5 })
  recordRound(s, { round: 1, receipts: [receipt('reviewer', 'a1')], findings: [R('correctness', 'P1', 'src/a.ts:10')] })
  resolveFinding(s, { id: 'F1', fix: 'fixed', verify: 'fixed' })
  recordRound(s, { round: 2, receipts: [receipt('reviewer', 'a2')], findings: [R('correctness', 'P1', 'src/c.ts:99')] })
  const v = judge(s)
  check('S6 修复引入同级新问题 → escalate', v.decision, 'escalate')
  check('S6 理由指出修复引入', /修复引入/.test(v.reason), true)
}

// ---------------------------------------------------------------- 场景 7：修复引入更轻的新问题 → 继续

{
  const s = createState({ target: 'feat/t', maxRounds: 5 })
  recordRound(s, { round: 1, receipts: [receipt('reviewer', 'a1')], findings: [R('correctness', 'P1', 'src/a.ts:10')] })
  resolveFinding(s, { id: 'F1', fix: 'fixed', verify: 'fixed' })
  recordRound(s, { round: 2, receipts: [receipt('reviewer', 'a2')], findings: [R('correctness', 'P2', 'src/c.ts:99')] })
  check('S7 新问题更轻 → continue', judge(s).decision, 'continue')
}

// ---------------------------------------------------------------- 场景 8：争议项阻断收敛

{
  const s = createState({ target: 'feat/s' })
  recordRound(s, { round: 1, receipts: [receipt('reviewer', 'a1')], findings: [R('correctness', 'P1', 'src/a.ts:10')] })
  resolveFinding(s, { id: 'F1', fix: 'unfixed', verify: 'disputed', note: '评审者与挑战者未达成一致' })
  recordRound(s, { round: 2, receipts: [receipt('reviewer', 'a2')], findings: [] })
  const v = judge(s)
  check('S8 争议项 → escalate（不因本轮为空而收敛）', v.decision, 'escalate')
  check('S8 理由指出争议不得静默合并', /绝不静默合并/.test(v.reason), true)
}

// ---------------------------------------------------------------- 场景 9：记录阶段的丢弃与留痕

{
  const s = createState({ target: 'feat/r' })
  recordRound(s, {
    round: 1,
    receipts: [receipt('reviewer', 'a1')],
    findings: [
      R('correctness', 'P0', 'src/a.ts:10'),
      R('correctness', 'P1', 'src/a.ts:11'), // 轮内重复 → 合并，保留 P0
      R('style', 'P2', '没有位置的发现'), // 无位置 → 丢弃
      R('style', 'nitpick', 'src/b.ts:1', 50), // 低置信度 → 丢弃
    ],
  })
  check('S9 只落 1 条', Object.keys(s.findings).length, 1)
  check('S9 重复项保留最高严重度', s.findings.F1.severity, 'P0')
  check('S9 丢弃留痕（共 3 条）', s.dropped.length, 3)
  check('S9 丢弃原因齐备', [...new Set(s.dropped.map((d) => d.reason))].sort(), [
    'in-round-duplicate',
    'low-confidence',
    'no-location',
  ])
}

// ---------------------------------------------------------------- 场景 10：未知严重度按阻塞处理

{
  const s = createState({ target: 'feat/q' })
  recordRound(s, { round: 1, receipts: [receipt('reviewer', 'a1')], findings: [R('x', '严重', 'src/a.ts:1')] })
  check('S10 未知严重度归一为 P2', s.findings.F1.severity, 'P2')
  check('S10 未知严重度仍阻塞收敛', judge(s).decision, 'continue')
}

// ---------------------------------------------------------------- 场景 11：无法重复记录同一轮

{
  const s = createState({ target: 'feat/p' })
  recordRound(s, { round: 1, receipts: [], findings: [] })
  let threw = false
  try {
    recordRound(s, { round: 1, receipts: [], findings: [] })
  } catch {
    threw = true
  }
  check('S11 拒绝重复写入同一轮', threw, true)
}

// ---------------------------------------------------------------- 场景 12：nitpick 不影响收敛

{
  const s = createState({ target: 'feat/o' })
  recordRound(s, {
    round: 1,
    receipts: [receipt('reviewer', 'a1')],
    findings: [R('style', 'nitpick', 'src/a.ts:1'), R('doc', 'theoretical', 'src/b.ts:2')],
  })
  check('S12 仅 nitpick / 理论风险 → converge', judge(s).decision, 'converge')
}

// ---------------------------------------------------------------- 场景 13：absence 模式 —— 缺席即通过

{
  const s = createState({ target: 'feat/n1', verifyMode: 'absence' })
  recordRound(s, {
    round: 1,
    receipts: [receipt('reviewer', 'a1')],
    findings: [R('correctness', 'P1', 'src/a.ts:10')],
  })
  check('S13 第1轮 → continue', judge(s).decision, 'continue')
  recordRound(s, {
    round: 2,
    receipts: [{ role: 'reviewer', agentId: 'a2', provider: 'agent-tool', fresh: true, lens: 'correctness', model: 'opus' }],
    findings: [],
  })
  check('S13 缺席 → 判定已修复', s.findings.F1.verify, 'fixed')
  check('S13 留痕 closedBy', s.findings.F1.closedBy, { round: 2, rule: 'absence' })
  check('S13 第2轮空 → converge', judge(s).decision, 'converge')
  check('S13 轮次备注记录缺席判定', /缺席判定：F1/.test(s.rounds[1].notes.join(' ')), true)
}

// ---------------------------------------------------------------- 场景 14：absence 模式 —— 视角未覆盖则不关闭

{
  const s = createState({ target: 'feat/n2', verifyMode: 'absence' })
  recordRound(s, {
    round: 1,
    receipts: [{ role: 'reviewer', agentId: 'a1', provider: 'agent-tool', fresh: true, lens: 'concurrency' }],
    findings: [R('concurrency', 'P1', 'src/a.ts:10')],
  })
  recordRound(s, {
    round: 2,
    receipts: [{ role: 'reviewer', agentId: 'a2', provider: 'agent-tool', fresh: true, lens: 'correctness' }],
    findings: [],
  })
  // 视角未覆盖 → 缺席不构成证据，保持 pending（既不判已修，也不静默通过）
  check('S14 视角未覆盖 → 保持 pending', s.findings.F1.verify, 'pending')
  check('S14 留痕说明未应用', /未覆盖 lens=concurrency/.test(s.findings.F1.note), true)
}

// ---------------------------------------------------------------- 场景 15：absence 关闭后重现 → 回归

{
  const s = createState({ target: 'feat/n3', verifyMode: 'absence', maxRounds: 5 })
  const rev = (id, lens = 'correctness') => ({ role: 'reviewer', agentId: id, provider: 'agent-tool', fresh: true, lens })
  recordRound(s, { round: 1, receipts: [rev('a1')], findings: [R('correctness', 'P1', 'src/a.ts:10')] })
  recordRound(s, { round: 2, receipts: [rev('a2')], findings: [] })
  check('S15 第2轮已判修复', s.findings.F1.fix, 'fixed')
  recordRound(s, { round: 3, receipts: [rev('a3')], findings: [R('correctness', 'P1', 'src/a.ts:10')] })
  const v = judge(s)
  check('S15 回归 → escalate', v.decision, 'escalate')
  check('S15 标记 regressed', s.findings.F1.regressed, true)
}

// ---------------------------------------------------------------- 场景 16：卡住阈值可调

{
  const s = createState({ target: 'feat/n4', stuckAfterRounds: 3, maxRounds: 5 })
  recordRound(s, { round: 1, receipts: [receipt('reviewer', 'a1')], findings: [R('correctness', 'P1', 'src/a.ts:10')] })
  recordRound(s, { round: 2, receipts: [receipt('reviewer', 'a2')], findings: [R('correctness', 'P1', 'src/a.ts:10')] })
  check('S16 阈值 3 → 第2轮仍 continue', judge(s).decision, 'continue')
  recordRound(s, { round: 3, receipts: [receipt('reviewer', 'a3')], findings: [R('correctness', 'P1', 'src/a.ts:10')] })
  const v = judge(s)
  check('S16 达阈值 → escalate', v.decision, 'escalate')
  check('S16 理由含阈值', /stuckAfterRounds=3/.test(v.reason), true)
}

// ---------------------------------------------------------------- 场景 17：凭据校验

{
  const s = createState({ target: 'feat/n5' })
  recordRound(s, { round: 1, receipts: [{ role: 'reviewer', agentId: 'a1', fresh: true }], findings: [] })
  check('S17 有效凭据计入预算', s.budget.subagentsUsed, 1)
  recordRound(s, { round: 2, receipts: [{ role: 'reviewer', agentId: 'a2' }], findings: [] })
  check('S17 无效凭据不计入预算', s.budget.subagentsUsed, 1)
  check('S17 无效凭据留痕', s.dropped.filter((d) => d.reason === 'invalid-receipt').length, 1)
  check('S17 轮次备注记录丢弃', /丢弃 1 份无效凭据/.test(s.rounds[1].notes.join(' ')), true)
}

// ---------------------------------------------------------------- 场景 18：拒绝未知 verifyMode

{
  let threw = false
  try {
    createState({ target: 'feat/n6', verifyMode: 'bogus' })
  } catch {
    threw = true
  }
  check('S18 拒绝未知 verifyMode', threw, true)
}

// ---------------------------------------------------------------- 场景 19：模型声明的合法性

{
  let same = false
  try {
    createState({ target: 'feat/m1', models: { reviewer: 'opus', fixer: 'opus' } })
  } catch {
    same = true
  }
  check('S19 拒绝两个角色同一模型', same, true)

  let partial = false
  try {
    createState({ target: 'feat/m1', models: { reviewer: 'opus' } })
  } catch {
    partial = true
  }
  check('S19 拒绝只声明一个模型', partial, true)

  const okState = createState({ target: 'feat/m1', models: { reviewer: 'opus', fixer: 'sonnet' } })
  check('S19 合法声明写入 rules', okState.rules.models, { reviewer: 'opus', fixer: 'sonnet' })
}

// ---------------------------------------------------------------- 场景 20：凭据模型必须与声明一致

{
  const s = createState({ target: 'feat/m2', models: { reviewer: 'opus', fixer: 'sonnet' } })
  recordRound(s, {
    round: 1,
    receipts: [
      { role: 'reviewer', agentId: 'a1', fresh: true, lens: 'correctness', model: 'opus' },
      { role: 'reviewer', agentId: 'a2', fresh: true, lens: 'security', model: 'haiku' }, // 与声明不符
      { role: 'fixer', agentId: 'a3', fresh: true, model: 'sonnet' },
    ],
    findings: [],
  })
  check('S20 一致的凭据计入预算', s.budget.subagentsUsed, 2)
  check('S20 不一致的凭据留痕', s.dropped.filter((d) => d.reason === 'model-mismatch').length, 1)
  check('S20 留痕含声明值与实际值', s.dropped.find((d) => d.reason === 'model-mismatch').detail, {
    role: 'reviewer', agentId: 'a2', declared: 'opus', got: 'haiku',
  })
}

// ---------------------------------------------------------------- 场景 21：降级信号 —— 跨模型未达成

{
  const s = createState({ target: 'feat/m3' })
  recordRound(s, {
    round: 1,
    receipts: [
      { role: 'reviewer', agentId: 'a1', fresh: true, lens: 'correctness', model: 'opus' },
      { role: 'fixer', agentId: 'a2', fresh: true, model: 'opus' },
    ],
    findings: [],
  })
  const v = judge(s)
  check('S21 判定不变（仍 converge）', v.decision, 'converge')
  check('S21 报 model-diversity', v.degraded, ['model-diversity'])
}

// ---------------------------------------------------------------- 场景 22：降级信号 —— 同一角色跨轮换模型

{
  const s = createState({ target: 'feat/m4' })
  recordRound(s, { round: 1, receipts: [{ role: 'reviewer', agentId: 'a1', fresh: true, lens: 'correctness', model: 'opus' }], findings: [] })
  recordRound(s, { round: 2, receipts: [{ role: 'reviewer', agentId: 'a2', fresh: true, lens: 'correctness', model: 'sonnet' }], findings: [] })
  const v = judge(s)
  check('S22 报 model-drift', v.degraded, ['model-drift:reviewer'])
}

// ---------------------------------------------------------------- 汇总

console.log(`\n${pass} 通过，${fail} 失败`)
process.exitCode = fail ? 1 : 0
