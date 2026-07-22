const Image = require('../models/Image');

async function getStatus(req, res, next) {
  try {
    const { processingId } = req.params;
    const image = await Image.findOne({ processingId }).lean();

    if (!image) {
      return res.status(404).json({ error: 'No image found with that processing ID.' });
    }

    return res.json({
      processingId: image.processingId,
      status: image.status,
      attempts: image.attempts,
      maxAttempts: image.maxAttempts,
      uploadedAt: image.uploadedAt,
      processingStartedAt: image.processingStartedAt,
      processedAt: image.processedAt,
      failureReason: image.status === 'failed' ? image.failureReason : undefined,
    });
  } catch (err) {
    next(err);
  }
}

async function getResult(req, res, next) {
  try {
    const { processingId } = req.params;
    const image = await Image.findOne({ processingId }).lean();

    if (!image) {
      return res.status(404).json({ error: 'No image found with that processing ID.' });
    }

    if (image.status !== 'completed') {
      return res.status(409).json({
        error: `Analysis is not yet available. Current status: ${image.status}.`,
        status: image.status,
        failureReason: image.status === 'failed' ? image.failureReason : undefined,
      });
    }

    return res.json({
      processingId: image.processingId,
      originalFilename: image.originalFilename,
      status: image.status,
      processedAt: image.processedAt,
      analysis: image.analysis,
    });
  } catch (err) {
    next(err);
  }
}

async function listImages(req, res, next) {
  try {
    const { status, limit = 20, page = 1 } = req.query;
    const filter = status ? { status } : {};
    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10)));

    const [items, total] = await Promise.all([
      Image.find(filter)
        .select('processingId originalFilename status attempts uploadedAt processedAt analysis.issues analysis.confidenceScore')
        .sort({ createdAt: -1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum)
        .lean(),
      Image.countDocuments(filter),
    ]);

    return res.json({ total, page: pageNum, limit: limitNum, items });
  } catch (err) {
    next(err);
  }
}

module.exports = { getStatus, getResult, listImages };
