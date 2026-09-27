-- Remove the pull-worker infrastructure: WorkerToken table and the
-- lease/token columns on InspectionAudio. AI transcription and analysis now
-- run in-process via the SDK provider (push mode only).

DROP TABLE IF EXISTS "WorkerToken";

ALTER TABLE "InspectionAudio"
  DROP COLUMN IF EXISTS "transcriptionClaimedAt",
  DROP COLUMN IF EXISTS "transcriptionLeaseUntil",
  DROP COLUMN IF EXISTS "transcriptionWorkerTokenId",
  DROP COLUMN IF EXISTS "analysisClaimedAt",
  DROP COLUMN IF EXISTS "analysisLeaseUntil",
  DROP COLUMN IF EXISTS "analysisWorkerTokenId";
