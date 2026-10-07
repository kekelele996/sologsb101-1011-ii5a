import type { CorrectionPolicy } from './reportPeriod'

/** 实测侧对账状态：已挂到报汛、待挂、因报汛时段改动而失效 */
export type MeasurementLinkStatus = '已挂' | '待挂' | '已失效'

/** 值班室侧校正状态 */
export type CorrectionStatus = '待修正' | '已重报' | '已失效'

/**
 * 测验组侧：一次实测到盖住它的报汛时段的归属。
 * 报汛时段被改动到不再覆盖测流时刻时，本条自动退回“待挂”；值班室校正单仍保留。
 */
export interface MeasurementLink {
  id: string
  sectionId: string
  stationId: string
  reportPeriodId: string | null
  measuredAt: string
  measuredFlowM3s: number
  /** 挂接时快照报汛值，用于保留当时的对账依据 */
  reportedFlowM3s: number | null
  deviationPct: number
  status: MeasurementLinkStatus
  /** v3 升级自动回填最近实测时，未找到合适报汛时段则列出原因 */
  unmatchedReason: string
  linkedAt: number
  createdAt: number
  updatedAt: number
}

/** 水情值班室侧校正单：两边各记各的，挂接失效不删除值班室这份 */
export interface FlowCorrection {
  id: string
  stationId: string
  reportPeriodId: string
  sectionId: string | null
  measurementLinkId: string | null
  policy: CorrectionPolicy
  segmentNo: string
  originalReportedFlowM3s: number
  measuredFlowM3s: number
  deviationPct: number
  /** 单次修正只改本次；整段偏移时为需要一起重报的原报汛时段 id */
  affectedReportPeriodIds: string[]
  revisedFlowByReportId: Record<string, number>
  status: CorrectionStatus
  decidedBy: string
  decidedAt: string
  reissuedAt: string | null
  note: string
  createdAt: number
  updatedAt: number
}

export interface ReportReconcileRow {
  report: import('./reportPeriod').ReportPeriod
  stationName: string
  link: MeasurementLink | null
  correction: FlowCorrection | null
  revisedFlowM3s: number | null
}
