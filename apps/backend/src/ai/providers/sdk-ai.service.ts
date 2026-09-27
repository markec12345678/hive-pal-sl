import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Readable } from 'stream';
import {
  buildInspectionPrompt,
  emptyFormDraft,
  mapAiToFormDraft,
  normalizeRecommendation,
  parseJsonContent,
  truncateTranscript,
  type InspectionFormDraft,
  type RawAiRecommendation,
} from './inspection-draft';

/**
 * Minimal structural type for the z-ai-web-dev-sdk client. The package is
 * ESM-only while this backend compiles to CommonJS, so it is loaded through a
 * dynamic `import()` at call time instead of a static import.
 */
interface ZaiClient {
  chat: {
    completions: {
      create: (body: Record<string, unknown>) => Promise<unknown>;
    };
  };
  audio: {
    asr: {
      create: (body: Record<string, unknown>) => Promise<unknown>;
    };
  };
}

interface ZaiSdkModule {
  default: { create: () => Promise<ZaiClient> };
}

export interface SdkTranscript {
  text: string;
  language?: string | null;
  segments?: unknown[];
}

export interface SdkAnalysisResult {
  draft: InspectionFormDraft;
  analysisError: string | null;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

const ANALYSIS_ATTEMPTS = 2;
const ANALYSIS_RETRY_DELAY_MS = 2_000;
/** Pacing for the typewriter-style assistant stream (ms between chunks). */
const STREAM_CHUNK_DELAY_MS = 25;
const STREAM_CHUNK_SIZE = 24;

@Injectable()
export class SdkAiService {
  private client: ZaiClient | null = null;
  private clientPromise: Promise<ZaiClient> | null = null;

  constructor(private readonly config: ConfigService) {}

  /** Global feature toggle: AI_ENABLED=true turns on all SDK-backed features. */
  isEnabled(): boolean {
    return this.config.get<string>('AI_ENABLED') === 'true';
  }

  assertEnabled(): void {
    if (!this.isEnabled()) {
      throw new Error('AI is disabled (AI_ENABLED !== "true")');
    }
  }

  private async getClient(): Promise<ZaiClient> {
    if (this.client) return this.client;
    if (!this.clientPromise) {
      this.clientPromise = (async () => {
        const mod =
          (await import('z-ai-web-dev-sdk')) as unknown as ZaiSdkModule;
        return mod.default.create();
      })();
      try {
        this.client = await this.clientPromise;
      } catch (error) {
        // Do not cache the failure forever: drop the promise so a later call
        // can retry after transient SDK/config issues are resolved.
        this.clientPromise = null;
        throw error;
      }
    }
    return this.clientPromise;
  }

  private async withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`AI request timed out after ${ms}ms`)),
        ms,
      );
    });
    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      clearTimeout(timer);
    }
  }

  private getRequestTimeoutMs(): number {
    return Number(this.config.get('AI_REQUEST_TIMEOUT_MS') ?? 600_000);
  }

  /** Transcribe an audio buffer via the SDK speech-to-text endpoint. */
  async transcribe(audio: Buffer): Promise<SdkTranscript> {
    this.assertEnabled();
    const client = await this.getClient();

    const response = (await this.withTimeout(
      client.audio.asr.create({
        file_base64: audio.toString('base64'),
      }),
      this.getRequestTimeoutMs(),
    )) as { text?: string; language?: string };

    return {
      text: (response?.text ?? '').trim(),
      language: response?.language ?? null,
      segments: [],
    };
  }

  /**
   * Analyze a transcript and produce the inspection form draft consumed by
   * the frontend. Never throws for analysis problems — mirrors the old
   * Python behavior of returning an empty draft plus an error message.
   */
  async analyzeTranscript(transcript: string): Promise<SdkAnalysisResult> {
    this.assertEnabled();
    const trimmed = truncateTranscript(transcript);

    if (!trimmed) {
      return {
        draft: emptyFormDraft(),
        analysisError: 'Transcript is empty; nothing to analyze',
      };
    }

    let lastError: unknown = null;
    for (let attempt = 0; attempt < ANALYSIS_ATTEMPTS; attempt++) {
      try {
        const client = await this.getClient();
        const completion = (await this.withTimeout(
          client.chat.completions.create({
            messages: [
              {
                role: 'system',
                content:
                  'Return only JSON that exactly matches the provided inspection schema.',
              },
              { role: 'user', content: buildInspectionPrompt(trimmed) },
            ],
            thinking: { type: 'disabled' },
          }),
          this.getRequestTimeoutMs(),
        )) as { choices?: Array<{ message?: { content?: string } }> };

        const content = completion?.choices?.[0]?.message?.content ?? '';
        const raw = parseJsonContent(content) as RawAiRecommendation;
        return {
          draft: mapAiToFormDraft(normalizeRecommendation(raw)),
          analysisError: null,
        };
      } catch (error) {
        lastError = error;
        if (attempt < ANALYSIS_ATTEMPTS - 1) {
          await new Promise((resolve) =>
            setTimeout(resolve, ANALYSIS_RETRY_DELAY_MS),
          );
        }
      }
    }

    return {
      draft: emptyFormDraft(),
      analysisError:
        lastError instanceof Error ? lastError.message : String(lastError),
    };
  }

  /**
   * Stream an assistant chat answer as a Node Readable emitting plain text
   * chunks. The SDK completion is fetched in one call and re-chunked so the
   * browser keeps its progressive "typewriter" SSE experience.
   */
  async streamChat(messages: ChatMessage[]): Promise<Readable> {
    this.assertEnabled();
    const client = await this.getClient();

    const completion = (await this.withTimeout(
      client.chat.completions.create({
        messages,
        thinking: { type: 'disabled' },
      }),
      this.getRequestTimeoutMs(),
    )) as { choices?: Array<{ message?: { content?: string } }> };

    const full = completion?.choices?.[0]?.message?.content ?? '';

    const stream = new Readable({ read() {} });
    const pushChunks = async (target: Readable) => {
      try {
        for (let i = 0; i < full.length; i += STREAM_CHUNK_SIZE) {
          const chunk = full.slice(i, i + STREAM_CHUNK_SIZE);
          await new Promise((resolve) =>
            setTimeout(resolve, STREAM_CHUNK_DELAY_MS),
          );
          target.push(chunk);
        }
        target.push(null);
      } catch (error) {
        target.destroy(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    };
    queueMicrotask(() => void pushChunks(stream));
    return stream;
  }
}
