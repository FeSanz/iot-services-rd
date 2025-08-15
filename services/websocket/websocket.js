const { WebSocketServer } = require('ws');
let wss = null;

function initWebSocket(server) {
    wss = new WebSocketServer({ server });

    wss.on('connection', (ws) => {
        ws.on('message', (msg) => {
            try {
                const data = JSON.parse(msg);
                switch (data.typews) {
                    case 'sensor':
                        if (data.sensor_id) {
                            ws.suscribedSensorId = data.sensor_id;
                        }
                        break;
                    case 'alerts':
                        if (data.organization_id) {
                            ws.suscribedOrganization = data.organization_id;
                            ws.wsType = 'alerts';
                        }
                        break;
                    case 'workorders-new':
                        if (data.organization_id) {
                            ws.subscribedOrganizationId = data.organization_id;
                            ws.wsType = 'workorders-new';
                        }
                        break;
                    case 'workorders-advance':
                        if (data.organization_id) {
                            ws.subscribedOrganizationId = data.organization_id;
                            ws.wsType = 'workorders-advance';
                        }
                        break;
                }
            } catch (e) {
                console.error('Error 1', e);
            }
        });
        ws.on('close', () => {
            //console.log('Cliente WebSocket desconectado');
        });

        ws.on('error', (error) => {
            console.error('Error en WebSocket: ', error);
        });
    });
}

function notifySensorData(sensor_id, payload) {
    if (!wss) {
        console.warn('WebSocket server de sensores no inicializado');
        return;
    }
    wss.clients.forEach((client) => {
        if (client.readyState == 1 && client.suscribedSensorId == sensor_id) {
            client.send(JSON.stringify(payload));
        }
    });
}
function notifyAlert(organization_id, payload, action) {
    if (!wss) {
        console.warn('WebSocket server de alertas no inicializado');
        return;
    }
    wss.clients.forEach((client) => {
        if (
            client.readyState === 1 &&
            client.suscribedOrganization == organization_id &&
            client.wsType === 'alerts'
        ) {
            client.send(JSON.stringify({ action, ...payload }));
        }
    });
}

function notifyNewWorkOrders(organizationId, payload) {
    if (!wss) {
        console.warn('WebSocket server de OT no inicializado');
        return;
    }
    wss.clients.forEach((client) => {
        if (client.readyState === 1 && client.subscribedOrganizationId == organizationId && client.wsType === 'workorders-new') {
            client.send(JSON.stringify(payload));
        }
    });
}

function notifyWorkOrdersAdvance(organizationId, payload) {
    if (!wss) {
        console.warn('WebSocket server de OT no inicializado');
        return;
    }
    wss.clients.forEach((client) => {
        if (client.readyState === 1 && client.subscribedOrganizationId == organizationId && client.wsType === 'workorders-advance') {
            client.send(JSON.stringify(payload));
        }
    });
}

module.exports = {
    initWebSocket,
    notifyAlert,
    notifySensorData,
    notifyNewWorkOrders,
    notifyWorkOrdersAdvance
};