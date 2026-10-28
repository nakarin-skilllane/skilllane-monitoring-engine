/**
 * Whole HTML documents of the report: the monitor's iframe (screen), the PNG (760 px drawn at
 * 2×) and the PDF (A4). White always, fonts inlined, no script: Gotenberg prints it as is.
 */
import type { StoredReport } from '../types'
import { dataView } from './data-view'
import { fontFaceCss } from './fonts'
import { dateTime, esc, thaiDate, windowText } from './html'
import { infographic, type ReportTab } from './infographic'

export type ReportView = 'data' | 'infographic'
export type RenderMode = 'screen' | 'png' | 'pdf'
export interface ReportPart {
  tab: ReportTab
  view: ReportView
}

/** CSS width of the infographic; the PNG is this × 2. */
export const CARD_WIDTH = 760

const CSS = `
*{box-sizing:border-box}
html,body{margin:0;background:#fff;color:#1d2420;font-family:'IBM Plex Sans Thai',system-ui,sans-serif;font-size:14px;line-height:1.45;-webkit-print-color-adjust:exact;print-color-adjust:exact}
body.screen{padding:12px}
body.png{width:${CARD_WIDTH}px;zoom:2}
.part+.part{break-before:page;page-break-before:always}
body.screen .part+.part,body.png .part+.part{margin-top:16px}
code,.rt{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.ig{width:100%;max-width:${CARD_WIDTH}px;margin:0 auto;border:1px solid #e3e8e5;border-radius:14px;overflow:hidden;background:#fff;break-inside:avoid}
body.png .ig{border-radius:0;border:0}
.ig-band{background:#1f3d33;color:#fff;padding:12px 18px;display:flex;align-items:center;justify-content:space-between;gap:10px}
.ig--detail .ig-band{background:#2a2f45}
.ig-band>div{display:flex;flex-direction:column;gap:2px}
.ig-kicker{font-size:11.5px;opacity:.8}
.ig-band b{font-size:18px;font-weight:600}
.ig-pill{display:inline-flex;align-items:center;gap:6px;font-size:13px;font-weight:600;border-radius:999px;padding:4px 12px;white-space:nowrap}
.ig-pill .dot{width:8px;height:8px;border-radius:50%;background:currentColor}
.ig-pill.ok{background:#86d8b4;color:#0f3b2a}.ig-pill.warn{background:#f2c46b;color:#3d2b00}.ig-pill.bad{background:#e2735e;color:#fff}
.ig-sum{margin:0;padding:10px 18px 0;font-size:14px;color:#333}
.ig-ailine{margin:8px 18px 0;padding:8px 12px;border-radius:8px;background:#f4f0fc;border:1px solid #d9cdf4;color:#4b3c8c;font-size:12.5px}
.ig-ailine b,.ig-t .ai b{font-size:10.5px;background:#e6dcfa;border-radius:4px;padding:1px 6px;margin-right:6px}
.ig-aimiss{margin:8px 18px 0;padding:6px 12px;border-radius:8px;background:#f1f3f2;color:#6b716e;font-size:12px}
.ig-kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;padding:10px 18px}
.ig-kpis>div{background:#f6f8f7;border:1px solid #e6ebe8;border-radius:10px;padding:8px 10px 6px;display:grid;grid-template-columns:1fr auto;column-gap:6px}
.ig-kpis span{grid-column:1 / span 2;font-size:11px;color:#6b716e}
.ig-kpis b{font-size:21px;line-height:1.2;font-weight:600}
.ig-kpis em{grid-column:1 / span 2;font-style:normal;font-size:11.5px;font-weight:600;color:#6b716e}
.ig-kpis em.bad{color:#c0503a}.ig-kpis em.ok{color:#2e8b65}
.ig-kpis em.sub{font-weight:600;color:#444}.ig-kpis em.sub.bad{color:#c0503a}.ig-kpis em.sub.ok{color:#2e8b65}
.dv-figures em.sub{color:#444;font-weight:600}
.ig-spark{grid-column:2;grid-row:2;display:flex;align-items:flex-end;gap:2px;height:26px;width:42px;align-self:end}
.ig-spark i{flex:1;background:#b9d8c7;border-radius:1px 1px 0 0}.ig-spark i.last{background:#c0503a}
.ig-sec{padding:0 18px 12px}
.ig-ct{display:block;font-size:11px;font-weight:600;color:#555;margin-bottom:5px}
.ig-empty{margin:0;font-size:12.5px;color:#888}
.ig-feats{display:flex;flex-wrap:wrap;gap:6px}
.ig-feat{display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:3px 10px;font-size:12px;border:1px solid #e3e3e3;background:#fafafa}
.ig-feat b{font-weight:600}
.ig-feat .dot{width:7px;height:7px;border-radius:50%;background:#9aa5b1}
.ig-feat.ok{border-color:#9cc7b1;background:#e9f5ee}.ig-feat.ok .dot{background:#2e8b65}
.ig-feat.warn{border-color:#e9c46a;background:#fdf1cf}.ig-feat.warn .dot{background:#b07d12}
.ig-feat.bad{border-color:#e8a898;background:#fbe3dd}.ig-feat.bad .dot{background:#c0503a}
.ig-tl{display:flex;flex-direction:column;gap:3px}
.ig-tl-bar{position:relative;height:14px;border-radius:7px;background:#e3efe8;overflow:hidden}
.ig-tl-bar i{position:absolute;top:0;height:100%;border-radius:7px}
.ig-tl-bar i.w,.ig-tl-leg i.w{background:#f2c46b}.ig-tl-bar i.r,.ig-tl-leg i.r{background:#c0503a}.ig-tl-bar i.g,.ig-tl-leg i.g{background:#9aa5b1}
.ig-ticks{display:flex;justify-content:space-between;font-size:10px;color:#888}
.ig-tl-leg{display:flex;gap:4px 14px;flex-wrap:wrap;font-size:11.5px;color:#444;margin-top:4px}
.ig-tl-leg i{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:4px;vertical-align:middle}
.ig-follow{display:flex;flex-direction:column;gap:6px}
.ig-fo{display:flex;gap:8px;align-items:flex-start;font-size:13px;background:#f8faf9;border:1px solid #e6ebe8;border-radius:8px;padding:6px 10px}
.ig-tag{display:inline-block;font-size:10.5px;font-weight:600;border-radius:4px;padding:2px 6px;white-space:nowrap}
.ig-tag.new{background:#fbe3dd;color:#c0503a}.ig-tag.up{background:#fdf1cf;color:#9a6a00}.ig-tag.same{background:#eee;color:#666}
.ig-slow{display:flex;flex-direction:column;gap:5px}
.ig-sr{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(0,2fr) auto;gap:10px;align-items:center;font-size:12px}
.ig-sr code{font-size:11px;color:#444;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ig-sr .trk{position:relative;height:10px;background:#eef2f0;border-radius:5px}
.ig-sr .trk i{position:absolute;left:0;top:0;height:100%;border-radius:5px;background:#9cc7b1}
.ig-sr .trk i.now{background:#c0503a;opacity:.85;height:4px;top:3px}
.ig-t{width:100%;border-collapse:collapse;font-size:12.5px}
.ig-t td{padding:6px;border-top:1px solid #f0f0f0;vertical-align:middle}
.ig-t tr:first-child td{border-top:0}
.ig-t .rt{font-size:11px;color:#555}
.ig-t .meta{font-size:10.5px;color:#888}
.ig-t .n{white-space:nowrap;color:#444;min-width:170px;text-align:right}
.ig-t .trk{position:relative;display:block;height:10px;background:#eef2f0;border-radius:5px;margin-top:4px}
.ig-t .trk i{position:absolute;left:0;top:0;height:100%;border-radius:5px;background:#9cc7b1}
.ig-t .trk i.now{background:#c0503a;opacity:.85;height:4px;top:3px}
.ig-t .ai{color:#5b4a9e;font-size:11.5px;max-width:220px}
.ig-foot{display:flex;justify-content:space-between;gap:12px;font-size:10.5px;color:#888;padding:8px 18px;background:#f6f8f7;border-top:1px solid #e6ebe8}
.dv h2{font-size:18px;margin:0 0 8px}
.dv-figures{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-bottom:10px;break-inside:avoid}
.dv-figures div{border:1px solid #e3e8e5;border-radius:8px;padding:6px 8px;display:flex;flex-direction:column}
.dv-figures span{font-size:10.5px;color:#6b716e}.dv-figures b{font-size:17px;font-weight:600}.dv-figures em{font-style:normal;font-size:10.5px;color:#6b716e}
.dv-status{margin-bottom:10px;break-inside:avoid}
.dv-status p{margin:0 0 4px}
.pill{display:inline-block;border-radius:999px;padding:1px 10px;font-weight:600;font-size:12.5px}
.pill.ok{background:#86d8b4;color:#0f3b2a}.pill.warn{background:#f2c46b;color:#3d2b00}.pill.bad{background:#e2735e;color:#fff}
.src{display:inline-block;font-size:10px;font-weight:600;border:1px solid #d5dbd8;border-radius:4px;padding:0 5px;color:#6b716e;vertical-align:middle}
.src.ai{background:#f4f0fc;border-color:#d9cdf4;color:#4b3c8c}
.dv-ai{font-size:12.5px;color:#4b3c8c}
.dv-aimiss{font-size:12px;color:#6b716e;background:#f1f3f2;border-radius:6px;padding:4px 10px}
.dv-card{border:1px solid #e3e8e5;border-radius:10px;padding:8px 10px;margin-bottom:10px;break-inside:avoid}
.dv-card h3{font-size:13.5px;margin:0 0 2px;font-weight:600}
.dv-meta{margin:0 0 6px;font-size:11px;color:#6b716e}
.dv-empty{margin:0;font-size:12px;color:#888}
.dv table{width:100%;border-collapse:collapse;font-size:11.5px}
.dv th{text-align:left;font-weight:600;color:#555;border-bottom:1px solid #e3e8e5;padding:3px 4px}
.dv td{border-bottom:1px solid #f0f2f1;padding:3px 4px;vertical-align:top;word-break:break-word}
.dv tr{break-inside:avoid}
.dv .num{text-align:right;white-space:nowrap}
.dv-charts{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.dv-charts .dv-card,.dv>:last-child{margin-bottom:0}
.dv-chart svg text{font-size:9px;fill:#888}.dv-chart svg text.v{font-size:10px;fill:#c0503a;font-weight:600}
@media (max-width:620px){body.screen .ig-kpis{grid-template-columns:repeat(2,1fr)}body.screen .ig-sr{grid-template-columns:1fr}}
`

/** The parts of a report in one document; parts after the first start a new page in a PDF. */
export function reportDocument(r: StoredReport, parts: ReportPart[], mode: RenderMode): string {
  const title = `รายงานประจำวัน ${r.env} ${r.reportDate}`
  const body = parts
    .map((p) => `<div class="part">${p.view === 'infographic' ? infographic(r, p.tab) : dataView(r, p.tab)}</div>`)
    .join('')
  return `<!doctype html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${fontFaceCss()}${CSS}</style></head><body class="${mode}">${body}</body></html>`
}

const MARGIN_CSS = `<style>${fontFaceCss()}*{font-family:'IBM Plex Sans Thai',system-ui,sans-serif}div{box-sizing:border-box;width:100%;font-size:8.5px;color:#6b716e;padding:0 12mm;display:flex;justify-content:space-between;-webkit-print-color-adjust:exact}</style>`

/** PDF page header: title · env · date. */
export const pdfHeader = (r: StoredReport): string =>
  `<html><head>${MARGIN_CSS}</head><body><div><span>รายงานประจำวัน · ${esc(r.env)}</span><span>${esc(thaiDate(r.reportDate))}</span></div></body></html>`

/** PDF page footer: window · built at · page number. */
export const pdfFooter = (r: StoredReport): string =>
  `<html><head>${MARGIN_CSS}</head><body><div><span>ช่วงข้อมูล ${esc(windowText(r.windowStartMs, r.windowEndMs))} · สร้างเมื่อ ${esc(dateTime(r.generatedAt))}</span><span>หน้า <span class="pageNumber"></span>/<span class="totalPages"></span></span></div></body></html>`
