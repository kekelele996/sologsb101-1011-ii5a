<script setup lang="ts">
/**
 * 实时报汛与实测对账台：
 * - 水情值班室维护整点报汛时段、临时关系线查算值与协商规则；
 * - 测验组按测流时刻把实测断面流量挂到盖住它的时段；
 * - 偏差超限生成值班室待修正单，重报时按页面写明的单次/整段规则执行。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  Bell,
  Connection,
  Delete,
  Edit,
  Plus,
  RefreshRight,
  Warning
} from '@element-plus/icons-vue'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import DeviationTag from '@/components/common/DeviationTag.vue'
import { useStationStore } from '@/stores/stationStore'
import { useSectionStore } from '@/stores/sectionStore'
import { useReportStore } from '@/stores/reportStore'
import {
  CORRECTION_POLICIES,
  createEmptyReportDraft,
  isTimeCovered,
  type CorrectionPolicy,
  type ReportPeriod
} from '@/types/reportPeriod'
import type { FlowCorrection, MeasurementLink } from '@/types/flowCorrection'
import { initDatabase } from '@/utils/db'

const stationStore = useStationStore()
const sectionStore = useSectionStore()
const reportStore = useReportStore()

const activeTab = ref<'duty' | 'measure' | 'unmatched'>('duty')
const stationFilter = ref<string>('')
const dialogVisible = ref(false)
const editingId = ref<string | null>(null)
const submitting = ref(false)
const form = reactive(createEmptyReportDraft())

const filteredReports = computed(() =>
  stationFilter.value
    ? reportStore.reportRows.filter((row) => row.report.stationId === stationFilter.value)
    : reportStore.reportRows
)

const filteredSections = computed(() => {
  const list = sectionStore.sections
    .filter((section) => !stationFilter.value || section.stationId === stationFilter.value)
    .slice()
    .sort((a, b) => Date.parse(b.measuredAt) - Date.parse(a.measuredAt))
  return list.map((section) => {
    const link = reportStore.linkOfSection(section.id)
    const covers = reportStore.coveringReports(section)
    const linkedReport = link?.reportPeriodId ? reportStore.reportById(link.reportPeriodId) : null
    return {
      section,
      link,
      covers,
      linkedReport,
      attached: link?.status === '已挂',
      stationName: stationStore.stationById(section.stationId)?.name ?? '未知测站'
    }
  })
})

const unmatchedRows = computed(() =>
  reportStore.unmatchedLinks
    .filter((link) => !stationFilter.value || link.stationId === stationFilter.value)
    .map((link) => ({
      link,
      stationName: reportStore.stationName(link.stationId),
      section: link.sectionId ? sectionStore.sectionById(link.sectionId) : null
    }))
)

const invalidRows = computed(() =>
  reportStore.invalidCorrections
    .filter((correction) => !stationFilter.value || correction.stationId === stationFilter.value)
    .map((correction) => ({
      correction,
      report: reportStore.reportById(correction.reportPeriodId)
    }))
)

function openCreate(): void {
  editingId.value = null
  Object.assign(form, createEmptyReportDraft(stationFilter.value || stationStore.stations[0]?.id || ''))
  dialogVisible.value = true
}

function openEdit(report: ReportPeriod): void {
  editingId.value = report.id
  Object.assign(form, {
    stationId: report.stationId,
    startedAt: report.startedAt.slice(0, 16),
    endedAt: report.endedAt.slice(0, 16),
    hourStageM: report.hourStageM,
    reportedFlowM3s: report.reportedFlowM3s,
    temporaryLineNo: report.temporaryLineNo,
    segmentNo: report.segmentNo,
    correctionPolicy: report.correctionPolicy,
    reporter: report.reporter
  })
  dialogVisible.value = true
}

async function submitReport(): Promise<void> {
  if (!form.stationId) {
    ElMessage.warning('请选择测站')
    return
  }
  if (!form.startedAt || !form.endedAt) {
    ElMessage.warning('请填写报汛时段起止时间')
    return
  }
  if (Date.parse(form.endedAt) <= Date.parse(form.startedAt)) {
    ElMessage.warning('结束时间必须晚于开始时间')
    return
  }
  if (!Number.isFinite(form.hourStageM)) {
    ElMessage.warning('请填写整点水位')
    return
  }
  if (!Number.isFinite(form.reportedFlowM3s) || form.reportedFlowM3s <= 0) {
    ElMessage.warning('请填写有效的报汛流量')
    return
  }
  if (!form.temporaryLineNo.trim() || !form.segmentNo.trim()) {
    ElMessage.warning('请填写临时关系线号与段号')
    return
  }

  submitting.value = true
  try {
    const payload = {
      stationId: form.stationId,
      startedAt: new Date(form.startedAt).toISOString(),
      endedAt: new Date(form.endedAt).toISOString(),
      hourStageM: form.hourStageM,
      reportedFlowM3s: form.reportedFlowM3s,
      temporaryLineNo: form.temporaryLineNo.trim(),
      segmentNo: form.segmentNo.trim(),
      correctionPolicy: form.correctionPolicy,
      reporter: form.reporter.trim() || '值班室'
    }
    if (editingId.value) {
      await reportStore.updateReport(editingId.value, payload)
      ElMessage.success('报汛时段已更新；不再被覆盖的实测已退回测验组重挂')
    } else {
      await reportStore.createReport(payload)
      ElMessage.success('报汛时段已登记')
    }
    dialogVisible.value = false
  } finally {
    submitting.value = false
  }
}

async function removeReport(report: ReportPeriod): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `删除 ${new Date(report.startedAt).toLocaleString('zh-CN')} 报汛时段后，已挂实测将退回待挂；值班室校正单仍保留。确认删除？`,
      '删除报汛时段',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await reportStore.removeReport(report.id)
  ElMessage.success('报汛时段已删除，实测侧已退回待挂')
}

async function changePolicy(report: ReportPeriod, policy: CorrectionPolicy | string | number | boolean): Promise<void> {
  await reportStore.setCorrectionPolicy(report.id, String(policy) as CorrectionPolicy)
  ElMessage.success(`本时段修正规则已写明为「${String(policy)}」`)
}

async function attachFirst(row: (typeof filteredSections.value)[number]): Promise<void> {
  const report = row.covers[0]
  if (!report) {
    ElMessage.warning('没有盖住该测流时刻的报汛时段')
    return
  }
  await doAttach(row.section.id, report.id)
}

async function doAttach(sectionId: string, reportPeriodId: string): Promise<void> {
  try {
    const link = await reportStore.attachMeasurement(sectionId, reportPeriodId)
    ElMessage.success(
      Math.abs(link.deviationPct) > reportStore.deviationLimitPct
        ? `已挂接，偏差 ${link.deviationPct}%，已给本次报汛挂待修正`
        : `已挂接，偏差 ${link.deviationPct}%`
    )
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '挂接失败')
  }
}

async function detach(link: MeasurementLink): Promise<void> {
  try {
    await ElMessageBox.confirm('退回后测验组需重新挂接；值班室那份校正单不会删除。确认退回待挂？', '退回实测归属', {
      type: 'warning',
      confirmButtonText: '退回待挂',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }
  await reportStore.detachMeasurement(link.id)
  ElMessage.success('已退回待挂，值班室校正单保留')
}

async function issueCorrection(correction: FlowCorrection): Promise<void> {
  const report = reportStore.reportById(correction.reportPeriodId)
  const scope = correction.policy === '整段偏移' ? `同站同临时线同段号（${correction.segmentNo}）全部时段` : '仅这一次报汛'
  try {
    await ElMessageBox.confirm(
      `当前页面规则为「${correction.policy}」：将重报${scope}。实测 ${correction.measuredFlowM3s.toFixed(
        1
      )} m³/s，原报汛 ${correction.originalReportedFlowM3s.toFixed(1)} m³/s，偏差 ${correction.deviationPct}%。确认值班室重报？`,
      '按协商规则重报',
      { type: 'warning', confirmButtonText: '确认重报', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await reportStore.issueCorrection(correction.id)
  ElMessage.success(correction.policy === '整段偏移' ? '整段偏移重报完成' : '本次报汛已按实测重报')
}

async function recalcSection(sectionId: string): Promise<void> {
  const value = await sectionStore.recalcSectionFlow(sectionId)
  if (value <= 0) ElMessage.warning('当前垂线测点未算出有效流量')
  else {
    await reportStore.ensureSectionLink(sectionId)
    ElMessage.success(`实测断面流量已重算为 ${value.toFixed(2)} m³/s`)
  }
}

function correctionTagType(status: FlowCorrection['status']): 'danger' | 'success' | 'info' {
  if (status === '待修正') return 'danger'
  if (status === '已重报') return 'success'
  return 'info'
}

onMounted(() => {
  if (stationStore.stations.length === 0) void initDatabase()
  reportStore.start()
})
</script>

<template>
  <section class="page">
    <div class="gb-brand-bar" />

    <div class="page__head">
      <div>
        <h2 class="page__title">实测流量 · 实时报汛对账台</h2>
        <p class="gb-hint">
          两边各记各的：测验完成后按测流时刻挂到盖住它的报汛时段；偏差超过
          {{ reportStore.deviationLimitPct }}% 时，本次报汛自动挂“待修正”。
        </p>
      </div>
      <div class="page__actions">
        <el-select v-model="stationFilter" clearable placeholder="全部测站" class="page__station-select">
          <el-option v-for="station in stationStore.stations" :key="station.id" :label="station.name" :value="station.id" />
        </el-select>
        <el-button type="primary" :icon="Plus" @click="openCreate">新增报汛时段</el-button>
      </div>
    </div>

    <el-alert
      type="info"
      show-icon
      :closable="false"
      title="协商规则写在每个时段上：「单次修正」只改这一次报汛；「整段偏移」按本次实测减原报汛的偏移量，重报同站、同临时关系线、同段号的全部时段。"
    />

    <div class="gb-stats-row">
      <StatBadge label="报汛时段" :value="reportStore.stats.reportCount" suffix="段" icon="Bell" />
      <StatBadge label="已挂实测" :value="reportStore.stats.attachedCount" suffix="次" tone="success" icon="Connection" />
      <StatBadge label="待挂实测" :value="reportStore.stats.pendingLinkCount" suffix="次" tone="warning" icon="RefreshRight" />
      <StatBadge
        label="待修正报汛"
        :value="reportStore.stats.pendingCorrectionCount"
        suffix="单"
        :tone="reportStore.stats.pendingCorrectionCount ? 'danger' : 'success'"
        icon="Warning"
      />
    </div>

    <el-tabs v-model="activeTab" class="reconcile-tabs">
      <el-tab-pane name="duty">
        <template #label>
          <el-badge :value="reportStore.stats.pendingCorrectionCount" :hidden="reportStore.stats.pendingCorrectionCount === 0" type="danger">
            水情值班室台账
          </el-badge>
        </template>

        <el-table :data="filteredReports" border stripe class="gb-table-compact">
          <el-table-column label="报汛时段" min-width="210">
            <template #default="{ row }">
              <div class="gb-mono">{{ new Date(row.report.startedAt).toLocaleString('zh-CN') }}</div>
              <div class="gb-hint gb-mono">至 {{ new Date(row.report.endedAt).toLocaleTimeString('zh-CN') }}</div>
            </template>
          </el-table-column>
          <el-table-column prop="stationName" label="测站" width="130" />
          <el-table-column label="整点水位" width="105" align="right">
            <template #default="{ row }">
              <span class="gb-mono">{{ row.report.hourStageM.toFixed(2) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="报汛 / 重报流量" width="155" align="right">
            <template #default="{ row }">
              <div class="gb-mono">{{ row.report.reportedFlowM3s.toFixed(1) }}</div>
              <div v-if="row.revisedFlowM3s !== null && Math.abs(row.revisedFlowM3s - row.report.reportedFlowM3s) > 0.01" class="gb-mono page__success">
                最近重报 {{ row.revisedFlowM3s.toFixed(1) }}
              </div>
            </template>
          </el-table-column>
          <el-table-column label="实测 / 偏差" width="210">
            <template #default="{ row }">
              <template v-if="row.link">
                <div class="gb-mono">{{ row.link.measuredFlowM3s.toFixed(1) }} m³/s</div>
                <DeviationTag
                  :deviation-pct="row.link.deviationPct"
                  :verdict="Math.abs(row.link.deviationPct) > reportStore.deviationLimitPct ? '超限' : '合格'"
                  :limit="reportStore.deviationLimitPct"
                />
              </template>
              <el-tag v-else size="small" type="info" effect="plain">待测验组挂实测</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="临时关系线 / 段号" width="155">
            <template #default="{ row }">
              <div>{{ row.report.temporaryLineNo }}</div>
              <div class="gb-hint gb-mono">{{ row.report.segmentNo }}</div>
            </template>
          </el-table-column>
          <el-table-column label="修正规则" width="150">
            <template #default="{ row }">
              <el-select
                :model-value="row.report.correctionPolicy"
                size="small"
                @change="(value: string | number | boolean) => changePolicy(row.report, value)"
              >
                <el-option v-for="policy in CORRECTION_POLICIES" :key="policy" :label="policy" :value="policy" />
              </el-select>
            </template>
          </el-table-column>
          <el-table-column label="校正状态 / 操作" width="250" fixed="right">
            <template #default="{ row }">
              <el-tag :type="correctionTagType(row.correction?.status ?? '已失效')" size="small" effect="plain">
                {{ row.correction?.status ?? '暂无待修正' }}
              </el-tag>
              <div class="row-actions">
                <el-button
                  v-if="row.correction?.status === '待修正'"
                  type="primary"
                  size="small"
                  @click="issueCorrection(row.correction)"
                >
                  按规则重报
                </el-button>
                <el-button size="small" :icon="Edit" @click="openEdit(row.report)">改时段</el-button>
                <el-button size="small" type="danger" plain :icon="Delete" @click="removeReport(row.report)" />
              </div>
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>

      <el-tab-pane name="measure">
        <template #label>
          <el-badge :value="reportStore.sectionPendingLinks.length" :hidden="reportStore.sectionPendingLinks.length === 0" type="warning">
            测验组实测挂接
          </el-badge>
        </template>

        <EmptyPanel
          v-if="filteredSections.length === 0"
          title="还没有断面测次"
          description="先在测站台账录入测次、垂线与测点，算出实测断面流量后再回来挂接。"
          compact
        />
        <el-table v-else :data="filteredSections" border stripe class="gb-table-compact">
          <el-table-column prop="section.measureNo" label="测次" min-width="140" />
          <el-table-column prop="stationName" label="测站" width="130" />
          <el-table-column label="测流时刻" min-width="170">
            <template #default="{ row }">
              <span class="gb-mono">{{ new Date(row.section.measuredAt).toLocaleString('zh-CN') }}</span>
            </template>
          </el-table-column>
          <el-table-column label="实测流量" width="130" align="right">
            <template #default="{ row }">
              <span class="gb-mono">{{ row.section.measuredFlowM3s?.toFixed(1) ?? '—' }}</span>
            </template>
          </el-table-column>
          <el-table-column label="覆盖时段" min-width="210">
            <template #default="{ row }">
              <template v-if="row.linkedReport && row.attached">
                <el-tag size="small" type="success" effect="plain">已挂</el-tag>
                <span class="gb-mono table-text">{{ new Date(row.linkedReport.startedAt).toLocaleString('zh-CN') }}</span>
              </template>
              <template v-else-if="row.covers.length > 0">
                <el-tag size="small" type="warning" effect="plain">待挂</el-tag>
                <span class="gb-mono table-text">{{ new Date(row.covers[0].startedAt).toLocaleString('zh-CN') }}</span>
              </template>
              <el-tag v-else size="small" type="danger" effect="plain">无覆盖时段</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="偏差" width="190">
            <template #default="{ row }">
              <DeviationTag
                v-if="row.attached && row.link"
                :deviation-pct="row.link.deviationPct"
                :verdict="Math.abs(row.link.deviationPct) > reportStore.deviationLimitPct ? '超限' : '合格'"
                :limit="reportStore.deviationLimitPct"
              />
              <span v-else class="gb-hint">尚未对账</span>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="270" fixed="right">
            <template #default="{ row }">
              <el-button size="small" @click="recalcSection(row.section.id)">重算实测</el-button>
              <el-button
                v-if="!row.attached && row.covers.length > 0"
                type="primary"
                size="small"
                :icon="Connection"
                @click="attachFirst(row)"
              >
                挂到覆盖时段
              </el-button>
              <el-button v-if="row.attached && row.link" size="small" @click="detach(row.link)">退回待挂</el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>

      <el-tab-pane name="unmatched">
        <template #label>
          <el-badge :value="unmatchedRows.length" :hidden="unmatchedRows.length === 0" type="danger">
            升级待挂 / 对不上
          </el-badge>
        </template>

        <el-alert
          title="旧数据没有实测归属时，升级按时刻回填最近一次实测；站点、时刻对不上的记录在本页单列，不由系统强挂。"
          type="warning"
          show-icon
          :closable="false"
          class="unmatched-alert"
        />
        <el-table :data="unmatchedRows" border stripe class="gb-table-compact">
          <el-table-column prop="stationName" label="测站" width="140" />
          <el-table-column label="原始实测时刻" min-width="170">
            <template #default="{ row }">
              <span class="gb-mono">{{ new Date(row.link.measuredAt).toLocaleString('zh-CN') }}</span>
            </template>
          </el-table-column>
          <el-table-column label="最近实测流量" width="140" align="right">
            <template #default="{ row }">
              <span class="gb-mono">{{ row.link.measuredFlowM3s.toFixed(1) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="测次" width="160">
            <template #default="{ row }">{{ row.section?.measureNo ?? '旧关系点据（无测次）' }}</template>
          </el-table-column>
          <el-table-column prop="link.unmatchedReason" label="单列原因" min-width="280" show-overflow-tooltip />
          <el-table-column label="操作" width="180">
            <template #default="{ row }">
              <el-button
                v-if="row.section"
                size="small"
                type="primary"
                @click="activeTab = 'measure'"
              >
                去人工重挂
              </el-button>
              <el-tag v-else size="small" type="info" effect="plain">仅存档，不参与自动挂接</el-tag>
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>
    </el-tabs>

    <el-card v-if="invalidRows.length > 0" shadow="never" class="gb-panel">
      <div class="gb-panel-title">
        <h3>值班室存档：失效校正单</h3>
        <span class="gb-hint">挂接退回或报汛时段改动后，测验组本侧重挂；值班室这份照旧保留。</span>
      </div>
      <el-table :data="invalidRows" border class="gb-table-compact">
        <el-table-column label="原时段" min-width="180">
          <template #default="{ row }">{{ row.report ? new Date(row.report.startedAt).toLocaleString('zh-CN') : '时段已删除' }}</template>
        </el-table-column>
        <el-table-column prop="correction.policy" label="规则" width="120" />
        <el-table-column label="偏差" width="110" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.correction.deviationPct }}%</span>
          </template>
        </el-table-column>
        <el-table-column prop="correction.note" label="存档原因" min-width="280" show-overflow-tooltip />
      </el-table>
    </el-card>

    <el-dialog v-model="dialogVisible" :title="editingId ? '改动报汛时段' : '新增报汛时段'" width="620px" :close-on-click-modal="false">
      <el-alert
        title="值班室改动起止时间或测站后，若原已挂实测不再被盖住，测验组侧会自动退回“待挂”；值班室校正单保留。"
        type="info"
        :closable="false"
        class="dialog-alert"
      />
      <el-form label-width="120px">
        <el-form-item label="测站" required>
          <el-select v-model="form.stationId" class="page__full">
            <el-option v-for="station in stationStore.stations" :key="station.id" :label="station.name" :value="station.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="开始时间" required>
          <el-date-picker v-model="form.startedAt" type="datetime" value-format="YYYY-MM-DDTHH:mm" />
        </el-form-item>
        <el-form-item label="结束时间" required>
          <el-date-picker v-model="form.endedAt" type="datetime" value-format="YYYY-MM-DDTHH:mm" />
        </el-form-item>
        <el-form-item label="整点水位" required>
          <el-input-number v-model="form.hourStageM" :min="-50" :max="200" :step="0.01" :precision="2" controls-position="right" />
          <span class="page__unit">m</span>
        </el-form-item>
        <el-form-item label="报汛流量" required>
          <el-input-number v-model="form.reportedFlowM3s" :min="0.01" :max="100000" :step="1" :precision="1" controls-position="right" />
          <span class="page__unit">m³/s</span>
        </el-form-item>
        <el-form-item label="临时关系线" required>
          <el-input v-model="form.temporaryLineNo" placeholder="如 临时-A" />
        </el-form-item>
        <el-form-item label="段号" required>
          <el-input v-model="form.segmentNo" placeholder="整段偏移时使用，如 SEG-A1" />
        </el-form-item>
        <el-form-item label="修正规则" required>
          <el-radio-group v-model="form.correctionPolicy">
            <el-radio v-for="policy in CORRECTION_POLICIES" :key="policy" :value="policy">{{ policy }}</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="值班员">
          <el-input v-model="form.reporter" maxlength="20" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitReport">保存</el-button>
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

.page__actions,
.row-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.page__station-select {
  width: 160px;
}

.page__unit {
  margin-left: 8px;
  font-size: 12px;
  color: #8194a2;
}

.page__full {
  width: 100%;
}

.page__success {
  color: #188a5a;
  font-weight: 700;
}

.page__muted {
  color: #93a3af;
  text-decoration: line-through;
}

.table-text {
  margin-left: 8px;
  font-size: 12px;
}

.reconcile-tabs :deep(.el-tabs__content) {
  padding-top: 4px;
}

.unmatched-alert,
.dialog-alert {
  margin-bottom: 12px;
}
</style>
