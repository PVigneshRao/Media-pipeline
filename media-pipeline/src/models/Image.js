const mongoose = require('mongoose');

const STATUS = Object.freeze({
  PENDING: 'pending',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  FAILED: 'failed',
});

/**
 * Schema design notes (see README "Architecture" section for full reasoning):
 * - `processingId` is a UUID we generate at upload time and return to the client
 *   immediately. It is the public-facing identifier (Mongo's _id is kept internal).
 * - `analysis` is embedded rather than a separate collection because it's small,
 *   always fetched together with the image record, and never queried independently.
 *   A separate collection would only make sense at a scale where analysis payloads
 *   grow large or need independent indexing - not the case here.
 * - `perceptualHash` is indexed and pulled to the top level (duplicated out of
 *   `analysis.duplicate`) specifically so duplicate-detection can query it directly
 *   without scanning/deserializing the whole analysis blob for every comparison.
 */
const imageSchema = new mongoose.Schema(
  {
    processingId: { type: String, required: true, unique: true, index: true },
    originalFilename: { type: String, required: true },
    storedFilename: { type: String, required: true },
    storagePath: { type: String, required: true },
    mimeType: { type: String, required: true },
    sizeBytes: { type: Number, required: true },

    status: {
      type: String,
      enum: Object.values(STATUS),
      default: STATUS.PENDING,
      index: true,
    },

    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 3 },
    failureReason: { type: String, default: null },

    // Pulled to top level for fast duplicate-lookup queries (see note above).
    perceptualHash: { type: String, default: null, index: true },

    analysis: {
      blur: {
        laplacianVariance: Number,
        threshold: Number,
        isBlurry: Boolean,
      },
      brightness: {
        meanBrightness: Number,
        threshold: Number,
        isLowLight: Boolean,
      },
      duplicate: {
        isDuplicate: Boolean,
        matchedProcessingId: { type: String, default: null },
        hashDistance: { type: Number, default: null },
      },
      ocr: {
        extractedText: String,
        detectedPlate: { type: String, default: null },
        isValidPlateFormat: { type: Boolean, default: null },
        ocrConfidence: { type: Number, default: null },
      },
      dimensions: {
        width: Number,
        height: Number,
        isValidResolution: Boolean,
      },
      screenshotCheck: {
        isLikelyScreenshot: Boolean,
        isLikelyPhotoOfPhoto: Boolean,
        reasons: [String],
      },
      editingHeuristics: {
        isSuspiciousEdit: Boolean,
        elaScore: Number,
        reasons: [String],
      },
      issues: [String],
      confidenceScore: Number, // 0-1 heuristic confidence in the overall verdict
    },

    uploadedAt: { type: Date, default: Date.now },
    processingStartedAt: { type: Date, default: null },
    processedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

imageSchema.index({ createdAt: -1 });

module.exports = mongoose.model('Image', imageSchema);
module.exports.STATUS = STATUS;
