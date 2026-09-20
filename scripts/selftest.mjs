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

// ---------------------------------------------------------------- 汇总

console.log(`\n${pass} 通过，${fail} 失败`)
process.exitCode = fail ? 1 : 0
