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
  await connectDB();

  // The queue and its handler are created here (not inside a route file) so
  // there is exactly one queue instance for the process lifetime, and both
  // the upload route (producer) and the worker (consumer) share it.
  const queue = new InMemoryQueue({ concurrency: QUEUE_CONCURRENCY });
  queue.process(createImageJobHandler(queue));

  // Recovery pass: if the process crashed mid-job, those images are stuck in
  // "pending"/"processing" in the DB with no corresponding in-memory job.
  // Re-enqueue them on startup so they aren't silently lost forever. This
  // doesn't make the queue durable, but it closes the most common failure
  // window (a restart) without needing an external broker.
  const Image = require('./models/Image');
  const stuck = await Image.find({ status: { $in: ['pending', 'processing'] } })
    .select('processingId')
    .lean();
  if (stuck.length) {
    logger.info(`Re-enqueuing ${stuck.length} job(s) left over from a previous run`);
    stuck.forEach((doc) => queue.enqueue({ id: doc.processingId, processingId: doc.processingId }));
  }

  const app = express();

  app.use(cors());
  app.use(express.json());
  app.use(morgan('dev', { stream: { write: (msg) => logger.http ? logger.http(msg.trim()) : logger.info(msg.trim()) } }));
  app.use(express.static(path.join(__dirname, '../ui')));

  app.get('/health', (req, res) => {
    res.json({ status: 'ok', queueSize: queue.size(), uptime: process.uptime() });
  });

  app.use('/api/images/upload', buildUploadRouter(queue));
  app.use('/api/images', statusRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  app.listen(PORT, () => {
    logger.info(`Server listening on port ${PORT}`);
  });
}

start().catch((err) => {
  logger.error(`Fatal startup error: ${err.message}`);
  process.exit(1);
});
