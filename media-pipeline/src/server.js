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
