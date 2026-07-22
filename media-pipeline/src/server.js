require('dotenv').config();

const path = require('path');
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');

const connectDB = require('./config/db');
const logger = require('./utils/logger');
const InMemoryQueue = require('./queue/inMemoryQueue');
const { createImageJobHandler } = require('./workers/imageWorker');
const buildUploadRouter = require('./routes/upload');
const statusRouter = require('./routes/status');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');

const PORT = process.env.PORT || 4000;
const QUEUE_CONCURRENCY = parseInt(process.env.QUEUE_CONCURRENCY || '2', 10);

async function start() {
  const app = express();

  const queue = new InMemoryQueue({ concurrency: QUEUE_CONCURRENCY });
  queue.process(createImageJobHandler(queue));

  app.use(cors());
  app.use(express.json());
  app.use(morgan('dev', { stream: { write: (msg) => logger.http ? logger.http(msg.trim()) : logger.info(msg.trim()) } }));
  app.use(express.static(path.join(__dirname, '../ui')));

  app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../ui/index.html'));
  });

  app.get('/docs', (req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>API Documentation — Intelligent Media Pipeline</title>
  <style>
    :root {
      --bg: #0d1117; --panel: #161b22; --border: #30363d; --text: #c9d1d9;
      --heading: #f0f6fc; --accent: #58a6ff; --green: #238636; --amber: #d29922; --mono: monospace;
    }
    body { background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; max-width: 900px; margin: 0 auto; padding: 40px 20px; }
    h1, h2, h3 { color: var(--heading); }
    h1 { border-bottom: 1px solid var(--border); padding-bottom: 12px; }
    .badge { display: inline-block; padding: 4px 8px; font-size: 12px; font-weight: bold; border-radius: 4px; color: #fff; margin-right: 8px; font-family: var(--mono); }
    .post { background: #238636; } .get { background: #1f6feb; }
    .card { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 20px; margin-bottom: 24px; }
    pre { background: #010409; border: 1px solid var(--border); padding: 12px; border-radius: 6px; overflow-x: auto; color: #e6edf3; font-family: var(--mono); font-size: 13px; }
    code { font-family: var(--mono); color: var(--accent); }
    .endpoint { display: flex; align-items: center; font-size: 18px; font-weight: bold; font-family: var(--mono); margin-bottom: 12px; }
  </style>
</head>
<body>
  <h1>Intelligent Media Pipeline — API Documentation</h1>
  <p>Interactive reference for the asynchronous media processing and ANPR pipeline endpoints.</p>

  <div class="card">
    <div class="endpoint"><span class="badge post">POST</span> /api/images/upload</div>
    <p>Upload a vehicle image for asynchronous quality, integrity, and ANPR analysis.</p>
    <h4>Request (multipart/form-data)</h4>
    <p>Form Field: <code>image</code> (Allowed: JPEG, PNG, WEBP. Max 15MB)</p>
    <h4>Response (202 Accepted)</h4>
    <pre>{
  "processingId": "2e8afad1-3e03-4a57-bd9f-a00184bf40ee",
  "status": "pending",
  "message": "Image accepted and queued for processing.",
  "statusUrl": "/api/images/2e8afad1-3e03-4a57-bd9f-a00184bf40ee/status",
  "resultUrl": "/api/images/2e8afad1-3e03-4a57-bd9f-a00184bf40ee/result"
}</pre>
  </div>

  <div class="card">
    <div class="endpoint"><span class="badge get">GET</span> /api/images/:processingId/status</div>
    <p>Poll the processing lifecycle state for an uploaded image.</p>
    <h4>Response (200 OK)</h4>
    <pre>{
  "processingId": "2e8afad1-3e03-4a57-bd9f-a00184bf40ee",
  "status": "completed",
  "attempts": 1,
  "maxAttempts": 3,
  "uploadedAt": "2026-07-22T11:40:59.702Z",
  "processedAt": "2026-07-22T11:41:14.481Z"
}</pre>
  </div>

  <div class="card">
    <div class="endpoint"><span class="badge get">GET</span> /api/images/:processingId/result</div>
    <p>Fetch the complete analysis result payload for a completed image.</p>
    <h4>Response (200 OK)</h4>
    <pre>{
  "processingId": "2e8afad1-3e03-4a57-bd9f-a00184bf40ee",
  "status": "completed",
  "analysis": {
    "blur": { "laplacianVariance": 182.4, "isBlurry": false },
    "brightness": { "meanBrightness": 112.5, "isLowLight": false },
    "ocr": { "detectedPlate": "MH12KR1145", "isValidPlateFormat": true },
    "duplicate": { "isDuplicate": false },
    "confidenceScore": 0.92
  }
}</pre>
  </div>

  <div class="card">
    <div class="endpoint"><span class="badge get">GET</span> /api/images</div>
    <p>List and filter image analysis records with pagination.</p>
    <p>Query Params: <code>status=completed</code>, <code>limit=20</code>, <code>page=1</code></p>
  </div>

  <div class="card">
    <div class="endpoint"><span class="badge get">GET</span> /health</div>
    <p>Check system health, database connection state, and active queue length.</p>
  </div>
</body>
</html>`);
  });

  app.get('/health', (req, res) => {
    const isDbConnected = require('mongoose').connection.readyState === 1;
    res.json({
      status: 'ok',
      dbConnected: isDbConnected,
      queueSize: queue.size(),
      uptime: process.uptime(),
    });
  });

  app.use('/api/images/upload', buildUploadRouter(queue));
  app.use('/api/images', statusRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  app.listen(PORT, '0.0.0.0', () => {
    logger.info(`Server listening on port ${PORT} (host 0.0.0.0)`);
  });

  // Connect to DB and perform recovery pass
  try {
    await connectDB();
    const Image = require('./models/Image');
    const stuck = await Image.find({ status: { $in: ['pending', 'processing'] } })
      .select('processingId')
      .lean();
    if (stuck.length) {
      logger.info(`Re-enqueuing ${stuck.length} job(s) left over from a previous run`);
      stuck.forEach((doc) => queue.enqueue({ id: doc.processingId, processingId: doc.processingId }));
    }
  } catch (err) {
    logger.error(`Database initialization error: ${err.message}`);
  }
}

start().catch((err) => {
  logger.error(`Fatal startup error: ${err.message}`);
  process.exit(1);
});
