import {
  OS_CALIBRATION,
  isOsAligned,
  taskDenominator,
  taskEffectSize,
  type CalibrationReceipt,
  type CohortReviewItem,
  type CohortTask,
  type DeviceProfile,
} from '@/domain/device-cohort'
import { listRows, saveRows } from './local-store'
import type { EntryRow } from './types'

/**
 * 设备分析与群组对比的口径数据。
 *
 * 列表里的记录（localStore 的 device / cohortcmp）是业务事实，这里只保存口径相关的
 * 附加信息：画像版本、任务版本、唯一可复核的分母、口径来源和复核清单。读写时两边同步，
 * 页面在设备详情和群组对比里看到的是同一份数据。
 *
 * 旧数据只有「效应值」没有分母，这里在首次加载时统一按操作系统口径补算分母；
 * 维度不是操作系统口径的任务保持原样，并显式标注为待修正，避免把错位分母继续当结果用。
 */

const CALIBRATION_KEY = 'behavior-event-trace-hub:device-cohort-calibration'

export type CalibrationState = {
  profiles: DeviceProfile[]
  tasks: CohortTask[]
  reviews: CohortReviewItem[]
  receipts: CalibrationReceipt[]
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function parseShare(value: unknown): number {
  const match = String(value ?? '').match(/-?\d+(\.\d+)?/)
  return match ? Number(match[0]) : 0
}

function formatShare(value: number): string {
  return `${value}%`
}

function deriveProfiles(source: EntryRow[] = listRows('device')): DeviceProfile[] {
  return source.map((row) => ({
    id: Number(row.id),
    profileNo: String(row['画像编号'] ?? ''),
    deviceType: String(row['设备类型'] ?? ''),
    os: String(row['操作系统'] ?? ''),
    browserVersion: String(row['浏览器版本'] ?? ''),
    userShare: parseShare(row['用户占比']),
    reportNo: String(row['行为差异报告'] ?? ''),
    version: 1,
    status: String(row.status ?? '草稿'),
  }))
}

function deriveTasks(
  profiles: DeviceProfile[],
  source: EntryRow[] = listRows('cohortcmp'),
): CohortTask[] {
  return source.map((row) => {
    const task: CohortTask = {
      id: Number(row.id),
      taskNo: String(row['任务编号'] ?? ''),
      groupA: String(row['群组A'] ?? ''),
      groupB: String(row['群组B'] ?? ''),
      dimension: String(row['对比维度'] ?? ''),
      // 旧效应值只有在口径对得上时才可信；对不上的一律不显示，等重算。
      effectSize: null,
      denominator: null,
      calibration: '待对齐口径',
      version: 1,
      status: String(row.status ?? '草稿'),
    }
    if (isOsAligned(task)) {
      task.denominator = taskDenominator(task, profiles)
      task.effectSize = taskEffectSize(task, profiles)
      task.calibration = OS_CALIBRATION
    }
    return task
  })
}

function fallbackState(): CalibrationState {
  const deviceRows = listRows('device')
  const profiles = deriveProfiles(deviceRows)
  const tasks = deriveTasks(profiles, listRows('cohortcmp'))
  return { profiles, tasks, reviews: [], receipts: [] }
}

let cache: CalibrationState | null = null

/**
 * 列表数据先被重置（resetModule）时，口径缓存里的状态已经过时：
 * 只要画像编号 / 任务编号对不上，就从列表重新推导一遍，避免两边互相覆盖。
 */
function stale(state: CalibrationState): boolean {
  const deviceIds = listRows('device').map((row) => String(row['画像编号'] ?? ''))
  const taskIds = listRows('cohortcmp').map((row) => String(row['任务编号'] ?? ''))
  const profileIds = state.profiles.map((profile) => profile.profileNo)
  const cohortIds = state.tasks.map((task) => task.taskNo)
  return (
    deviceIds.length !== profileIds.length ||
    deviceIds.some((id, index) => id !== profileIds[index]) ||
    taskIds.length !== cohortIds.length ||
    taskIds.some((id, index) => id !== cohortIds[index])
  )
}

function readState(): CalibrationState {
  const fallback = fallbackState()
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(CALIBRATION_KEY)
  if (!raw) {
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Partial<CalibrationState>
    const restored: CalibrationState = {
      profiles: parsed.profiles ?? fallback.profiles,
      tasks: parsed.tasks ?? fallback.tasks,
      reviews: parsed.reviews ?? fallback.reviews,
      receipts: parsed.receipts ?? [],
    }
    return stale(restored) ? fallback : restored
  } catch {
    return fallback
  }
}

export function calibrationState(): CalibrationState {
  if (cache === null) {
    cache = readState()
    // 首次加载就把口径数据写回列表：种子里的旧效应值（如按浏览器版本算出来的）
    // 不能先显示一遍再被覆盖，页面一打开看到的就是对齐后的结果。
    syncRowsInto(cache)
  }
  return cache
}

/** 把口径数据写回列表记录，保证设备分析 / 群组对比两张表看到的不是旧值。 */
function syncRowsInto(state: CalibrationState): void {
  const deviceRows = listRows('device').map((row) => {
    const profile = state.profiles.find((item) => Number(item.id) === Number(row.id))
    if (!profile) {
      return row
    }
    return {
      ...row,
      status: profile.status,
      pending: profile.status !== '已生成' && profile.status !== '已归档',
      '画像编号': profile.profileNo,
      '设备类型': profile.deviceType,
      '操作系统': profile.os,
      '浏览器版本': profile.browserVersion,
      '用户占比': formatShare(profile.userShare),
      '行为差异报告': profile.reportNo,
    }
  })
  saveRows('device', deviceRows)

  const cohortRows = listRows('cohortcmp').map((row) => {
    const task = state.tasks.find((item) => Number(item.id) === Number(row.id))
    if (!task) {
      return row
    }
    return {
      ...row,
      status: task.status,
      pending: task.status !== '已确认' && task.status !== '已归档',
      '任务编号': task.taskNo,
      '群组A': task.groupA,
      '群组B': task.groupB,
      '对比维度': task.dimension,
      '效应值': task.effectSize === null ? '' : String(task.effectSize),
      '结论描述': task.denominator === null
        ? '效应值分母未对齐，需按操作系统口径重算'
        : `${task.calibration} · 效应值 ${task.effectSize} · 分母 ${task.denominator}`,
    }
  })
  saveRows('cohortcmp', cohortRows)
}

export function saveCalibration(state: CalibrationState): void {
  cache = state
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(CALIBRATION_KEY, JSON.stringify(state))
    syncRowsInto(state)
  }
}

export function resetCalibration(): CalibrationState {
  const fresh = fallbackState()
  saveCalibration(fresh)
  return fresh
}

/**
 * 列表里的通用动作（发起分析 / 归档等）改了状态时，把状态并回口径数据，
 * 避免下一次口径写入把页面上的状态又覆盖回去。
 */
export function adoptModuleStatus(key: string, id: number, status: string): void {
  const state = calibrationState()
  if (key === 'device') {
    const index = state.profiles.findIndex((item) => item.id === id)
    if (index < 0) {
      return
    }
    const profiles = [...state.profiles]
    profiles[index] = { ...profiles[index], status }
    saveCalibration({ ...state, profiles })
    return
  }
  if (key === 'cohortcmp') {
    const index = state.tasks.findIndex((item) => item.id === id)
    if (index < 0) {
      return
    }
    const tasks = [...state.tasks]
    tasks[index] = { ...tasks[index], status }
    saveCalibration({ ...state, tasks })
  }
}

export function calibrationStorageKey(): string {
  return CALIBRATION_KEY
}
