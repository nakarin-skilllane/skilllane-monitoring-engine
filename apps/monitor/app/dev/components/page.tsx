import type { Metadata } from 'next'
import Link from 'next/link'
import { AutoRefresh } from '@/components/AutoRefresh'
import { CategoryChip, EnvTag, HttpStatus, LevelBadge, Live, Method, NewBadge, ServiceChip, ServiceDots, StateChip, Tag, Ts } from '@/components/badges'
import { ChartFrame } from '@/components/charts/ChartFrame'
import { KpiSpark, SparkBars, SparkLine } from '@/components/charts/Sparkline'
import { TimeBars, TimeLine } from '@/components/charts/TimeCharts'
import { CopyButton } from '@/components/CopyButton'
import { Drawer, DrawerLink } from '@/components/Drawer'
import { ActualError, ErrorDetailText, IdChip, KvList } from '@/components/ErrorParts'
import { ExpandRow } from '@/components/ExpandRow'
import { Kpi, Kpis } from '@/components/Kpi'
import { PageHead } from '@/components/PageHead'
import { Panel, Section } from '@/components/Panel'
import { AppliedChip, ParamSegmented, ParamToggleChip } from '@/components/ParamControls'
import { ChangedValue, LiveTbody } from '@/components/Motion'
import { Pipeline3D } from '@/components/Pipeline3D'
import { EmptyState, EngineErrorState, KpiSkeleton, Skeleton, TableSkeleton } from '@/components/states'
import { SystemMap3D } from '@/components/SystemMap3D'
import { DurCell, NumCell, SortTh, Table, TableWrap } from '@/components/table'
import { Tabs } from '@/components/Tabs'
import { engine, getHealth, getMeta } from '@/lib/engine'
import { fmtCount, fmtDuration, fmtPercent, fmtRelative, fmtTime } from '@/lib/format'
import { buildHref, parseScope, type RawSearchParams, scopeQuery, withParams } from '@/lib/params'
import { actualError, type Kv } from '@/lib/readable'
import { serviceOrder } from '@/lib/services'
import { systemMapFromTopology } from '@/lib/topology'
import type { PipelineTransport } from '@/lib/3d/system-map'
import './screen.css'

export const metadata: Metadata = { title: 'Component gallery', robots: { index: false } }

/** Internal reference: every shared component with demo data (not in the nav). */
export default async function ComponentsPage({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  const sp = await searchParams
  const meta = await getMeta()
  const scope = parseScope(sp, 'overview', { envs: meta.ok ? meta.data.envs : undefined, limited: meta.ok && meta.data.envsLimited })
  const order = serviceOrder(meta.ok ? meta.data : null)
  const t0 = Math.floor((scope.nowMs - 3600_000) / 60_000) * 60_000
  const minutes = Array.from({ length: 60 }, (_, i) => t0 + i * 60_000)
  const req = minutes.map((_, i) => 1150 + Math.round(60 * Math.sin(i / 5) + ((i * 37) % 23)))
  const err = minutes.map((_, i) => (i * 7) % 5)
  const lvl = minutes.map((_, i) => [0, 900 + ((i * 13) % 80), 10 + ((i * 7) % 9), 3 + (i % 4), i === 41 ? 1 : 0])
  const kvs: Kv[] = [
    { k: 'method', v: 'POST' },
    { k: 'route', v: '/question-bank/import' },
    { k: 'status', v: '500', tone: 'bad' },
    { k: 'source', v: 'ImportQuestionBankHandler.execute' },
    { k: 'duration', v: '1,842 ms' },
  ]
  const traceId = '4bf92f3577b34da6a3ce929d0e0e4736'
  const [topo, health] = await Promise.all([engine.topology(scopeQuery(scope)), getHealth()])
  const transport = health.ok && ['kafka', 'rabbitmq', 'bullmq'].includes(health.data.transport) ? (health.data.transport as PipelineTransport) : 'kafka'
  // a new key every minute: the top row of the LiveTbody demo slides in after an auto refresh
  const minuteKey = Math.floor(scope.nowMs / 60_000)
  return (
    <>
      <PageHead
        scope={scope}
        title="Component gallery"
        question="ทุก component ที่หน้าจอใช้ร่วมกัน พร้อมข้อมูลตัวอย่าง"
        crumbs={[{ label: 'dev' }, { label: 'components' }]}
        actions={
          <>
            <AutoRefresh />
            <Link className="btn btn--primary" href={buildHref('/overview', scope.keep)}>
              ไปที่ภาพรวม
            </Link>
          </>
        }
      />

      <Kpis cols={4} label="ตัวอย่าง KPI">
        <Kpi label="Request" value={1180} unit="req/min" foot={`รวม ${fmtCount(70800)} request`} spark={req} />
        <Kpi label="Error rate (5xx)" value={0.16} decimals={2} unit="%" delta={{ text: '112 ครั้ง', tone: 'bad' }} spark={err} sparkBad tone="alert" />
        <Kpi label="p95" value={312} unit="ms" foot="route ช้าสุด 2.4 s" />
        <Kpi label="Error group ใหม่หลัง deploy" value={1} delta={{ text: <>Read from undefined value · <span className="badge-new">NEW</span></>, tone: 'bad' }} href="/errors" linkLabel="เปิด error group ใหม่" />
      </Kpis>

      <Section id="dev-badges" title="Badge และ chip" meta="components/badges.tsx">
        <div className="panel panel__body dev-row">
          <LevelBadge level="debug" /> <LevelBadge level="info" /> <LevelBadge level="warn" /> <LevelBadge level="error" /> <LevelBadge level="fatal" />
          <Method method="POST" /> <HttpStatus status={200} /> <HttpStatus status={404} /> <HttpStatus status={500} />
          <CategoryChip category="bug" /> <CategoryChip category="input" /> <CategoryChip category="data" /> <CategoryChip category="dependency" /> <CategoryChip category="config" />
          <NewBadge since="31.4.0" /> <EnvTag env="prod" /> <EnvTag env="staging" /> <Tag>31.4.0</Tag>
          <StateChip state="ok">up</StateChip> <StateChip state="warn">ต้องดู</StateChip> <StateChip state="down">down</StateChip>
          <ServiceChip service="school-core-api" role="api" order={order} /> <ServiceChip service="school-etl-api" role="api" order={order} />
          <ServiceChip service="video-transcoder-api" role="api" order={order} /> <ServiceDots services={['school-core-api', 'school-etl-api']} order={order} />
          <Ts value={scope.nowMs} /> <Ts value={scope.nowMs} format="date" /> <span className="hint">{fmtRelative(scope.nowMs - 5 * 60_000, scope.nowMs)}</span>
          <span className="hint">
            {fmtDuration(84)} · {fmtDuration(1842)} · {fmtPercent(0.0016)} · {fmtPercent(0.114)}
          </span>
        </div>
      </Section>

      <Section id="dev-error" title="บรรทัด error ที่อ่านง่าย" meta="components/ErrorParts.tsx · lib/readable.ts">
        <div className="err-list">
          <article className="err-row">
            <div className="err-row__head">
              <LevelBadge level="error" />
              <h3 className="err-row__title">Value too long for column</h3>
              <CategoryChip category="data" />
            </div>
            <KvList items={kvs} />
            <ErrorDetailText text="QuestionBankEntity.title got 312 (max 255). Validate the length in the DTO or import before saving." />
            <ActualError text={actualError({ type: 'QueryFailedError', code: 'ORA-12899', message: 'ORA-12899: value too large for column "APP"."QUESTION_BANK"."TITLE" (actual: 312, maximum: 255)' })} />
            <div className="err-row__meta">
              <ServiceChip service="school-core-api" role="api" order={order} />
              <IdChip label="trace" value={traceId} href={buildHref(`/traces/${traceId}`, scope.keep)} />
              <IdChip label="user" value="u_1029" href={buildHref('/logs', scope.keep, { userId: 'u_1029' })} copy={false} />
            </div>
          </article>
        </div>
      </Section>

      <Section id="dev-charts" title="กราฟ" meta="components/charts/*">
        <div className="stack">
          <ChartFrame
            titleId="dev-c-req"
            title="Request ต่อนาที"
            sub="ตัวอย่าง 60 นาที"
            legend={[{ label: 'request', className: 'svc-1', shape: 'line' }]}
            table={{ caption: 'ค่าต่อนาที', columns: ['นาที', 'Request'], rows: minutes.slice(-5).map((t, i) => [fmtTime(t), fmtCount(req[55 + i])]) }}
          >
            <TimeLine
              labelledBy="dev-c-req"
              stepSeconds={60}
              buckets={minutes}
              series={[{ key: 'req', label: 'request', className: 'svc-1', values: req, area: true }]}
              events={[{ at: minutes[22], label: 'deploy 31.4.0' }]}
            />
          </ChartFrame>
          <ChartFrame
            titleId="dev-c-lvl"
            title="Log ตาม level"
            legend={[
              { label: 'INF', className: 'c-lvl-inf' },
              { label: 'WRN', className: 'c-lvl-wrn' },
              { label: 'ERR', className: 'c-lvl-err' },
              { label: 'FTL', className: 'c-lvl-ftl' },
            ]}
          >
            <TimeBars
              labelledBy="dev-c-lvl"
              stepSeconds={60}
              buckets={minutes.map((t, i) => ({ t, values: lvl[i] }))}
              series={[
                { key: 'debug', label: 'DBG', className: 'c-lvl-dbg' },
                { key: 'info', label: 'INF', className: 'c-lvl-inf' },
                { key: 'warn', label: 'WRN', className: 'c-lvl-wrn' },
                { key: 'error', label: 'ERR', className: 'c-lvl-err' },
                { key: 'fatal', label: 'FTL', className: 'c-lvl-ftl' },
              ]}
              bands={[{ from: minutes[30], to: minutes[31] }]}
            />
          </ChartFrame>
        </div>
        <div className="panel panel__body dev-row mt-4">
          <KpiSpark values={req.slice(-12)} />
          <SparkBars values={[14, 16, 11, 5, 3, 6, 6, 4, 1, 0, 0, 0, 0, 0, 0, 0, 2, 6, 13, 20, 24, 21, 15, 47]} highlight={23} label="24 ชั่วโมง" maxLabel="สูงสุด 47/ชม." />
          <SparkLine values={req.slice(-20)} label="request 20 นาที" />
        </div>
      </Section>

      <Section id="dev-table" title="ตาราง" meta="components/table.tsx · ExpandRow">
        <div className="filterbar">
          <div className="filterbar__group">
            <span className="filter-label">level</span>
            <ParamToggleChip param="level" value="warn" multi label="WRN" count={694} />
            <ParamToggleChip param="level" value="error" multi label="ERR" count={228} />
          </div>
          <ParamSegmented label="สถานะ" param="status" options={[{ value: '', label: 'ทั้งหมด' }, { value: 'error', label: 'Error' }, { value: 'ok', label: 'ปกติ' }]} />
          {sp.userId ? <AppliedChip param="userId" label="user" value={String(sp.userId)} /> : <Link className="btn btn--sm btn--quiet" href={withParams('/dev/components', sp, { userId: 'u_1029' })} scroll={false}>ใส่ตัวกรอง user</Link>}
        </div>
        <TableWrap label="ตัวอย่างตาราง">
          <Table caption="route ตัวอย่าง">
            <thead>
              <tr>
                <th scope="col" className="col-tight">
                  <span className="sr-only">ขยาย</span>
                </th>
                <th scope="col">Route</th>
                <SortTh label="Request" href={withParams('/dev/components', sp, { sort: 'requests' })} dir="descending" num />
                <th scope="col" className="num">Error rate</th>
                <th scope="col" className="num">p95</th>
              </tr>
            </thead>
            <tbody>
              <ExpandRow
                label="ขยาย POST /question-bank/import"
                colSpan={4}
                className="is-bad"
                cells={
                  <>
                    <td className="mono">POST /question-bank/import</td>
                    <NumCell>412</NumCell>
                    <NumCell className="t-danger">{fmtPercent(0.114)}</NumCell>
                    <DurCell ms={2100} max={2400} tone="bad" />
                  </>
                }
                detail={
                  <div className="row-detail__body">
                    <KvList items={kvs} />
                  </div>
                }
              />
              <tr className="is-slow">
                <td />
                <td className="mono">GET /classes/:id/students</td>
                <NumCell>9,870</NumCell>
                <NumCell>0 %</NumCell>
                <DurCell ms={2400} max={2400} tone="warn" />
              </tr>
            </tbody>
          </Table>
        </TableWrap>
      </Section>

      <Section id="dev-tabs" title="Tabs, drawer, copy" meta="Tabs.tsx · Drawer.tsx · CopyButton.tsx">
        <Panel>
          <Tabs
            label="ตัวอย่าง tabs"
            param="tab"
            items={[
              { key: 'a', label: 'Attribute', count: 12, panel: <p className="lead">แท็บแรก (URL param tab)</p> },
              { key: 'b', label: 'Log', count: 4, panel: <p className="lead">แท็บที่สอง</p> },
            ]}
          />
          <div className="dev-row mt-4">
            <DrawerLink param="drawer" value="demo" className="btn">
              เปิด drawer
            </DrawerLink>
            <CopyButton text={traceId} label="คัดลอก trace id" />
            <CopyButton text={traceId} variant="icon" ariaLabel="คัดลอก trace id" />
            <CopyButton targetId="dev-ai" label="คัดลอกให้ AI" variant="primary" />
          </div>
          <pre className="code code--wrap mt-3" id="dev-ai">{`### Value too long for column (ORA-12899, category: data)\n- level: error\n- fields: see docs/DATA-DICTIONARY.md`}</pre>
        </Panel>
        <Drawer id="dev-drawer" param="drawer" value="demo" title="Value too long for column" sub={<><LevelBadge level="error" /><EnvTag env="prod" /></>} foot={<CopyButton text={traceId} label="คัดลอก trace id" />}>
          <p className="lead">เนื้อหา drawer ที่ server render ไว้ เปิดจาก URL ?drawer=demo · Esc / ปุ่มปิด / พื้นหลัง เพื่อปิด</p>
        </Drawer>
      </Section>

      <Section id="dev-states" title="Empty, error, loading" meta="components/states.tsx">
        <div className="grid grid--2">
          <Panel>
            <EmptyState title="ไม่มี log ในช่วงนี้" text="ลองขยายช่วงเวลา หรือเอาตัวกรอง level ออก" />
          </Panel>
          <EngineErrorState error={{ kind: 'unreachable', status: null, message: 'ECONNREFUSED', path: '/api/overview?env=prod', engineUrl: 'http://localhost:5100' }} />
        </div>
        <div className="mt-4">
          <KpiSkeleton count={3} />
        </div>
        <div className="panel mt-4">
          <TableSkeleton rows={3} />
        </div>
      </Section>

      <Section id="dev-motion" title="Motion" meta="components/Motion.tsx · ปิดได้ด้วย ?motion=off">
        <div className="panel panel__body" id="dev-motion-demo">
          <div className="dev-row">
            <Live /> <NewBadge since="31.4.0" />
            <span>
              ข้อมูลล่าสุด <ChangedValue value={scope.nowMs} className="ts">{fmtTime(scope.nowMs)}</ChangedValue>
            </span>
            <span className="kpi__value" data-mo-count="">
              1,180
            </span>
            <button className="btn btn--sm" type="button" data-mo-replay="#dev-motion-demo">
              เล่นอีกครั้ง
            </button>
          </div>
          <div className="mt-4">
            <SparkBars values={err.slice(-24)} label="ตัวอย่าง 24 ช่อง" maxLabel="สูงสุด 4" />
          </div>
          <div className="table-wrap mt-4">
            <table className="table table--dense">
              <caption className="sr-only">ตัวอย่างแถวใหม่</caption>
              <LiveTbody resetKey="demo">
                {[minuteKey, minuteKey - 1, minuteKey - 2].map((k) => (
                  <tr key={k} data-key={String(k)}>
                    <td className="ts">{fmtTime(k * 60_000)}</td>
                    <td>แถวของนาทีนี้เลื่อนเข้ามาหลัง auto refresh รอบใหม่</td>
                  </tr>
                ))}
              </LiveTbody>
            </table>
          </div>
          <div className="mt-4">
            <Skeleton variant="title" />
            <Skeleton variant="text" />
            <Skeleton variant="short" />
          </div>
        </div>
      </Section>

      <Section id="dev-3d" title="ภาพ 3 มิติ" meta="components/SystemMap3D.tsx (GET /api/topology) · components/Pipeline3D.tsx">
        <Panel flush>
          {topo.ok ? (
            <SystemMap3D data={systemMapFromTopology(topo.data)} serviceOrder={order} ariaLabel="แผนผังระบบตัวอย่าง" legendOpen={false} />
          ) : (
            <EngineErrorState error={topo.error} inPanel={false} />
          )}
        </Panel>
        <div className="panel mt-4">
          <Pipeline3D transport={transport} links={{ monitor: '/overview', clickhouse: '/DATA-DICTIONARY.md', ai: '/DATA-DICTIONARY.md' }} />
        </div>
      </Section>
    </>
  )
}
