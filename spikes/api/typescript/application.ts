import 'reflect-metadata';
import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyReply } from 'fastify';
import type { LabDatabase } from './database.js';
import { LabModule } from './lab.module.js';

@Catch()
class LabExceptionFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const detail = typeof error === 'object' && error !== null
      ? error as { code?: string; statusCode?: number } : {};
    let status = error instanceof HttpException ? error.getStatus() : detail.statusCode ?? 500;
    if (error instanceof SyntaxError || detail.code === 'FST_ERR_CTP_INVALID_JSON_BODY') status = 422;
    const errors: Record<number, string> = {
      400: 'bad_request', 401: 'unauthorized', 403: 'forbidden', 404: 'not_found',
      413: 'body_too_large', 415: 'unsupported_media_type', 422: 'invalid_json',
    };
    // No exponer mensajes SQL, credenciales, stack ni detalles del framework.
    const code = errors[status] ?? 'internal_error';
    if (!(status in errors)) status = 500;
    host.switchToHttp().getResponse<FastifyReply>().code(status).send({ error: code });
  }
}

export async function createLabApplication(database?: LabDatabase): Promise<NestFastifyApplication> {
  const adapter = new FastifyAdapter({ bodyLimit: 8192, requestTimeout: 10_000, logger: false });
  const fastify = adapter.getInstance();
  const parseJson = fastify.getDefaultJsonParser('error', 'error');
  fastify.removeContentTypeParser('application/json');
  fastify.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    const text = typeof body === 'string' ? body : body.toString('utf8');
    // Preservar el contrato F01 para cuerpo vacío sin renunciar al parser seguro de Fastify.
    if (text === '') { done(null, {}); return; }
    parseJson(request, text, (error, value) => {
      // El adaptador Nest convierte FastifyError y pierde su código original.
      // Normalizar aquí mantiene el 422 histórico sin filtrar el error del parser.
      done(error ? new HttpException('invalid_json', 422) : null, value);
    });
  });
  fastify.addHook('onSend', async (_request, reply, payload) => {
    reply.header('cache-control', 'no-store');
    return payload;
  });
  const app = await NestFactory.create<NestFastifyApplication>(LabModule.register(database), adapter, {
    logger: false, bodyParser: false, abortOnError: false,
  });
  app.useGlobalFilters(new LabExceptionFilter());
  return app;
}
