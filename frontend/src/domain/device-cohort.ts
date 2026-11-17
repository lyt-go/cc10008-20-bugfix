/**
 * 设备画像口径与群组对比口径的对齐规则。
 *
 * 事件的根因：设备画像按「操作系统」分组，群组对比却按「浏览器版本」计算，
 * 故障设备的画像与对比任务被错误读取，效应值的分母取成了浏览器版本的设备数，
 * 导致同一份设备集合上出现两套互相对不上的差异数据。
 *
 * 对齐后的唯一口径：
 *   - 分组维度固定为「操作系统」；群组 A / B 的取值必须是操作系统取值；
 *   - 参与对比的设备集合 = 操作系统落在群组 A 或群组 B 上的设备画像；
 *   - 设备差异报告只有一个可复核的分母 = 该设备集合的用户占比之和。
 *
 * 画像口径修订与对比口径重算可能在同一设备集合上同时发生，仲裁边界只有两种：
 *   - profile（按画像口径重建差异报告）：以新的画像口径为准整体重算；
 *   - task（按任务口径修订群组对照报告）：保留任务登记时的口径与分母，只修订报告。
 * 两种做法落在同一个「效应值分母」字段上，分母始终唯一，不会出现分母错位。
 */

export type DeviceProfile = {
  id: number
  profileNo: string
  deviceType: string
  os: string
  browserVersion: string
  userShare: number
  /** 行为差异报告编号，空串表示报告尚未生成，不能进入群组对比 */
  reportNo: string
  /** 画像口径版本号，确认画像时自增 */
  version: number
  status: string
}

export type CohortTask = {
  id: number
  taskNo: string
  /** 群组 A 的操作系统取值 */
  groupA: string
  /** 群组 B 的操作系统取值 */
  groupB: string
  dimension: string
  /** 效应值；null 表示尚未重算 */
  effectSize: number | null
  /** 唯一可复核的分母；null 表示尚未重算 */
  denominator: number | null
  /** 对比口径来源：操作系统口径 / 画像口径 / 任务口径 */
  calibration: string
  /** 任务登记时的口径版本号 */
  version: number
  status: string
}

export type ReviewSource = '设备画像' | '群组对比'

export type CohortReviewItem = {
  id: number
  deviceId: number
  profileNo: string
  reportNo: string
  taskId: number
  taskNo: string
  os: string
  userShare: number
  effectSize: number | null
  denominator: number | null
  source: ReviewSource
  /** 跨模块来源：同一份报告可能同时由设备画像与群组对比送入 */
  sources: ReviewSource[]
  detail: string
  submittedAt: string
  reviewStatus: '待复核' | '已复核'
}

export type CohortArbitration = 'profile' | 'task'

/**
 * 写入回执：每次口径写入都留一张回执。
 * ok=false 且带 conflictId 表示这份请求被拒绝，不会覆盖已确认的效应值。
 */
export type CalibrationReceipt = {
  id: number
  requestId: string
  target: 'profile' | 'task'
  targetId: number
  targetNo: string
  action: string
  ok: boolean
  conflictId: string | null
  message: string
  at: string
}

export const OS_GROUP_FIELD = '操作系统'
export const OS_CALIBRATION = '操作系统口径'
export const PROFILE_CALIBRATION = '画像口径'
export const TASK_CALIBRATION = '任务口径'

export function round1(value: number): number {
  return Math.round(value * 10) / 10
}

export function round4(value: number): number {
  return Math.round(value * 10000) / 10000
}

/** 群组是否按操作系统取值划分；不是就直接判为口径错位。 */
export function isOsAligned(task: CohortTask): boolean {
  return task.dimension === OS_GROUP_FIELD || task.dimension === `${OS_GROUP_FIELD}用户占比`
}

/** 同一设备集合：操作系统落在群组 A / B 上的设备画像。 */
export function taskMembers(task: CohortTask, profiles: DeviceProfile[]): DeviceProfile[] {
  return profiles.filter(
    (profile) => profile.os === task.groupA || profile.os === task.groupB,
  )
}

/** 唯一可复核的分母：两组设备用户占比之和。 */
export function taskDenominator(task: CohortTask, profiles: DeviceProfile[]): number {
  return round1(taskMembers(task, profiles).reduce((sum, profile) => sum + profile.userShare, 0))
}

/** 效应值 =（A 组占比 − B 组占比）/ 同一个分母。 */
export function taskEffectSize(task: CohortTask, profiles: DeviceProfile[]): number | null {
  if (!isOsAligned(task)) {
    return null
  }
  const denominator = taskDenominator(task, profiles)
  if (denominator <= 0) {
    return null
  }
  const sum = (os: string) =>
    taskMembers(task, profiles)
      .filter((profile) => profile.os === os)
      .reduce((total, profile) => total + profile.userShare, 0)
  return round4((sum(task.groupA) - sum(task.groupB)) / denominator)
}

/** 参与对比的设备里最高画像版本；冲突判定与画像口径重建都以它为准。 */
export function latestProfileVersion(task: CohortTask, profiles: DeviceProfile[]): number {
  const versions = taskMembers(task, profiles).map((profile) => profile.version)
  return versions.length ? Math.max(...versions) : task.version
}

/** 设备集合里是否有画像口径修订晚于任务口径：即两种口径在同一设备集合上相遇。 */
export function isCalibrationConflict(task: CohortTask, profiles: DeviceProfile[]): boolean {
  return taskMembers(task, profiles).some((profile) => profile.version > task.version)
}

/**
 * 核对一条设备画像与对比任务的口径调用关系，返回偏差明细。
 * 只核对口径本身（分组维度、群组归属、用户占比、分母）；报告是否齐备另行统计，
 * 避免把「暂时缺报告」误判成口径错位。
 */
export function verifyCohortAlignment(
  profile: DeviceProfile,
  task: CohortTask,
  profiles: DeviceProfile[],
): string[] {
  const issues: string[] = []
  if (!isOsAligned(task)) {
    issues.push(`${task.taskNo} 的对比维度「${task.dimension}」不是操作系统口径`)
  }
  if (profile.os !== task.groupA && profile.os !== task.groupB) {
    issues.push(`${profile.profileNo}（${profile.os}）不在 ${task.taskNo} 的群组 A / B 内`)
  }
  if (profile.userShare <= 0) {
    issues.push(`${profile.profileNo} 的用户占比缺失，无法作为分母`)
  }
  const denominator = taskDenominator(task, profiles)
  if (denominator <= 0) {
    issues.push(`${task.taskNo} 的效应值分母为空`)
  } else if (task.denominator !== null && task.denominator !== denominator) {
    issues.push(
      `${task.taskNo} 的效应值分母为 ${task.denominator}，按操作系统口径应为 ${denominator}`,
    )
  }
  return issues
}

/** 报告是否完整：效应值与分母都齐备才算一份完整报告，任缺其一都不能进入复核清单。 */
export function isCompleteReport(task: CohortTask): boolean {
  return task.effectSize !== null && task.denominator !== null
}

/** 按画像口径重建差异报告的内容（不改任务本身，便于先展示再提交）。 */
export function rebuildByProfile(task: CohortTask, profiles: DeviceProfile[]) {
  return {
    effectSize: taskEffectSize(task, profiles),
    denominator: taskDenominator(task, profiles),
    calibration: PROFILE_CALIBRATION,
    version: latestProfileVersion(task, profiles),
  }
}

/**
 * 按任务口径修订群组对照报告的内容：保留任务登记时的口径与分母，
 * 不跟着画像口径重算，分母仍是同一份记录。
 */
export function reviseByTask(task: CohortTask) {
  return {
    effectSize: task.effectSize,
    denominator: task.denominator,
    calibration: TASK_CALIBRATION,
    version: task.version,
  }
}
