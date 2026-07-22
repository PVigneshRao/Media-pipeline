const express = require('express');
const router = express.Router();
const { getStatus, getResult, listImages } = require('../controllers/statusController');

router.get('/', listImages);
router.get('/:processingId/status', getStatus);
router.get('/:processingId/result', getResult);

module.exports = router;
