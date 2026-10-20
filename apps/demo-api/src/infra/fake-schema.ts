import { Injectable, OnModuleInit } from '@nestjs/common'
import { registerTypeormSchema } from 'skilllane-monitoring'

/**
 * The demo has no TypeORM, so it registers what a DataSource would expose
 * (entityMetadatas, read structurally by skilllane-monitoring). Errors then name
 * `QuestionBankEntity.title` instead of "APP"."QUESTION_BANK"."TITLE", and a
 * `reading 'school'` TypeError names the school relation of ClassroomEntity.
 */
const column = (databaseName: string, propertyPath: string) => ({
  databaseName,
  propertyPath,
})

export const ENTITY_METADATAS = [
  {
    name: 'QuestionBankEntity',
    tableName: 'QUESTION_BANK',
    columns: [
      column('ID', 'id'),
      column('CODE', 'code'),
      column('TITLE', 'title'),
      column('SCHOOL_ID', 'schoolId'),
      column('OWNER_ID', 'ownerId'),
      column('CREATED_AT', 'createdAt'),
    ],
    uniques: [{ name: 'UQ_QUESTION_CODE', columns: [{ propertyPath: 'code' }] }],
    relations: [{ propertyName: 'owner' }],
  },
  {
    name: 'ClassroomEntity',
    tableName: 'CLASSROOM',
    columns: [
      column('ID', 'id'),
      column('NAME', 'name'),
      column('SCHOOL_ID', 'schoolId'),
    ],
    relations: [{ propertyName: 'school' }, { propertyName: 'students' }],
  },
  {
    name: 'SchoolEntity',
    tableName: 'SCHOOL',
    columns: [column('ID', 'id'), column('NAME', 'name')],
    relations: [{ propertyName: 'classrooms' }],
  },
  {
    name: 'StudentEntity',
    tableName: 'STUDENT',
    columns: [
      column('ID', 'id'),
      column('CLASSROOM_ID', 'classroomId'),
      column('DISPLAY_NAME', 'displayName'),
    ],
    relations: [{ propertyName: 'classroom' }],
  },
  {
    name: 'ExamEntity',
    tableName: 'EXAM',
    columns: [column('ID', 'id'), column('TITLE', 'title')],
    relations: [{ propertyName: 'questions' }],
  },
]

@Injectable()
export class FakeTypeormSchema implements OnModuleInit {
  onModuleInit(): void {
    registerTypeormSchema({ entityMetadatas: ENTITY_METADATAS })
  }
}
