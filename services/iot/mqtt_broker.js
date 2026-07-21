// services/iot/mqtt_broker.js
//
// Broker MQTT local (Aedes sobre TCP) para ingesta directa de datos de sensores.
// Reusa sensorDataHandler/sensorsDataHandler -- los mismos que usan
// POST /sensorData y POST /sensorsData -- para que el dato entre por HTTP o
// por MQTT de forma idéntica (misma inserción, mismo aviso por WebSocket).
//
// Distinto del cliente MQTT existente (services/mqtt/mqtt_client.js), que se
// CONECTA a un broker externo cargado desde mes_settings. Este archivo LEVANTA
// un broker propio para que los dispositivos se conecten directo a este proceso.

const net = require('net');
const { Aedes } = require('aedes');
const pool = require('../../database/pool');
const { sensorDataHandler, sensorsDataHandler } = require('../handlers/sensor_data_handler');

// Nota de nombre: no reusamos MQTT_PORT porque esa env/valor de mes_settings ya
// identifica el puerto del broker EXTERNO al que se conecta mqtt_client.js.
// Usamos una variable separada para el puerto de este broker local.
const PORT = parseInt(process.env.MQTT_BROKER_PORT) || 1883;

// ================================================================
// AUTENTICACIÓN DE DISPOSITIVO
// ----------------------------------------------------------------
// No es JWT. Igual que en sensor_data_handler.js, un dispositivo se
// identifica por el token plano de mes_machines.token, comparado
// directo en SQL (WHERE m.token = $1). Replicamos aquí el mismo
// lookup mínimo solo para aceptar/rechazar la conexión MQTT; el
// handler vuelve a validar el token al insertar (no se modifica),
// así que no hay bypass de seguridad, solo una validación duplicada.
// Ver nota al final del archivo sobre cómo desacoplar esto.
// ================================================================
async function verifyDeviceToken(token) {
    if (!token) return false;

    const result = await pool.query(
        'SELECT machine_id FROM mes_machines WHERE token = $1 LIMIT 1',
        [token]
    );

    return result.rows.length > 0;
}

async function buildAedes() {
    const aedes = await Aedes.createBroker();

    // Convención: el token del dispositivo viaja en el username del CONNECT
    // (fallback a password si el firmware solo soporta ese campo).
    aedes.authenticate = async (client, username, password, callback) => {
        const token = username || (password ? password.toString() : null);

        try {
            const valid = await verifyDeviceToken(token);

            if (!valid) {
                const error = new Error('Token de dispositivo inválido');
                error.returnCode = 4; // MQTT 3.1.1: Bad username or password
                return callback(error, false);
            }

            // Se guarda para no exigir que el dispositivo repita el token en
            // cada publish; sensorDataHandler/sensorsDataHandler igual lo
            // vuelven a validar contra mes_machines al insertar.
            client.deviceToken = token;
            callback(null, true);
        } catch (err) {
            console.error('[MQTT-BROKER] Error autenticando dispositivo:', err.message);
            const error = new Error('Error de autenticación');
            error.returnCode = 5; // Not authorized
            callback(error, false);
        }
    };

    // ============================================================
    // TOPICS (equivalentes a las rutas HTTP)
    // ------------------------------------------------------------
    // sensores/<sensor_var>/data   ->  valor único   (== POST /sensorData)
    // sensores/batch/<device_id>   ->  varios valores (== POST /sensorsData)
    //
    // El segmento tras "sensores/" en el topic individual es el
    // `sensor_var` (código de variable del sensor) que ya exige
    // sensorDataHandler, NO el sensor_id numérico de la BD.
    // ============================================================
    aedes.on('publish', async (packet, client) => {
        if (!client || packet.topic.startsWith('$SYS')) return;

        const parts = packet.topic.split('/');
        if (parts[0] !== 'sensores') return;

        let payload;
        try {
            payload = JSON.parse(packet.payload.toString());
        } catch (err) {
            console.error(`[MQTT-BROKER] Payload no es JSON válido en topic ${packet.topic}`);
            return;
        }

        try {
            if (parts[1] === 'batch') {
                // sensores/batch/<device_id>
                const result = await sensorsDataHandler({
                    token: client.deviceToken,
                    items: payload.items
                });

                if (!result.success) {
                    console.error(`[MQTT-BROKER] Lote rechazado (cliente ${client.id}): ${result.message}`);
                }
            } else {
                // sensores/<sensor_var>/data
                const result = await sensorDataHandler({
                    token: client.deviceToken,
                    sensor_var: parts[1],
                    value: payload.value,
                    comment: payload.comment
                });

                if (!result.success) {
                    console.error(`[MQTT-BROKER] Dato rechazado (cliente ${client.id}): ${result.message}`);
                }
            }
            // notifySensorData ya se dispara DENTRO de sensorDataHandler/
            // sensorsDataHandler (igual que la ruta POST actual, que también
            // delega en el handler) -- no se vuelve a llamar aquí para no
            // duplicar el broadcast por WebSocket.
        } catch (err) {
            console.error(`[MQTT-BROKER] Error procesando publish en ${packet.topic}:`, err.message);
        }
    });

    aedes.on('clientError', (client, err) => {
        console.error(`[MQTT-BROKER] clientError cliente=${client?.id || 'desconocido'}:`, err.message);
    });

    aedes.on('connectionError', (client, err) => {
        console.error(`[MQTT-BROKER] connectionError cliente=${client?.id || 'desconocido'}:`, err.message);
    });

    return aedes;
}

async function startMqttBroker() {
    const aedes = await buildAedes();
    const server = net.createServer(aedes.handle);

    server.listen(PORT, () => {
        console.log(`[MQTT-BROKER] Broker Aedes escuchando en puerto ${PORT}`);
    });

    server.on('error', (err) => {
        console.error('[MQTT-BROKER] Error del servidor TCP:', err.message);
    });

    return { aedes, server };
}

module.exports = { startMqttBroker };
