// services/mqtt/mqtt_client.js
const mqtt = require('mqtt');
const pool = require('../../database/pool');

const { woCompletedHandler } = require('../handlers/work_execution_handler');
const { sensorDataHandler, sensorsDataHandler } = require('../handlers/sensor_data_handler');

// Topics con wildcard: + captura el companyId
const TOPICS = {
    WO_COMPLETED: 'mes/+/erp/woCompleted',
    SENSOR_DATA:  'mes/+/iot/sensorData',
    SENSORS_DATA: 'mes/+/iot/sensorsData',
};

let client = null;
let mqttConfig = null;

// ================================================================
// Cargar configuración MQTT desde mes_settings (global)
// ================================================================
async function loadMQTTSettings() {
    try {
        const result = await pool.query(`SELECT name, value FROM mes_settings WHERE type = 'MQTT' AND enabled_flag = 'Y'
                                            ORDER BY setting_id LIMIT 3`);

        if (result.rows.length === 0) {
            console.error('[MQTT] No se encontraron datos de conexión MQTT habilitados');
            return null;
        }

        const settings = {};
        result.rows.forEach(row => { settings[row.name] = row.value; });

        if (!settings.MQTT_BROKER || !settings.MQTT_CREDENTIALS || !settings.MQTT_PORT) {
            console.error('[MQTT] Datos de conexión incompletos. Se requiere: BROKER, CREDENTIALS, PORT');
            return null;
        }

        // Decodificar credenciales de MQTT
        const decoded = Buffer.from(settings.MQTT_CREDENTIALS, 'base64').toString('utf-8');
        const separatorIndex = decoded.indexOf(':');

        if (separatorIndex === -1) {
            console.error('[MQTT] Formato de credenciales inválido.');
            return null;
        }

        return {
            host: settings.MQTT_BROKER,
            port: parseInt(settings.MQTT_PORT),
            username: decoded.substring(0, separatorIndex),
            password: decoded.substring(separatorIndex + 1),
            protocol: parseInt(settings.MQTT_PORT) === 8883 ? 'mqtts' : 'mqtt',
            clientId: `condor_mes_${Math.random().toString(16).substr(2, 8)}`,
        };

    } catch (error) {
        console.error('[MQTT] Error consultando datos de conexión MQTT:', error.message);
        return null;
    }
}

// ================================================================
// INICIALIZAR
// ================================================================
async function initMQTT() {

    const config = await loadMQTTSettings();

    if (!config) {
        console.error('[MQTT] No se pudo inicializar, configuración no disponible');
        return null;
    }

    mqttConfig = config;
    const url = `${config.protocol}://${config.host}:${config.port}`;

    client = mqtt.connect(url, {
        username: config.username,
        password: config.password,
        clientId: config.clientId,
        rejectUnauthorized: config.protocol === 'mqtts',
        reconnectPeriod: 5000,
        connectTimeout: 30000,
    });

    client.on('connect', () => {
        Object.values(TOPICS).forEach(topic => {
            client.subscribe(topic, { qos: 1 }, (err) => {
                if (err) {console.error(`[MQTT] Error suscribiendo a ${topic}:`, err.message);}
            });
        });
    });

    client.on('message', async (topic, payload) => {
        const raw = payload.toString();
        let data;
        try {
            data = JSON.parse(raw);
        } catch (e) {
            console.error('[MQTT] JSON inválido:', raw);
            return;
        }
        try {
            await routeMessage(topic, data);
        } catch (error) {
            console.error(`[MQTT] Error procesando [${topic}]:`, error.message);
        }
    });

    client.on('error', (err) => console.error('[MQTT] Error:', err.message));
    client.on('reconnect', () => console.log('[MQTT] Reintentando conexión...'));
    client.on('offline', () => console.log('[MQTT] Desconectado'));

    return client;
}

// ================================================================
// ENRUTAR MENSAJES
// ----------------------------------------------------------------
// Topic structure: mes/{companyId}/{module}/{action}
// ================================================================
async function routeMessage(topic, data) {
    const parts = topic.split('/');

    const companyId = parts[1];
    const module = parts[2]; // module (erp/iot)
    const action = parts[3];

    // ── mes/{companyId}/erp/woCompleted ──
    if (module === 'erp' && action === 'woCompleted') {
        const organizationId = data.OrganizationId || data.organizationId || null;

        if (!organizationId) {
            console.error(`[MQTT-ERP] Company ${companyId}: falta OrganizationId`);
            publishMessage(`mes/${companyId}/erp/woCompleted/response`, JSON.stringify({
                success: false, message: 'Falta OrganizationId en el payload'
            }));
            return;
        }

        const result = await woCompletedHandler(organizationId, data);

        if (!result.success) {
            console.error(`[MQTT-ERP] Company ${companyId}: ${result.message}`);
        }

        publishMessage(`mes/${companyId}/erp/woCompleted/response`, JSON.stringify({
            success: result.success,
            message: result.message,
            data: result.data
        }));
    }

    // ── mes/{companyId}/iot/sensorData ──
    else if (module === 'iot' && action === 'sensorData') {
        const result = await sensorDataHandler(data);

        if (!result.success) {
            console.error(`[MQTT-IOT] Company ${companyId}: ${result.message}`);
        }
    }

    // ── mes/{companyId}/iot/sensorsData ──
    else if (module === 'iot' && action === 'sensorsData') {
        const result = await sensorsDataHandler(data);

        if (!result.success) {
            console.error(`[MQTT-IOT] Company ${companyId}: ${result.message}`);
        }
    }

    else {
        console.log(`[MQTT] Topic no manejado: ${topic}`);
    }
}

// ================================================================
// PUBLICAR
// ================================================================
function publishMessage(topic, message, options = { qos: 1, retain: false }) {
    if (client && client.connected) {
        client.publish(topic, message, options, (err) => {
            if (err) console.error(`[MQTT] Error publicando en ${topic}:`, err.message);
        });
    } else {
        console.error('[MQTT] Cliente no conectado');
    }
}

// ================================================================
// ESTADO
// ================================================================
function getMQTTStatus() {
    return {
        connected: client ? client.connected : false,
        clientId: mqttConfig?.clientId || null,
        broker: mqttConfig ? `${mqttConfig.host}:${mqttConfig.port}` : null,
        topics: Object.values(TOPICS),
    };
}

module.exports = { initMQTT, publishMessage, getMQTTStatus };
