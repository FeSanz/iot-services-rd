/**
 * Capa de alcance del bot (ETAPA 1).
 *
 * El resto del backend confia en el alcance que llega por query string
 * (req.query.organizations, req.query.user_id). El bot NO hereda eso: aqui el
 * alcance sale del user_id del JWT y de la base, nunca de la peticion.
 *
 * Reglas que este modulo hace cumplir:
 *   1. organization_id nunca es parametro que el modelo pueda nombrar.
 *   2. Toda consulta del bot filtra por las organizaciones del usuario.
 *   3. Ninguna consulta del bot lleva SQL crudo del modelo.
 */
// Dos pools a proposito:
//   pool         -- rol de la aplicacion. Solo lo usa resolveScope, que tiene
//                   que leer mes_users/mes_users_org, tablas que el rol del bot
//                   no ve (ni debe: ahi estan las contraseñas).
//   poolReadonly -- rol condor_ai_ro. TODO dato que toca el bot pasa por aqui.
const pool = require('../../database/pool');
const poolReadonly = require('../../database/poolReadonly');
const { ZONA } = require('./domain');

/**
 * Organizaciones y compañias del usuario. Entrada: el user_id del TOKEN.
 * @param {number} userId  req.user.user_id, jamas req.query.user_id
 */
async function resolveScope(userId) {
    if (!Number.isInteger(userId)) {
        throw new Error(`user_id invalido: ${JSON.stringify(userId)}`);
    }

    const { rows } = await pool.query(
        `SELECT o.organization_id, o.company_id, u.role
           FROM mes_users_org uo
           JOIN mes_organizations o USING (organization_id)
           JOIN mes_users u ON u.user_id = uo.user_id
          WHERE uo.user_id = $1
            AND u.enabled_flag = 'Y'
          ORDER BY o.organization_id`,
        [userId]
    );

    if (rows.length === 0) {
        // Usuario inexistente, deshabilitado o sin organizaciones: los tres
        // casos significan lo mismo para el bot, no ve nada.
        throw new Error(`El usuario ${userId} no tiene organizaciones asignadas`);
    }

    // Que organizacion es de que compañia. Sin esto, orgIds es una lista plana
    // y no hay forma de recortar el alcance a UNA compañia -- ver
    // scopeDeCompania, que es donde importa.
    const orgsPorCompania = {};
    for (const r of rows) {
        (orgsPorCompania[r.company_id] = orgsPorCompania[r.company_id] || []).push(r.organization_id);
    }

    return {
        userId,
        // El rol sale de la base, no del JWT: un token viejo puede traer el rol
        // que tenia el usuario antes de que se lo cambiaran.
        role: rows[0].role,
        orgIds: rows.map((r) => r.organization_id),
        companyIds: [...new Set(rows.map((r) => r.company_id))],
        orgsPorCompania,
    };
}

/**
 * El mismo alcance, recortado a UNA compañia.
 *
 * El esquema permite que un usuario tenga organizaciones de varias compañias
 * --hoy nadie lo hace, pero el codigo lo soporta-- y ahi el alcance completo
 * mezcla. Se vio en el reporte: la cabecera del PDF decia el nombre de UNA
 * compañia y las cifras sumaban las organizaciones de TODAS. Un documento que
 * miente en la cabecera es peor que uno que falta.
 *
 * El chat tenia el mismo defecto y no se notaba: company_id solo elegia de quien
 * era la llave del LLM, mientras las consultas seguian viendo todo.
 *
 * Recorta, nunca ensancha: las organizaciones salen del alcance que ya se
 * resolvio contra la base, no de lo que pida nadie.
 */
function scopeDeCompania(scope, companyId) {
    const orgIds = (scope.orgsPorCompania || {})[companyId];
    if (!orgIds || orgIds.length === 0) {
        // Mismo mensaje que si no existiera: no se confirma la existencia de
        // compañias ajenas.
        throw Object.assign(new Error('Compañia fuera de alcance'), { status: 403 });
    }
    return {
        ...scope,
        orgIds,
        companyIds: [Number(companyId)],
        orgsPorCompania: { [companyId]: orgIds },
    };
}

/**
 * Unico camino a la base para las tools del bot. Va por el pool de solo
 * lectura, contra las vistas de assets/db/vistas_bot.sql.
 *
 * El SQL debe nombrar el marcador $ORGS, que se sustituye por el arreglo de
 * organizaciones del usuario:
 *
 *     consultarConAlcance(scope, 'SELECT ... WHERE wo.organization_id = ANY($ORGS)')
 *
 * Si una tool olvida el filtro, esto revienta en vez de devolver datos de otra
 * compañia. Es el punto entero de la etapa: el aislamiento no depende de que
 * quien escriba la tool se acuerde.
 *
 * Es async a proposito: asi el olvido de $ORGS llega como rechazo de promesa y
 * no como throw sincrono, que se le escaparia a un llamador con .catch().
 */
async function consultarConAlcance(scope, sql, params = []) {
    if (!scope || !Array.isArray(scope.orgIds) || scope.orgIds.length === 0) {
        throw new Error('consultarConAlcance requiere un scope de resolveScope()');
    }
    if (!sql.includes('$ORGS')) {
        throw new Error('consulta del bot sin filtro de alcance: falta $ORGS');
    }
    const texto = sql.split('$ORGS').join(`$${params.length + 1}`);
    return poolReadonly.query(texto, [...params, scope.orgIds]);
}

/**
 * ¿La organizacion esta dentro del alcance? Para cuando el usuario nombra una
 * planta y el bot la resuelve a un id: hay que comprobar antes de usarla.
 */
function orgEnAlcance(scope, organizationId) {
    return scope.orgIds.includes(Number(organizationId));
}

/**
 * Rango [desde, hasta] cerrado, con el corte de dia en la zona DE LA PLANTA.
 *
 * Las columnas de fecha son timestamptz y la base corre en UTC: un
 * `col >= '2026-08-25'` cortaria a la medianoche UTC, que son las 6 de la tarde
 * del dia anterior en planta. El "reporte del 25" traia la produccion de la
 * noche del 24 y perdia la de la noche del 25 -- y la grafica por dia, que
 * agrupa por fecha local, mostraba una barra fuera del periodo declarado.
 *
 * `$N::timestamp AT TIME ZONE zona` convierte la fecha pedida en la medianoche
 * de Mexico. La conversion va en el LADO DEL PARAMETRO, no sobre la columna:
 * la comparacion sigue siendo por indice.
 */
function rangoFechas(columna, desde, hasta, siguiente) {
    const partes = [];
    const valores = [];
    if (desde) {
        valores.push(desde);
        partes.push(`AND ${columna} >= ($${siguiente + valores.length - 1}::timestamp AT TIME ZONE '${ZONA}')`);
    }
    if (hasta) {
        valores.push(hasta);
        partes.push(`AND ${columna} < (($${siguiente + valores.length - 1}::date + 1)::timestamp AT TIME ZONE '${ZONA}')`);
    }
    return { sql: partes.join('\n'), valores };
}

module.exports = { resolveScope, scopeDeCompania, consultarConAlcance, orgEnAlcance, rangoFechas };
