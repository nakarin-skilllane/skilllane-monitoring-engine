import { describe, expect, it } from 'vitest'
import { NOISE_GROUPS, NOISE_SQL, parseCollapse, parseHide, parsePattern } from '../src/query/noise'

describe('noise groups', () => {
  it('only ever match debug / info lines (a warn, error or fatal line is never hidden)', () => {
    for (const g of NOISE_GROUPS) expect(NOISE_SQL[g].startsWith("level IN ('debug', 'info') AND ")).toBe(true)
  })

  it('hide a probe only when it answered below 400', () => {
    expect(NOISE_SQL.probe).toContain('http_status < 400')
    expect(NOISE_SQL.probe).toContain("'health'")
    expect(NOISE_SQL.preflight).toContain("http_method = 'OPTIONS'")
  })
})

describe('/api/logs params', () => {
  it('hide = a comma list of groups', () => {
    expect(parseHide({ hide: 'probe, Cache' })).toEqual(['probe', 'cache'])
    expect(parseHide({})).toEqual([])
    expect(() => parseHide({ hide: 'probe,nope' })).toThrow(/unknown value/)
  })

  it('collapse = 1 or 0', () => {
    expect(parseCollapse({ collapse: '1' })).toBe(true)
    expect(parseCollapse({ collapse: '0' })).toBe(false)
    expect(parseCollapse({})).toBe(false)
    expect(() => parseCollapse({ collapse: 'yes' })).toThrow(/collapse/)
  })

  it('pattern = a decimal UInt64', () => {
    expect(parsePattern({ pattern: '18446744073709551615' })).toBe(18446744073709551615n)
    expect(parsePattern({})).toBeUndefined()
    expect(() => parsePattern({ pattern: '18446744073709551616' })).toThrow(/pattern/)
    expect(() => parsePattern({ pattern: 'abc' })).toThrow(/pattern/)
  })
})
