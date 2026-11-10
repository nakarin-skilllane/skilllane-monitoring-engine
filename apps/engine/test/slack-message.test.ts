import { describe, expect, it } from 'vitest'
import { mrkdwn, reportLink, slackText } from '../src/reports/slack/slack-message'

const r = { env: 'prod', reportDate: '2026-10-21' }

describe('slackText', () => {
  it('is only a link to the report, named by env and Thai date', () => {
    const text = slackText(r, { publicUrl: 'http://m:3300' })
    expect(text).toMatch(/^<http:\/\/m:3300\/reports\/daily\?env=prod&date=2026-10-21\|รายงานประจำวัน · prod · .+ 2569>$/)
    expect(text.split('\n')).toHaveLength(1)
  })

  it('without MONITOR_PUBLIC_URL: the name as plain text', () => {
    expect(slackText(r, {})).toMatch(/^รายงานประจำวัน · prod · .+ 2569$/)
  })

  it('says why the pictures are missing, escaped', () => {
    const text = slackText({ env: 'a<b>', reportDate: '2026-10-21' }, { noFiles: 'GOTENBERG & <x>' })
    expect(text).toContain('รายงานประจำวัน · a&lt;b&gt; · ')
    expect(text.split('\n')[1]).toBe('_แนบภาพสรุปไม่ได้: GOTENBERG &amp; &lt;x&gt;_')
  })
})

describe('helpers', () => {
  it('mrkdwn escapes only & < >', () => {
    expect(mrkdwn(`a & <b> "c" 'd'`)).toBe(`a &amp; &lt;b&gt; "c" 'd'`)
  })
  it('reportLink encodes the env', () => {
    expect(reportLink('http://m', { env: 'a b', reportDate: '2026-10-21' })).toBe('http://m/reports/daily?env=a%20b&date=2026-10-21')
  })
})
