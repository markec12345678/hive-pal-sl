/**
 * Batch AI analyzer for stray audio files (replaces the retired
 * apps/ai-app "incoming folder" + curl /process_incoming workflow).
 *
 * What it does:
 *   - walks the given file or folder for audio files (wav/mp3/m4a/flac/ogg/webm)
 *   - transcribes each file via the z-ai-web-dev-sdk ASR endpoint
 *   - drafts a structured HivePal inspection draft from the transcript via the
 *     SDK LLM endpoint (same prompt/normalization the backend uses in-process)
 *   - writes <name>.transcript.txt and <name>.draft.json next to the file
 *
 * Usage (from apps/backend):
 *   pnpm dlx tsx scripts/ai-analyze.ts <file-or-folder>
 *   pnpm dlx tsx scripts/ai-analyze.ts ./recordings --overwrite
 *
 * Flags:
 *   --overwrite   rewrite outputs even if they already exist
 *
 * Note: this script is standalone (no database, no backend). To import the
 * resulting inspection into HivePal, use the app UI.
 */

import { promises as fs } from 'fs';
import path from 'path';
import {
  buildInspectionPrompt,
  mapAiToFormDraft,
  normalizeRecommendation,
  parseJsonContent,
  truncateTranscript,
} from '../src/ai/providers/inspection-draft';

const SUPPORTED_EXTENSIONS = new Set([
  '.wav',
  '.mp3',
  '.m4a',
  '.flac',
  '.ogg',
  '.webm',
]);

interface Args {
  target: string;
  overwrite: boolean;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  let overwrite = false;
  for (const arg of argv) {
    if (arg === '--overwrite') overwrite = true;
    else positional.push(arg);
  }
  if (positional.length !== 1) {
    console.error(
      'Usage: tsx scripts/ai-analyze.ts <audio-file-or-folder> [--overwrite]',
    );
    process.exit(1);
  }
  return { target: positional[0], overwrite };
}

async function collectAudioFiles(target: string): Promise<string[]> {
  const stat = await fs.stat(target);
  if (stat.isFile()) return [target];
  const entries = await fs.readdir(target, { withFileTypes: true });
  return entries
    .filter(
      (entry) =>
        entry.isFile() &&
        SUPPORTED_EXTENSIONS.has(path.extname(entry.name).toLowerCase()),
    )
    .map((entry) => path.join(target, entry.name))
    .sort();
}

/* Z.ai SDK is ESM-only; load it dynamically so this script works under tsx. */
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

async function loadSdk(): Promise<ZaiClient> {
  const mod = (await import('z-ai-web-dev-sdk')) as unknown as {
    default: { create: () => Promise<ZaiClient> };
  };
  return mod.default.create();
}

async function transcribe(
  client: ZaiClient,
  filePath: string,
): Promise<string> {
  const audio = await fs.readFile(filePath);
  const response = (await client.audio.asr.create({
    file_base64: audio.toString('base64'),
  })) as { text?: string };
  return (response?.text ?? '').trim();
}

async function analyze(
  client: ZaiClient,
  transcript: string,
): Promise<unknown> {
  const completion = (await client.chat.completions.create({
    messages: [
      {
        role: 'system',
        content:
          'Return only JSON that exactly matches the provided inspection schema.',
      },
      { role: 'user', content: buildInspectionPrompt(transcript) },
    ],
    thinking: { type: 'disabled' },
  })) as { choices?: Array<{ message?: { content?: string } }> };

  const content = completion?.choices?.[0]?.message?.content ?? '';
  return mapAiToFormDraft(
    normalizeRecommendation(parseJsonContent(content) as never),
  );
}

/* Draft pipeline shared with the backend provider (ported from app.py) —
   imported statically above; it is a pure TS module with no SDK dependency. */

async function processFile(
  client: ZaiClient,
  filePath: string,
  overwrite: boolean,
): Promise<void> {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath, path.extname(filePath));
  const transcriptPath = path.join(dir, `${base}.transcript.txt`);
  const draftPath = path.join(dir, `${base}.draft.json`);

  if (
    !overwrite &&
    (await fs
      .access(transcriptPath)
      .then(() => true)
      .catch(() => false))
  ) {
    console.log(`↷ skip ${filePath} (outputs exist, use --overwrite)`);
    return;
  }

  console.log(`🎙  transcribing ${filePath} …`);
  const transcript = await transcribe(client, filePath);
  if (!transcript) {
    console.warn(`⚠  empty transcript for ${filePath}`);
  }
  await fs.writeFile(transcriptPath, transcript, 'utf-8');

  if (transcript) {
    console.log(`🧠 analyzing transcript (${transcript.length} chars) …`);
    const draft = await analyze(client, truncateTranscript(transcript));
    await fs.writeFile(draftPath, JSON.stringify(draft, null, 2), 'utf-8');
    console.log(
      `✅ ${base}: wrote ${path.basename(transcriptPath)}, ${path.basename(draftPath)}`,
    );
  } else {
    console.log(
      `✅ ${base}: wrote ${path.basename(transcriptPath)} (no draft — empty transcript)`,
    );
  }
}

async function main(): Promise<void> {
  const { target, overwrite } = parseArgs(process.argv.slice(2));
  const files = await collectAudioFiles(target);

  if (files.length === 0) {
    console.error(`No supported audio files found at: ${target}`);
    process.exit(1);
  }

  console.log(`Found ${files.length} audio file(s).`);
  const client = await loadSdk();

  let failures = 0;
  for (const file of files) {
    try {
      await processFile(client, file, overwrite);
    } catch (error) {
      failures++;
      console.error(
        `✗ ${file}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (failures > 0) {
    console.error(`\n${failures} file(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log('\nAll files processed.');
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
