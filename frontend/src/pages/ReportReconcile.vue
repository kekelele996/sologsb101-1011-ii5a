<script setup lang="ts">
/**
 * 模块 7：/reports 实时报汛与实测对账
 * 值班室按整点水位查临时关系线报出报汛流量；测验组管测次与实测断面流量，两边各记各的。
 * 按测流时刻对账：实测挂到盖住它的报汛时段上比对，差得多挂待修正，值班室据此重报；
 * 值班室改动报汛时段后校正失效退回待挂，由测验组本侧重挂。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Bell, Connection, Delete, Edit, Plus, Promotion, Refresh } from '@element-plus/icons-vue'
import StatBadge from '@/components/common/StatBadge.vue'
import DeviationTag from '@/components/common/DeviationTag.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import { useReportStore } from '@/stores/reportStore'
import { useStationStore } from '@/stores/stationStore'
import { useRatingStore } from '@/stores/ratingStore'
import { CORRECTION_POLICIES, type CorrectionPolicy, type FloodReport } from '@/types/report'
import { REPORT_DEVIATION_LIMIT_PCT, isReportDeviationOver } from '@/types/correction'
import { curveFlow } from '@/types/rating'
import { initDatabase } from '@/utils/db'

const reportStore = useReportStore()
const stationStore = useStationStore()
const ratingStore = useRatingStore()

const dialogVisible = ref(false)
const editingId = ref<string | null>(null)
const submitting = ref(false)
const backfilling = ref(false)
const form = reactive({
  stationId: '',
  periodStart: '',
  periodEnd: '',
  stageM: 0,
  lineNo: 'A',
  reportedFlowM3s: 0,
  dutyOperator: ''
})

/** 当前站 id（双向绑定到 store，跨页保留） */
const currentStationId = computed<string>({
  get: () => reportStore.activeStationId ?? '',
  set: (value: string) => reportStore.setActiveStation(value || null)
})

const currentStationName = computed(() => reportStore.stationNameOf(currentStationId.value))

/** 临时关系线下拉：沿用定线号体系 */
const lineNoOptions = computed<string[]>(() =>
  ratingStore.lineNos.length > 0 ? ratingStore.lineNos : ['A', 'B', 'C']
)

/** 临时关系线查流量预览：选线 + 整点水位 → 曲线流量 */
const curvePreview = computed<number | null>(() => {
  const fit = ratingStore.allFits.find((item) => item.lineNo === form.lineNo)
  if (!fit || !fit.valid || !Number.isFinite(form.stageM) || form.stageM <= 0) return null
  return curveFlow(fit, form.stageM)
})

function fmtTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function toLocalInput(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 按临时关系线查流量填入报汛流量（值班室报汛口径） */
function fillFromCurve(): void {
  if (curvePreview.value === null) {
    ElMessage.warning(`${form.lineNo} 线暂不可定线或水位未填，无法查线，请手工录入报汛流量`)
    return
  }
  form.reportedFlowM3s = curvePreview.value
  ElMessage.success(`已按 ${form.lineNo} 线查得报汛流量 ${curvePreview.value} m³/s`)
}

function openCreate(): void {
  editingId.value = null
  const start = new Date()
  start.setMinutes(0, 0, 0)
  const end = new Date(start.getTime() + 3600_000)
  form.stationId = currentStationId.value || stationStore.stations[0]?.id || ''
  form.periodStart = toLocalInput(start)
  form.periodEnd = toLocalInput(end)
  form.stageM = 0
  form.lineNo = lineNoOptions.value[0] ?? 'A'
  form.reportedFlowM3s = 0
  form.dutyOperator = '林昭'
  dialogVisible.value = true
}

function openEdit(report: FloodReport): void {
  editingId.value = report.id
  form.stationId = report.stationId
  form.periodStart = report.periodStart.slice(0, 16)
  form.periodEnd = report.periodEnd.slice(0, 16)
  form.stageM = report.stageM
  form.lineNo = report.lineNo
  form.reportedFlowM3s = report.reportedFlowM3s
  form.dutyOperator = report.dutyOperator
  dialogVisible.value = true
}

async function submitForm(): Promise<void> {
  if (!form.stationId) {
    ElMessage.warning('请选择所属测站')
    return
  }
  if (!form.periodStart || !form.periodEnd) {
    ElMessage.warning('请填写报汛时段起止（按整点）')
    return
  }
  const startMs = new Date(form.periodStart).getTime()
  const endMs = new Date(form.periodEnd).getTime()
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    ElMessage.warning('时段止应晚于时段起')
    return
  }
  if (!Number.isFinite(form.stageM)) {
    ElMessage.warning('请填写整点水位（m）')
    return
  }
  if (!Number.isFinite(form.reportedFlowM3s) || form.reportedFlowM3s <= 0) {
    ElMessage.warning('报汛流量应为大于 0 的数字（m³/s）')
    return
  }
  if (!form.dutyOperator.trim()) {
    ElMessage.warning('请填写值班员')
    return
  }
  submitting.value = true
  try {
    const payload = {
      stationId: form.stationId,
      periodStart: new Date(form.periodStart).toISOString(),
      periodEnd: new Date(form.periodEnd).toISOString(),
      stageM: form.stageM,
      lineNo: form.lineNo,
      reportedFlowM3s: form.reportedFlowM3s,
      dutyOperator: form.dutyOperator.trim()
    }
    if (editingId.value) {
      // 值班室改动报汛时段：挂上去的校正跟着失效退回待挂，值班室这份照旧保留新值
      const invalidated = await reportStore.updateReport(editingId.value, payload)
      ElMessage.success(
        invalidated > 0
          ? `报汛时段已改动，${invalidated} 条校正失效退回待挂，待测验组本侧重挂`
          : '报汛时段已更新'
      )
    } else {
      await reportStore.createReport({ ...payload, status: '正常', reportedAt: new Date().toISOString() })
      ElMessage.success('报汛时段已报出')
    }
    dialogVisible.value = false
  } finally {
    submitting.value = false
  }
}

async function removeReport(report: FloodReport): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `删除 ${fmtTime(report.periodStart)} ~ ${fmtTime(report.periodEnd)} 时段的报汛将同时删除挂在上面的校正，确认删除？`,
      '删除确认',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await reportStore.removeReport(report.id)
  ElMessage.success('报汛时段已删除')
}

/** 测验组挂接：把实测挂到盖住它的那条报汛时段上 */
async function attach(sectionId: string): Promise<void> {
  const result = await reportStore.attachSection(sectionId)
  if (result.ok) ElMessage.success(result.message)
  else ElMessage.warning(result.message)
}

/** 测验组本侧重挂：值班室改动退回的待挂校正 */
async function reattach(correctionId: string): Promise<void> {
  const result = await reportStore.reattachCorrection(correctionId)
  if (result.ok) ElMessage.success(result.message)
  else ElMessage.warning(result.message)
}

/** 值班室据此重报：按本站商量定的修正策略执行 */
async function applyReport(report: FloodReport): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `按当前策略「${reportStore.policyInfo.label}」重报 ${fmtTime(report.periodStart)} 时段？${reportStore.policyInfo.description}。`,
      '重报确认',
      { type: 'warning', confirmButtonText: '据此重报', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  const result = await reportStore.applyCorrection(report.id)
  if (result.ok) ElMessage.success(result.message)
  else ElMessage.warning(result.message)
}

/** 旧数据回填：照时刻回填最近一次实测，对不上的保持单列 */
async function runBackfill(): Promise<void> {
  backfilling.value = true
  try {
    const result = await reportStore.backfill()
    ElMessage.success(
      `回填完成：补挂 ${result.attached} 条；仍对不上 ${result.unmatched} 条，已在下方单列`
    )
  } finally {
    backfilling.value = false
  }
}

async function changePolicy(value: CorrectionPolicy): Promise<void> {
  if (!currentStationId.value) return
  await reportStore.setPolicy(currentStationId.value, value)
  ElMessage.success(`修正策略已改为「${reportStore.policyInfo.label}」，本页照此执行`)
}

onMounted(() => {
  if (stationStore.stations.length === 0) void initDatabase()
})
</script>

<template>
  <section class="page">
    <div class="gb-brand-bar" />

    <div class="page__head">
      <div>
        <h2 class="page__title">实时报汛与实测对账</h2>
        <p class="gb-hint">
          值班室按整点水位查临时关系线报出报汛流量，测验组管实测断面流量，两边各记各的；
          实测挂到盖住它的报汛时段上比对，偏差超过 {{ REPORT_DEVIATION_LIMIT_PCT }}% 给这次报汛挂待修正，值班室据此重报。
        </p>
      </div>
      <div class="page__actions">
        <el-button :icon="Refresh" :loading="backfilling" @click="runBackfill">回填旧数据</el-button>
        <el-button type="primary" :icon="Plus" @click="openCreate">新增报汛时段</el-button>
      </div>
    </div>

    <el-card shadow="never" class="gb-panel">
      <div class="page__policy">
        <div class="page__policy-station">
          <span class="gb-hint">对账测站</span>
          <el-select v-model="currentStationId" placeholder="选择测站" class="page__station-select">
            <el-option
              v-for="station in stationStore.stations"
              :key="station.id"
              :label="station.name"
              :value="station.id"
            />
          </el-select>
        </div>
        <el-alert type="info" show-icon :closable="false" class="page__policy-alert">
          <template #title>
            当前修正策略：{{ currentStationName }} 照「{{ reportStore.policyInfo.label }}」走 ——
            {{ reportStore.policyInfo.description }}（两边商量定后在此切换）
          </template>
          <el-radio-group
            :model-value="reportStore.policy"
            @change="(value: string | number | boolean | undefined) => changePolicy(value as CorrectionPolicy)"
          >
            <el-radio v-for="item in CORRECTION_POLICIES" :key="item.value" :value="item.value">
              {{ item.label }}
            </el-radio>
          </el-radio-group>
        </el-alert>
      </div>
    </el-card>

    <div class="gb-stats-row">
      <StatBadge label="报汛时段" :value="reportStore.stationReports.length" suffix="段" icon="Files" />
      <StatBadge
        label="待修正报汛"
        :value="reportStore.flaggedReports.length"
        suffix="段"
        :tone="reportStore.flaggedReports.length > 0 ? 'danger' : 'success'"
        icon="WarningFilled"
      />
      <StatBadge
        label="待挂校正"
        :value="reportStore.pendingCorrections.length"
        suffix="条"
        :tone="reportStore.pendingCorrections.length > 0 ? 'warning' : 'success'"
        icon="Histogram"
      />
      <StatBadge
        label="未挂实测报汛"
        :value="reportStore.unmatchedReports.length"
        suffix="段"
        tone="info"
        icon="DataLine"
      />
    </div>

    <el-card shadow="never" class="gb-panel">
      <div class="gb-panel-title">
        <h3>
          <el-icon><Bell /></el-icon>
          报汛时段（值班室）
        </h3>
        <span class="gb-hint">按整点水位查临时关系线报出；改动时段后挂上去的校正失效退回待挂</span>
      </div>

      <EmptyPanel
        v-if="reportStore.stationReports.length === 0"
        title="该站还没有报汛时段"
        description="值班室按整点水位查临时关系线报出报汛流量后，实测即可挂上来对账。"
        action-text="新增报汛时段"
        compact
        @action="openCreate"
      />

      <el-table v-else :data="reportStore.stationReports" border stripe class="gb-table-compact">
        <el-table-column label="报汛时段" width="200">
          <template #default="{ row }">
            <span class="gb-mono">{{ fmtTime(row.periodStart) }} ~ {{ fmtTime(row.periodEnd) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="整点水位 (m)" width="110" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.stageM.toFixed(2) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="临时关系线" width="100" align="center">
          <template #default="{ row }">
            <el-tag size="small" effect="plain">{{ row.lineNo }} 线</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="报汛流量 (m³/s)" width="140" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.reportedFlowM3s.toFixed(1) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="挂接实测比对" min-width="220">
          <template #default="{ row }">
            <template v-if="reportStore.attachedByReport[row.id]">
              <span class="gb-mono">{{ reportStore.attachedByReport[row.id].measuredFlowM3s.toFixed(1) }}</span>
              <DeviationTag
                :deviation-pct="reportStore.attachedByReport[row.id].deviationPct"
                :verdict="isReportDeviationOver(reportStore.attachedByReport[row.id].deviationPct) ? '超限' : '合格'"
                :limit="REPORT_DEVIATION_LIMIT_PCT"
                size="small"
                class="page__deviation"
              />
            </template>
            <span v-else class="gb-hint">未挂实测</span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="96" align="center">
          <template #default="{ row }">
            <el-tag
              size="small"
              :type="row.status === '待修正' ? 'danger' : row.status === '已重报' ? 'info' : 'success'"
              effect="plain"
            >
              {{ row.status }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="dutyOperator" label="值班员" width="90" />
        <el-table-column label="操作" width="230" fixed="right">
          <template #default="{ row }">
            <el-button size="small" :icon="Edit" @click="openEdit(row)">编辑</el-button>
            <el-button
              size="small"
              type="warning"
              plain
              :icon="Promotion"
              :disabled="row.status !== '待修正'"
              @click="applyReport(row)"
            >
              重报
            </el-button>
            <el-button size="small" type="danger" plain :icon="Delete" @click="removeReport(row)" />
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-card shadow="never" class="gb-panel">
      <div class="gb-panel-title">
        <h3>
          <el-icon><Connection /></el-icon>
          实测挂接校正（测验组）
        </h3>
        <span class="gb-hint">
          每次测完把实测挂到盖住它的报汛时段上；值班室改动时段后校正失效退回待挂，由测验组本侧重挂
        </span>
      </div>

      <EmptyPanel
        v-if="reportStore.correctionRows.length === 0"
        title="还没有挂接校正"
        description="在下方「未挂接的实测测次」里把实测挂到盖住它的报汛时段上，实测值和报汛值即在此摆一起比。"
        compact
      />

      <el-table v-else :data="reportStore.correctionRows" border stripe class="gb-table-compact">
        <el-table-column label="测次号" width="130">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.section ? row.section.measureNo : '测次已删除' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="测流时刻" width="120">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.section ? fmtTime(row.section.measuredAt) : '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="实测流量 (m³/s)" width="130" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.correction.measuredFlowM3s.toFixed(1) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="报汛快照 (m³/s)" width="130" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.correction.reportedFlowM3s.toFixed(1) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="偏差" width="190">
          <template #default="{ row }">
            <DeviationTag
              :deviation-pct="row.correction.deviationPct"
              :verdict="isReportDeviationOver(row.correction.deviationPct) ? '超限' : '合格'"
              :limit="REPORT_DEVIATION_LIMIT_PCT"
            />
          </template>
        </el-table-column>
        <el-table-column label="状态" width="86" align="center">
          <template #default="{ row }">
            <el-tag size="small" :type="row.correction.status === '已挂' ? 'success' : 'warning'" effect="plain">
              {{ row.correction.status }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="来源" width="100" align="center">
          <template #default="{ row }">
            <el-tag size="small" :type="row.correction.origin === '升级回填' ? 'info' : 'primary'" effect="plain">
              {{ row.correction.origin }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="挂接时间" width="120">
          <template #default="{ row }">
            <span class="gb-mono">{{ fmtTime(row.correction.attachedAt) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="110" fixed="right">
          <template #default="{ row }">
            <el-button
              v-if="row.correction.status === '待挂'"
              size="small"
              type="warning"
              :icon="Connection"
              @click="reattach(row.correction.id)"
            >
              重挂
            </el-button>
            <span v-else class="gb-hint">—</span>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-card shadow="never" class="gb-panel">
      <div class="gb-panel-title">
        <h3>未挂接的实测测次</h3>
        <span class="gb-hint">测流时刻落进哪条报汛时段，就挂到哪条上</span>
      </div>

      <EmptyPanel
        v-if="reportStore.unattachedSections.length === 0"
        title="该站测次都已挂接"
        description="新测次录入后会出现在这里，测完即挂到盖住它的报汛时段上。"
        compact
      />

      <el-table v-else :data="reportStore.unattachedSections" border stripe class="gb-table-compact">
        <el-table-column prop="measureNo" label="测次号" width="130">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.measureNo }}</span>
          </template>
        </el-table-column>
        <el-table-column label="测流时刻" width="130">
          <template #default="{ row }">
            <span class="gb-mono">{{ fmtTime(row.measuredAt) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="水位 (m)" width="100" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.stageM.toFixed(2) }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="method" label="测法" width="100" align="center" />
        <el-table-column label="实测流量 (m³/s)" width="140" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ (reportStore.sectionFlows[row.id] ?? 0).toFixed(1) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="120" fixed="right">
          <template #default="{ row }">
            <el-button size="small" type="primary" plain :icon="Connection" @click="attach(row.id)">
              挂接
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-card v-if="reportStore.unmatchedReports.length > 0" shadow="never" class="gb-panel">
      <div class="gb-panel-title">
        <h3>未挂实测的报汛（单列）</h3>
        <span class="gb-hint">
          没有任何实测归属的报汛：旧数据回填对不上的，或报出后还没有测流盖住的时段
        </span>
      </div>
      <el-table :data="reportStore.unmatchedReports" border stripe class="gb-table-compact">
        <el-table-column label="报汛时段" width="200">
          <template #default="{ row }">
            <span class="gb-mono">{{ fmtTime(row.periodStart) }} ~ {{ fmtTime(row.periodEnd) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="整点水位 (m)" width="110" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.stageM.toFixed(2) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="临时关系线" width="100" align="center">
          <template #default="{ row }">
            <el-tag size="small" effect="plain">{{ row.lineNo }} 线</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="报汛流量 (m³/s)" width="140" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.reportedFlowM3s.toFixed(1) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="96" align="center">
          <template #default="{ row }">
            <el-tag
              size="small"
              :type="row.status === '待修正' ? 'danger' : row.status === '已重报' ? 'info' : 'success'"
              effect="plain"
            >
              {{ row.status }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="说明" min-width="200">
          <template #default>
            <span class="gb-hint">等下次测流挂接，或点「回填旧数据」照时刻补挂最近一次实测</span>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-dialog
      v-model="dialogVisible"
      :title="editingId ? '编辑报汛时段（值班室）' : '新增报汛时段（值班室）'"
      width="560px"
      :close-on-click-modal="false"
    >
      <el-alert
        v-if="editingId"
        type="warning"
        show-icon
        :closable="false"
        title="改动报汛时段后，挂在上面的校正将失效退回待挂，由测验组本侧重挂；这份报汛照旧保留新值。"
        class="page__dialog-alert"
      />
      <el-form label-width="110px">
        <el-form-item label="所属测站" required>
          <el-select v-model="form.stationId" placeholder="选择测站" class="page__full">
            <el-option
              v-for="station in stationStore.stations"
              :key="station.id"
              :label="station.name"
              :value="station.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="时段起" required>
          <el-date-picker
            v-model="form.periodStart"
            type="datetime"
            value-format="YYYY-MM-DDTHH:mm"
            placeholder="整点，如 08:00"
            class="page__full"
          />
        </el-form-item>
        <el-form-item label="时段止" required>
          <el-date-picker
            v-model="form.periodEnd"
            type="datetime"
            value-format="YYYY-MM-DDTHH:mm"
            placeholder="整点，如 09:00"
            class="page__full"
          />
        </el-form-item>
        <el-form-item label="整点水位" required>
          <el-input-number v-model="form.stageM" :min="-50" :max="200" :step="0.01" :precision="2" controls-position="right" />
          <span class="page__unit">m</span>
        </el-form-item>
        <el-form-item label="临时关系线" required>
          <el-select v-model="form.lineNo" class="page__full">
            <el-option v-for="lineNo in lineNoOptions" :key="lineNo" :label="`${lineNo} 线`" :value="lineNo" />
          </el-select>
        </el-form-item>
        <el-form-item label="报汛流量" required>
          <el-input-number
            v-model="form.reportedFlowM3s"
            :min="0.01"
            :max="100000"
            :step="1"
            :precision="1"
            controls-position="right"
          />
          <span class="page__unit">m³/s</span>
          <el-button size="small" class="page__curve-btn" @click="fillFromCurve">按临时关系线查流量</el-button>
        </el-form-item>
        <el-form-item v-if="curvePreview !== null" label="查线预览">
          <span class="gb-hint">
            {{ form.lineNo }} 线在水位 {{ form.stageM.toFixed(2) }} m 处曲线流量 {{ curvePreview }} m³/s
          </span>
        </el-form-item>
        <el-form-item label="值班员" required>
          <el-input v-model="form.dutyOperator" placeholder="值班员姓名" maxlength="16" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitForm">
          {{ editingId ? '保存（校正退回待挂）' : '报出' }}
        </el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.page__head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.page__title {
  margin: 0 0 4px;
  font-size: 19px;
  color: #0f4c75;
}

.page__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.page__policy {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 14px;
}

.page__policy-station {
  display: flex;
  align-items: center;
  gap: 8px;
}

.page__station-select {
  width: 180px;
}

.page__policy-alert {
  flex: 1;
  min-width: 320px;
}

.page__policy-alert :deep(.el-alert__content) {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.page__deviation {
  margin-left: 8px;
}

.page__unit {
  margin-left: 8px;
  font-size: 12px;
  color: #8194a2;
}

.page__curve-btn {
  margin-left: 10px;
}

.page__full {
  width: 100%;
}

.page__dialog-alert {
  margin-bottom: 12px;
}
</style>
