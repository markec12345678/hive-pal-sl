import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AiService } from './ai.service';
import { AiController } from './ai.controller';
import { PrismaService } from '../prisma/prisma.service';
import { LoggerModule } from '../logger/logger.module';
import { SdkAiService } from './providers/sdk-ai.service';

@Module({
  imports: [ConfigModule, LoggerModule],
  controllers: [AiController],
  providers: [AiService, SdkAiService, PrismaService],
  exports: [AiService, SdkAiService],
})
export class AiModule {}
