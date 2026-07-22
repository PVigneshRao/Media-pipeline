/**
 * Seeds the database with a few synthetic image analysis records so the
 * status/result APIs can be exercised immediately without waiting on real
 * uploads to process. Does NOT touch the queue - these are inserted directly
 * in "completed"/"failed" states.
 *
 * Usage: npm run seed
 */
require('dotenv').config();
const { v4: uuidv4 } = require('uuid');
const connectDB = require('../src/config/db');
const Image = require('../src/models/Image');
const logger = require('../src/utils/logger');

async function seed() {
  await connectDB();
  await Image.deleteMany({ originalFilename: { $regex: /^seed-/ } });

  const records = [
    {
      processingId: uuidv4(),
      originalFilename: 'seed-clear-plate.jpg',
      storedFilename: 'seed-clear-plate.jpg',
      storagePath: '/tmp/seed-clear-plate.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 204800,
      status: 'completed',
      attempts: 1,
      processedAt: new Date(),
      analysis: {
        blur: { laplacianVariance: 340.2, threshold: 100, isBlurry: false },
        brightness: { meanBrightness: 128.5, threshold: 60, isLowLight: false },
        duplicate: { isDuplicate: false, matchedProcessingId: null, hashDistance: null },
        ocr: { extractedText: 'KA20MH1234', detectedPlate: 'KA20MH1234', isValidPlateFormat: true, ocrConfidence: 87.2 },
        dimensions: { width: 1280, height: 960, isValidResolution: true },
        screenshotCheck: { isLikelyScreenshot: false, isLikelyPhotoOfPhoto: false, reasons: [] },
        editingHeuristics: { isSuspiciousEdit: false, elaScore: 4.1, reasons: [] },
        issues: [],
        confidenceScore: 1.0,
      },
    },
    {
      processingId: uuidv4(),
      originalFilename: 'seed-blurry-lowlight.jpg',
      storedFilename: 'seed-blurry-lowlight.jpg',
      storagePath: '/tmp/seed-blurry-lowlight.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 190000,
      status: 'completed',
      attempts: 1,
      processedAt: new Date(),
      analysis: {
        blur: { laplacianVariance: 42.1, threshold: 100, isBlurry: true },
        brightness: { meanBrightness: 31.4, threshold: 60, isLowLight: true },
        duplicate: { isDuplicate: false, matchedProcessingId: null, hashDistance: null },
        ocr: { extractedText: null, detectedPlate: null, isValidPlateFormat: null, ocrConfidence: null },
        dimensions: { width: 640, height: 480, isValidResolution: true },
        screenshotCheck: { isLikelyScreenshot: false, isLikelyPhotoOfPhoto: false, reasons: [] },
        editingHeuristics: { isSuspiciousEdit: false, elaScore: 3.8, reasons: [] },
        issues: ['blurry_image', 'low_light'],
        confidenceScore: 0.76,
      },
    },
    {
      processingId: uuidv4(),
      originalFilename: 'seed-failed-corrupt.jpg',
      storedFilename: 'seed-failed-corrupt.jpg',
      storagePath: '/tmp/seed-failed-corrupt.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 512,
      status: 'failed',
      attempts: 3,
      failureReason: 'Failed after 3 attempts: unreadable or corrupt image file',
    },
  ];

  await Image.insertMany(records);
  logger.info(`Seeded ${records.length} sample image records.`);
  process.exit(0);
}

seed().catch((err) => {
  logger.error(`Seed failed: ${err.message}`);
  process.exit(1);
});
