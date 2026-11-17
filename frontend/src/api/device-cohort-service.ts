import {
  OS_CALIBRATION,
  PROFILE_CALIBRATION,
  TASK_CALIBRATION,
  isCalibrationConflict,
  isCompleteReport,
  isOsAligned,
  latestProfileVersion,
  rebuildByProfile,
  reviseByTask,
  round1,
  taskDenominator,
  taskEffectSize,
  taskMembers,
  verifyCohortAlignment,
  type CalibrationReceipt,
  type CohortArbitration,
  type CohortReviewItem,
  type CohortTask,
  type DeviceProfile,
  type ReviewSource,
} from '@/domain/device-cohort'
import {
  calibrationState,
  saveCalibration,
  adoptModuleStatus as adoptCalibrationStatus,
  type CalibrationState,
} from '@/data/calibration-store'
import type { ActionResult } from '@/data/types'

/**
 * 设备分析与群组对比之间的口径服务。
 *
 * 所有写入都按「读当前状态 → 校验版本 → 一次性落盘」的顺序执行。同一轮并发里的两个请求
 * 只有先落盘的那一份会推进口径版本；后到的请求版本对不上会被拒绝，回执标记冲突，不会
 * 覆盖已经确认的效应值，也不会再写第二份设备群组差异数据报告。
 */

/** 口径版本在所有画像与任务之间单调递增，任何一次写入都会推进。 */
function nextVersion(state: CalibrationState): number {
  const profileMax = state.profiles.reduce((max, item) => Math.max(max, item.version), 0)
  const taskMax = state.tasks.reduce((max, item) => Math.max(max, item.version), 0)
  return Math.max(profileMax, taskMax) + 1
}

function timestamp(): string {
  return new Date().toISOString()
}

let receiptSeq = 0

/** 每次写入都留一张回执；被拒绝的请求也会留，并带上冲突号。 */
function makeReceipt(input: {
  target: 'profile' | 'task'
  targetId: number
  targetNo: string
  action: string
  requestId?: string
  result: ActionResult
}): CalibrationReceipt {
  receiptSeq += 1
  return {
    id: receiptSeq,
    requestId: input.requestId ?? `req-${Date.now()}-${receiptSeq}`,
    target: input.target,
    targetId: input.targetId,
    targetNo: input.targetNo,
    action: input.action,
    ok: input.result.ok,
    conflictId: input.result.conflictId ?? null,
    message: input.result.message,
    at: timestamp(),
  }
}

function withReceipt(state: CalibrationState, receipt: CalibrationReceipt): CalibrationState {
  return { ...state, receipts: [...state.receipts, receipt] }
}

/** 被拒绝的请求只落回执，不碰画像 / 任务 / 复核清单。 */
function reject(input: {
  state: CalibrationState
  target: 'profile' | 'task'
  targetId: number
  targetNo: string
  action: string
  requestId?: string
  result: ActionResult
}): ActionResult {
  const receipt = makeReceipt(input)
  saveCalibration(withReceipt(input.state, receipt))
  return { ...input.result, receiptId: receipt.id } as ActionResult
}

export function listCalibrationReceipts(targetId?: number): CalibrationReceipt[] {
  const all = calibrationState().receipts
  return targetId === undefined ? all : all.filter((item) => item.targetId === targetId)
}

export function listProfiles(): DeviceProfile[] {
  return calibrationState().profiles
}

export function listCohortTasks(): CohortTask[] {
  return calibrationState().tasks
}

export function getCohortTask(id: number): CohortTask | undefined {
  return calibrationState().tasks.find((task) => task.id === id)
}

export function getDeviceProfile(id: number): DeviceProfile | undefined {
  return calibrationState().profiles.find((profile) => profile.id === id)
}

/**
 * 设备详情的口径核对：从设备画像顺着差异报告找到群组对比任务，
 * 逐条给出操作系统口径、用户占比和效应值分母是否一致。
 */
export function profileAlignment(profileId: number): {
  profile: DeviceProfile | null
  rows: {
    task: CohortTask
    calibration: string
    /** 已确认报告里的效应值；null 表示这份报告已被清空，不能拿来当结果 */
    effectSize: number | null
    /** 已记录的唯一可复核分母 */
    denominator: number | null
    /** 按当前画像口径应得的值，只用于核对，不直接展示成结论 */
    recomputed: { effectSize: number | null; denominator: number }
    members: DeviceProfile[]
    issues: string[]
  }[]
} {
  const state = calibrationState()
  const profile = state.profiles.find((item) => item.id === profileId) ?? null
  if (!profile) {
    return { profile: null, rows: [] }
  }
  const rows = state.tasks
    .filter((task) => task.groupA === profile.os || task.groupB === profile.os)
    .map((task) => ({
      task,
      calibration: isOsAligned(task) ? OS_CALIBRATION : task.calibration,
      effectSize: task.effectSize,
      denominator: task.denominator,
      recomputed: {
        effectSize: taskEffectSize(task, state.profiles),
        denominator: taskDenominator(task, state.profiles),
      },
      members: taskMembers(task, state.profiles),
      issues: verifyCohortAlignment(profile, task, state.profiles),
    }))
  return { profile, rows }
}

/** 群组对比任务的成员与口径明细，页面的任务详情直接用它。 */
export function taskAlignment(taskId: number) {
  const state = calibrationState()
  const task = state.tasks.find((item) => item.id === taskId)
  if (!task) {
    return null
  }
  const members = taskMembers(task, state.profiles)
  return {
    task,
    members,
    calibration: isOsAligned(task) ? OS_CALIBRATION : task.calibration,
    effectSize: task.effectSize,
    denominator: task.denominator,
    complete: isCompleteReport(task),
    recomputed: {
      effectSize: taskEffectSize(task, state.profiles),
      denominator: taskDenominator(task, state.profiles),
    },
    conflict: isCalibrationConflict(task, state.profiles),
    missingReports: members.filter((profile) => !profile.reportNo),
    reviews: state.reviews.filter((item) => item.taskId === taskId),
    receipts: state.receipts.filter((item) => item.target === 'task' && item.targetId === taskId),
  }
}

export type ReviewQuery = { taskId?: number; deviceId?: number }

export function listCohortReviews(query: ReviewQuery = {}): CohortReviewItem[] {
  return calibrationState().reviews.filter((item) => {
    if (query.taskId !== undefined && item.taskId !== query.taskId) return false
    if (query.deviceId !== undefined && item.deviceId !== query.deviceId) return false
    return true
  })
}

/** 同一份报告只保留一条复核记录；来源跨模块累加，设备画像与群组对比都能追溯。 */
function upsertReview(
  reviews: CohortReviewItem[],
  profile: DeviceProfile,
  task: CohortTask,
  source: ReviewSource,
): CohortReviewItem[] {
  const existing = reviews.find(
    (item) => item.deviceId === profile.id && item.taskId === task.id,
  )
  const sources: ReviewSource[] = existing
    ? [...new Set<ReviewSource>([...existing.sources, source])]
    : [source]
  const next: CohortReviewItem = {
    id: existing?.id ?? Math.max(0, ...reviews.map((item) => item.id)) + 1,
    deviceId: profile.id,
    profileNo: profile.profileNo,
    reportNo: profile.reportNo,
    taskId: task.id,
    taskNo: task.taskNo,
    os: profile.os,
    userShare: profile.userShare,
    effectSize: task.effectSize,
    denominator: task.denominator,
    source,
    sources,
    detail: `${profile.profileNo}（${profile.os}，占比 ${profile.userShare}%）→ ${task.taskNo}（${task.calibration}，效应值 ${task.effectSize ?? '—'}，分母 ${task.denominator ?? '—'}）`,
    submittedAt: timestamp(),
    reviewStatus: '待复核',
  }
  return [...reviews.filter((item) => item !== existing), next]
}

/**
 * 沿差异报告把设备送进群组对比复核清单。
 *
 * 报告不完整（缺效应值或分母）时不再沿用旧值：清单里只保留这条设备与本任务的对应关系，
 * 效应值 / 分母置空等重算，避免复核人拿着错位分母下结论。
 */
function syncReviews(
  reviews: CohortReviewItem[],
  profiles: DeviceProfile[],
  tasks: CohortTask[],
  source: ReviewSource = '设备画像',
): CohortReviewItem[] {
  let next = reviews
  for (const task of tasks) {
    if (!isCompleteReport(task)) {
      // 报告被清空的任务不能继续留在复核清单里，否则复核人看到的还是旧分母。
      next = next.filter((item) => item.taskId !== task.id)
      continue
    }
    for (const profile of profiles) {
      if (!profile.reportNo) continue
      if (profile.os !== task.groupA && profile.os !== task.groupB) continue
      next = upsertReview(next, profile, task, source)
    }
  }
  return next
}

/**
 * 按当前画像集合重建一组任务的口径数据。
 *
 * arbitration = profile 时以画像口径为准整体重算；task 时保留任务登记时的口径与分母。
 * 两种做法都只落同一个 denominator 字段，因此设备差异报告的可复核分母始终唯一。
 */
function rebuildTask(
  task: CohortTask,
  profiles: DeviceProfile[],
  arbitration: CohortArbitration,
  version: number,
): CohortTask {
  const members = taskMembers(task, profiles)
  const blocked = members.length === 0 || members.some((profile) => !profile.reportNo)

  if (arbitration === 'task') {
    const revised = reviseByTask(task)
    return {
      ...task,
      effectSize: revised.effectSize,
      denominator: revised.denominator,
      calibration: TASK_CALIBRATION,
      version,
      // 任务口径修订不改分母；只有原本没有分母的任务才需要重算。
      status: revised.denominator === null ? '对比计算中' : task.status,
    }
  }

  if (blocked) {
    // 画像口径重建需要设备集合完整。缺报告时不能沿用旧效应值，先清空等复核。
    return {
      ...task,
      effectSize: null,
      denominator: members.length ? taskDenominator(task, profiles) : null,
      calibration: PROFILE_CALIBRATION,
      version,
      status: '对比计算中',
    }
  }

  const rebuilt = rebuildByProfile(task, profiles)
  return {
    ...task,
    effectSize: rebuilt.effectSize,
    denominator: rebuilt.denominator,
    calibration: PROFILE_CALIBRATION,
    version,
    status: rebuilt.effectSize === null ? '对比计算中' : '已确认',
  }
}

/**
 * 口径修订与对比重算在同一设备集合上相遇时的仲裁入口。
 * 两种做法分别得到「按画像口径重建的差异报告」和「按任务口径修订的群组对照报告」。
 */
export function arbitrateCohort(input: {
  taskId: number
  arbitration: CohortArbitration
  expectVersion?: number
  requestId?: string
}): ActionResult {
  const state = calibrationState()
  const index = state.tasks.findIndex((item) => item.id === input.taskId)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${input.taskId} 的对比任务` }
  }
  const task = state.tasks[index]
  const rejectInput = {
    state,
    target: 'task' as const,
    targetId: task.id,
    targetNo: task.taskNo,
    action: input.arbitration === 'profile' ? '按画像口径重建' : '按任务口径修订',
    requestId: input.requestId,
  }
  if (input.expectVersion !== undefined && input.expectVersion !== task.version) {
    return reject({
      ...rejectInput,
      result: {
        ok: false,
        message: `${task.taskNo} 的口径版本已被推进到 v${task.version}，本次 v${input.expectVersion} 的请求被拒绝，已确认的效应值保持不变`,
        conflictId: `task-${task.taskNo}-v${task.version}`,
      },
    })
  }
  if (!isOsAligned(task)) {
    return reject({
      ...rejectInput,
      result: {
        ok: false,
        message: `${task.taskNo} 的对比维度「${task.dimension}」不是操作系统口径，先修正口径再重算`,
        conflictId: `caliber-${task.taskNo}`,
      },
    })
  }
  const members = taskMembers(task, state.profiles)
  if (members.length === 0) {
    return reject({
      ...rejectInput,
      result: { ok: false, message: `${task.taskNo} 的群组 A / B 没有对应的设备画像` },
    })
  }
  if (input.arbitration === 'profile') {
    const missing = members.filter((profile) => !profile.reportNo)
    if (missing.length > 0) {
      return reject({
        ...rejectInput,
        result: {
          ok: false,
          message: `${task.taskNo} 还有 ${missing.map((item) => item.profileNo).join('、')} 未生成行为差异报告，不能按画像口径重建`,
          conflictId: `report-${task.taskNo}`,
        },
      })
    }
  }

  const version = nextVersion(state)
  const updated = rebuildTask(task, state.profiles, input.arbitration, version)
  if (input.arbitration === 'task' && updated.denominator === null) {
    return reject({
      ...rejectInput,
      result: {
        ok: false,
        message: `${task.taskNo} 尚未登记可复核的效应值分母，无法按任务口径修订`,
        conflictId: `denominator-${task.taskNo}`,
      },
    })
  }
  const tasks = [...state.tasks]
  tasks[index] = updated
  const reviews = syncReviews(state.reviews, state.profiles, [updated], '群组对比')
  const result: ActionResult = {
    ok: true,
    message: `${updated.taskNo} 已按${updated.calibration}确认，效应值 ${updated.effectSize ?? '—'}，分母 ${updated.denominator ?? '—'}`,
  }
  const receipt = makeReceipt({ ...rejectInput, result })
  saveCalibration(withReceipt({ ...state, tasks, reviews }, receipt))
  return { ...result, receiptId: receipt.id }
}

/**
 * 画像口径修订：确认设备画像。
 *
 * 确认后画像版本推进，同一设备集合上的任务按画像口径重建，差异报告沿任务送进复核清单，
 * 任务列表里的旧效应值同步被覆盖，不会继续显示。
 */
export function confirmDeviceProfile(input: {
  profileId: number
  reportNo?: string
  expectVersion?: number
  requestId?: string
}): ActionResult {
  const state = calibrationState()
  const index = state.profiles.findIndex((item) => item.id === input.profileId)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${input.profileId} 的设备画像` }
  }
  const current = state.profiles[index]
  const rejectInput = {
    state,
    target: 'profile' as const,
    targetId: current.id,
    targetNo: current.profileNo,
    action: '确认画像',
    requestId: input.requestId,
  }
  if (input.expectVersion !== undefined && input.expectVersion !== current.version) {
    return reject({
      ...rejectInput,
      result: {
        ok: false,
        message: `${current.profileNo} 的画像口径已被其他请求修订为 v${current.version}，本次 v${input.expectVersion} 的请求被拒绝，已确认的效应值保持不变`,
        conflictId: `profile-${current.profileNo}-v${current.version}`,
      },
    })
  }
  const reportNo = input.reportNo?.trim()
  if (reportNo !== undefined && reportNo === '') {
    return reject({
      ...rejectInput,
      result: { ok: false, message: `${current.profileNo} 的确认必须带行为差异报告编号` },
    })
  }
  const nextReport = reportNo ?? current.reportNo
  if (!nextReport) {
    return reject({
      ...rejectInput,
      result: { ok: false, message: `${current.profileNo} 缺少行为差异报告，不能确认画像` },
    })
  }
  if (current.status === '已生成' && reportNo === undefined) {
    return reject({
      ...rejectInput,
      result: { ok: false, message: `${current.profileNo} 已经是「已生成」，不用重复确认` },
    })
  }

  const version = nextVersion(state)
  const updated: DeviceProfile = {
    ...current,
    reportNo: nextReport,
    version,
    status: '已生成',
  }
  const profiles = [...state.profiles]
  profiles[index] = updated

  // 同一设备集合上的任务整体按画像口径重建：有交集就推进版本，旧效应值不再保留。
  const tasks = state.tasks.map((task) => {
    const touched = taskMembers(task, profiles).some((member) => member.id === updated.id)
    if (!touched) {
      return task
    }
    return rebuildTask(task, profiles, 'profile', version)
  })
  const reviews = syncReviews(state.reviews, profiles, tasks.filter((task) => {
    return taskMembers(task, profiles).some((member) => member.id === updated.id)
  }))
  const result: ActionResult = {
    ok: true,
    message: `${updated.profileNo} 已确认，画像口径推进到 v${version}，${tasks.filter((task) => task.version === version).length} 个对比任务已按画像口径重建`,
  }
  const receipt = makeReceipt({ ...rejectInput, result })
  saveCalibration(withReceipt({ ...state, profiles, tasks, reviews }, receipt))
  return { ...result, receiptId: receipt.id }
}

/** 单任务重算入口：默认按画像口径重建差异报告。 */
export function recomputeCohortTask(
  taskId: number,
  arbitration: CohortArbitration = 'profile',
): ActionResult {
  return arbitrateCohort({ taskId, arbitration })
}

/** 把历史任务的对比维度修正为操作系统口径，并立即按画像口径重算。 */
export function realignCohortTask(
  taskId: number,
  expectVersion?: number,
  requestId?: string,
): ActionResult {
  const state = calibrationState()
  const index = state.tasks.findIndex((item) => item.id === taskId)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${taskId} 的对比任务` }
  }
  const task = state.tasks[index]
  const rejectInput = {
    state,
    target: 'task' as const,
    targetId: task.id,
    targetNo: task.taskNo,
    action: '修正口径',
    requestId,
  }
  if (expectVersion !== undefined && expectVersion !== task.version) {
    return reject({
      ...rejectInput,
      result: {
        ok: false,
        message: `${task.taskNo} 的口径版本已被推进到 v${task.version}，本次 v${expectVersion} 的请求被拒绝，已确认的效应值保持不变`,
        conflictId: `task-${task.taskNo}-v${task.version}`,
      },
    })
  }
  const osValues = new Set(state.profiles.map((profile) => profile.os))
  if (!osValues.has(task.groupA) || !osValues.has(task.groupB)) {
    return reject({
      ...rejectInput,
      result: {
        ok: false,
        message: `${task.taskNo} 的群组 A / B 不是设备画像里的操作系统取值，无法按操作系统口径对齐`,
        conflictId: `caliber-${task.taskNo}`,
      },
    })
  }
  const version = nextVersion(state)
  const aligned: CohortTask = { ...task, dimension: '操作系统用户占比', version }
  const tasks = [...state.tasks]
  tasks[index] = rebuildTask(aligned, state.profiles, 'profile', version)
  const reviews = syncReviews(state.reviews, state.profiles, [tasks[index]])
  const result: ActionResult = {
    ok: true,
    message: `${task.taskNo} 已从「${task.dimension}」修正为操作系统口径，效应值 ${tasks[index].effectSize ?? '—'}，分母 ${tasks[index].denominator ?? '—'}`,
  }
  const receipt = makeReceipt({ ...rejectInput, result })
  saveCalibration(withReceipt({ ...state, tasks, reviews }, receipt))
  return { ...result, receiptId: receipt.id }
}

export type CalibrationRequest =
  | {
      kind: 'confirm-profile'
      requestId?: string
      profileId: number
      reportNo?: string
      expectVersion?: number
    }
  | {
      kind: 'arbitrate-task'
      requestId?: string
      taskId: number
      arbitration: CohortArbitration
      expectVersion?: number
    }
  | {
      kind: 'realign-task'
      requestId?: string
      taskId: number
      expectVersion?: number
    }

/**
 * 批量（并发）写入入口：请求按顺序各自读取最新状态。
 *
 * 第一份完整请求落盘后版本推进，第二份同口径请求版本对不上被拒绝并标记冲突；
 * 落盘的设备群组差异数据报告只有一份，被拒绝的回执不会覆盖已确认的效应值。
 */
export function submitCalibrationRequests(requests: CalibrationRequest[]): ActionResult[] {
  return requests.map((request) => {
    if (request.kind === 'confirm-profile') {
      return confirmDeviceProfile(request)
    }
    if (request.kind === 'realign-task') {
      return realignCohortTask(request.taskId, request.expectVersion, request.requestId)
    }
    return arbitrateCohort(request)
  })
}

/** 列表里的通用动作改完状态后调用，把状态并回口径数据。 */
export function adoptModuleStatus(key: string, id: number, status: string): void {
  adoptCalibrationStatus(key, id, status)
}

/** 冲突探测：任务口径是否落后于同一设备集合上的最新画像口径。 */
export function detectCalibrationConflict(taskId: number): boolean {
  const state = calibrationState()
  const task = state.tasks.find((item) => item.id === taskId)
  if (!task) {
    return false
  }
  return (
    isCalibrationConflict(task, state.profiles) ||
    task.version < latestProfileVersion(task, state.profiles)
  )
}

/** 检验用：取当前状态快照。 */
export function calibrationSnapshot(): CalibrationState {
  return calibrationState()
}

export { OS_CALIBRATION, PROFILE_CALIBRATION, TASK_CALIBRATION, round1 }
