/**
 * 报汛对账 store：维护报汛时段（值班室侧）与实测挂接校正（测验组侧）。
 * 实测流量和实时报汛各记各的，两边按测流时刻对账：
 * 每次测完把实测挂到盖住它的那条报汛时段上，实测值和报汛值摆一起比，
 * 差得多的给这次报汛挂待修正，值班室据此按本站商量定的修正策略重报。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { db, createId, watchTable } from '@/utils/db'
import type { Station } from '@/types/station'
import type { Section } from '@/types/section'
import type { Vertical } from '@/types/vertical'
import type { Point } from '@/types/point'
import type { CorrectionPolicy, FloodReport } from '@/types/report'
import {
  CORRECTION_POLICIES,
  DEFAULT_CORRECTION_POLICY,
  findCoveringReport,
  findSegmentReports,
  matchLatestSection
} from '@/types/report'
import type { Correction, CorrectionOrigin } from '@/types/correction'
import { calcReportDeviationPct, isReportDeviationOver } from '@/types/correction'
import { round, sectionFlowFromRows } from '@/utils/flow'

/** 对账动作回执：页面统一按 ok 提示成功或失败原因 */
export interface ReconcileResult {
  ok: boolean
  message: string
}

export const useReportStore = defineStore('report', () => {
  const reports = ref<FloodReport[]>([])
  const corrections = ref<Correction[]>([])
  const sections = ref<Section[]>([])
  const stations = ref<Station[]>([])
  const verticals = ref<Vertical[]>([])
  const points = ref<Point[]>([])
  const ready = ref(false)
  const error = ref<string | null>(null)
  /** 对账页当前选中的测站 */
  const activeStationId = ref<string | null>(null)

  let started = false

  function start(): void {
    if (started) return
    started = true
    watchTable<FloodReport>(() => db.reports).subscribe((rows) => {
      reports.value = rows
      ready.value = true
      error.value = null
    })
    watchTable<Correction>(() => db.corrections).subscribe((rows) => {
      corrections.value = rows
    })
    watchTable<Section>(() => db.sections).subscribe((rows) => {
      sections.value = rows
    })
    watchTable<Station>(() => db.stations).subscribe((rows) => {
      stations.value = rows
      if (activeStationId.value === null && rows.length > 0) activeStationId.value = rows[0].id
    })
    watchTable<Vertical>(() => db.verticals).subscribe((rows) => {
      verticals.value = rows
    })
    watchTable<Point>(() => db.points).subscribe((rows) => {
      points.value = rows
    })
  }

  const stationNameOf = (stationId: string): string =>
    stations.value.find((station) => station.id === stationId)?.name ?? '未知测站'

  function setActiveStation(id: string | null): void {
    activeStationId.value = id
  }

  /** 当前测站的修正策略（两边商量定，页面写明照哪条走） */
  const policy = computed<CorrectionPolicy>(
    () =>
      stations.value.find((station) => station.id === activeStationId.value)?.correctionPolicy ??
      DEFAULT_CORRECTION_POLICY
  )

  const policyInfo = computed(
    () => CORRECTION_POLICIES.find((item) => item.value === policy.value) ?? CORRECTION_POLICIES[0]
  )

  /** 当前站报汛时段（按时段起点升序） */
  const stationReports = computed<FloodReport[]>(() =>
    reports.value
      .filter((report) => report.stationId === activeStationId.value)
      .sort((a, b) => Date.parse(a.periodStart) - Date.parse(b.periodStart))
  )

  /** 报汛 id → 最新一条已挂校正（一条报汛可被多次测流挂接，展示取最新） */
  const attachedByReport = computed<Record<string, Correction>>(() => {
    const map: Record<string, Correction> = {}
    corrections.value
      .filter((item) => item.status === '已挂')
      .sort((a, b) => Date.parse(a.attachedAt) - Date.parse(b.attachedAt))
      .forEach((item) => {
        map[item.reportId] = item
      })
    return map
  })

  /** 校正行：校正 + 报汛 + 测次，供对账表展示（报汛或测次被删时保留行并标注） */
  const correctionRows = computed(() =>
    corrections.value
      .map((correction) => ({
        correction,
        report: reports.value.find((report) => report.id === correction.reportId) ?? null,
        section: sections.value.find((section) => section.id === correction.sectionId) ?? null
      }))
      .filter((row) => {
        const stationId = row.report?.stationId ?? row.section?.stationId ?? null
        return stationId === activeStationId.value
      })
      .sort((a, b) => Date.parse(b.correction.attachedAt) - Date.parse(a.correction.attachedAt))
  )

  /** 待挂校正：值班室改动报汛时段后失效退回，待测验组本侧重挂 */
  const pendingCorrections = computed(() =>
    correctionRows.value.filter((row) => row.correction.status === '待挂')
  )

  /** 待修正报汛（当前站） */
  const flaggedReports = computed(() => stationReports.value.filter((report) => report.status === '待修正'))

  /** 未挂实测的报汛（对不上的单列）：没有任何校正归属 */
  const unmatchedReports = computed<FloodReport[]>(() =>
    stationReports.value.filter(
      (report) => !corrections.value.some((item) => item.reportId === report.id)
    )
  )

  /** 当前站未挂接的实测测次：没有已挂校正的，等待挂到盖住它的报汛时段 */
  const unattachedSections = computed<Section[]>(() =>
    sections.value
      .filter((section) => section.stationId === activeStationId.value)
      .filter(
        (section) =>
          !corrections.value.some((item) => item.sectionId === section.id && item.status === '已挂')
      )
      .sort((a, b) => Date.parse(b.measuredAt) - Date.parse(a.measuredAt))
  )

  /** 测次 id → 实测断面流量（测验组口径现算，数据量小直接同步算） */
  const sectionFlows = computed<Record<string, number>>(() => {
    const map: Record<string, number> = {}
    sections.value.forEach((section) => {
      map[section.id] = sectionFlowFromRows(verticals.value, points.value, section.id)
    })
    return map
  })

  /** 全局待办数（导航徽标）：待修正报汛 + 待挂校正 */
  const attentionCount = computed<number>(
    () =>
      reports.value.filter((report) => report.status === '待修正').length +
      corrections.value.filter((item) => item.status === '待挂').length
  )

  /** 实测断面流量：挂接时从库表现算，保证与测验组一侧口径一致 */
  async function computeSectionFlow(sectionId: string): Promise<number> {
    const verticalRows = await db.verticals.where('sectionId').equals(sectionId).toArray()
    const verticalIds = verticalRows.map((row) => row.id)
    const pointRows =
      verticalIds.length > 0 ? await db.points.where('verticalId').anyOf(verticalIds).toArray() : []
    return sectionFlowFromRows(verticalRows, pointRows, sectionId)
  }

  async function createReport(
    payload: Omit<FloodReport, 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<FloodReport> {
    const now = Date.now()
    const row: FloodReport = { ...payload, id: createId('rep'), createdAt: now, updatedAt: now }
    await db.reports.put(row)
    return row
  }

  /**
   * 值班室改动报汛时段：挂上去的校正跟着失效退回待挂（同事务），
   * 测验组本侧重挂，值班室这份报汛照旧保留新值。
   * 返回失效退回的校正条数。
   */
  async function updateReport(id: string, patch: Partial<FloodReport>): Promise<number> {
    const now = Date.now()
    let invalidated = 0
    await db.transaction('rw', [db.reports, db.corrections], async () => {
      await db.reports.update(id, { ...patch, updatedAt: now } as never)
      invalidated = await db.corrections
        .where('reportId')
        .equals(id)
        .and((item) => item.status === '已挂')
        .modify((item) => {
          item.status = '待挂'
          item.updatedAt = now
        })
    })
    return invalidated
  }

  async function removeReport(id: string): Promise<void> {
    await db.transaction('rw', [db.reports, db.corrections], async () => {
      await db.corrections.where('reportId').equals(id).delete()
      await db.reports.delete(id)
    })
  }

  /**
   * 挂接 / 重挂共用的写校正逻辑：实测值和报汛值摆一起比，
   * 差得多的给这次报汛挂待修正；重挂后偏差回到限值内的，待修正自动销号。
   */
  async function putCorrection(
    existing: Correction | null,
    report: FloodReport,
    section: Section,
    origin: CorrectionOrigin
  ): Promise<Correction> {
    const measuredFlowM3s = await computeSectionFlow(section.id)
    const deviationPct = calcReportDeviationPct(measuredFlowM3s, report.reportedFlowM3s)
    const now = Date.now()
    const row: Correction = {
      id: existing?.id ?? createId('cor'),
      reportId: report.id,
      sectionId: section.id,
      measuredFlowM3s,
      reportedFlowM3s: report.reportedFlowM3s,
      deviationPct,
      status: '已挂',
      origin,
      attachedAt: new Date(now).toISOString(),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    }
    await db.transaction('rw', [db.reports, db.corrections], async () => {
      await db.corrections.put(row)
      if (isReportDeviationOver(deviationPct)) {
        if (report.status !== '已重报') {
          await db.reports.update(report.id, { status: '待修正', updatedAt: now } as never)
        }
      } else if (report.status === '待修正') {
        await db.reports.update(report.id, { status: '正常', updatedAt: now } as never)
      }
    })
    return row
  }

  /** 测验组挂接：每次测完把实测挂到盖住它的那条报汛时段上 */
  async function attachSection(sectionId: string): Promise<ReconcileResult> {
    const section =
      sections.value.find((item) => item.id === sectionId) ?? (await db.sections.get(sectionId))
    if (!section) return { ok: false, message: '测次不存在或已删除' }
    const duplicated = corrections.value.some(
      (item) => item.sectionId === sectionId && item.status === '已挂'
    )
    if (duplicated) return { ok: false, message: '该测次已挂接，无需重复挂' }
    const report = findCoveringReport(reports.value, section.stationId, section.measuredAt)
    if (!report) {
      return { ok: false, message: '没有盖住该测流时刻的报汛时段，请先由值班室补报该时段' }
    }
    // 该测次若留有失效退回的待挂校正，重挂复用原记录
    const existing =
      corrections.value.find((item) => item.sectionId === sectionId && item.status === '待挂') ??
      null
    const row = await putCorrection(existing, report, section, existing?.origin ?? '测验挂接')
    const over = isReportDeviationOver(row.deviationPct)
    return {
      ok: true,
      message: `已挂到 ${report.periodStart.slice(0, 16).replace('T', ' ')} 时段：实测 ${row.measuredFlowM3s} ↔ 报汛 ${row.reportedFlowM3s} m³/s，偏差 ${row.deviationPct}%${over ? '，已给这次报汛挂待修正' : ''}`
    }
  }

  /** 测验组本侧重挂：值班室改动退回的待挂校正挂回原报汛；原报汛已删则重找盖住的时段 */
  async function reattachCorrection(correctionId: string): Promise<ReconcileResult> {
    const correction = corrections.value.find((item) => item.id === correctionId)
    if (!correction) return { ok: false, message: '校正记录不存在' }
    if (correction.status === '已挂') return { ok: false, message: '该校正已在挂，无需重挂' }
    const section = sections.value.find((item) => item.id === correction.sectionId)
    if (!section) return { ok: false, message: '原测次已删除，无法重挂' }
    const report =
      reports.value.find((item) => item.id === correction.reportId) ??
      findCoveringReport(reports.value, section.stationId, section.measuredAt)
    if (!report) {
      return { ok: false, message: '原报汛已删除且没有盖住测流时刻的时段，无法重挂' }
    }
    const row = await putCorrection(correction, report, section, correction.origin)
    return {
      ok: true,
      message: `已重挂：实测 ${row.measuredFlowM3s} ↔ 报汛 ${row.reportedFlowM3s} m³/s，偏差 ${row.deviationPct}%`
    }
  }

  /**
   * 值班室据此重报：按本站商量定的修正策略执行。
   * single 只改这一次报汛；segment 整段都照实测偏移量重报。
   * 重报后同步刷新挂在这些时段上的校正快照，保持已挂。
   */
  async function applyCorrection(reportId: string): Promise<ReconcileResult> {
    const report = reports.value.find((item) => item.id === reportId)
    if (!report) return { ok: false, message: '报汛时段不存在或已删除' }
    const correction = corrections.value
      .filter((item) => item.reportId === reportId && item.status === '已挂')
      .sort((a, b) => Date.parse(b.attachedAt) - Date.parse(a.attachedAt))[0]
    if (!correction) return { ok: false, message: '该报汛没有已挂的实测校正，无法据此重报' }
    const station = stations.value.find((item) => item.id === report.stationId)
    const currentPolicy = station?.correctionPolicy ?? DEFAULT_CORRECTION_POLICY
    const delta = round(correction.measuredFlowM3s - report.reportedFlowM3s, 3)
    const now = Date.now()
    const iso = new Date(now).toISOString()
    const targets = currentPolicy === 'segment' ? findSegmentReports(reports.value, report) : [report]
    await db.transaction('rw', [db.reports, db.corrections], async () => {
      for (const item of targets) {
        const nextFlow = round(item.reportedFlowM3s + delta, 2)
        await db.reports.update(item.id, {
          reportedFlowM3s: nextFlow,
          status: '已重报',
          reportedAt: iso,
          updatedAt: now
        } as never)
        // 同步刷新挂在这些时段上的校正快照：偏差按新报汛值重算，保持已挂
        const attached = await db.corrections
          .where('reportId')
          .equals(item.id)
          .and((row) => row.status === '已挂')
          .toArray()
        for (const row of attached) {
          await db.corrections.update(row.id, {
            reportedFlowM3s: nextFlow,
            deviationPct: calcReportDeviationPct(row.measuredFlowM3s, nextFlow),
            updatedAt: now
          } as never)
        }
      }
    })
    return {
      ok: true,
      message:
        currentPolicy === 'segment'
          ? `已按「整段照实测偏移重报」执行：偏移 ${delta > 0 ? '+' : ''}${delta} m³/s，整段 ${targets.length} 条时段一并重报`
          : `已按「只改本次报汛」执行：该时段报汛流量改为实测值 ${correction.measuredFlowM3s} m³/s`
    }
  }

  /** 切换本站修正策略（两边商量定后在此改，页面写明照哪条走） */
  async function setPolicy(stationId: string, next: CorrectionPolicy): Promise<void> {
    await db.stations.update(stationId, { correctionPolicy: next, updatedAt: Date.now() } as never)
  }

  /**
   * 旧数据回填：没有实测归属的报汛，照时刻回填最近一次实测；
   * 对不上的保持未匹配，由页面单列。
   */
  async function backfill(): Promise<{ attached: number; unmatched: number }> {
    const targets = reports.value.filter(
      (report) => !corrections.value.some((item) => item.reportId === report.id)
    )
    let attached = 0
    const now = Date.now()
    for (const report of targets) {
      const section = matchLatestSection(sections.value, report)
      if (!section) continue
      const measuredFlowM3s = await computeSectionFlow(section.id)
      const deviationPct = calcReportDeviationPct(measuredFlowM3s, report.reportedFlowM3s)
      const row: Correction = {
        id: createId('cor'),
        reportId: report.id,
        sectionId: section.id,
        measuredFlowM3s,
        reportedFlowM3s: report.reportedFlowM3s,
        deviationPct,
        status: '已挂',
        origin: '升级回填',
        attachedAt: new Date(now).toISOString(),
        createdAt: now,
        updatedAt: now
      }
      await db.corrections.put(row)
      if (isReportDeviationOver(deviationPct) && report.status === '正常') {
        await db.reports.update(report.id, { status: '待修正', updatedAt: now } as never)
      }
      attached += 1
    }
    return { attached, unmatched: targets.length - attached }
  }

  return {
    reports,
    corrections,
    sections,
    stations,
    ready,
    error,
    activeStationId,
    policy,
    policyInfo,
    stationReports,
    attachedByReport,
    correctionRows,
    pendingCorrections,
    flaggedReports,
    unmatchedReports,
    unattachedSections,
    sectionFlows,
    attentionCount,
    start,
    setActiveStation,
    stationNameOf,
    createReport,
    updateReport,
    removeReport,
    attachSection,
    reattachCorrection,
    applyCorrection,
    setPolicy,
    backfill
  }
})
