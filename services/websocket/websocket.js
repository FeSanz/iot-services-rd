const { WebSocketServer } = require('ws');
let wss = null;

function initWebSocket(server) {
    wss = new WebSocketServer({ server });

    wss.on('connection', (ws) => {
        ws.on('message', (msg) => {
            try {
                const data = JSON.parse(msg);
                if (data.type === 'suscribe' && data.sensor_id) {
                    ws.suscribedSensorId = data.sensor_id;
                }
            } catch (e) {
                console.error('Error 1', e);
            }
        });

        ws.on('close', () => {
            
        });
    });
}

function notifyToUsers(sensor_id, payload) {
    if (!wss) return;
    wss.clients.forEach((client) => {
        if (client.readyState == 1 && client.suscribedSensorId == sensor_id) {
            client.send(JSON.stringify(payload));
        }
    });
}

module.exports = {
    initWebSocket,
    notifyToUsers
};