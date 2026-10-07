/**
 * 实测挂接校正：每次测完把实测挂到盖住它的那条报汛时段上，
 * 实测值和报汛值摆一起比，差得多的给这次报汛挂待修正，值班室据此重报。
 */

/** 校正状态：已挂（挂在报汛时段上） / 待挂（值班室改动时段后失效退回，待测验组本侧重挂） */
export type CorrectionStatus = '已挂' | '待挂'

export const CORRECTION_STATUSES: CorrectionStatus[] = ['已挂', '待挂']

/** 校正来源：测验挂接（测完即挂） / 升级回填（旧数据照时刻补挂最近一次实测） */
export type CorrectionOrigin = '测验挂接' | '升级回填'

/** 报汛对账偏差限值（%）：实测与报汛相差超过该值，给这次报汛挂待修正 */
export const REPORT_DEVIATION_LIMIT_PCT = 8

/** 实测挂接校正记录 */
export interface Correction {
  id: string
  /** 挂接的报汛时段 */
  reportId: string
  /** 实测断面测次 */
  sectionId: string
  /** 实测断面流量（m³/s，挂接时快照） */
  measuredFlowM3s: number
  /** 报汛流量（m³/s，挂接时快照；值班室改动时段后凭此识别失效） */
  reportedFlowM3s: number
  /** 偏差（%）：(报汛 − 实测) / 实测 × 100 */
  deviationPct: number
  /** 已挂 / 待挂 */
  status: CorrectionStatus
  /** 测验挂接 / 升级回填 */
  origin: CorrectionOrigin
  /** 挂接时间 */
  attachedAt: string
  createdAt: number
  updatedAt: number
}

/** 计算对账偏差百分比：(报汛 − 实测) / 实测 × 100 */
export function calcReportDeviationPct(measuredFlowM3s: number, reportedFlowM3s: number): number {
  if (!Number.isFinite(measuredFlowM3s) || measuredFlowM3s === 0) return 0
  return Number((((reportedFlowM3s - measuredFlowM3s) / measuredFlowM3s) * 100).toFixed(2))
}

/** 偏差是否超限（差得多）：超限则给这次报汛挂待修正 */
export function isReportDeviationOver(deviationPct: number, limit = REPORT_DEVIATION_LIMIT_PCT): boolean {
  return Math.abs(deviationPct) > limit
}
