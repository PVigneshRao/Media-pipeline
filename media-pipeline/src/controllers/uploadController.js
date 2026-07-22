const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const Image = require('../models/Image');
const logger = require('../utils/logger');

const STORAGE_DIR = path.join(process.cwd(), process.env.STORAGE_DIR || 'storage/uploads');
if (!fs.existsSync(STORAGE_DIR)) {
  fs.mkdirSync(STORAGE_DIR, { recursive: true });
}

const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, STORAGE_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `${uuidv4()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: (parseInt(process.env.MAX_UPLOAD_MB || '15', 10)) * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
      return cb(new Error(`Unsupported file type: ${file.mimetype}. Allowed: jpeg, png, webp`));
    }
    cb(null, true);
  },
});

/**
 * Builds the controller with a reference to the queue so we can enqueue a
 * job right after persisting metadata, without introducing a circular
 * import between routes and the queue/worker wiring in server.js.
 */
function buildUploadController(queue) {
  async function uploadImage(req, res, next) {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No image file provided. Use multipart/form-data field name "image".' });
      }

      const processingId = uuidv4();

      const image = await Image.create({
        processingId,
        originalFilename: req.file.originalname,
        storedFilename: req.file.filename,
        storagePath: req.file.path,
        mimeType: req.file.mimetype,
        sizeBytes: req.file.size,
        status: 'pending',
        maxAttempts: parseInt(process.env.MAX_JOB_ATTEMPTS || '3', 10),
      });

      queue.enqueue({ id: processingId, processingId });

      logger.info(`Image uploaded and queued`, { processingId, filename: req.file.originalname });

      // Return immediately - processing happens asynchronously. This is the
      // core async contract of the API: the client gets an ID it can poll,
      // not a blocking wait for analysis to finish.
      return res.status(202).json({
        processingId,
        status: image.status,
        message: 'Image accepted and queued for processing.',
        statusUrl: `/api/images/${processingId}/status`,
        resultUrl: `/api/images/${processingId}/result`,
      });
    } catch (err) {
      next(err);
    }
  }

  return { uploadImage, multerMiddleware: upload.single('image') };
}

module.exports = { buildUploadController, STORAGE_DIR };
