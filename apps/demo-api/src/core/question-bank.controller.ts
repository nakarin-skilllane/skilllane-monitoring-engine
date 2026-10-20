import { Body, Controller, Get, HttpCode, Post, Query, Req } from '@nestjs/common'
import { CommandBus, QueryBus } from '@nestjs/cqrs'
import type { Request } from 'express'
import type { DemoUser } from '../common/demo-user.middleware'
import {
  GetMyQuestionsQuery,
  ImportOptions,
  ImportQuestionBankCommand,
} from './question-bank.handlers'

interface ImportBody {
  fileName?: string
  uploadedBy?: { id?: string; email?: string }
  options?: ImportOptions
}

@Controller('question-bank')
export class QuestionBankController {
  constructor(
    private readonly queryBus: QueryBus,
    private readonly commandBus: CommandBus,
  ) {}

  @Get('my')
  my(
    @Req() req: { user?: DemoUser },
    @Query('subject') subject?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.queryBus.execute(
      new GetMyQuestionsQuery(
        req.user?.id ?? 'anonymous',
        req.user?.schoolId,
        subject,
        Math.max(1, Number(page) || 1),
        Math.min(50, Math.max(1, Number(limit) || 20)),
      ),
    )
  }

  @Post('import')
  import(@Req() req: { user?: DemoUser }, @Body() body: ImportBody) {
    return this.commandBus.execute(
      new ImportQuestionBankCommand(
        req.user?.id ?? 'anonymous',
        req.user?.schoolId,
        body?.fileName ?? 'questions.xlsx',
        body?.options ?? {},
      ),
    )
  }

  /**
   * Picture / attachment upload (multipart/form-data or a raw binary): the
   * stream is read here, not by a body parser. The SDK keeps only the part
   * names, file names, types and sizes of such a body.
   */
  @Post('files')
  @HttpCode(201)
  async upload(@Req() req: Request) {
    let bytes = 0
    await new Promise<void>((resolve, reject) => {
      // A JSON / form body was already read by Nest's body parser.
      if (req.readableEnded) return resolve()
      req.on('data', (chunk: Buffer) => {
        bytes += chunk.length
      })
      req.on('end', resolve)
      req.on('error', reject)
    })
    return {
      fileId: `att_${Date.now().toString(36)}`,
      bytes,
      contentType: req.headers['content-type']?.split(';')[0] ?? 'application/octet-stream',
      status: 'stored',
    }
  }
}
