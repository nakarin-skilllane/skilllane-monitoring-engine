import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
} from '@nestjs/common'
import { className, pickBy, SUBJECTS } from '../common/school-data'
import { between, sleep } from '../common/util'
import { EntityNotFoundError, OracleClient } from '../infra/oracle'

const CHOICES = ['A', 'B', 'C', 'D']

interface SubmitBody {
  studentId?: number
  startedAt?: string
  answers?: Array<{ questionId?: number; choice?: string }>
}

@Controller('exams')
export class ExamsController {
  constructor(private readonly oracle: OracleClient) {}

  /** Exams above 900 do not exist: findOneOrFail → 404 (warn). */
  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.oracle.run(
      'SELECT',
      'EXAM',
      'SELECT "ID", "TITLE", "SUBJECT", "DUE_AT", "DURATION_MIN" FROM "APP"."EXAM" WHERE "ID" = :1',
      () => this.findOneOrFail(id),
      [id],
    )
  }

  /** Stands in for examRepository.findOneOrFail({ where: { id } }). */
  private async findOneOrFail(id: number) {
    await sleep(between(10, 40))
    if (id > 900) throw new EntityNotFoundError('ExamEntity', { id })
    const subject = pickBy(SUBJECTS, id)
    return {
      id,
      title: `สอบกลางภาค${subject.name} ${className(id)}`,
      subject: subject.code,
      questions: 20,
      durationMin: 60,
      dueAt: new Date(Date.UTC(2026, 9, 20 + (id % 7), 3)).toISOString(),
    }
  }

  /** ValidationPipe-style 400: one rule per entry, property path first. */
  @Post(':id/submit')
  async submit(@Param('id', ParseIntPipe) id: number, @Body() body: SubmitBody) {
    const answers = Array.isArray(body?.answers) ? body.answers : []
    const errors: string[] = []
    if (!answers.length) errors.push('answers should not be empty')
    answers.forEach((answer, i) => {
      if (!CHOICES.includes(String(answer?.choice))) {
        errors.push(`answers.${i}.choice must be one of A, B, C, D`)
      }
    })
    if (errors.length) throw new BadRequestException(errors)
    const studentId = body.studentId ?? between(100, 49_999)
    const score = Math.round((answers.filter((a, i) => a.choice === CHOICES[(id + i) % 4]).length / answers.length) * 1000) / 10
    await this.oracle.run(
      'INSERT',
      'EXAM_SUBMISSION',
      'INSERT INTO "APP"."EXAM_SUBMISSION" ("EXAM_ID", "STUDENT_ID", "ANSWERS", "SCORE", "STARTED_AT", "SUBMITTED_AT") VALUES (:1, :2, :3, :4, :5, :6)',
      () => sleep(between(20, 80)),
      [
        id,
        studentId,
        JSON.stringify(answers),
        score,
        body.startedAt ? new Date(body.startedAt) : null,
        new Date(),
      ],
    )
    return { examId: id, studentId, accepted: answers.length, score }
  }
}
