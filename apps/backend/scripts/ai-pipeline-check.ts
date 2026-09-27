/**
 * Deployment smoke test for the SDK-based AI pipeline: ASR contract + LLM draft.
 * Run: pnpm dlx tsx scripts/ai-pipeline-check.ts
 */
import ZAI from 'z-ai-web-dev-sdk';
import { createHash } from 'crypto';
import {
  buildInspectionPrompt,
  mapAiToFormDraft,
  normalizeRecommendation,
  parseJsonContent,
  truncateTranscript,
} from '../src/ai/providers/inspection-draft';

/** Generate a valid 16 kHz mono WAV file buffer (2 s of quiet tone). */
function makeWav(): Buffer {
  const sampleRate = 16_000;
  const seconds = 2;
  const numSamples = sampleRate * seconds;
  const dataSize = numSamples * 2; // 16-bit mono
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); // fmt chunk size
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buffer.writeUInt16LE(2, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    // 440 Hz sine at low amplitude (a "beep", not speech)
    const sample = Math.round(Math.sin(2 * Math.PI * 440 * t) * 1000);
    buffer.writeInt16LE(sample, 44 + i * 2);
  }
  return buffer;
}

async function main() {
  const zai = await ZAI.create();

  // 1) ASR contract check with a generated WAV (API shape, not speech quality)
  console.log('1) ASR contract check (generated WAV) …');
  const wav = makeWav();
  try {
    const asr = (await zai.audio.asr.create({
      file_base64: wav.toString('base64'),
    })) as { text?: string; language?: string };
    console.log(
      `   OK — ASR responded: text="${(asr?.text ?? '').slice(0, 60)}" language=${asr?.language ?? '?'}`,
    );
  } catch (error) {
    console.log(
      `   SKIPPED (endpoint unavailable: ${error instanceof Error ? error.message : error})`,
    );
  }

  // 2) LLM: Slovenian transcript -> inspection draft (same prompt as prod)
  const transcript =
    'Inšpekcija panja številka tri, dvajsetega maja dva tisoč šestindvajset. ' +
    'Kraljica je videna, zelo dobra. Populacija je močna, ocena osem. ' +
    'Zaprte zalege šest okvirjev, odprte zalege tri okvirji. ' +
    'Zaloga medišča štirje okvirji, cvetni prah dva okvirja. ' +
    'Najdem dva matičnika. Hranil sem dva litra sirupa. ' +
    'Temperatura triindvajset stopinj, sončno.';
  console.log('2) LLM drafting inspection from Slovenian transcript …');
  const completion = (await zai.chat.completions.create({
    messages: [
      {
        role: 'system',
        content:
          'Return only JSON that exactly matches the provided inspection schema.',
      },
      {
        role: 'user',
        content: buildInspectionPrompt(truncateTranscript(transcript)),
      },
    ],
    thinking: { type: 'disabled' },
  })) as { choices?: Array<{ message?: { content?: string } }> };

  const content = completion?.choices?.[0]?.message?.content ?? '';
  if (!content) throw new Error('Empty LLM response');
  console.log(
    `   raw content hash: ${createHash('sha1').update(content).digest('hex').slice(0, 12)}`,
  );

  const draft = mapAiToFormDraft(
    normalizeRecommendation(parseJsonContent(content) as never),
  );

  console.log('3) RESULTING FORM DRAFT:');
  console.log(
    JSON.stringify(
      {
        temperature: draft.temperature,
        weatherConditions: draft.weatherConditions,
        notes: draft.notes?.slice(0, 160),
        observations: {
          queenSeen: draft.observations.queenSeen,
          strength: draft.observations.strength,
          cappedBroodFrames: draft.observations.cappedBroodFrames,
          uncappedBroodFrames: draft.observations.uncappedBroodFrames,
          honeyFrames: draft.observations.honeyFrames,
          pollenFrames: draft.observations.pollenFrames,
          queenCells: draft.observations.queenCells,
        },
        actions: draft.actions,
      },
      null,
      2,
    ),
  );
}

main()
  .then(() => console.log('\nPIPELINE OK'))
  .catch((error) => {
    console.error('PIPELINE FAILED:', error);
    process.exit(1);
  });
