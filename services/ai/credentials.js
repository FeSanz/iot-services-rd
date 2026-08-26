/**
 * Boveda de llaves del LLM, una por compañia (ETAPA 3.5, plan 7.4).
 *
 * Decision del cliente: la llave la pone cada cliente, no Condor.
 *
 * Reglas que este modulo hace cumplir, y que son el punto entero:
 *   - La llave se guarda cifrada (AES-256-GCM). Nunca en texto plano.
 *   - La llave maestra vive SOLO en AI_CRED_MASTER_KEY, nunca en la base.
 *   - Descifrar devuelve la llave a una variable local que muere con la
 *     peticion. No hay cache de modulo ni global. A proposito.
 *   - Lo que sale hacia la UI es {provider, model, last4, configured} y nada
 *     mas. Ni al administrador se le devuelve la llave: si la perdio, la rota.
 */
const crypto = require('crypto');
const pool = require('../../database/pool');
const { validarUrlDeProveedor } = require('./url-proveedor');

// Un proveedor nuevo se agrega aqui, no en un if suelto por el codigo.
const PROVEEDORES = {
    // urlPorDefecto: sin ella, guardar una credencial sin base_url dejaba una
    // fila que el chat no puede usar -- la primera pregunta moria con "Falta la
    // URL del proveedor", un error que no apunta a la causa.
    groq:   { prefijo: 'gsk_', largoMinimo: 20, requiereLlave: true, urlPorDefecto: 'https://api.groq.com/openai/v1' },
    openai: { prefijo: 'sk-',  largoMinimo: 20, requiereLlave: true, urlPorDefecto: 'https://api.openai.com/v1' },
    // Cubre las dos formas de Ollama: la local (no pide llave) y Ollama Cloud
    // (si la pide, pero sin prefijo reconocible). Lo que las distingue es
    // base_url, no la llave -- por eso aqui base_url es obligatoria.
    ollama: { prefijo: '',     largoMinimo: 0,  requiereLlave: false },
};

function falla(status, mensaje) {
    const e = new Error(mensaje);
    e.status = status;
    return e;
}

/**
 * La llave maestra se valida al usarla, NO al cargar el modulo.
 *
 * Es la leccion de services/iot/notifications.js:11, que lee una variable de
 * entorno en el cuerpo del modulo y tumba el backend entero si falta. Aqui, si
 * AI_CRED_MASTER_KEY no esta, lo unico que deja de funcionar es el bot.
 */
function llaveMaestra() {
    const b64 = process.env.AI_CRED_MASTER_KEY;
    if (!b64) {
        throw falla(503, 'AI_CRED_MASTER_KEY sin definir: la boveda de llaves esta deshabilitada');
    }
    const maestra = Buffer.from(b64, 'base64');
    if (maestra.length !== 32) {
        throw falla(503, `AI_CRED_MASTER_KEY debe ser de 32 bytes, es de ${maestra.length}`);
    }
    return maestra;
}

function cifrar(textoPlano) {
    const iv = crypto.randomBytes(12);   // 12 bytes es el estandar de GCM
    const c = crypto.createCipheriv('aes-256-gcm', llaveMaestra(), iv);
    const ciphertext = Buffer.concat([c.update(textoPlano, 'utf8'), c.final()]);
    return { ciphertext, iv, authTag: c.getAuthTag() };
}

// Acepta authTag (lo que devuelve cifrar) y auth_tag (lo que devuelve la base).
function descifrar({ ciphertext, iv, authTag, auth_tag }) {
    const d = crypto.createDecipheriv('aes-256-gcm', llaveMaestra(), iv);
    d.setAuthTag(authTag || auth_tag);
    // Si alguien manipulo el ciphertext en la base, esto LANZA en vez de
    // devolver basura. Por eso GCM y no CBC.
    return Buffer.concat([d.update(ciphertext), d.final()]).toString('utf8');
}

function validarLlave(provider, apiKey) {
    const p = PROVEEDORES[provider];
    if (!p) {
        throw falla(400, `Proveedor no soportado: ${provider}. Validos: ${Object.keys(PROVEEDORES).join(', ')}`);
    }
    if (typeof apiKey !== 'string' || apiKey.trim() === '') {
        throw falla(400, 'La llave viene vacia');
    }
    const llave = apiKey.trim();
    if (p.requiereLlave) {
        if (llave.length < p.largoMinimo) {
            throw falla(400, `La llave de ${provider} es demasiado corta`);
        }
        if (p.prefijo && !llave.startsWith(p.prefijo)) {
            throw falla(400, `La llave de ${provider} deberia empezar con "${p.prefijo}"`);
        }
    }
    return llave;
}

/**
 * Guarda o reemplaza la llave de una compañia. La llave llega en el BODY de un
 * POST, nunca por query string: los query strings quedan en los logs de
 * acceso, en el historial del navegador y en los proxies.
 */
async function guardarCredencial({ companyId, provider, apiKey, model, baseUrl, userId }) {
    const llave = validarLlave(provider, apiKey);

    // La fila que se guarda tiene que poder USARSE tal cual: todo lo que el
    // chat necesita (url y modelo) se resuelve y valida aqui, con quien lo
    // escribio delante, y no meses despues dentro de una conversacion.
    const urlFinal = (typeof baseUrl === 'string' && baseUrl.trim())
        ? baseUrl.trim()
        : (PROVEEDORES[provider].urlPorDefecto || null);
    if (!urlFinal) {
        throw falla(400, `${provider} necesita "base_url": no hay una por defecto`);
    }
    await validarUrlDeProveedor(urlFinal);

    // Rotar la llave no borra el modelo: si no mandan uno, se conserva el que
    // ya habia. Solo una credencial NUEVA esta obligada a decirlo.
    let modeloFinal = (typeof model === 'string' && model.trim()) ? model.trim() : null;
    if (!modeloFinal) {
        const { rows: previa } = await pool.query(
            'SELECT model FROM mes_ai_credentials WHERE company_id = $1 AND provider = $2',
            [companyId, provider]
        );
        modeloFinal = previa[0]?.model || null;
        if (!modeloFinal) {
            throw falla(400, `Falta "model": di que modelo de ${provider} se va a usar`);
        }
    }

    const { ciphertext, iv, authTag } = cifrar(llave);
    const last4 = llave.slice(-4).padStart(4, '*');

    const { rows } = await pool.query(
        `INSERT INTO mes_ai_credentials
                (company_id, provider, model, base_url, ciphertext, iv, auth_tag, last4, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
         ON CONFLICT (company_id, provider) DO UPDATE
            SET model        = EXCLUDED.model,
                base_url     = EXCLUDED.base_url,
                ciphertext   = EXCLUDED.ciphertext,
                iv           = EXCLUDED.iv,
                auth_tag     = EXCLUDED.auth_tag,
                last4        = EXCLUDED.last4,
                key_version  = EXCLUDED.key_version,
                updated_by   = EXCLUDED.updated_by,
                updated_date = now()
         RETURNING company_id, provider, model, base_url, last4, updated_date`,
        [companyId, provider, modeloFinal, urlFinal, ciphertext, iv, authTag, last4, userId]
    );
    return { ...rows[0], configured: true };
}

/**
 * Lo unico que puede salir del servidor. Sin ciphertext, sin iv, sin authTag,
 * sin llave.
 */
async function describirCredenciales(companyId) {
    const { rows } = await pool.query(
        `SELECT provider, model, base_url, last4, key_version, updated_date
           FROM mes_ai_credentials
          WHERE company_id = $1
          ORDER BY provider`,
        [companyId]
    );
    return rows.map((r) => ({ ...r, configured: true }));
}

/**
 * Uso interno del servidor, jamas de una tool ni de una respuesta HTTP.
 * Devuelve la llave descifrada en un objeto que muere con la peticion.
 */
async function obtenerCredencial(companyId, provider) {
    const { rows } = await pool.query(
        `SELECT provider, model, base_url, ciphertext, iv, auth_tag
           FROM mes_ai_credentials
          WHERE company_id = $1 AND provider = $2`,
        [companyId, provider]
    );
    if (rows.length === 0) {
        throw falla(404, `La compañia ${companyId} no tiene llave configurada para ${provider}`);
    }
    return {
        provider: rows[0].provider,
        model: rows[0].model,
        // Las filas guardadas antes de que existiera la URL por defecto pueden
        // traerla vacia: se resuelve tambien al leer, no solo al guardar.
        baseUrl: rows[0].base_url || PROVEEDORES[rows[0].provider]?.urlPorDefecto || null,
        apiKey: descifrar(rows[0]),
    };
}

/**
 * La credencial que usa el agente cuando nadie dice cual. Si una compañia tiene
 * varias configuradas, gana la que se toco al final: rotar o agregar una llave
 * es la forma de cambiar de proveedor, sin otro boton que mantener.
 */
async function obtenerCredencialActiva(companyId) {
    const { rows } = await pool.query(
        `SELECT provider FROM mes_ai_credentials
          WHERE company_id = $1 ORDER BY updated_date DESC LIMIT 1`,
        [companyId]
    );
    if (rows.length === 0) {
        throw falla(503, `La compañia ${companyId} todavia no tiene configurada la llave del LLM`);
    }
    return obtenerCredencial(companyId, rows[0].provider);
}

async function borrarCredencial(companyId, provider) {
    const { rowCount } = await pool.query(
        `DELETE FROM mes_ai_credentials WHERE company_id = $1 AND provider = $2`,
        [companyId, provider]
    );
    return rowCount > 0;
}

/**
 * Tapa cualquier cosa con pinta de llave antes de que llegue a un log o a un
 * mensaje de error. El plan lo exige (prueba 7.4.7-3: configurar una llave,
 * provocar un error del proveedor y buscarla en TODA la salida del servidor).
 *
 * Se aplica sobre el texto, no sobre una lista de llaves conocidas: asi tambien
 * tapa la llave de un proveedor que todavia no existe aqui.
 */
function redactar(texto) {
    if (texto == null) return texto;
    return String(texto)
        .replace(/\b(gsk_|sk-|sk_)[A-Za-z0-9_\-]{8,}/g, '$1[REDACTADO]')
        .replace(/\b(Bearer)\s+[A-Za-z0-9._\-]{8,}/gi, '$1 [REDACTADO]');
}

module.exports = {
    PROVEEDORES,
    guardarCredencial,
    describirCredenciales,
    obtenerCredencial,
    obtenerCredencialActiva,
    borrarCredencial,
    redactar,
    // exportadas para las pruebas
    cifrar,
    descifrar,
};
