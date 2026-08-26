#!/usr/bin/env node
/**
 * Mete la llave del LLM del .env en la boveda, para una compañia.
 *
 *   node --env-file=../.env scripts/seed-credencial.js <company_id>
 *
 * Existe porque el agente tiene UN solo camino para conseguir la llave: la
 * boveda. No hay respaldo por variable de entorno, y es a proposito -- ese
 * respaldo es justo como se termina compartiendo una llave entre clientes sin
 * que nadie lo note.
 *
 * En local sirve para probar. En un cliente nuevo sirve para arrancar antes de
 * que exista la pantalla de configuracion.
 */
const pool = require('../database/pool');
const { guardarCredencial, describirCredenciales } = require('../services/ai/credentials');

const companyId = Number(process.argv[2]);

// El proveedor sale de la URL: es lo unico que de verdad los distingue.
function proveedorDe(baseUrl = '') {
    if (baseUrl.includes('ollama')) return 'ollama';
    if (baseUrl.includes('groq')) return 'groq';
    return 'openai';
}

async function main() {
    if (!Number.isInteger(companyId)) {
        throw new Error('Uso: seed-credencial.js <company_id>');
    }
    const baseUrl = process.env.LLM_BASE_URL;
    const model = process.env.LLM_MODEL;
    const apiKey = process.env.LLM_API_KEY;
    if (!baseUrl || !model || !apiKey) {
        throw new Error('Faltan LLM_BASE_URL, LLM_MODEL o LLM_API_KEY en el .env');
    }

    const provider = proveedorDe(baseUrl);
    const guardada = await guardarCredencial({
        companyId, provider, apiKey, model, baseUrl, userId: null,
    });

    console.log('guardada:', { ...guardada, base_url: baseUrl });
    console.log('la compañia ahora tiene:', await describirCredenciales(companyId));
}

main()
    .catch((e) => { console.error('FALLA:', e.message); process.exitCode = 1; })
    .finally(() => pool.end().finally(() => process.exit(process.exitCode || 0)));
