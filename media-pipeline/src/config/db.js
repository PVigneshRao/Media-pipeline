const mongoose = require('mongoose');
const logger = require('../utils/logger');

async function connectDB() {
  const uri =
    process.env.MONGO_URI ||
    process.env.MONGO_URL ||
    process.env.MONGODB_URL ||
    process.env.MONGO_PRIVATE_URL ||
    'mongodb://localhost:27017/media_pipeline';
  try {
    await mongoose.connect(uri);
    logger.info(`MongoDB connected -> ${uri}`);
  } catch (err) {
    logger.error(`MongoDB connection failed: ${err.message}`);
    // Fail fast: the whole system depends on persistence being available.
    process.exit(1);
  }
}

module.exports = connectDB;
