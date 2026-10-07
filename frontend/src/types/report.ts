/**
 * 实时报汛时段：水情值班室按整点水位查临时关系线报出的报汛流量。
 * 与实测流量（断面测次）各记各的，两边按测流时刻对账。
 */

/** 报汛时段状态：正常 / 待修正（实测比对差得多，挂起待值班室重报） / 已重报 */
export type ReportStatus = '正常' | '待修正' | '已重报'

export const REPORT_STATUSES: ReportStatus[] = ['正常', '待修正', '已重报']

/**
 * 修正策略：实测值只改这一次报汛，还是整段都照实测偏移重报。
 * 两边先商量定，报汛对账页顶部写明当前照哪条走。
 */
export type CorrectionPolicy = 'single' | 'segment'

export const DEFAULT_CORRECTION_POLICY: CorrectionPolicy = 'single'

export const CORRECTION_POLICIES: Array<{ value: CorrectionPolicy; label: string; description: string }> = [
  {
    value: 'single',
    label: '只改本次报汛',
    description: '重报时仅把被校正的这条报汛改为实测值，其余时段不动'
  },
  {
    value: 'segment',
    label: '整段照实测偏移重报',
    description: '重报时同站同线的连续时段整段按实测偏移量一并平移'
  }
]

export function correctionPolicyLabel(policy: CorrectionPolicy | undefined): string {
  return CORRECTION_POLICIES.find((item) => item.value === policy)?.label ?? CORRECTION_POLICIES[0].label
}

/** 报汛时段：一次整点报汛 */
export interface FloodReport {
  id: string
  /** 所属测站 */
  stationId: string
  /** 时段起（整点） */
  periodStart: string
  /** 时段止（整点） */
  periodEnd: string
  /** 整点水位（m） */
  stageM: number
  /** 临时关系线定线号：报汛流量由此线查得 */
  lineNo: string
  /** 报汛流量（m³/s） */
  reportedFlowM3s: number
  /** 值班员 */
  dutyOperator: string
  /** 正常 / 待修正 / 已重报 */
  status: ReportStatus
  /** 报出时间 */
  reportedAt: string
  createdAt: number
  updatedAt: number
}

/** 判断报汛时段是否盖住某时刻（含端点） */
export function periodContains(
  report: Pick<FloodReport, 'periodStart' | 'periodEnd'>,
  isoTime: string
): boolean {
  const start = Date.parse(report.periodStart)
  const end = Date.parse(report.periodEnd)
  const time = Date.parse(isoTime)
  if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(time)) return false
  return start <= time && time <= end
}

/**
 * 找盖住测流时刻的报汛时段（同站）。
 * 多条盖住时取时段起点最晚的一条（最贴近测流时刻）。
 */
export function findCoveringReport(
  reports: FloodReport[],
  stationId: string,
  isoTime: string
): FloodReport | null {
  const covering = reports.filter(
    (report) => report.stationId === stationId && periodContains(report, isoTime)
  )
  if (covering.length === 0) return null
  return covering.sort((a, b) => Date.parse(b.periodStart) - Date.parse(a.periodStart))[0]
}

/** 时段首尾相接的容差（ms）：相邻间隔不超过该值视为同一段 */
const SEGMENT_GAP_MS = 90_000

/**
 * 同站、同临时关系线且时段首尾相接的报汛视为一段。
 * 返回目标报汛所在的整段（按时段起点升序），供「整段照实测偏移重报」使用。
 */
export function findSegmentReports(reports: FloodReport[], target: FloodReport): FloodReport[] {
  const chain = reports
    .filter((report) => report.stationId === target.stationId && report.lineNo === target.lineNo)
    .sort((a, b) => Date.parse(a.periodStart) - Date.parse(b.periodStart))
  const index = chain.findIndex((report) => report.id === target.id)
  if (index < 0) return [target]
  let lo = index
  let hi = index
  while (lo > 0 && Date.parse(chain[lo].periodStart) - Date.parse(chain[lo - 1].periodEnd) <= SEGMENT_GAP_MS) lo -= 1
  while (
    hi < chain.length - 1 &&
    Date.parse(chain[hi + 1].periodStart) - Date.parse(chain[hi].periodEnd) <= SEGMENT_GAP_MS
  ) {
    hi += 1
  }
  return chain.slice(lo, hi + 1)
}

/**
 * 升级回填匹配：为一条没有实测归属的报汛找同站最近一次实测。
 * 取测流时刻不晚于时段末的最新测次；对不上（该站此前没有测次）返回 null，由页面单列。
 */
export function matchLatestSection<T extends { id: string; stationId: string; measuredAt: string }>(
  sections: T[],
  report: Pick<FloodReport, 'stationId' | 'periodEnd'>
): T | null {
  const end = Date.parse(report.periodEnd)
  const candidates = sections.filter(
    (section) => section.stationId === report.stationId && Date.parse(section.measuredAt) <= end
  )
  if (candidates.length === 0) return null
  return candidates.sort((a, b) => Date.parse(b.measuredAt) - Date.parse(a.measuredAt))[0]
}
