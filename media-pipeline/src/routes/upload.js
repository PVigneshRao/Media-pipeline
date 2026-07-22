const express = require('express');

function buildUploadRouter(queue) {
  const router = express.Router();
  const { buildUploadController } = require('../controllers/uploadController');
  const { uploadImage, multerMiddleware } = buildUploadController(queue);

  router.post('/', multerMiddleware, uploadImage);

  return router;
}

module.exports = buildUploadRouter;
