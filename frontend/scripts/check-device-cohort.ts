/**
 * 口径对齐自检：在 Node 里用内存 localStorage 跑一遍数据层，
 * 覆盖「设备详情 → 群组对比」的操作系统口径、用户占比与效应值分母一致性。
 *
 * 运行：node --experimental-strip-types scripts/check-device-cohort.ts
 * 或先 esbuild 打包（见 Makefile 的 check 目标）。
 */

type Row = Record<string, unknown>

const store = new Map<string, string>()
const localStorageMock = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
  removeItem: (key: string) => void store.delete(key),
  clear: () => store.clear(),
  key: (index: number) => [...store.keys()][index] ?? null,
  get length() {
    return store.size
  },
}
;(globalThis as unknown as { window: unknown }).window = { localStorage: localStorageMock }

const {
  confirmDeviceProfile,
  arbitrateCohort,
  realignCohortTask,
  listProfiles,
  listCohortTasks,
  profileAlignment,
  taskAlignment,
  listCohortReviews,
  submitCalibrationRequests,
  calibrationSnapshot,
} = await import('../src/api/device-cohort-service.ts')
const { resetRows } = await import('../src/data/local-store.ts')
const { resetCalibration } = await import('../src/data/calibration-store.ts')

let failures = 0
function check(name: string, condition: boolean, detail = '') {
  if (condition) {
    console.log(`  ok   ${name}`)
  } else {
    failures += 1
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function reset() {
  resetCalibration()
  resetRows('device')
  resetRows('cohortcmp')
  resetCalibration()
}

console.log('1. 设备详情与群组对比的操作系统口径 / 用户占比 / 效应值分母一致')
reset()
{
  const alignment = profileAlignment(2) // DEVI-0002 macOS 15
  check('DEVI-0002 能顺着差异报告找到同一操作系统口径的对比任务', alignment.rows.length === 1, `rows=${alignment.rows.length}`)
  const row = alignment.rows[0]
  check('对比任务按操作系统分组', row.task.dimension === '操作系统用户占比', row.task.dimension)
  check('画像在群组 A / B 内', row.issues.length === 0, row.issues.join('; '))
  const expected = 32.4 + 21.8
  check('效应值分母 = 两组用户占比之和', row.denominator === Math.round(expected * 10) / 10, String(row.denominator))
  check('效应值分母与任务记录一致', row.task.denominator === row.denominator, `${row.task.denominator} vs ${row.denominator}`)
  check('效应值 = A−B 占比差 / 同一分母', row.effectSize === Math.round(((32.4 - 21.8) / expected) * 10000) / 10000, String(row.effectSize))
  check('设备详情展示的效应值与任务记录同源', row.effectSize === row.task.effectSize)
}

console.log('2. 历史浏览器版本口径的任务不显示旧值，修正后回到操作系统口径')
reset()
{
  const before = taskAlignment(3)
  check('COHO-0003 旧口径被标注', before?.task.dimension === '浏览器版本', before?.task.dimension)
  check('旧口径不再显示原效应值', before?.task.effectSize === null, String(before?.task.effectSize))
  const result = realignCohortTask(3)
  check('修正口径成功', result.ok, result.message)
  const after = taskAlignment(3)
  check('修正后按操作系统口径', after?.task.dimension === '操作系统用户占比', after?.task.dimension)
  check('修正后分母唯一且为两组占比之和', after?.denominator === 45.8, String(after?.denominator))
  check('修正后效应值与分母同源', after?.task.effectSize === Math.round(((26.5 - 19.3) / 45.8) * 10000) / 10000, String(after?.task.effectSize))
}

console.log('3. 并发确认两个设备口径：只接受一份，另一份被拒绝且不覆盖效应值')
reset()
{
  const snapshot = calibrationSnapshot()
  const version = snapshot.profiles[1].version
  const receipts = submitCalibrationRequests([
    { kind: 'confirm-profile', profileId: 2, reportNo: 'DEVR-0002', expectVersion: version },
    { kind: 'confirm-profile', profileId: 2, reportNo: 'DEVR-0002-B', expectVersion: version },
  ])
  check('第一份请求被接受', receipts[0].ok, receipts[0].message)
  check('第二份请求被拒绝', receipts[1].ok === false, receipts[1].message)
  check('被拒绝的回执带冲突号', Boolean(receipts[1].conflictId), String(receipts[1].conflictId))
  const state = calibrationSnapshot()
  check('画像只落了一个报告号', state.profiles[1].reportNo === 'DEVR-0002', state.profiles[1].reportNo)
  const task = state.tasks.find((item) => item.id === 2)
  const expected = Math.round(((32.4 - 21.8) / (32.4 + 21.8)) * 10000) / 10000
  check('已确认效应值没有被第二次请求覆盖', task?.effectSize === expected, String(task?.effectSize))
}

console.log('4. 并发写入：只落一份差异报告，另一回执标记冲突')
reset()
{
  const state = calibrationSnapshot()
  const version = state.tasks.find((item) => item.id === 1)!.version
  const receipts = submitCalibrationRequests([
    { kind: 'arbitrate-task', taskId: 1, arbitration: 'profile', expectVersion: version },
    { kind: 'arbitrate-task', taskId: 1, arbitration: 'task', expectVersion: version },
  ])
  check('第一份写入成功', receipts[0].ok, receipts[0].message)
  check('第二份写入标记冲突', receipts[1].ok === false && Boolean(receipts[1].conflictId), receipts[1].message)
  const task = calibrationSnapshot().tasks.find((item) => item.id === 1)!
  check('任务只保留一份口径结果', task.calibration === '画像口径', task.calibration)
  check('分母没有被第二份覆盖', task.denominator === 45.8, String(task.denominator))
  const reviews = listCohortReviews({ taskId: 1 })
  check('复核清单按设备去重', reviews.length === 2, `reviews=${reviews.length}`)
  check('同一份报告只出现一次', new Set(reviews.map((item) => item.reportNo)).size === reviews.length)
}

console.log('5. 修复沿差异报告进入群组对比复核清单，跨模块保留来源')
reset()
{
  confirmDeviceProfile({ profileId: 2, reportNo: 'DEVR-0002' })
  const reviews = listCohortReviews({ deviceId: 2 })
  check('DEVI-0002 的报告进入复核清单', reviews.length > 0, `reviews=${reviews.length}`)
  check('复核项带任务编号', reviews.every((item) => item.taskNo.startsWith('COHO-')), '')
  check('来源保留设备画像', reviews.some((item) => item.sources.includes('设备画像')), JSON.stringify(reviews.map((r) => r.sources)))
  const task = calibrationSnapshot().tasks.find((item) => item.id === 2)!
  check('设备群组差异不再显示旧值', task.effectSize !== null && task.denominator !== null, `${task.effectSize}/${task.denominator}`)
  check('复核项里的效应值与任务一致', reviews.find((item) => item.taskId === 2)?.effectSize === task.effectSize)
}

console.log('6. 画像口径修订 + 对比口径重算同时发生：两种仲裁边界，分母唯一')
reset()
{
  const version = calibrationSnapshot().profiles[2].version // DEVI-0003 iOS 18
  const receipts = submitCalibrationRequests([
    { kind: 'confirm-profile', profileId: 3, reportNo: 'DEVR-0003', expectVersion: version },
    { kind: 'arbitrate-task', taskId: 1, arbitration: 'task', expectVersion: 1 },
  ])
  check('画像口径修订先落盘', receipts[0].ok, receipts[0].message)
  check('同一设备集合上的任务口径重算被拒绝', receipts[1].ok === false, receipts[1].message)
  const profileTask = calibrationSnapshot().tasks.find((item) => item.id === 1)!
  check('冲突边界落在画像口径', profileTask.calibration === '画像口径', profileTask.calibration)
  check('按画像口径重建的差异报告分母唯一', profileTask.denominator === 45.8, String(profileTask.denominator))
  check('效应值与分母同源', profileTask.effectSize === Math.round(((26.5 - 19.3) / 45.8) * 10000) / 10000, String(profileTask.effectSize))

  const second = arbitrateCohort({
    taskId: 1,
    arbitration: 'task',
    expectVersion: profileTask.version,
  })
  check('按任务口径修订群组对照报告可行', second.ok, second.message)
  const taskTask = calibrationSnapshot().tasks.find((item) => item.id === 1)!
  check('任务口径修订不改分母', taskTask.denominator === 45.8, String(taskTask.denominator))
  check('两种做法落在同一个分母字段', taskTask.denominator === profileTask.denominator)
  check('两种做法只产出一份任务记录', listCohortTasks().filter((item) => item.id === 1).length === 1)
}

console.log('7. 设备集合里有缺失报告时：效应值清空，分母仍只有一份且不再显示旧值')
reset()
{
  const version = calibrationSnapshot().profiles[0].version
  const result = confirmDeviceProfile({ profileId: 1, reportNo: 'DEVR-0001', expectVersion: version })
  check('确认画像成功', result.ok, result.message)
  const task = calibrationSnapshot().tasks.find((item) => item.id === 2)!
  check('缺报告的对比任务不沿用旧效应值', task.effectSize === null, String(task.effectSize))
  check('分母仍然唯一且按操作系统口径计算', task.denominator === 54.2, String(task.denominator))
  const blocked = arbitrateCohort({ taskId: 2, arbitration: 'profile', expectVersion: task.version })
  check('按画像口径重建被拒绝并说明缺报告', blocked.ok === false && blocked.message.includes('DEVI-0002'), blocked.message)
  const alignment = profileAlignment(1)
  check('设备详情不再拿旧效应值当结果', alignment.rows.find((row) => row.task.id === 2)?.effectSize === null)
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项未通过`)
process.exit(failures === 0 ? 0 : 1)
