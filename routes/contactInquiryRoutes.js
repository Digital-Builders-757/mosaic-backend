const express = require('express');
const router = express.Router();

const { createContactInquiry } = require('../controllers/contactInquiry.controller');
const { requireRecaptcha } = require('../utils/recaptcha');

// reCAPTCHA runs before the handler. Per-IP rate limiting ships separately with
// the trust-proxy change, because it depends on req.ip being the real client.
router.post('/', requireRecaptcha(), createContactInquiry);

module.exports = router;
