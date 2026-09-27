import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.interface';
import { ApiaryScopeFilter } from '../interface/request-with.apiary';
import { apiaryWriteScope } from '../common';
import { Prisma } from '@/prisma/client';
import { SdkAiService } from './providers/sdk-ai.service';

export interface AiTranscript {
  text: string;
  language?: string | null;
  segments?: unknown[];
  [key: string]: unknown;
}

export interface AiInspectionDraft {
  [key: string]: unknown;
}

export interface AiProcessUploadResponse {
  status: string;
  transcript: AiTranscript;
  inspectionDraft: AiInspectionDraft;
  analysisError?: string | null;
}

/**
 * Runs the audio -> transcript -> inspection draft pipeline in-process via
 * the SDK provider (replaces the former external Python AI service).
 */
@Injectable()
export class AiService {
  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly sdkAi: SdkAiService,
  ) {}

  async analyzeInspectionAudio(
    inspectionId: string,
    audioId: string,
    filter: ApiaryScopeFilter,
  ): Promise<AiProcessUploadResponse> {
    if (!this.sdkAi.isEnabled()) {
      throw new BadRequestException('AI is disabled');
    }

    // The caller must be able to write to the apiary the inspection belongs to.
    const audio = await this.prisma.inspectionAudio.findFirst({
      where: {
        id: audioId,
        inspectionId,
        inspection: { hive: { apiary: apiaryWriteScope(filter) } },
      },
    });

    if (!audio) {
      throw new NotFoundException('Audio not found');
    }

    const downloadUrl = await this.storage.generateDownloadUrl(
      audio.storageKey,
      900,
    );

    const audioResponse = await fetch(downloadUrl);
    if (!audioResponse.ok) {
      throw new BadRequestException(
        `Failed to fetch audio file from storage (${audioResponse.status})`,
      );
    }
    const audioBuffer = Buffer.from(await audioResponse.arrayBuffer());

    await this.prisma.inspectionAudio.update({
      where: { id: audio.id },
      data: { transcriptionStatus: 'PROCESSING' },
    });

    try {
      const transcript = await this.sdkAi.transcribe(audioBuffer);
      const { draft, analysisError } = await this.sdkAi.analyzeTranscript(
        transcript.text,
      );

      await this.prisma.inspectionAudio.update({
        where: { id: audio.id },
        data: {
          transcriptionStatus: 'COMPLETED',
          transcription: transcript.text,
          transcriptionError: null,
          analysisStatus: 'COMPLETED',
          analysisResult:
            (draft as unknown as Prisma.InputJsonValue) ?? Prisma.JsonNull,
          analysisError,
          analysisCompletedAt: new Date(),
        },
      });

      return {
        status: 'completed',
        transcript: {
          text: transcript.text,
          language: transcript.language,
          segments: transcript.segments,
        },
        inspectionDraft: draft as unknown as AiInspectionDraft,
        analysisError,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.prisma.inspectionAudio
        .update({
          where: { id: audio.id },
          data: {
            transcriptionStatus: 'FAILED',
            transcriptionError: message,
          },
        })
        .catch(() => undefined);
      throw error;
    }
  }
}
