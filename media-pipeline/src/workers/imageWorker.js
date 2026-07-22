const { spawn } = require('child_process');
const path = require('path');
const Image = require('../models/Image');
const { STATUS } = require('../models/Image');
const { hammingDistance } = require('../utils/hamming');
const logger = require('../utils/logger');

const PYTHON_BIN = process.env.PYTHON_BIN || 'python3';
const ANALYZE_SCRIPT = path.join(__dirname, '..', 'analysis', 'analyze.py');
const MAX_JOB_ATTEMPTS = parseInt(process.env.MAX_JOB_ATTEMPTS || '3', 10);
const JOB_RETRY_DELAY_MS = parseInt(process.env.JOB_RETRY_DELAY_MS || '2000', 10);
const DUPLICATE_HASH_DISTANCE_THRESHOLD = parseInt(
  process.env.DUPLICATE_HASH_DISTANCE_THRESHOLD || '5',
  10
);

/**
 * Runs analyze.py as a subprocess and resolves with the parsed JSON result.
 * We pass image-check thresholds through as env vars so both the Node side
 * (for its own reasoning/logging) and the Python side read from the same
 * single source of truth (.env).
 */
function runPythonAnalysis(imagePath) {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON_BIN, [ANALYZE_SCRIPT, imagePath], {
      env: process.env,
      timeout: 30_000, // guard against a hung OCR/OpenCV call blocking the worker forever
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('error', (err) => {
      reject(new Error(`Failed to start analysis process: ${err.message}`));
    });

    child.on('close', (code) => {
      if (stderr) {
        // Python logs diagnostics (e.g. "OCR failed: ...") to stderr; these are
        // useful even on success, so we always log them at debug level.
        logger.debug(`analyze.py stderr`, { stderr: stderr.slice(0, 2000) });
      }

      if (code !== 0) {
        return reject(new Error(`Analysis script exited with code ${code}: ${stderr.slice(0, 500)}`));
      }

      try {
        const parsed = JSON.parse(stdout.trim());
        if (parsed.error) {
          return reject(new Error(parsed.error));
        }
        resolve(parsed);
      } catch (e) {
        reject(new Error(`Failed to parse analysis output as JSON: ${e.message}. Raw: ${stdout.slice(0, 500)}`));
      }
    });
  });
}

/**
 * Cross-record duplicate check. Done in Node (not Python) because it needs
 * a DB query across existing records - keeping "does this hash exist
 * elsewhere" as a persistence-layer concern rather than mixing it into the
 * stateless per-image Python script.
 */
async function findDuplicate(perceptualHash, currentProcessingId) {
  if (!perceptualHash) return { isDuplicate: false, matchedProcessingId: null, hashDistance: null };

  // Exact match first (cheap, indexed).
  const exact = await Image.findOne({
    perceptualHash,
    processingId: { $ne: currentProcessingId },
  }).lean();

  if (exact) {
    return { isDuplicate: true, matchedProcessingId: exact.processingId, hashDistance: 0 };
  }

  // Fall back to near-match scan. This is O(n) over completed images with a
  // hash - acceptable for the scale of this assignment; see README
  // "Trade-offs" for how this would be replaced with a proper similarity
  // index (e.g. a BK-tree or a vector/ANN index) at real scale.
  const candidates = await Image.find({
    perceptualHash: { $ne: null },
    processingId: { $ne: currentProcessingId },
  })
    .select('processingId perceptualHash')
    .lean();

  let best = null;
  for (const candidate of candidates) {
    const distance = hammingDistance(perceptualHash, candidate.perceptualHash);
    if (distance <= DUPLICATE_HASH_DISTANCE_THRESHOLD && (!best || distance < best.hashDistance)) {
      best = { isDuplicate: true, matchedProcessingId: candidate.processingId, hashDistance: distance };
    }
  }

  return best || { isDuplicate: false, matchedProcessingId: null, hashDistance: null };
}

/**
 * Main job handler registered with the queue. One job = one image.
 * Owns the full pending -> processing -> (completed | failed) lifecycle,
 * including retry-with-backoff by re-enqueuing itself on transient failure.
 */
function createImageJobHandler(queue) {
  return async function handleImageJob(job) {
    const { processingId } = job;
    const image = await Image.findOne({ processingId });

    if (!image) {
      logger.error(`Job references missing image record`, { processingId });
      return;
    }

    image.status = STATUS.PROCESSING;
    image.processingStartedAt = new Date();
    image.attempts += 1;
    await image.save();

    logger.info(`Processing started`, { processingId, attempt: image.attempts });

    try {
      const analysisResult = await runPythonAnalysis(image.storagePath);

      const duplicate = await findDuplicate(analysisResult.perceptualHash, processingId);

      const issues = [...analysisResult.issues];
      if (duplicate.isDuplicate && !issues.includes('duplicate_image')) {
        issues.push('duplicate_image');
      }

      image.perceptualHash = analysisResult.perceptualHash || null;
      image.analysis = {
        blur: analysisResult.blur,
        brightness: analysisResult.brightness,
        duplicate,
        ocr: analysisResult.ocr,
        dimensions: analysisResult.dimensions,
        screenshotCheck: analysisResult.screenshotCheck,
        editingHeuristics: analysisResult.editingHeuristics,
        issues,
        confidenceScore: analysisResult.confidenceScore,
      };
      image.status = STATUS.COMPLETED;
      image.processedAt = new Date();
      image.failureReason = null;
      await image.save();

      logger.info(`Processing completed`, { processingId, issues });
    } catch (err) {
      logger.error(`Processing failed`, { processingId, attempt: image.attempts, error: err.message });

      if (image.attempts < image.maxAttempts) {
        image.status = STATUS.PENDING;
        image.failureReason = `Attempt ${image.attempts} failed: ${err.message}`;
        await image.save();

        // Exponential-ish backoff: delay grows with attempt count so a
        // transient failure (e.g. brief resource contention) gets a bit more
        // breathing room on each retry.
        const delay = JOB_RETRY_DELAY_MS * image.attempts;
        setTimeout(() => queue.enqueue(job), delay);
        logger.info(`Job scheduled for retry`, { processingId, delayMs: delay, nextAttempt: image.attempts + 1 });
      } else {
        image.status = STATUS.FAILED;
        image.failureReason = `Failed after ${image.attempts} attempts: ${err.message}`;
        await image.save();
        logger.error(`Job permanently failed`, { processingId, attempts: image.attempts });
      }
    }
  };
}

module.exports = { createImageJobHandler, MAX_JOB_ATTEMPTS };
