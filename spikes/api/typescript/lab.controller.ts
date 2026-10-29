import { Controller, Get, Inject, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { LAB_DATABASE, type LabDatabase } from './database.js';

@Controller()
export class LabController {
  constructor(@Inject(LAB_DATABASE) private readonly database: LabDatabase) {}

  private async execute(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const idempotencyKey = request.headers['idempotency-key'];
    const result = await this.database.execute({
      method: request.method,
      path: request.url.split('?')[0] ?? '/',
      authorization: request.headers.authorization ?? '',
      idempotencyKey: typeof idempotencyKey === 'string' ? idempotencyKey : '',
      // null debe seguir siendo null: no convertir un JSON inválido para el contrato en {}.
      body: request.body === undefined ? {} : request.body,
    });
    reply.code(result.http_status).send(result.payload);
  }

  @Get('health')
  health(@Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    return this.execute(request, reply);
  }

  @Post('v1/enrollments')
  enroll(@Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    return this.execute(request, reply);
  }

  @Get('v1/operations/:operationId')
  operation(@Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    return this.execute(request, reply);
  }

  @Post('v1/operations/:operationId/ack')
  acknowledge(@Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    return this.execute(request, reply);
  }
}
