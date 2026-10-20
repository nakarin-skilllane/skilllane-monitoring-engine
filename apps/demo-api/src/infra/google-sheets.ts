import { Injectable } from '@nestjs/common'
import { SpanKind, SpanStatusCode, trace } from '@opentelemetry/api'
import { captureHttp } from 'skilllane-monitoring'
import { scoreOf, studentName } from '../common/school-data'
import { between, chance, sleep } from '../common/util'

const tracer = trace.getTracer('demo-googleapis')

/** The shape googleapis (gaxios) throws: response.status, config.url, data.error.errors[]. */
export class GaxiosError extends Error {
  readonly code: string
  readonly status: number
  readonly config: { url: string; method: string }
  readonly response: {
    status: number
    statusText: string
    config: { url: string; method: string }
    data: unknown
  }

  constructor(status: number, reason: string, message: string, url: string) {
    super(message)
    this.name = 'GaxiosError'
    this.code = String(status)
    this.status = status
    this.config = { url, method: 'POST' }
    this.response = {
      status,
      statusText: 'Too Many Requests',
      config: this.config,
      data: quotaBody(message, reason),
    }
  }
}

const QUOTA_MESSAGE =
  "Quota exceeded for quota metric 'Write requests' and limit 'Write requests per minute per user' of service 'sheets.googleapis.com' for consumer 'project_number:418820214735'."

function quotaBody(message: string, reason: string) {
  return {
    error: {
      code: 429,
      message,
      status: 'RESOURCE_EXHAUSTED',
      errors: [{ message, domain: 'usageLimits', reason }],
    },
  }
}

// The service account's OAuth token (ya29…): a header the SDK masks.
const OAUTH_TOKEN = `ya29.c.b0AXv0zTN${'q7Lk2Pz'.repeat(6)}`

/**
 * Fake Google Sheets export: the CLIENT span googleapis' HTTP call would
 * have, with the request and response the SDK captures on such a span
 * (captureHttp, since nothing goes over the network); `failRate` of calls
 * answer 429.
 */
@Injectable()
export class GoogleSheetsClient {
  async appendReport(
    reportId: string,
    failRate: number,
    data: { rows: number; term: string },
  ): Promise<void> {
    const spreadsheetId = `1xDemoReport${reportId}`
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/Report!A1:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`
    const values = Array.from({ length: data.rows }, (_, i) => {
      const studentId = Number(reportId) * 10 + i
      return [String(studentId), studentName(studentId), data.term, scoreOf(studentId, 1), scoreOf(studentId, 2)]
    })
    const request = {
      headers: {
        authorization: `Bearer ${OAUTH_TOKEN}`,
        'content-type': 'application/json',
        'x-goog-api-client': 'gl-node/20.19.6 gdcl/7.2.0',
        'user-agent': 'google-api-nodejs-client/7.2.0 (gzip)',
      },
      body: {
        range: 'Report!A1',
        majorDimension: 'ROWS',
        values: [['รหัสนักเรียน', 'ชื่อ-สกุล', 'ภาคเรียน', 'กลางภาค', 'ปลายภาค'], ...values],
      },
    }
    await tracer.startActiveSpan(
      'POST sheets.googleapis.com',
      {
        kind: SpanKind.CLIENT,
        attributes: {
          'http.request.method': 'POST',
          'url.full': url,
          'server.address': 'sheets.googleapis.com',
          'server.port': 443,
        },
      },
      async (span) => {
        try {
          await sleep(between(80, 300))
          if (chance(failRate)) {
            span.setAttribute('http.response.status_code', 429)
            captureHttp(span, {
              url,
              request,
              response: {
                headers: { 'content-type': 'application/json; charset=UTF-8', 'retry-after': '30' },
                body: quotaBody(QUOTA_MESSAGE, 'rateLimitExceeded'),
              },
            })
            throw new GaxiosError(429, 'rateLimitExceeded', QUOTA_MESSAGE, url)
          }
          span.setAttribute('http.response.status_code', 200)
          captureHttp(span, {
            url,
            request,
            response: {
              headers: { 'content-type': 'application/json; charset=UTF-8', vary: 'Origin, X-Origin, Referer' },
              body: {
                spreadsheetId,
                tableRange: 'Report!A1:E1',
                updates: {
                  spreadsheetId,
                  updatedRange: `Report!A2:E${values.length + 2}`,
                  updatedRows: values.length + 1,
                  updatedColumns: 5,
                  updatedCells: (values.length + 1) * 5,
                },
              },
            },
          })
        } catch (error) {
          span.recordException(error as Error)
          span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message })
          throw error
        } finally {
          span.end()
        }
      },
    )
  }
}
