import { Controller, Get, Param, ParseIntPipe, Query } from '@nestjs/common'
import { QueryBus } from '@nestjs/cqrs'
import { ClassroomRepository, GetClassReportQuery } from './classes.handlers'

@Controller('classes')
export class ClassesController {
  constructor(
    private readonly queryBus: QueryBus,
    private readonly classrooms: ClassroomRepository,
  ) {}

  @Get(':id/report')
  report(@Param('id', ParseIntPipe) id: number) {
    return this.queryBus.execute(new GetClassReportQuery(id))
  }

  @Get(':id/students')
  async students(
    @Param('id', ParseIntPipe) id: number,
    @Query('term') term = '2569/1',
    @Query('include') include = '',
  ) {
    const students = await this.classrooms.students(id, term, include.split(',').includes('scores'))
    return { classId: id, term, count: students.length, students }
  }
}
