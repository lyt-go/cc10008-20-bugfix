<template>
  <section class="page" data-module="device">
    <header class="page-head">
      <div>
        <h2>设备分析管理</h2>
        <p class="page-desc">
          分析不同设备环境下的用户行为差异，生成设备维度的行为画像。设备画像按
          <strong>操作系统</strong>分组，群组对比沿用同一口径与同一份效应值分母。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记设备画像</button>
        <button class="btn" type="button" @click="exportRows">导出设备分析清单</button>
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
          <td :colspan="columns.length + 2" class="empty-state">暂无设备分析数据，可先登记设备画像</td>
        </tr>
      </tbody>
    </table>

    <section v-if="detail.profile" class="detail-panel" data-detail="device">
      <header class="detail-head">
        <h3>{{ detail.profile.profileNo }} · {{ detail.profile.os }}</h3>
        <span class="detail-meta">画像口径 v{{ detail.profile.version }}</span>
        <button class="btn ghost" type="button" @click="closeDetail">收起</button>
      </header>
      <dl class="detail-grid">
        <div><dt>设备类型</dt><dd>{{ detail.profile.deviceType }}</dd></div>
        <div><dt>操作系统（分组口径）</dt><dd>{{ detail.profile.os }}</dd></div>
        <div><dt>浏览器版本（仅展示）</dt><dd>{{ detail.profile.browserVersion }}</dd></div>
        <div><dt>用户占比</dt><dd>{{ detail.profile.userShare }}%</dd></div>
        <div><dt>行为差异报告</dt><dd>{{ detail.profile.reportNo || '未生成' }}</dd></div>
        <div><dt>画像版本</dt><dd>v{{ detail.profile.version }}</dd></div>
      </dl>

      <div class="detail-actions">
        <label class="inline-field">
          <span>行为差异报告编号</span>
          <input v-model="reportDraft" placeholder="如 DEVR-0002" />
        </label>
        <button class="btn primary" type="button" @click="confirmProfile">确认画像（推进口径版本）</button>
        <button class="btn" type="button" @click="confirmTwice">并发确认两次</button>
      </div>
      <p v-if="receipts.length" class="detail-note">
        并发回执：{{ receipts.map((item) => `${item.requestId} ${item.ok ? '已落盘' : `被拒绝（${item.conflictId}）`}`).join('；') }}
      </p>

      <h4>群组对比口径核对</h4>
      <table class="data-table">
        <thead>
          <tr>
            <th>对比任务</th>
            <th>对比维度</th>
            <th>群组 A / B</th>
            <th>参与设备</th>
            <th>用户占比合计</th>
            <th>效应值</th>
            <th>分母</th>
            <th>口径</th>
            <th>结论</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in detail.rows" :key="item.task.id">
            <td>{{ item.task.taskNo }}</td>
            <td>{{ item.task.dimension }}</td>
            <td>{{ item.task.groupA }} / {{ item.task.groupB }}</td>
            <td>{{ item.members.map((member) => member.profileNo).join('、') || '—' }}</td>
            <td>{{ item.recomputed.denominator }}%</td>
            <td>{{ item.effectSize ?? '待重算' }}</td>
            <td>{{ item.denominator ?? '—' }}</td>
            <td>{{ item.calibration }}</td>
            <td :class="item.issues.length ? 'error-text' : ''">
              {{ item.issues.length ? item.issues.join('；') : '口径一致' }}
            </td>
          </tr>
          <tr v-if="!detail.rows.length">
            <td colspan="9" class="empty-state">该设备画像还没有进入任何群组对比任务</td>
          </tr>
        </tbody>
      </table>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条设备分析记录</span>
      <span v-if="infoMessage" class="ok-text">{{ infoMessage }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { downloadEntries, listEntries, moduleMeta, runAction as applyAction } from '@/api/local-service'
import {
  confirmDeviceProfile,
  profileAlignment,
  submitCalibrationRequests,
} from '@/api/device-cohort-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('device')
const columns = ["画像编号", "设备类型", "操作系统", "浏览器版本", "屏幕分辨率", "网络类型", "用户占比", "行为差异报告"]
const actions = ["发起分析", "确认画像", "归档画像"]
const statuses = ["草稿", "分析中", "已生成", "已归档"]
const stats = computed(() => [
  { label: '设备画像总数', value: total.value },
  { label: '已生成画像', value: rows.value.filter((row) => String(row.status) === '已生成').length },
  { label: '分析中画像', value: rows.value.filter((row) => String(row.status) === '分析中').length },
])

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const infoMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const reportDraft = ref('')

const detail = ref<ReturnType<typeof profileAlignment>>({ profile: null, rows: [] })
const receipts = ref<{ requestId: string; ok: boolean; conflictId: string | null; message: string }[]>([])

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
  errorMessage.value = '设备画像登记入口尚未接入审批流'
}

function openDetail(row: { id: number | string }) {
  const alignment = profileAlignment(Number(row.id))
  detail.value = alignment
  reportDraft.value = alignment.profile?.reportNo ?? ''
  receipts.value = []
  errorMessage.value = ''
  infoMessage.value = ''
}

function closeDetail() {
  detail.value = { profile: null, rows: [] }
}

function confirmProfile() {
  const profile = detail.value.profile
  if (!profile) {
    return
  }
  errorMessage.value = ''
  infoMessage.value = ''
  // 带上当前画像版本：并发确认时只有一份能落盘，另一份会拿到冲突回执。
  const result = confirmDeviceProfile({
    profileId: profile.id,
    reportNo: reportDraft.value,
    expectVersion: profile.version,
  })
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  infoMessage.value = result.message
  reload()
  openDetail(profile)
}

/**
 * 同一个设备口径的两次确认请求：第一份落盘，第二份因为版本已经推进被拒绝。
 * 已确认的效应值只保留第一份的结果。
 */
function confirmTwice() {
  const profile = detail.value.profile
  if (!profile) {
    return
  }
  errorMessage.value = ''
  infoMessage.value = ''
  const request = (suffix: string) => ({
    kind: 'confirm-profile' as const,
    requestId: `${profile.profileNo}-${suffix}`,
    profileId: profile.id,
    reportNo: reportDraft.value || profile.reportNo,
    expectVersion: profile.version,
  })
  const results = submitCalibrationRequests([request('A'), request('B')])
  const summary = results.map((result, index) => ({
    requestId: index === 0 ? `${profile.profileNo}-A` : `${profile.profileNo}-B`,
    ok: result.ok,
    conflictId: result.conflictId ?? null,
    message: result.message,
  }))
  infoMessage.value = results.map((result) => result.message).join(' / ')
  reload()
  openDetail(profile)
  // openDetail 会清空回执，这里把并发结果补回去。
  receipts.value = summary
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  infoMessage.value = ''
  if (action === '确认画像') {
    openDetail(row)
    confirmProfile()
    return
  }
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
  if (detail.value.profile?.id === Number(row.id)) {
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
    errorMessage.value = error instanceof Error ? error.message : '设备分析列表读取失败'
  }
}

onMounted(reload)
</script>
