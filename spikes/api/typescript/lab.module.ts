import { Module, type DynamicModule } from '@nestjs/common';
import { LAB_DATABASE, PostgresLabDatabase, type LabDatabase } from './database.js';
import { LabController } from './lab.controller.js';

@Module({ controllers: [LabController] })
export class LabModule {
  static register(database?: LabDatabase): DynamicModule {
    return {
      module: LabModule,
      providers: [database
        ? { provide: LAB_DATABASE, useValue: database }
        : { provide: LAB_DATABASE, useClass: PostgresLabDatabase }],
    };
  }
}
