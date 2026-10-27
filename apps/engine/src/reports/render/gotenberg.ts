/** Gotenberg (Chromium) turns the report's HTML into a PNG or a PDF. */

/** A render longer than this fails (the spec's limit). */
export const RENDER_TIMEOUT_MS = 20_000
/** A4 portrait, inches; margins leave room for the header and footer. */
const A4 = { paperWidth: '8.27', paperHeight: '11.69', marginTop: '0.6', marginBottom: '0.6', marginLeft: '0.4', marginRight: '0.4' }

export interface Renderer {
  readonly enabled: boolean
  /** Screenshot of the whole page at `width` CSS px (the document zooms itself). */
  png(html: string, width: number): Promise<Buffer>
  pdf(html: string, header: string, footer: string): Promise<Buffer>
}

export class GotenbergClient implements Renderer {
  constructor(private readonly url: string | undefined) {}

  get enabled(): boolean {
    return !!this.url
  }

  png(html: string, width: number): Promise<Buffer> {
    // height is the viewport only: Gotenberg captures the full page
    return this.post('/forms/chromium/screenshot/html', { 'index.html': html }, { width: String(width), height: '10', format: 'png' })
  }

  pdf(html: string, header: string, footer: string): Promise<Buffer> {
    return this.post('/forms/chromium/convert/html', { 'index.html': html, 'header.html': header, 'footer.html': footer }, { ...A4, printBackground: 'true' })
  }

  private async post(route: string, files: Record<string, string>, fields: Record<string, string>): Promise<Buffer> {
    if (!this.url) throw new Error('GOTENBERG_URL is not set')
    const form = new FormData()
    for (const [name, html] of Object.entries(files)) form.append('files', new Blob([html], { type: 'text/html' }), name)
    for (const [name, value] of Object.entries(fields)) form.append(name, value)
    const res = await fetch(`${this.url}${route}`, { method: 'POST', body: form, signal: AbortSignal.timeout(RENDER_TIMEOUT_MS) })
    if (!res.ok) throw new Error(`Gotenberg ${res.status}: ${(await res.text()).slice(0, 200)}`)
    return Buffer.from(await res.arrayBuffer())
  }
}
