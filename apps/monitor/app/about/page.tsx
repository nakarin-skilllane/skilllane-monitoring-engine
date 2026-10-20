import type { Metadata } from 'next'
import Link from 'next/link'
import type { ReactNode } from 'react'
import { CategoryChip, HttpStatus, LevelBadge, NewBadge, StateChip } from '@/components/badges'
import { CopyLinkButton } from '@/components/CopyButton'
import { Icon, type IconName } from '@/components/icons'
import { Panel, Section } from '@/components/Panel'
import { Pipeline3D } from '@/components/Pipeline3D'
import { engine, getHealth, getMeta } from '@/lib/engine'
import { fmtCount, fmtDateTime, fmtDuration, fmtPercent, shortId } from '@/lib/format'
import type { PipelineTransport } from '@/lib/3d/system-map'
import { buildHref, inRange, keepOf, parseScope, type RawSearchParams, scopeQuery } from '@/lib/params'
import { systemLabel } from '@/lib/readable'
import { depTitle, mergeDependencies } from '@/app/overview/_lib/model'
import './screen.css'

export const metadata: Metadata = { title: { absolute: 'skilllane monitor คืออะไร' } }

const TRANSPORT_LABEL: Record<PipelineTransport, string> = { kafka: 'Kafka', rabbitmq: 'RabbitMQ', bullmq: 'BullMQ' }

interface Card {
  icon: IconName
  name: string
  href: string
  /** Route shown in the corner (the mockup showed its file name). */
  path: string
  question: string
  data: ReactNode
  api: string
}

/**
 * skilllane monitor คืออะไร (design/monitoring-ui/index.html): what the product is, how data travels (the 3D
 * pipeline with the Kafka / RabbitMQ / BullMQ switch), what each screen answers with a live number from the
 * engine for the env in the URL, how to read the badges, and the design principles. Links keep env / from / to.
 */
export default async function AboutPage({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  const sp = await searchParams
  const meta = await getMeta()
  const envs = meta.ok ? meta.data.envs : undefined
  const keep = keepOf(sp)
  // each card counts what its screen shows by default (overview 1 h, errors and jobs 24 h) unless the URL picks a range
  const ovScope = parseScope(sp, 'overview', { envs, limited: meta.ok && meta.data.envsLimited })
  const errScope = parseScope(sp, 'errors', { envs, limited: meta.ok && meta.data.envsLimited })
  const jobScope = parseScope(sp, 'jobs', { envs, limited: meta.ok && meta.data.envsLimited })
  const env = ovScope.env
  const [health, ov, errs, jobs, deps] = await Promise.all([
    getHealth(),
    engine.overview(scopeQuery(ovScope)),
    engine.errors({ ...scopeQuery(errScope), limit: 500, sparkBuckets: 1 }),
    engine.jobs(scopeQuery(jobScope)),
    engine.dependencies(scopeQuery(jobScope)),
  ])
  const transport: PipelineTransport =
    health.ok && (['kafka', 'rabbitmq', 'bullmq'] as string[]).includes(health.data.transport) ? (health.data.transport as PipelineTransport) : 'kafka'
  const href = (path: string, extra?: Record<string, string>) => buildHref(path, keep, extra)
  const errRange = errScope.preset === 'now-24h' ? '24 ชั่วโมง' : 'ช่วงที่เลือก'

  // the latest deploy that replaced an earlier version, for the "same data on every screen" sentence
  const release = meta.ok
    ? meta.data.releases
        .filter((r) => (!env || r.env === env) && r.previousVersion)
        .sort((a, b) => b.deployedAt.localeCompare(a.deployedAt))[0]
    : undefined

  // live lines of the cards
  const overviewData: ReactNode = ov.ok ? (
    (() => {
      const worst = [...ov.data.services].sort((a, b) => b.errorRate - a.errorRate)[0]
      // the route example is an HTTP route (a job key such as `export export:class-score` reads as a doubled word)
      const slow = [...ov.data.routes].filter((r) => r.method !== '').sort((a, b) => b.p95Ms - a.p95Ms)[0]
      return [
        `${ov.data.services.length} service/role`,
        worst ? `error rate ${worst.service}/${worst.role} ${fmtPercent(worst.errorRate)}` : '',
        slow ? `${slow.route} p95 ${fmtDuration(slow.p95Ms)}` : '',
        'Δ เทียบก่อน deploy',
      ]
        .filter(Boolean)
        .join(' · ')
    })()
  ) : (
    'สุขภาพของทุก service: request, error rate, p95, route ที่ต้องดู · Δ เทียบก่อน deploy'
  )
  const groups = errs.ok ? errs.data.groups : []
  // detail cards show an error-level group (a warn group is a 4xx or a retry, not the example to open first)
  const isError = (level: string) => level === 'error' || level === 'fatal'
  const fresh = groups.filter((g) => g.isNew).sort((a, b) => b.firstSeen.localeCompare(a.firstSeen))[0]
  // the plain "Error detail" card shows an established group, so the two detail cards open two kinds of page
  const top = groups.find((g) => isError(g.level) && g.fingerprint !== fresh?.fingerprint) ?? groups.find((g) => isError(g.level)) ?? groups[0]
  const newCount = groups.filter((g) => g.isNew).length
  const traceGroup = groups.find((g) => g.sampleTraceId && isError(g.level)) ?? groups.find((g) => g.sampleTraceId)
  const failing = jobs.ok ? [...jobs.data.stats].filter((s) => s.failed > 0).sort((a, b) => b.failed - a.failed)[0] : undefined
  // one row per host:port with the outage as every screen shows it (its length = the union over the processes that saw it)
  const depRows = deps.ok ? mergeDependencies(deps.data, jobScope.fromMs) : []
  const outage = depRows.find((d) => d.issue === 'down') ?? [...depRows].filter((d) => d.issue === 'recovered').sort((a, b) => (b.upAtMs ?? 0) - (a.upAtMs ?? 0))[0]

  const cards: Card[] = [
    {
      icon: 'overview',
      name: 'ภาพรวม',
      href: href('/overview'),
      path: '/overview',
      question: `ตอนนี้ ${env ?? 'ทุก env'} มีอะไรผิดปกติ service ไหน route ไหนต้องดูก่อน`,
      data: overviewData,
      api: 'GET /api/overview',
    },
    {
      icon: 'logs',
      name: 'Log',
      href: href('/logs'),
      path: '/logs',
      question: 'เกิดอะไรขึ้นบ้าง ตอนไหน กรองตาม level, service, route, user หรือ trace',
      data: (
        <>
          histogram ตาม level ต่อนาที · error อ่านได้ในแถว · เปิดแถวเพื่อดูทุก field ·{' '}
          <Link className="ix-card__alt" href={href('/logs', { level: 'error,fatal' })}>
            เฉพาะ error
          </Link>
        </>
      ),
      api: 'GET /api/logs',
    },
    {
      icon: 'traces',
      name: 'Trace',
      href: href('/traces'),
      path: '/traces',
      question: 'Request หรือ job ไหนช้า หรือ error ในช่วงเวลานี้',
      data: 'scatter เวลา × duration โดย error เด่นกว่า · ตาราง entry span',
      api: 'GET /api/traces',
    },
    {
      icon: 'traces',
      name: 'Trace detail',
      href: traceGroup ? href(`/traces/${traceGroup.sampleTraceId}`) : href('/traces'),
      path: '/traces/:traceId',
      question: 'Request นี้ผ่าน service ไหน และพังหรือช้าที่ span ไหน',
      data: traceGroup ? `trace ${shortId(traceGroup.sampleTraceId)} · ตัวอย่างของ ${traceGroup.hint || traceGroup.errorType}` : 'เปิดจากรายการ Trace หรือจาก error',
      api: 'GET /api/traces/:traceId',
    },
    {
      icon: 'errors',
      name: 'Error',
      href: href('/errors'),
      path: '/errors',
      question: 'Error แบบไหนเกิดบ่อย ใหม่หลัง deploy หรือเปล่า กระทบ user กี่คน',
      data: errs.ok
        ? `${fmtCount(groups.length)} group ${inRange(errRange)}${newCount ? ` · ${fmtCount(newCount)} group ใหม่หลัง ${fresh?.firstSeenVersion || 'deploy'}` : ' · ไม่มี group ใหม่หลัง deploy'}`
        : 'group ตาม fingerprint · NEW หลัง deploy · จำนวน user',
      api: 'GET /api/errors',
    },
    {
      icon: 'errors',
      name: 'Error detail',
      href: top ? href(`/errors/${top.fingerprint}`) : href('/errors'),
      path: '/errors/:fingerprint',
      question: 'ต้องแก้ที่ไฟล์ไหน function ไหน และส่งให้ AI ช่วยดูอย่างไร',
      data: top ? `${top.hint || top.errorType} · ${fmtCount(top.count)} ครั้ง · ${fmtCount(top.users)} users` : 'เปิดจากรายการ Error',
      api: 'GET /api/errors/:fingerprint',
    },
    {
      icon: 'errors',
      name: 'Error detail (NEW)',
      href: fresh ? href(`/errors/${fresh.fingerprint}`) : href('/errors', { sort: 'firstSeen' }),
      path: '/errors/:fingerprint',
      question: 'Error ที่เพิ่งเกิดหลัง deploy: ใหม่จริงไหม แก้ที่ไหน กระทบ route ไหน',
      data: fresh
        ? `${fresh.hint || fresh.errorType} · NEW ตั้งแต่ ${fresh.firstSeenVersion} · ${fmtCount(fresh.count)} ครั้ง · ${fmtCount(fresh.users)} users`
        : `ไม่มี error group ใหม่หลัง deploy ${inRange(errRange)}`,
      api: 'GET /api/errors/:fingerprint',
    },
    {
      icon: 'jobs',
      name: 'งานเบื้องหลัง',
      href: href('/jobs'),
      path: '/jobs',
      question: 'Queue, cron และ consumer ทำงานครบไหม ระบบที่เรียกใช้ล่มช่วงไหน',
      data:
        jobs.ok || deps.ok
          ? [
              failing ? `${failing.type || failing.queue} ล้มเหลว ${fmtCount(failing.failed)}` : jobs.ok ? 'ไม่มี job ที่ล้มเหลว' : '',
              outage
                ? outage.issue === 'down'
                  ? `${depTitle(outage, systemLabel)} down อยู่`
                  : `${depTitle(outage, systemLabel)} down ${fmtDuration(outage.lastOutageMs)}`
                : '',
            ]
              .filter(Boolean)
              .join(' · ')
          : 'BullMQ, Kafka, RabbitMQ, cron และสถานะ dependency',
      api: 'GET /api/jobs · GET /api/dependencies',
    },
  ]

  return (
    <>
      <header className="page-head">
        <div className="page-head__text">
          <h1 className="page-title">skilllane monitor</h1>
          <p className="page-sub">
            ดู log, trace และ error ของทุก app ที่ติดตั้ง <span className="mono">skilllane-monitoring</span> ในที่เดียว
          </p>
        </div>
        <div className="page-actions">
          <CopyLinkButton />
          <a className="btn btn--quiet" href="/DATA-DICTIONARY.md">
            พจนานุกรมข้อมูล
          </a>
          <Link className="btn" href={href('/overview')}>
            ไปที่ภาพรวม
            <Icon name="arrow" />
          </Link>
        </div>
      </header>

      <section className="section" aria-labelledby="h-about">
        <div className="grid grid--main-side">
          <div className="panel">
            <div className="panel__head">
              <h2 className="panel__title" id="h-about">
                skilllane monitor คืออะไร
              </h2>
            </div>
            <div className="panel__body ix-about">
              <p className="lead">
                App ที่ติดตั้ง <span className="mono">skilllane-monitoring</span> เขียน log และสร้าง trace ตามปกติ SDK ส่งข้อมูลเข้า queue ที่ลูกค้าใช้อยู่แล้ว เลือกได้ระหว่าง Kafka,
                RabbitMQ หรือ BullMQ skilllane-monitoring engine subscribe จาก queue นั้น เขียนลง ClickHouse แล้วเปิด query API ให้หน้าจอนี้อ่าน เราทำหน้าที่ publish และ subscribe เท่านั้น
                ไม่ได้ดูแล queue ของลูกค้า
              </p>
              <p className="lead">
                ทุกหน้าจออ่านจาก engine API (<span className="mono">/api/*</span>) เท่านั้น และทุกหน้าใช้ข้อมูลชุดเดียวกัน: env {env ?? 'ทุก env'}
                {release ? (
                  <>
                    , หลัง deploy{' '}
                    <span className="mono">
                      {release.service} {release.currentVersion}
                    </span>{' '}
                    เมื่อ {fmtDateTime(release.deployedAt)} (ก่อนหน้า {release.previousVersion})
                  </>
                ) : null}
              </p>
              <p className="lead">
                ภาพ <a href="#h-pipe">ข้อมูลเดินทางอย่างไร</a> ด้านล่างเล่นเส้นทางนี้ทีละขั้น: log และ span ออกจากแอปเป็นชุด พักใน queue ไปที่ engine ลง ClickHouse
                แล้วหน้าจอนี้และ AI อ่านต่อ
              </p>
            </div>
          </div>
          <div className="panel">
            <div className="panel__head">
              <h2 className="panel__title">สิ่งที่หน้าจอต้องทำให้เห็นชัด</h2>
            </div>
            <div className="panel__body ix-req-body">
              <ol className="ix-req">
                <li>
                  <span className="ix-req__n">1</span>
                  <span>
                    ใช้ได้กับทุก app ที่ติดตั้ง package<span className="ix-req__where">service / role / env อยู่ในทุกแถวและทุกหัวข้อ</span>
                  </span>
                </li>
                <li>
                  <span className="ix-req__n">2</span>
                  <span>
                    Log กิจกรรมพร้อมเวลา<span className="ix-req__where">Log: ค้นหา กรอง histogram ตาม level</span>
                  </span>
                </li>
                <li>
                  <span className="ix-req__n">3</span>
                  <span>
                    Trace ราย request<span className="ix-req__where">Trace และ trace detail: waterfall ข้าม service</span>
                  </span>
                </li>
                <li>
                  <span className="ix-req__n">4</span>
                  <span>
                    เป็นมิตรกับ AI<span className="ix-req__where">คัดลอกให้ AI, ชื่อ field คงที่, ลิงก์พจนานุกรมข้อมูล</span>
                  </span>
                </li>
                <li>
                  <span className="ix-req__n">5</span>
                  <span>
                    Error อ่านง่ายและบอกที่แก้<span className="ix-req__where">Error และ error detail: hint, fix, function, ไฟล์, target, หมวด</span>
                  </span>
                </li>
              </ol>
            </div>
          </div>
        </div>
      </section>

      <section className="section" aria-labelledby="h-pipe">
        <div className="section__head">
          <h2 className="section__title" id="h-pipe">
            ข้อมูลเดินทางอย่างไร
          </h2>
          <span className="section__meta">ภาพ 3 มิติ (ถ้าเบราว์เซอร์รองรับ เลือก queue ได้ที่มุมซ้ายบนของภาพ) · ชี้หรือกดแต่ละจุดเพื่อดูว่าทำอะไร</span>
        </div>
        <div className="panel">
          <Pipeline3D
            className="ix-pipe"
            transport={transport}
            height={400}
            narrowHeight={600}
            links={{ monitor: href('/overview'), clickhouse: '/DATA-DICTIONARY.md', ai: '/DATA-DICTIONARY.md' }}
            ariaLabel="เส้นทางของข้อมูล"
          />
        </div>
        <p className="hint mt-2">
          log และ span จากแอปของลูกค้า ผ่าน queue ที่ลูกค้าใช้อยู่ ไปที่ skilllane-monitoring engine และ ClickHouse แล้วหน้าจอชุดนี้กับ AI อ่านต่อ · สีของซองดูได้ที่ &quot;อ่านภาพนี้อย่างไร&quot;
          {health.ok ? <> · engine ที่หน้าจอนี้ต่ออยู่อ่านจาก {TRANSPORT_LABEL[transport]} (GET /api/health)</> : null}
        </p>
      </section>

      <Section id="screens" title="หน้าจอ" meta={`แต่ละหน้าตอบคำถามหนึ่งข้อ · ตัวเลขใต้คำถามคือสิ่งที่หน้านั้นแสดงตอนนี้ (${env ?? 'ทุก env'})`}>
        <div className="ix-screens">
          {cards.map((c) => (
            <article className="ix-card" key={c.name}>
              <span className="ix-card__top">
                <Icon name={c.icon} />
                <Link className="ix-card__link ix-card__name" href={c.href}>
                  {c.name}
                </Link>
                <span className="ix-card__file">{c.path}</span>
              </span>
              <span className="ix-card__q">{c.question}</span>
              <span className="ix-card__data">{c.data}</span>
              <span className="ix-card__api">{c.api}</span>
            </article>
          ))}
        </div>
      </Section>

      <Section id="legend" title="สัญลักษณ์" meta="สีบอกความรุนแรงหรือตัวตนของ service และมีตัวอักษรกำกับเสมอ">
        <div className="grid grid--3">
          <div className="table-wrap">
            <table className="table table--dense ix-legend-table">
              <caption>
                ระดับ log (<span className="mono">level</span>)
              </caption>
              <thead>
                <tr>
                  <th scope="col">ป้าย</th>
                  <th scope="col">ความหมาย</th>
                </tr>
              </thead>
              <tbody>
                {(
                  [
                    ['debug', 'รายละเอียดสำหรับ debug'],
                    ['info', 'เหตุการณ์ปกติ'],
                    ['warn', 'ผิดปกติแต่ยังทำงานต่อได้ เช่น 4xx, retry'],
                    ['error', 'Request หรือ job ล้มเหลว'],
                    ['fatal', 'Process ล่มหรือหยุดทำงาน'],
                  ] as const
                ).map(([lvl, text]) => (
                  <tr key={lvl}>
                    <td>
                      <LevelBadge level={lvl} />
                    </td>
                    <td>{text}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="table-wrap">
            <table className="table table--dense ix-legend-table">
              <caption>
                หมวดของ error (<span className="mono">error_category</span>)
              </caption>
              <thead>
                <tr>
                  <th scope="col">ป้าย</th>
                  <th scope="col">ใครต้องทำอะไร</th>
                </tr>
              </thead>
              <tbody>
                {(
                  [
                    ['bug', 'bug: แก้โค้ดแล้ว deploy'],
                    ['input', 'input: client ส่งค่าไม่ผ่านหรือหาไม่เจอ'],
                    ['data', 'data: ข้อมูลใน DB ไม่ตรงกับ schema หรือกันเอง'],
                    ['dependency', 'dependency: DB, Redis, API ภายนอก'],
                    ['config', 'config: env หรือ credential ผิด'],
                  ] as const
                ).map(([cat, text]) => (
                  <tr key={cat}>
                    <td>
                      <CategoryChip category={cat} />
                    </td>
                    <td>{text}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="table-wrap">
            <table className="table table--dense ix-legend-table">
              <caption>ป้ายอื่น</caption>
              <thead>
                <tr>
                  <th scope="col">ป้าย</th>
                  <th scope="col">ความหมาย</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>
                    <HttpStatus status={404} /> <HttpStatus status={500} />
                  </td>
                  <td>HTTP status; 2xx ไม่มีสี</td>
                </tr>
                <tr>
                  <td>
                    <NewBadge />
                  </td>
                  <td>Error group ที่เริ่มเกิดหลัง version ล่าสุด</td>
                </tr>
                <tr>
                  <td>
                    <StateChip state="ok">up</StateChip> <StateChip state="warn">ต้องดู</StateChip> <StateChip state="down">down</StateChip>
                  </td>
                  <td>สถานะระบบที่เรียกใช้ (ต้องดู = ยังตอบแต่ปฏิเสธ request)</td>
                </tr>
                <tr>
                  <td>
                    <span className="svc svc-1">core</span> <span className="svc svc-2">etl</span> <span className="svc svc-3">video</span>
                  </td>
                  <td>สีประจำ service คงที่ทุกหน้า</td>
                </tr>
                <tr>
                  <td>
                    <span className="env env--prod">prod</span>
                  </td>
                  <td>กำลังดู production; top bar มีเส้นสีนี้</td>
                </tr>
                <tr>
                  <td>
                    <a href="#legend">ลิงก์</a>
                  </td>
                  <td>เขียวเข้ม SkillLane = คลิกได้หรือเลือกอยู่ ไม่ใช่สถานะ</td>
                </tr>
                <tr>
                  <td>
                    <span className="btn btn--sm btn--cta">คัดลอกให้ AI</span>
                  </td>
                  <td>ส้ม = ปุ่มที่สำคัญที่สุดของหน้า มีได้ปุ่มเดียว ไม่ใช่สถานะ</td>
                </tr>
                <tr>
                  <td>
                    <span className="live">สด</span>
                  </td>
                  <td>ข้อมูลเข้ามาเองเมื่อช่วงเวลาเป็นแบบล่าสุด</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </Section>

      <Section id="principles" title="หลักการออกแบบ">
        <ol className="ix-principles">
          <li>
            <b>ข้อมูลมาก่อน</b>
            <p>ตัวเลข เวลา และ id อยู่ตำแหน่งแรกที่สายตาไปถึง ไม่มี hero ไม่มีภาพประกอบ ทุก block บอกช่วงเวลาและ env ที่มันแสดง</p>
          </li>
          <li>
            <b>สีหนึ่งสีมีความหมายเดียว</b>
            <p>
              แดง อำพัน เขียว ฟ้า ใช้กับสถานะเท่านั้น เขียวเข้มของ SkillLane คือสิ่งที่คลิกได้ ส้มคือปุ่มที่สำคัญที่สุดของหน้า สี service บอกตัวตน และทุกสีมีตัวอักษรหรือไอคอนกำกับ
              (สถานะเขียวมีจุดหรือไอคอนเสมอ)
            </p>
          </li>
          <li>
            <b>Error ต้องบอกที่แก้</b>
            <p>หัวข้อคือ hint ตามด้วยประโยค fix, function, ไฟล์ และ target ส่วนข้อความ error ดิบอยู่บรรทัดถัดไป ไม่ใช่หัวข้อ</p>
          </li>
          <li>
            <b>ทุกแถวมีบริบท</b>
            <p>service / role / env และเวลา ICT อยู่ในทุกแถว เพื่อให้ใช้ได้กับทุก app ที่ติดตั้ง package และไม่ต้องเดาว่าดูของใครอยู่</p>
          </li>
          <li>
            <b>คัดลอกได้ทุกอย่าง</b>
            <p>trace id, user id, stack และสรุป Markdown สำหรับ AI คัดลอกได้ในคลิกเดียว ชื่อ field ตรงกับ ClickHouse และพจนานุกรมข้อมูล</p>
          </li>
          <li>
            <b>ใช้ตอนตีสองได้</b>
            <p>
              dark theme ออกแบบเท่ากับ light ไม่มีพื้นที่สว่างจ้า ตัวหนังสือไม่เล็กกว่า 11 px · animation บอกแค่ว่าอะไรเพิ่งเข้ามา เปลี่ยน หรือเกิดก่อนหลัง จบใน 0.7 วินาที
              และปิดเองเมื่อเครื่องตั้ง reduced motion
            </p>
          </li>
        </ol>
      </Section>
    </>
  )
}
