import { Logger } from '@nestjs/common'
import {
  CommandHandler,
  ICommandHandler,
  IQueryHandler,
  QueryHandler,
} from '@nestjs/cqrs'
import axios from 'axios'
import { config } from '../config'
import { accessToken, pickBy, questionTitle, SUBJECTS } from '../common/school-data'
import { between, chance, sleep } from '../common/util'
import { CacheService } from '../infra/cache.service'
import { OracleClient, titleTooLong } from '../infra/oracle'

export class GetMyQuestionsQuery {
  constructor(
    readonly userId: string,
    readonly schoolId?: string,
    readonly subject?: string,
    readonly page = 1,
    readonly limit = 20,
  ) {}
}

export interface ImportOptions {
  sheet?: string
  skipDuplicates?: boolean
  dryRun?: boolean
}

export class ImportQuestionBankCommand {
  constructor(
    readonly userId: string,
    readonly schoolId: string | undefined,
    readonly fileName: string,
    readonly options: ImportOptions = {},
  ) {}
}

interface QuestionSummary {
  id: number
  code: string
  subject: string
  subjectName: string
  title: string
  difficulty: 'easy' | 'medium' | 'hard'
  updatedAt: string
}

interface ParsedSheet {
  rows: number
  sheet: string
  preview: Array<{ row: number; code: string; title: string; answer: string }>
  warnings: string[]
}

// school-core-api → school-etl-api: the service token (a header the SDK masks).
const serviceToken = accessToken('svc_school-core-api', undefined, 'service')

@QueryHandler(GetMyQuestionsQuery)
export class GetMyQuestionsHandler implements IQueryHandler<GetMyQuestionsQuery> {
  constructor(
    private readonly cache: CacheService,
    private readonly oracle: OracleClient,
  ) {}

  async execute(query: GetMyQuestionsQuery): Promise<QuestionSummary[]> {
    const key = `question-bank:my:${query.userId}:${query.subject ?? 'all'}:${query.page}`
    const cached = await this.cache.getJson<QuestionSummary[]>(key)
    if (cached) return cached
    const subject = SUBJECTS.find((s) => s.code === query.subject?.toUpperCase())
    const offset = (query.page - 1) * query.limit
    const rows = await this.oracle.run(
      'SELECT',
      'QUESTION_BANK',
      subject
        ? 'SELECT "ID", "CODE", "SUBJECT", "TITLE", "DIFFICULTY", "UPDATED_AT" FROM "APP"."QUESTION_BANK" WHERE "OWNER_ID" = :1 AND "SCHOOL_ID" = :2 AND "SUBJECT" = :3 ORDER BY "CREATED_AT" DESC OFFSET :4 ROWS FETCH NEXT :5 ROWS ONLY'
        : 'SELECT "ID", "CODE", "SUBJECT", "TITLE", "DIFFICULTY", "UPDATED_AT" FROM "APP"."QUESTION_BANK" WHERE "OWNER_ID" = :1 AND "SCHOOL_ID" = :2 ORDER BY "CREATED_AT" DESC OFFSET :3 ROWS FETCH NEXT :4 ROWS ONLY',
      async () => {
        await sleep(between(15, 70))
        const seed = Number(query.userId.replace(/\D/g, '')) || 1
        return Array.from({ length: between(3, Math.min(12, query.limit)) }, (_, i) => {
          const id = 1000 + offset + i
          const s = subject ?? pickBy(SUBJECTS, seed + i)
          return {
            id,
            code: `Q-${s.code}-${id}`,
            subject: s.code,
            subjectName: s.name,
            title: questionTitle(seed * 13 + id),
            difficulty: pickBy(['easy', 'medium', 'hard'] as const, id),
            updatedAt: new Date(Date.UTC(2026, 9, 1 + (id % 17), 2, id % 60)).toISOString(),
          }
        })
      },
      subject
        ? [query.userId, query.schoolId ?? null, subject.code, offset, query.limit]
        : [query.userId, query.schoolId ?? null, offset, query.limit],
    )
    await this.cache.setJson(key, rows, 20)
    return rows
  }
}

@CommandHandler(ImportQuestionBankCommand)
export class ImportQuestionBankHandler
  implements ICommandHandler<ImportQuestionBankCommand>
{
  private readonly logger = new Logger(ImportQuestionBankHandler.name)

  constructor(private readonly oracle: OracleClient) {}

  async execute(command: ImportQuestionBankCommand) {
    // school-etl-api parses the Excel file (HTTP; the trace continues there).
    const { data } = await axios.post<ParsedSheet>(
      `${config.etlUrl}/etl/parse-excel`,
      {
        fileName: command.fileName,
        schoolId: command.schoolId,
        sheetName: command.options.sheet ?? 'Questions',
        requestedBy: command.userId,
        columns: ['code', 'title', 'choiceA', 'choiceB', 'choiceC', 'choiceD', 'answer'],
      },
      {
        timeout: 5_000,
        params: { dryRun: command.options.dryRun ?? false, source: 'school-core-api' },
        headers: { authorization: `Bearer ${serviceToken}`, 'x-school-id': command.schoolId ?? '' },
      },
    )
    this.logger.log(`Parsed ${data.rows} rows from sheet ${data.sheet}`)

    // An Excel title longer than the column: the bug the demo shows.
    const failing = chance(config.importFailRate)
    const first = data.preview[0]
    const id = 50_000 + between(1, 9_999)
    await this.oracle.run(
      'INSERT',
      'QUESTION_BANK',
      'INSERT INTO "APP"."QUESTION_BANK" ("ID", "CODE", "TITLE", "SCHOOL_ID", "OWNER_ID", "CREATED_AT") VALUES (:1, :2, :3, :4, :5, :6)',
      () => this.saveQuestions(data.rows, failing),
      [
        id,
        first?.code ?? `Q-${id}`,
        failing ? `${first?.title ?? questionTitle(id)} `.repeat(12).slice(0, 312) : (first?.title ?? questionTitle(id)),
        command.schoolId ?? null,
        command.userId,
        new Date(),
      ],
    )
    this.logger.log(`Imported ${data.rows} questions`)
    return { imported: data.rows, sheet: data.sheet, warnings: data.warnings }
  }

  /** Stands in for repository.insert(rows) through node-oracledb. */
  private async saveQuestions(rows: number, failing: boolean): Promise<void> {
    await sleep(between(30, 120) + Math.min(rows, 100))
    if (failing) throw titleTooLong()
  }
}
