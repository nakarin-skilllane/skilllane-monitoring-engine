import { Injectable, Logger } from '@nestjs/common'
import { IQueryHandler, QueryHandler } from '@nestjs/cqrs'
import { classCode, className, nationalId, scoreOf, studentName } from '../common/school-data'
import { between, sleep } from '../common/util'
import { OracleClient } from '../infra/oracle'

export class GetClassReportQuery {
  constructor(readonly classId: number) {}
}

interface Classroom {
  id: number
  name: string
  school: { id: number; name: string }
}

@Injectable()
export class ClassroomRepository {
  constructor(private readonly oracle: OracleClient) {}

  /** Classrooms whose id ends in 7 were deleted: findOne returns undefined. */
  findOne(id: number): Promise<Classroom | undefined> {
    return this.oracle.run(
      'SELECT',
      'CLASSROOM',
      'SELECT "C"."ID", "C"."NAME", "S"."ID", "S"."NAME" FROM "APP"."CLASSROOM" "C" LEFT JOIN "APP"."SCHOOL" "S" ON "S"."ID" = "C"."SCHOOL_ID" WHERE "C"."ID" = :1',
      async () => {
        await sleep(between(10, 50))
        if (id % 10 === 7) return undefined
        return {
          id,
          name: className(id),
          school: { id: 100 + (id % 20), name: `โรงเรียนสาธิตวิทยา ${100 + (id % 20)}` },
        }
      },
      [id],
    )
  }

  /** The slow scenario: a full scan of STUDENT, 1.5–3 s. */
  students(classId: number, term: string, withScores: boolean) {
    return this.oracle.run(
      'SELECT',
      'STUDENT',
      'SELECT "ID", "STUDENT_CODE", "DISPLAY_NAME", "CLASSROOM_ID", "BIRTH_DATE" FROM "APP"."STUDENT" WHERE UPPER("CLASSROOM_CODE") LIKE :1 AND "TERM" = :2 AND "ACTIVE" = :3',
      async () => {
        await sleep(between(1_500, 3_000))
        return Array.from({ length: between(20, 40) }, (_, i) => {
          const id = classId * 100 + i
          return {
            id,
            studentCode: `66${String(id).padStart(5, '0')}`,
            displayName: studentName(id),
            classroomId: classId,
            birthDate: `20${10 + (id % 3)}-0${(id % 9) + 1}-${String((id % 27) + 1).padStart(2, '0')}`,
            ...(withScores
              ? { scores: { midterm: scoreOf(id, 1), final: scoreOf(id, 2), homework: scoreOf(id, 3) } }
              : {}),
          }
        })
      },
      [`${classCode(classId)}%`, term, 1],
    )
  }

  /** A student's record as the profile screen saves it. */
  updateProfile(studentId: number, profile: { displayName: string; email: string; birthDate?: string }) {
    return this.oracle.run(
      'UPDATE',
      'STUDENT',
      'UPDATE "APP"."STUDENT" SET "DISPLAY_NAME" = :1, "EMAIL" = :2, "NATIONAL_ID" = :3, "BIRTH_DATE" = :4, "UPDATED_AT" = :5 WHERE "ID" = :6',
      () => sleep(between(15, 60)),
      [
        profile.displayName,
        profile.email,
        nationalId(studentId),
        profile.birthDate ? new Date(`${profile.birthDate}T00:00:00+07:00`) : null,
        new Date(),
        studentId,
      ],
    )
  }
}

@QueryHandler(GetClassReportQuery)
export class GetClassReportHandler implements IQueryHandler<GetClassReportQuery> {
  private readonly logger = new Logger(GetClassReportHandler.name)

  constructor(
    private readonly classrooms: ClassroomRepository,
    private readonly oracle: OracleClient,
  ) {}

  async execute({ classId }: GetClassReportQuery) {
    // The bug the demo shows: no null check after findOne.
    const classroom = (await this.classrooms.findOne(classId)) as Classroom
    const school = classroom.school.name
    const scores = await this.oracle.run(
      'SELECT',
      'EXAM_SCORE',
      'SELECT "STUDENT_ID", AVG("SCORE") FROM "APP"."EXAM_SCORE" WHERE "CLASSROOM_ID" = :1 GROUP BY "STUDENT_ID"',
      async () => {
        await sleep(between(40, 160))
        return between(20, 40)
      },
      [classId],
    )
    this.logger.debug(`Class report built for ${scores} students`)
    return {
      classId,
      classroom: classroom.name,
      school,
      students: scores,
      average: Math.round(scoreOf(classId, 7) * 10) / 10,
      generatedAt: new Date().toISOString(),
    }
  }
}
