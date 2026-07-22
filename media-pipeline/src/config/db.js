const mongoose = require('mongoose');
const logger = require('../utils/logger');

async function connectDB(retries = 10, delayMs = 3000) {
  const uri =
    process.env.MONGO_URI ||
    process.env.MONGO_URL ||
    process.env.MONGODB_URL ||
    process.env.MONGO_PRIVATE_URL ||
    'mongodb://localhost:27017/media_pipeline';

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
      logger.info(`MongoDB connected -> ${uri}`);
      return;
    } catch (err) {
      logger.error(`MongoDB connection attempt ${attempt}/${retries} failed: ${err.message}`);
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      } else {
        logger.error(`All ${retries} MongoDB connection attempts failed. The app will keep retrying in background.`);
      }
    }
  }
}

module.exports = connectDB;
