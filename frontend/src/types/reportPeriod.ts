/** 报汛修正协商规则：只改本次，或按本次实测偏移重报整段 */
export type CorrectionPolicy = '单次修正' | '整段偏移'

export const CORRECTION_POLICIES: CorrectionPolicy[] = ['单次修正', '整段偏移']

/** 实测流量与报汛流量偏差超过该限值时，报汛记录挂“待修正” */
export const REPORT_DEVIATION_LIMIT_PCT = 10

/** 水情值班室报汛时段：按整点水位查临时关系线得到报汛流量 */
export interface ReportPeriod {
  id: string
  stationId: string
  /** 时段开始（含），通常为整点 */
  startedAt: string
  /** 时段结束（不含） */
  endedAt: string
  /** 整点水位（m） */
  hourStageM: number
  /** 报汛流量（m³/s），来自临时关系线 */
  reportedFlowM3s: number
  /** 临时关系线号 */
  temporaryLineNo: string
  /** 整段偏移时使用的段号；同站、同临时线、同段号一起重报 */
  segmentNo: string
  /** 测验组与值班室协商后确定的修正规则 */
  correctionPolicy: CorrectionPolicy
  /** 值班员 */
  reporter: string
  createdAt: number
  updatedAt: number
}

export interface ReportPeriodDraft {
  stationId: string
  startedAt: string
  endedAt: string
  hourStageM: number
  reportedFlowM3s: number
  temporaryLineNo: string
  segmentNo: string
  correctionPolicy: CorrectionPolicy
  reporter: string
}

export function createEmptyReportDraft(stationId = ''): ReportPeriodDraft {
  const start = new Date()
  start.setMinutes(0, 0, 0)
  const end = new Date(start.getTime() + 60 * 60 * 1000)
  return {
    stationId,
    startedAt: start.toISOString().slice(0, 16),
    endedAt: end.toISOString().slice(0, 16),
    hourStageM: 0,
    reportedFlowM3s: 0,
    temporaryLineNo: '临时-A',
    segmentNo: 'SEG-1',
    correctionPolicy: '单次修正',
    reporter: '值班室'
  }
}

/** 判断测流时刻是否落在报汛时段内（开始含、结束不含） */
export function isTimeCovered(startedAt: string, endedAt: string, measuredAt: string): boolean {
  const start = Date.parse(startedAt)
  const end = Date.parse(endedAt)
  const time = Date.parse(measuredAt)
  return Number.isFinite(start) && Number.isFinite(end) && Number.isFinite(time) && time >= start && time < end
}

/** 报汛相对实测的偏差：(报汛 - 实测) / 实测 × 100 */
export function calcReportDeviationPct(measuredFlowM3s: number, reportedFlowM3s: number): number {
  if (!Number.isFinite(measuredFlowM3s) || measuredFlowM3s === 0) return 0
  return Number((((reportedFlowM3s - measuredFlowM3s) / measuredFlowM3s) * 100).toFixed(2))
}

export function isReportDeviationOverLimit(deviationPct: number, limit = REPORT_DEVIATION_LIMIT_PCT): boolean {
  return Math.abs(deviationPct) > limit
}
