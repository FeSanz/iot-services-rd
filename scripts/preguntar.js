#!/usr/bin/env node
/**
 * Le pregunta algo al bot por HTTP, como lo haria la burbuja.
 *
 *   node --env-file=../.env scripts/preguntar.js 8 "como esta la planta?"
 *
 * El primer argumento es el user_id: el alcance sale de ahi, no de la pregunta.
 * Sirve para ver la misma pregunta contestada distinto segun quien la haga.
 */
const jwt = require('jsonwebtoken');

const userId = Number(process.argv[2]);
const pregunta = process.argv.slice(3).join(' ');
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

async function main() {
    if (!Number.isInteger(userId) || !pregunta) {
        throw new Error('Uso: preguntar.js <user_id> "<pregunta>"');
    }
    const token = jwt.sign({ user_id: userId }, process.env.JWT_SECRET, { expiresIn: '10m' });

    const empezo = Date.now();
    const r = await fetch(`${BASE_URL}/api/ai/chat`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: pregunta }),
    });
    const j = await r.json();

    console.log(`--- usuario ${userId} | ${r.status} | ${Date.now() - empezo} ms`);
    if (r.status !== 200) {
        console.log(JSON.stringify(j, null, 2));
        return;
    }
    console.log('herramientas:', j.items.tools_used.join(', ') || '(ninguna)');
    console.log();
    console.log(j.items.reply);
}

main().catch((e) => { console.error('FALLA:', e.message); process.exitCode = 1; });
