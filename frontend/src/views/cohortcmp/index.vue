<template>
  <section class="page" data-module="cohortcmp">
    <header class="page-head">
      <div>
        <h2>群组对比管理</h2>
        <p class="page-desc">
          对比分析不同用户群组在行为指标上的差异，量化群组间效果。群组 A / B 按
          <strong>操作系统</strong>取值划分，效应值分母与设备画像共用同一份。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记对比任务</button>
        <button class="btn" type="button" @click="exportRows">导出群组对比清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] || '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
            <button class="link" type="button" @click="openDetail(row)">口径核对</button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无群组对比数据，可先登记对比任务</td>
        </tr>
      </tbody>
    </table>

    <section v-if="detail" class="detail-panel" data-detail="cohortcmp">
      <header class="detail-head">
        <h3>{{ detail.task.taskNo }} · {{ detail.task.groupA }} vs {{ detail.task.groupB }}</h3>
        <span class="detail-meta">任务口径 v{{ detail.task.version }} · {{ detail.calibration }}</span>
        <button class="btn ghost" type="button" @click="closeDetail">收起</button>
      </header>

      <dl class="detail-grid">
        <div><dt>对比维度</dt><dd>{{ detail.task.dimension }}</dd></div>
        <div><dt>参与设备</dt><dd>{{ detail.members.map((item) => `${item.profileNo}(${item.os})`).join('、') || '—' }}</dd></div>
        <div><dt>用户占比合计（分母）</dt><dd>{{ detail.denominator ?? '—' }}%（重算校验 {{ detail.recomputed.denominator }}%）</dd></div>
        <div><dt>效应值</dt><dd>{{ detail.effectSize ?? '待重算' }}</dd></div>
        <div><dt>口径冲突</dt><dd :class="detail.conflict ? 'error-text' : ''">{{ detail.conflict ? '画像口径已修订，待仲裁' : '无' }}</dd></div>
        <div><dt>缺失差异报告</dt><dd :class="detail.missingReports.length ? 'error-text' : ''">{{ detail.missingReports.map((item) => item.profileNo).join('、') || '无' }}</dd></div>
      </dl>

      <div v-if="!isOsAlignedTask" class="detail-warning">
        「{{ detail.task.dimension }}」不是操作系统口径，旧效应值已停用，需要先修正口径。
      </div>

      <div class="detail-actions">
        <button class="btn primary" type="button" @click="arbitrate('profile')">
          按画像口径重建差异报告
        </button>
        <button class="btn" type="button" @click="arbitrate('task')">
          按任务口径修订群组对照报告
        </button>
        <button v-if="!isOsAlignedTask" class="btn" type="button" @click="realign">
          修正为操作系统口径
        </button>
      </div>
      <p class="detail-note">
        两种做法落在同一个可复核分母上，设备差异报告始终只有一份；并发提交时只有先落盘的一份生效。
      </p>

      <h4>写入回执</h4>
      <table class="data-table">
        <thead>
          <tr>
            <th>回执</th>
            <th>动作</th>
            <th>结果</th>
            <th>冲突号</th>
            <th>说明</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in detail.receipts" :key="item.id">
            <td>{{ item.requestId }}</td>
            <td>{{ item.action }}</td>
            <td :class="item.ok ? 'ok-text' : 'error-text'">{{ item.ok ? '已落盘' : '已拒绝' }}</td>
            <td>{{ item.conflictId ?? '—' }}</td>
            <td>{{ item.message }}</td>
          </tr>
          <tr v-if="!detail.receipts.length">
            <td colspan="5" class="empty-state">还没有针对该任务的写入回执</td>
          </tr>
        </tbody>
      </table>

      <h4>群组对比复核清单</h4>
      <table class="data-table">
        <thead>
          <tr>
            <th>设备画像</th>
            <th>行为差异报告</th>
            <th>操作系统</th>
            <th>用户占比</th>
            <th>效应值</th>
            <th>分母</th>
            <th>来源</th>
            <th>送出时间</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in detail.reviews" :key="item.id">
            <td>{{ item.profileNo }}</td>
            <td>{{ item.reportNo }}</td>
            <td>{{ item.os }}</td>
            <td>{{ item.userShare }}%</td>
            <td>{{ item.effectSize ?? '待重算' }}</td>
            <td>{{ item.denominator ?? '—' }}</td>
            <td>{{ item.sources.join(' → ') }}</td>
            <td>{{ item.submittedAt }}</td>
          </tr>
          <tr v-if="!detail.reviews.length">
            <td colspan="8" class="empty-state">还没有设备差异报告进入复核清单</td>
          </tr>
        </tbody>
      </table>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条群组对比记录</span>
      <span v-if="infoMessage" class="ok-text">{{ infoMessage }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { downloadEntries, listEntries, moduleMeta, runAction as applyAction } from '@/api/local-service'
import { arbitrateCohort, realignCohortTask, taskAlignment } from '@/api/device-cohort-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('cohortcmp')
const columns = ["任务编号", "群组A", "群组B", "对比维度", "时间对齐方式", "统计检验", "效应值", "结论描述"]
const actions = ["启动对比", "确认结论", "归档结论"]
const statuses = ["草稿", "对比计算中", "已确认", "已归档"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const infoMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

const stats = computed(() => [
  { label: '对比任务总数', value: total.value },
  { label: '已确认任务', value: rows.value.filter((row) => String(row.status) === '已确认').length },
  { label: '计算中任务', value: rows.value.filter((row) => String(row.status) === '对比计算中').length },
])

const detail = ref<ReturnType<typeof taskAlignment>>(null)
const isOsAlignedTask = computed(
  () => detail.value?.task.dimension === '操作系统' || detail.value?.task.dimension === '操作系统用户占比',
)

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '对比任务登记入口尚未接入审批流'
}

function openDetail(row: { id: number | string }) {
  detail.value = taskAlignment(Number(row.id))
  errorMessage.value = ''
  infoMessage.value = ''
}

function closeDetail() {
  detail.value = null
}

function arbitrate(arbitration: 'profile' | 'task') {
  const current = detail.value
  if (!current) {
    return
  }
  errorMessage.value = ''
  infoMessage.value = ''
  const result = arbitrateCohort({
    taskId: current.task.id,
    arbitration,
    expectVersion: current.task.version,
  })
  if (!result.ok) {
    errorMessage.value = result.conflictId ? `冲突：${result.message}` : result.message
    openDetail({ id: current.task.id })
    return
  }
  infoMessage.value = result.message
  reload()
  openDetail({ id: current.task.id })
}

function realign() {
  const current = detail.value
  if (!current) {
    return
  }
  errorMessage.value = ''
  const result = realignCohortTask(current.task.id, current.task.version)
  if (!result.ok) {
    errorMessage.value = result.message
    openDetail({ id: current.task.id })
    return
  }
  infoMessage.value = result.message
  reload()
  openDetail({ id: current.task.id })
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  infoMessage.value = ''
  if (action === '启动对比') {
    const result = applyAction(meta.key, Number(row.id), action)
    if (!result.ok) {
      errorMessage.value = result.message
      return
    }
    reload()
    return
  }
  if (action === '确认结论') {
    // 确认结论不能只推状态：要真正按操作系统口径重算，落一份可复核的效应值。
    const current = taskAlignment(Number(row.id))
    if (!current) {
      errorMessage.value = `没有找到编号为 ${row.id} 的对比任务`
      return
    }
    const result = arbitrateCohort({
      taskId: Number(row.id),
      arbitration: 'profile',
      expectVersion: current.task.version,
    })
    if (!result.ok) {
      errorMessage.value = result.message
      return
    }
    infoMessage.value = result.message
    reload()
    if (detail.value?.task.id === Number(row.id)) {
      openDetail(row)
    }
    return
  }
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
  if (detail.value?.task.id === Number(row.id)) {
    openDetail(row)
  }
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '群组对比列表读取失败'
  }
}

onMounted(reload)
</script>
