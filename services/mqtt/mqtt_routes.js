// services/iot/mqtt_routes.js
const express = require('express');
const router = express.Router();
const { publishMessage, getMQTTStatus } = require('../mqtt/mqtt_client');

// GET /api/mqtt/status
router.get('/mqtt/status', (req, res) => {
    res.json({ success: true, mqtt: getMQTTStatus() });
});

// POST /api/mqtt/publish
router.post('/mqtt/publish', (req, res) => {
    const { topic, message } = req.body;
    if (!topic || !message) {
        return res.status(400).json({ success: false, message: 'Faltan topic y message' });
    }
    publishMessage(topic, typeof message === 'string' ? message : JSON.stringify(message));
    res.json({ success: true, message: `Publicado en ${topic}` });
});

module.exports = router;
