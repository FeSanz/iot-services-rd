const { WebSocketServer } = require('ws');

let wss = null;

function initWorkOrdersWebSocket(server) {
    wss = new WebSocketServer({ server, path: '/workorders-ws' }); //Usar path
    wss.on('connection', (ws) => {
        ws.on('message', (msg) => {
            try {
                const data = JSON.parse(msg);

                if (data.organization_id) {
                    ws.subscribedOrganizationId = data.organization_id;
                }

            } catch (e) {
                console.error('Error procesando WebSocket OT:', e);
            }
        });

        ws.on('close', () => {
            console.log('Cliente WebSocket OT desconectado');
        });

        ws.on('error', (error) => {
            console.error('Error en WebSocket OT:', error);
        });
    });
}

// Función para notificar cambios en órdenes de trabajo
function notifyWorkOrderChanges(organizationId, payload) {
    if (!wss) {
        console.warn('WebSocket server de órdenes de trabajo no inicializado');
        return;
    }
    wss.clients.forEach((client) => {
        if (client.readyState === 1 && client.subscribedOrganizationId == organizationId) {
            client.send(JSON.stringify(payload));
        }
    });

    console.log(`Notificación OT enviada para organización ${organizationId}`);
}

module.exports = {
    initWorkOrdersWebSocket,
    notifyWorkOrderChanges
};