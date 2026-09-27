import { BadRequestException, Injectable } from '@nestjs/common';
import type { Readable } from 'stream';
import { SdkAiService } from '../ai/providers/sdk-ai.service';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * Streams assistant chat answers through the in-process SDK provider
 * (replaces the former relay to the external Python AI service /chat
 * endpoint). Returns a Node Readable emitting plain text chunks; the SSE
 * contract towards the browser is unchanged.
 */
@Injectable()
export class AssistantAiService {
  constructor(private readonly sdkAi: SdkAiService) {}

  isEnabled(): boolean {
    return this.sdkAi.isEnabled();
  }

  assertEnabled(): void {
    if (!this.isEnabled()) {
      throw new BadRequestException('AI is disabled');
    }
  }

  async streamChat(messages: ChatMessage[]): Promise<Readable> {
    this.assertEnabled();
    return this.sdkAi.streamChat(messages);
  }
}
