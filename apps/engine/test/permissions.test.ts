import { describe, expect, it } from 'vitest'
import { ALL_GRANTS, effectiveGrants, isViewPermission, parseGrants } from '../src/auth/permissions'

describe('report permissions', () => {
  it('reports is env-scoped, reports_manage is not', () => {
    expect(isViewPermission('reports')).toBe(true)
    expect(isViewPermission('reports_manage')).toBe(false)
    expect(effectiveGrants(parseGrants([{ permission: 'reports', envs: ['prod'] }, { permission: 'reports_manage', envs: ['prod'] }]))).toEqual({
      reports: ['prod'],
      reports_manage: 'all',
    })
  })
  it('admin holds both', () => {
    expect(ALL_GRANTS.map((g) => g.permission)).toEqual(expect.arrayContaining(['reports', 'reports_manage']))
  })
})
