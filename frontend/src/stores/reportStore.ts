/**
 * 报汛对账 store：水情值班室维护报汛时段，测验组维护实测挂接。
 * 两侧记录分开保存；报汛时段改动导致不再覆盖实测时，实测侧退回待挂，值班室校正单存档。
 */
import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { db, createId, watchTable } from '@/utils/db'
import type { Section } from '@/types/section'
import type { Station } from '@/types/station'
import {
  calcReportDeviationPct,
  isReportDeviationOverLimit,
  isTimeCovered,
  REPORT_DEVIATION_LIMIT_PCT,
  type CorrectionPolicy,
  type ReportPeriod,
  type ReportPeriodDraft
} from '@/types/reportPeriod'
import type { FlowCorrection, MeasurementLink, ReportReconcileRow } from '@/types/flowCorrection'

export const useReportStore = defineStore('report', () => {
  const reports = ref<ReportPeriod[]>([])
  const links = ref<MeasurementLink[]>([])
  const corrections = ref<FlowCorrection[]>([])
  const sections = ref<Section[]>([])
  const stations = ref<Station[]>([])
  const ready = ref(false)
  const error = ref<string | null>(null)
  const deviationLimitPct = ref(REPORT_DEVIATION_LIMIT_PCT)

  let started = false

  function start(): void {
    if (started) return
    started = true
    watchTable<ReportPeriod>(() => db.reportPeriods).subscribe((rows) => {
      reports.value = rows.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))
      ready.value = true
    })
    watchTable<MeasurementLink>(() => db.measurementLinks).subscribe((rows) => {
      links.value = rows
    })
    watchTable<FlowCorrection>(() => db.flowCorrections).subscribe((rows) => {
      corrections.value = rows
    })
    watchTable<Section>(() => db.sections).subscribe((rows) => {
      sections.value = rows
    })
    watchTable<Station>(() => db.stations).subscribe((rows) => {
      stations.value = rows
    })

    // 测次时刻、所属测站或实测流量变化后，自动校对已挂归属；不再被盖住就退回待挂。
    watch(sections, validateLinksWithSections, { deep: true })
  }

  const stationName = (stationId: string): string =>
    stations.value.find((station) => station.id === stationId)?.name ?? '未知测站'

  function reportsOfStation(stationId: string): ReportPeriod[] {
    return reports.value
      .filter((report) => report.stationId === stationId)
      .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
  }

  function coveringReports(section: Pick<Section, 'stationId' | 'measuredAt'>): ReportPeriod[] {
    return reports.value
      .filter(
        (report) =>
          report.stationId === section.stationId && isTimeCovered(report.startedAt, report.endedAt, section.measuredAt)
      )
      .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
  }

  function activeLinkOfSection(sectionId: string): MeasurementLink | null {
    return links.value
      .filter((link) => link.sectionId === sectionId && link.status === '已挂')
      .sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null
  }

  function linkOfSection(sectionId: string): MeasurementLink | null {
    return (
      links.value
        .filter((link) => link.sectionId === sectionId)
        .sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null
    )
  }

  function reportById(id: string | null | undefined): ReportPeriod | null {
    return id ? reports.value.find((report) => report.id === id) ?? null : null
  }

  function activeCorrectionOfReport(reportId: string): FlowCorrection | null {
    return (
      corrections.value
        .filter((correction) => correction.reportPeriodId === reportId && correction.status !== '已失效')
        .sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null
    )
  }

  function activeCorrectionOfLink(linkId: string): FlowCorrection | null {
    return corrections.value.find((item) => item.measurementLinkId === linkId && item.status !== '已失效') ?? null
  }

  const pendingLinks = computed<MeasurementLink[]>(() =>
    links.value
      .filter((link) => link.status === '待挂')
      .sort((a, b) => Date.parse(b.measuredAt) - Date.parse(a.measuredAt))
  )

  const pendingCorrections = computed<FlowCorrection[]>(() =>
    corrections.value
      .filter((correction) => correction.status === '待修正')
      .sort((a, b) => b.updatedAt - a.updatedAt)
  )

  const invalidCorrections = computed<FlowCorrection[]>(() =>
    corrections.value.filter((correction) => correction.status === '已失效')
  )

  const unmatchedLinks = computed<MeasurementLink[]>(() =>
    pendingLinks.value.filter((link) => link.unmatchedReason || !link.sectionId)
  )

  const sectionPendingLinks = computed<MeasurementLink[]>(() =>
    pendingLinks.value.filter((link) => link.sectionId && !link.unmatchedReason)
  )

  function currentRevisedFlow(report: ReportPeriod): number | null {
    const reissued = corrections.value
      .filter((correction) => correction.status === '已重报')
      .sort((a, b) => (b.reissuedAt ? Date.parse(b.reissuedAt) : 0) - (a.reissuedAt ? Date.parse(a.reissuedAt) : 0))
    for (const correction of reissued) {
      const value = correction.revisedFlowByReportId[report.id]
      if (typeof value === 'number') return value
    }
    return null
  }

  /** 值班台账：每个报汛时段 + 盖住时段内偏差最大的实测 + 当前校正状态 */
  const reportRows = computed<ReportReconcileRow[]>(() =>
    reports.value.map((report) => {
      const reportLinks = links.value.filter((link) => link.status === '已挂' && link.reportPeriodId === report.id)
      const link = reportLinks.sort((a, b) => Math.abs(b.deviationPct) - Math.abs(a.deviationPct))[0] ?? null
      const correction = activeCorrectionOfReport(report.id)
      return {
        report,
        stationName: stationName(report.stationId),
        link,
        correction,
        revisedFlowM3s: currentRevisedFlow(report)
      }
    })
  )

  const stats = computed(() => ({
    reportCount: reports.value.length,
    attachedCount: links.value.filter((link) => link.status === '已挂').length,
    pendingLinkCount: pendingLinks.value.length,
    pendingCorrectionCount: pendingCorrections.value.length,
    overLimitAttachedCount: links.value.filter(
      (link) => link.status === '已挂' && isReportDeviationOverLimit(link.deviationPct, deviationLimitPct.value)
    ).length
  }))

  async function createReport(payload: ReportPeriodDraft): Promise<ReportPeriod> {
    const now = Date.now()
    const row: ReportPeriod = { ...payload, id: createId('rpt'), createdAt: now, updatedAt: now }
    await db.reportPeriods.put(row)
    return row
  }

  async function updateReport(id: string, patch: Partial<ReportPeriodDraft>): Promise<void> {
    const previous = await db.reportPeriods.get(id)
    if (!previous) return
    const next = { ...previous, ...patch }
    const coverageChanged =
      patch.startedAt !== undefined ||
      patch.endedAt !== undefined ||
      (patch.stationId !== undefined && patch.stationId !== previous.stationId)
    const reportedFlowChanged =
      patch.reportedFlowM3s !== undefined && patch.reportedFlowM3s !== previous.reportedFlowM3s

    await db.transaction(
      'rw',
      [db.reportPeriods, db.measurementLinks, db.flowCorrections],
      async () => {
        await db.reportPeriods.put({ ...next, updatedAt: Date.now() })
        const attached = await db.measurementLinks
          .where('reportPeriodId')
          .equals(id)
          .toArray()
          .then((rows) => rows.filter((row) => row.status === '已挂'))

        for (const link of attached) {
          const stillCovered =
            next.stationId === link.stationId && isTimeCovered(next.startedAt, next.endedAt, link.measuredAt)
          if (coverageChanged && !stillCovered) {
            await db.measurementLinks.update(link.id, {
              status: '待挂',
              reportPeriodId: null,
              reportedFlowM3s: null,
              deviationPct: 0,
              unmatchedReason: '原报汛时段已改动且不再覆盖该测流时刻，测验组需重挂',
              updatedAt: Date.now()
            } as never)
            await db.flowCorrections
              .where('measurementLinkId')
              .equals(link.id)
              .modify((correction: FlowCorrection) => {
                if (correction.status !== '已失效') {
                  correction.status = '已失效'
                  correction.note = `${correction.note}｜报汛时段改动，挂接已退回待挂，值班室校正单存档`.trim()
                  correction.updatedAt = Date.now()
                }
              })
          } else if (reportedFlowChanged) {
            const deviation = calcReportDeviationPct(link.measuredFlowM3s, next.reportedFlowM3s)
            await db.measurementLinks.update(link.id, {
              reportedFlowM3s: next.reportedFlowM3s,
              deviationPct: deviation,
              updatedAt: Date.now()
            } as never)
            await db.flowCorrections
              .where('measurementLinkId')
              .equals(link.id)
              .modify((correction: FlowCorrection) => {
                if (correction.status === '待修正') {
                  correction.originalReportedFlowM3s = next.reportedFlowM3s
                  correction.deviationPct = deviation
                  correction.updatedAt = Date.now()
                }
              })
          }
        }
      }
    )
  }

  async function removeReport(id: string): Promise<void> {
    await db.transaction('rw', [db.reportPeriods, db.measurementLinks, db.flowCorrections], async () => {
      const attached = await db.measurementLinks.where('reportPeriodId').equals(id).toArray()
      for (const link of attached) {
        await db.measurementLinks.update(link.id, {
          status: '待挂',
          reportPeriodId: null,
          reportedFlowM3s: null,
          deviationPct: 0,
          unmatchedReason: '原报汛时段已删除，测验组需重挂',
          updatedAt: Date.now()
        } as never)
      }
      await db.flowCorrections.where('reportPeriodId').equals(id).modify((correction: FlowCorrection) => {
        if (correction.status !== '已失效') {
          correction.status = '已失效'
          correction.note = `${correction.note}｜原报汛时段已删除，校正单存档`.trim()
          correction.updatedAt = Date.now()
        }
      })
      await db.reportPeriods.delete(id)
    })
  }

  async function setCorrectionPolicy(id: string, policy: CorrectionPolicy): Promise<void> {
    await db.reportPeriods.update(id, { correctionPolicy: policy, updatedAt: Date.now() } as never)
  }

  async function attachMeasurement(sectionId: string, reportPeriodId: string): Promise<MeasurementLink> {
    const section = await db.sections.get(sectionId)
    const report = await db.reportPeriods.get(reportPeriodId)
    if (!section || !report) throw new Error('实测测次或报汛时段不存在')
    if (typeof section.measuredFlowM3s !== 'number' || section.measuredFlowM3s <= 0) {
      throw new Error('该测次尚无实测断面流量，请先在测验组侧计算或登记')
    }
    if (!isTimeCovered(report.startedAt, report.endedAt, section.measuredAt) || section.stationId !== report.stationId) {
      throw new Error('所选报汛时段没有盖住该测流时刻或测站不一致')
    }

    const now = Date.now()
    const deviation = calcReportDeviationPct(section.measuredFlowM3s, report.reportedFlowM3s)
    const existing = await db.measurementLinks
      .where('sectionId')
      .equals(sectionId)
      .toArray()
      .then((rows) => rows.sort((a, b) => b.updatedAt - a.updatedAt)[0])

    const link: MeasurementLink = {
      id: existing?.id ?? createId('lnk'),
      sectionId: section.id,
      stationId: section.stationId,
      reportPeriodId: report.id,
      measuredAt: section.measuredAt,
      measuredFlowM3s: section.measuredFlowM3s,
      reportedFlowM3s: report.reportedFlowM3s,
      deviationPct: deviation,
      status: '已挂',
      unmatchedReason: '',
      linkedAt: now,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    }
    await db.measurementLinks.put(link)

    if (isReportDeviationOverLimit(deviation, deviationLimitPct.value)) {
      await db.flowCorrections.put({
        id: createId('cor'),
        stationId: report.stationId,
        reportPeriodId: report.id,
        sectionId: section.id,
        measurementLinkId: link.id,
        policy: report.correctionPolicy,
        segmentNo: report.segmentNo,
        originalReportedFlowM3s: report.reportedFlowM3s,
        measuredFlowM3s: section.measuredFlowM3s,
        deviationPct: deviation,
        affectedReportPeriodIds: [],
        revisedFlowByReportId: {},
        status: '待修正',
        decidedBy: '系统按偏差阈值提出',
        decidedAt: new Date(now).toISOString(),
        reissuedAt: null,
        note: `实测与报汛偏差 ${deviation}%，超过 ${deviationLimitPct.value}% 限值`,
        createdAt: now,
        updatedAt: now
      })
    }
    return link
  }

  async function detachMeasurement(linkId: string): Promise<void> {
    const now = Date.now()
    await db.measurementLinks.update(linkId, {
      status: '待挂',
      reportPeriodId: null,
      reportedFlowM3s: null,
      deviationPct: 0,
      unmatchedReason: '测验组人工退回待挂，值班室校正单保留',
      updatedAt: now
    } as never)
  }

  /** 自动把一次实测挂到盖住它的最新报汛时段；未盖住时保留/生成待挂记录 */
  async function ensureSectionLink(sectionId: string): Promise<MeasurementLink | null> {
    const section = await db.sections.get(sectionId)
    if (!section) return null
    const cover = coveringReports(section)[0]
    const existing = linkOfSection(sectionId)
    if (!cover) {
      const now = Date.now()
      const row: MeasurementLink = {
        id: existing?.id ?? createId('lnk'),
        sectionId: section.id,
        stationId: section.stationId,
        reportPeriodId: null,
        measuredAt: section.measuredAt,
        measuredFlowM3s: typeof section.measuredFlowM3s === 'number' ? section.measuredFlowM3s : 0,
        reportedFlowM3s: null,
        deviationPct: 0,
        status: '待挂',
        unmatchedReason: '当前没有盖住该测流时刻的报汛时段',
        linkedAt: existing?.linkedAt ?? now,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      }
      await db.measurementLinks.put(row)
      return row
    }
    return attachMeasurement(sectionId, cover.id)
  }

  async function issueCorrection(correctionId: string): Promise<FlowCorrection> {
    const correction = await db.flowCorrections.get(correctionId)
    if (!correction) throw new Error('校正单不存在')
    if (correction.status !== '待修正') throw new Error('只有待修正校正单可以重报')
    const source = await db.reportPeriods.get(correction.reportPeriodId)
    if (!source) throw new Error('原报汛时段不存在')

    const sameSegment = reports.value.filter(
      (report) =>
        report.stationId === correction.stationId &&
        report.temporaryLineNo === source.temporaryLineNo &&
        report.segmentNo === correction.segmentNo
    )
    const affected = correction.policy === '整段偏移' ? sameSegment : [source]
    const offset = correction.measuredFlowM3s - correction.originalReportedFlowM3s
    const revisedFlowByReportId: Record<string, number> = {}
    affected.forEach((report) => {
      revisedFlowByReportId[report.id] =
        correction.policy === '整段偏移'
          ? Number((report.reportedFlowM3s + offset).toFixed(2))
          : correction.measuredFlowM3s
    })

    const now = new Date()
    await db.transaction('rw', [db.reportPeriods, db.flowCorrections, db.measurementLinks], async () => {
      for (const report of affected) {
        const revised = revisedFlowByReportId[report.id]
        await db.reportPeriods.update(report.id, { reportedFlowM3s: revised, updatedAt: Date.now() } as never)
        const reportLinks = await db.measurementLinks.where('reportPeriodId').equals(report.id).toArray()
        for (const link of reportLinks) {
          await db.measurementLinks.update(link.id, {
            reportedFlowM3s: revised,
            deviationPct: calcReportDeviationPct(link.measuredFlowM3s, revised),
            updatedAt: Date.now()
          } as never)
        }
      }
      await db.flowCorrections.update(correctionId, {
        affectedReportPeriodIds: affected.map((report) => report.id),
        revisedFlowByReportId,
        status: '已重报',
        reissuedAt: now.toISOString(),
        updatedAt: Date.now()
      } as never)
    })
    return db.flowCorrections.get(correctionId) as Promise<FlowCorrection>
  }

  async function removeCorrection(id: string): Promise<void> {
    await db.flowCorrections.delete(id)
  }

  async function validateLinksWithSections(): Promise<void> {
    if (sections.value.length === 0) return
    for (const link of links.value.filter((item) => item.status === '已挂')) {
      const section = sections.value.find((item) => item.id === link.sectionId)
      const report = reportById(link.reportPeriodId)
      if (!section || !report) continue
      const covered =
        section.stationId === report.stationId && isTimeCovered(report.startedAt, report.endedAt, section.measuredAt)
      if (!covered) {
        await db.measurementLinks.update(link.id, {
          stationId: section.stationId,
          measuredAt: section.measuredAt,
          status: '待挂',
          reportPeriodId: null,
          reportedFlowM3s: null,
          deviationPct: 0,
          unmatchedReason: '测次时刻或所属测站已变化，原报汛时段不再覆盖，需重挂',
          updatedAt: Date.now()
        } as never)
        continue
      }
      if (
        typeof section.measuredFlowM3s === 'number' &&
        Math.abs(section.measuredFlowM3s - link.measuredFlowM3s) > 0.001
      ) {
        const deviation = calcReportDeviationPct(section.measuredFlowM3s, report.reportedFlowM3s)
        const needsMetaUpdate = link.measuredAt !== section.measuredAt || link.stationId !== section.stationId
        await db.measurementLinks.update(link.id, {
          stationId: section.stationId,
          measuredAt: section.measuredAt,
          measuredFlowM3s: section.measuredFlowM3s,
          deviationPct: deviation,
          updatedAt: Date.now()
        } as never)
        await db.flowCorrections.where('measurementLinkId').equals(link.id).modify((correction: FlowCorrection) => {
          if (correction.status === '待修正') {
            correction.measuredFlowM3s = section.measuredFlowM3s as number
            correction.deviationPct = deviation
            correction.updatedAt = Date.now()
          }
        })
        if (needsMetaUpdate) return
      } else if (link.measuredAt !== section.measuredAt || link.stationId !== section.stationId) {
        await db.measurementLinks.update(link.id, {
          stationId: section.stationId,
          measuredAt: section.measuredAt,
          updatedAt: Date.now()
        } as never)
      }
    }
  }

  return {
    reports,
    links,
    corrections,
    sections,
    stations,
    ready,
    error,
    deviationLimitPct,
    reportRows,
    pendingLinks,
    pendingCorrections,
    invalidCorrections,
    unmatchedLinks,
    sectionPendingLinks,
    stats,
    start,
    stationName,
    reportsOfStation,
    coveringReports,
    reportById,
    activeLinkOfSection,
    linkOfSection,
    activeCorrectionOfReport,
    activeCorrectionOfLink,
    createReport,
    updateReport,
    removeReport,
    setCorrectionPolicy,
    attachMeasurement,
    detachMeasurement,
    ensureSectionLink,
    issueCorrection,
    removeCorrection,
    validateLinksWithSections
  }
})
