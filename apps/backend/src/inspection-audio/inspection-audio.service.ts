import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.interface';
import { CustomLoggerService } from '../logger/logger.service';
import { ApiaryScopeFilter } from '../interface/request-with.apiary';
import { apiaryReadScope, apiaryWriteScope } from '../common';
import { ConfigService } from '@nestjs/config';
import { v4 as uuidv4 } from 'uuid';
import { Prisma, TranscriptionStatus } from '@/prisma/client';
import { SdkAiService } from '../ai/providers/sdk-ai.service';

export interface UploadAudioDto {
  fileName: string;
  duration?: string; // Comes as string from form-data
}

export interface AudioResponse {
  id: string;
  inspectionId: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  duration: number | null;
  transcriptionStatus: TranscriptionStatus;
  analysisStatus: TranscriptionStatus;
  transcription: string | null;
  createdAt: string;
}

export interface ApiaryAudioListItem extends AudioResponse {
  inspectionDate: string;
  hiveId: string;
  hiveName: string;
}

export interface DownloadUrlResponse {
  downloadUrl: string;
  expiresIn: number;
}

export interface AiAnalysisStatusResponse {
  id: string;
  transcriptionStatus: TranscriptionStatus;
  analysisStatus: TranscriptionStatus;
  analysisError: string | null;
  analysisCompletedAt: Date | null;
}

export interface AiAnalysisResultResponse {
  status: TranscriptionStatus;
  transcript: {
    text: string | null;
  };
  inspectionDraft: Prisma.JsonValue | null;
  error: string | null;
}

const ALLOWED_MIME_TYPES = [
  'audio/webm',
  'audio/mp3',
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
];

@Injectable()
export class InspectionAudioService {
  private maxFileSize: number;

  private resolveBackendBaseUrl(): string {
    const backendPublicUrl =
      this.configService.get<string>('BACKEND_PUBLIC_URL');

    if (backendPublicUrl) {
      return backendPublicUrl.replace(/\/$/, '');
    }

    const port = this.configService.get<string>('PORT') ?? '3000';
    return `http://127.0.0.1:${port}`;
  }

  private resolveDownloadUrl(downloadUrl: string): string {
    if (/^https?:\/\//i.test(downloadUrl)) {
      return downloadUrl;
    }

    return new URL(downloadUrl, this.resolveBackendBaseUrl()).toString();
  }

  constructor(
    private prisma: PrismaService,
    private storageService: StorageService,
    private logger: CustomLoggerService,
    private configService: ConfigService,
    private sdkAi: SdkAiService,
  ) {
    this.maxFileSize = Number(
      this.configService.get('INSPECTION_AUDIO_MAX_FILE_SIZE') ?? 10485760,
    );
  }

  /**
   * Upload an audio recording
   */
  async upload(
    inspectionId: string,
    file: Express.Multer.File,
    dto: UploadAudioDto,
    filter: ApiaryScopeFilter,
  ): Promise<AudioResponse> {
    if (!this.storageService.isEnabled()) {
      throw new BadRequestException(
        'Audio recording is not available. Storage is not configured.',
      );
    }

    if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      throw new BadRequestException(
        `Invalid audio format. Allowed formats: ${ALLOWED_MIME_TYPES.join(', ')}`,
      );
    }

    if (file.size > this.maxFileSize) {
      throw new BadRequestException(
        `File size exceeds maximum allowed (${Math.round(this.maxFileSize / 1024 / 1024)}MB)`,
      );
    }

    const inspection = await this.prisma.inspection.findFirst({
      where: {
        id: inspectionId,
        hive: {
          apiary: apiaryWriteScope(filter),
        },
      },
    });

    if (!inspection) {
      throw new NotFoundException(
        `Inspection with ID ${inspectionId} not found`,
      );
    }

    const audioId = uuidv4();
    const extension = this.getExtensionFromMimeType(file.mimetype);
    const storageKey = `audio/${inspectionId}/${audioId}.${extension}`;

    await this.storageService.uploadObject(
      storageKey,
      file.buffer,
      file.mimetype,
    );

    const duration = dto.duration ? parseFloat(dto.duration) : null;

    const audio = await this.prisma.inspectionAudio.create({
      data: {
        id: audioId,
        inspectionId,
        storageKey,
        fileName: dto.fileName,
        mimeType: file.mimetype,
        fileSize: file.size,
        duration,
      },
    });

    this.logger.log({
      message: 'Audio recording uploaded',
      audioId,
      inspectionId,
      fileName: dto.fileName,
      fileSize: file.size,
    });

    return this.mapToResponse(audio);
  }

  /**
   * List all audio recordings for an inspection
   */
  async findAll(
    inspectionId: string,
    filter: ApiaryScopeFilter,
  ): Promise<AudioResponse[]> {
    const inspection = await this.prisma.inspection.findFirst({
      where: {
        id: inspectionId,
        hive: {
          apiary: apiaryReadScope(filter),
        },
      },
    });

    if (!inspection) {
      throw new NotFoundException(
        `Inspection with ID ${inspectionId} not found`,
      );
    }

    const audioRecordings = await this.prisma.inspectionAudio.findMany({
      where: { inspectionId },
      orderBy: { createdAt: 'desc' },
    });

    return audioRecordings.map((audio) => this.mapToResponse(audio));
  }

  /**
   * List all audio recordings for an apiary, joined with inspection + hive info.
   */
  async findAllForApiary(
    filter: ApiaryScopeFilter,
  ): Promise<ApiaryAudioListItem[]> {
    const records = await this.prisma.inspectionAudio.findMany({
      where: {
        inspection: {
          hive: {
            apiary: apiaryReadScope(filter),
          },
        },
      },
      include: {
        inspection: {
          select: {
            id: true,
            date: true,
            hive: {
              select: { id: true, name: true },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return records.map((r) => ({
      id: r.id,
      inspectionId: r.inspectionId,
      inspectionDate: r.inspection.date.toISOString(),
      hiveId: r.inspection.hive.id,
      hiveName: r.inspection.hive.name,
      fileName: r.fileName,
      mimeType: r.mimeType,
      fileSize: r.fileSize,
      duration: r.duration,
      transcriptionStatus: r.transcriptionStatus,
      analysisStatus: r.analysisStatus,
      transcription: r.transcription,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  /**
   * Start AI analysis for every audio in the apiary whose transcription is
   * NONE or FAILED. Reuses startAiAnalysis so push/pull/auto routing is shared.
   */
  async startAnalysisForPending(
    filter: ApiaryScopeFilter,
  ): Promise<{ started: number }> {
    const pending = await this.prisma.inspectionAudio.findMany({
      where: {
        transcriptionStatus: { in: ['NONE', 'FAILED'] },
        inspection: {
          hive: {
            apiary: apiaryWriteScope(filter),
          },
        },
      },
      select: { id: true, inspectionId: true },
    });

    let started = 0;
    for (const audio of pending) {
      try {
        await this.startAiAnalysis(audio.inspectionId, audio.id, filter);
        started++;
      } catch (err) {
        this.logger.warn({
          message: 'Failed to start AI analysis for audio in bulk',
          audioId: audio.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return { started };
  }

  /**
   * Get a pre-signed download URL for an audio recording
   */
  async getDownloadUrl(
    inspectionId: string,
    audioId: string,
    filter: ApiaryScopeFilter,
  ): Promise<DownloadUrlResponse> {
    if (!this.storageService.isEnabled()) {
      throw new BadRequestException(
        'Audio recording is not available. Storage is not configured.',
      );
    }

    const audio = await this.prisma.inspectionAudio.findFirst({
      where: {
        id: audioId,
        inspectionId,
        inspection: {
          hive: {
            apiary: apiaryReadScope(filter),
          },
        },
      },
    });

    if (!audio) {
      throw new NotFoundException(`Audio with ID ${audioId} not found`);
    }

    const expiresIn = 3600;
    const downloadUrl = await this.storageService.generateDownloadUrl(
      audio.storageKey,
      expiresIn,
    );

    return { downloadUrl, expiresIn };
  }

  /**
   * Delete an audio recording
   */
  async delete(
    inspectionId: string,
    audioId: string,
    filter: ApiaryScopeFilter,
  ): Promise<void> {
    const audio = await this.prisma.inspectionAudio.findFirst({
      where: {
        id: audioId,
        inspectionId,
        inspection: {
          hive: {
            apiary: apiaryWriteScope(filter),
          },
        },
      },
    });

    if (!audio) {
      throw new NotFoundException(`Audio with ID ${audioId} not found`);
    }

    if (this.storageService.isEnabled()) {
      try {
        await this.storageService.deleteObject(audio.storageKey);
      } catch (error) {
        this.logger.warn({
          message: 'Failed to delete audio from storage',
          audioId,
          storageKey: audio.storageKey,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    await this.prisma.inspectionAudio.delete({
      where: { id: audioId },
    });

    this.logger.log({
      message: 'Audio recording deleted',
      audioId,
      inspectionId,
    });
  }

  /**
   * Delete all audio recordings for an inspection (used when deleting inspection)
   */
  async deleteAllForInspection(inspectionId: string): Promise<void> {
    const audioRecordings = await this.prisma.inspectionAudio.findMany({
      where: { inspectionId },
      select: { storageKey: true },
    });

    if (this.storageService.isEnabled() && audioRecordings.length > 0) {
      try {
        await this.storageService.deleteObjects(
          audioRecordings.map((a) => a.storageKey),
        );
      } catch (error) {
        this.logger.warn({
          message: 'Failed to delete audio files from storage',
          inspectionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  async startAiAnalysis(
    inspectionId: string,
    audioId: string,
    filter: ApiaryScopeFilter,
  ): Promise<{ status: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED' }> {
    const audio = await this.prisma.inspectionAudio.findFirst({
      where: {
        id: audioId,
        inspectionId,
        inspection: {
          hive: {
            apiary: apiaryWriteScope(filter),
          },
        },
      },
    });

    if (!audio) {
      throw new NotFoundException(`Audio with ID ${audioId} not found`);
    }

    await this.prisma.inspectionAudio.update({
      where: { id: audioId },
      data: {
        transcription: null,
        transcriptionStatus: 'PENDING',
        transcriptionError: null,
        transcriptionRetries: 0,
        analysisStatus: 'NONE',
        analysisResult: Prisma.JsonNull,
        analysisError: null,
        analysisCompletedAt: null,
        analysisRetries: 0,
      },
    });

    if (this.sdkAi.isEnabled()) {
      void this.runAiAnalysisInBackground(audioId, audio.storageKey);
    } else {
      this.logger.warn({
        message: 'AI_ENABLED is not "true"; audio analysis job left PENDING',
        audioId,
      });
    }

    return { status: 'PENDING' };
  }

  async updateTranscriptionAndReanalyze(
    inspectionId: string,
    audioId: string,
    text: string,
    filter: ApiaryScopeFilter,
  ): Promise<{ status: 'PENDING' }> {
    const audio = await this.prisma.inspectionAudio.findFirst({
      where: {
        id: audioId,
        inspectionId,
        inspection: {
          hive: {
            apiary: apiaryWriteScope(filter),
          },
        },
      },
    });

    if (!audio) {
      throw new NotFoundException(`Audio with ID ${audioId} not found`);
    }

    if (audio.transcriptionStatus !== 'COMPLETED') {
      throw new BadRequestException(
        'Transcription must be COMPLETED before it can be edited',
      );
    }

    if (
      audio.analysisStatus === 'PENDING' ||
      audio.analysisStatus === 'PROCESSING'
    ) {
      throw new BadRequestException(
        'Analysis is already in progress for this recording',
      );
    }

    const trimmed = text.trim();
    if (!trimmed) {
      throw new BadRequestException('Transcription must not be empty');
    }

    await this.prisma.inspectionAudio.update({
      where: { id: audioId },
      data: {
        transcription: trimmed,
        analysisStatus: 'PENDING',
        analysisResult: Prisma.JsonNull,
        analysisError: null,
        analysisCompletedAt: null,
        analysisRetries: 0,
      },
    });

    if (this.sdkAi.isEnabled()) {
      void this.runAnalysisOnlyInBackground(audioId, trimmed);
    } else {
      this.logger.warn({
        message: 'AI_ENABLED is not "true"; analysis job left PENDING',
        audioId,
      });
    }

    this.logger.log({
      message: 'Transcription edited and analysis re-queued',
      audioId,
      length: trimmed.length,
    });

    return { status: 'PENDING' };
  }

  private async runAnalysisOnlyInBackground(
    audioId: string,
    transcript: string,
  ): Promise<void> {
    try {
      await this.prisma.inspectionAudio.update({
        where: { id: audioId },
        data: { analysisStatus: 'PROCESSING' },
      });

      const { draft, analysisError } =
        await this.sdkAi.analyzeTranscript(transcript);

      await this.prisma.inspectionAudio.update({
        where: { id: audioId },
        data: {
          analysisStatus: analysisError ? 'FAILED' : 'COMPLETED',
          analysisResult:
            (draft as unknown as Prisma.InputJsonValue) ?? Prisma.JsonNull,
          analysisError,
          analysisCompletedAt: analysisError ? null : new Date(),
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.prisma.inspectionAudio.update({
        where: { id: audioId },
        data: {
          analysisStatus: 'FAILED',
          analysisError: message,
        },
      });

      this.logger.error({
        message: 'Analysis-only re-run failed',
        audioId,
        error: message,
      });
    }
  }

  private async runAiAnalysisInBackground(
    audioId: string,
    storageKey: string,
  ): Promise<void> {
    try {
      await this.prisma.inspectionAudio.update({
        where: { id: audioId },
        data: { transcriptionStatus: 'PROCESSING' },
      });

      const downloadUrl = await this.storageService.generateDownloadUrl(
        storageKey,
        3600,
      );
      const resolvedDownloadUrl = this.resolveDownloadUrl(downloadUrl);
      const audioResponse = await fetch(resolvedDownloadUrl);

      if (!audioResponse.ok) {
        throw new Error(
          `Failed to download audio file: ${audioResponse.status}`,
        );
      }

      const audioBuffer = Buffer.from(await audioResponse.arrayBuffer());

      // Stage 1: speech-to-text via the SDK provider.
      const transcript = await this.sdkAi.transcribe(audioBuffer);

      await this.prisma.inspectionAudio.update({
        where: { id: audioId },
        data: {
          transcription: transcript.text,
          transcriptionStatus: 'COMPLETED',
          transcriptionError: null,
          analysisStatus: 'PROCESSING',
        },
      });

      // Stage 2: transcript -> structured inspection draft via the SDK LLM.
      const { draft, analysisError } = await this.sdkAi.analyzeTranscript(
        transcript.text,
      );

      await this.prisma.inspectionAudio.update({
        where: { id: audioId },
        data: {
          analysisStatus: analysisError ? 'FAILED' : 'COMPLETED',
          analysisResult:
            (draft as unknown as Prisma.InputJsonValue) ?? Prisma.JsonNull,
          analysisError,
          analysisCompletedAt: analysisError ? null : new Date(),
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.prisma.inspectionAudio.update({
        where: { id: audioId },
        data: {
          transcriptionStatus: 'FAILED',
          transcriptionError: message,
          analysisStatus: 'FAILED',
          analysisError: message,
        },
      });

      this.logger.error({
        message: 'AI analysis failed',
        audioId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async getAiAnalysisStatus(
    inspectionId: string,
    audioId: string,
    filter: ApiaryScopeFilter,
  ): Promise<AiAnalysisStatusResponse> {
    const audio = await this.prisma.inspectionAudio.findFirst({
      where: {
        id: audioId,
        inspectionId,
        inspection: {
          hive: {
            apiary: apiaryReadScope(filter),
          },
        },
      },
      select: {
        id: true,
        transcriptionStatus: true,
        analysisStatus: true,
        analysisError: true,
        analysisCompletedAt: true,
      },
    });

    if (!audio) {
      throw new NotFoundException(`Audio with ID ${audioId} not found`);
    }

    return audio;
  }

  async getAiAnalysisResult(
    inspectionId: string,
    audioId: string,
    filter: ApiaryScopeFilter,
  ): Promise<AiAnalysisResultResponse> {
    const audio = await this.prisma.inspectionAudio.findFirst({
      where: {
        id: audioId,
        inspectionId,
        inspection: {
          hive: {
            apiary: apiaryReadScope(filter),
          },
        },
      },
      select: {
        transcriptionStatus: true,
        analysisStatus: true,
        transcription: true,
        analysisResult: true,
        analysisError: true,
        transcriptionError: true,
      },
    });

    if (!audio) {
      throw new NotFoundException(`Audio with ID ${audioId} not found`);
    }

    // Report the overall pipeline status: COMPLETED only when both stages done;
    // FAILED if either failed; otherwise reflect the in-progress stage.
    let status: TranscriptionStatus = audio.transcriptionStatus;
    if (
      audio.transcriptionStatus === 'COMPLETED' &&
      audio.analysisStatus !== 'NONE'
    ) {
      status = audio.analysisStatus;
    }

    return {
      status,
      transcript: {
        text: audio.transcription,
      },
      inspectionDraft: audio.analysisResult,
      error: audio.analysisError ?? audio.transcriptionError,
    };
  }

  private getExtensionFromMimeType(mimeType: string): string {
    const mimeToExt: Record<string, string> = {
      'audio/webm': 'webm',
      'audio/mp3': 'mp3',
      'audio/mpeg': 'mp3',
      'audio/ogg': 'ogg',
      'audio/wav': 'wav',
    };

    return mimeToExt[mimeType] || 'webm';
  }

  private mapToResponse(
    audio: Awaited<ReturnType<typeof this.prisma.inspectionAudio.findFirst>>,
  ): AudioResponse {
    if (!audio) {
      throw new Error('Audio record not found');
    }

    return {
      id: audio.id,
      inspectionId: audio.inspectionId,
      fileName: audio.fileName,
      mimeType: audio.mimeType,
      fileSize: audio.fileSize,
      duration: audio.duration,
      transcriptionStatus: audio.transcriptionStatus,
      analysisStatus: audio.analysisStatus,
      transcription: audio.transcription,
      createdAt: audio.createdAt.toISOString(),
    };
  }
}
