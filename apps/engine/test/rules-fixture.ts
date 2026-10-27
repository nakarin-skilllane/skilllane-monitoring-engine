import type { ReportRules } from '../src/reports/types'

export const R: ReportRules = {
  badErrorRateX: 2,
  badOutageMin: 30,
  badFeatureSuccess: 0.95,
  warnErrorRateX: 1.5,
  newLookbackDays: 14,
  increaseX: 1.5,
  increaseMin: 10,
  featureDropPt: 0.5,
  dependencyMin: 5,
  slowX: 1.2,
  spikeX: 3,
  spikeMinReq: 50,
}
