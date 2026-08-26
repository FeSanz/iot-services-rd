/**
 * Capa de dominio curada (ETAPA 3, plan 3.2b).
 *
 * Lo que el bot NO puede deducir leyendo la base. Un agente que solo escanea
 * datos contesta con mucha seguridad cosas equivocadas: ve el texto
 * "No Signal" en una columna y se inventa que significa.
 *
 * QUE ES CADA COSA:
 *   confirmado: true   -> verificado contra los datos de produccion
 *   confirmado: false  -> lo que creemos, PENDIENTE de que lo confirme quien
 *                         conoce la operacion. El bot lo dice cuando lo usa.
 *
 * Este archivo lo tiene que terminar de llenar el equipo de Condor. Es lo que
 * separa un bot que suena bien de uno que acierta.
 */

// --- estados de orden de trabajo -------------------------------------------
// Unicos dos valores presentes en las 119 ordenes de produccion.
const ESTADOS_ORDEN = {
    RELEASED:   { etiqueta: 'Liberada',   descripcion: 'Liberada a piso, aun sin empezar', confirmado: false },
    IN_PROCESS: { etiqueta: 'En proceso', descripcion: 'Con produccion registrada',        confirmado: false },
};

// --- estados de alerta / paro ----------------------------------------------
// Valores reales en mes_alerts: completed 538, attending 3, open 3, assigned 1.
const ESTADOS_ALERTA = {
    open:      { etiqueta: 'Abierta',    descripcion: 'Reportada, sin atender',        abierta: true,  confirmado: false },
    assigned:  { etiqueta: 'Asignada',   descripcion: 'Asignada a alguien',            abierta: true,  confirmado: false },
    attending: { etiqueta: 'Atendiendo', descripcion: 'Alguien esta trabajando en el', abierta: true,  confirmado: false },
    completed: { etiqueta: 'Cerrada',    descripcion: 'Resuelta',                      abierta: false, confirmado: false },
};

// --- estados de maquina -----------------------------------------------------
// mes_machines.status, tal como lo escribe el MES. Ojo: 22 maquinas lo tienen
// vacio y una trae 'Y', que es basura de captura.
const ESTADOS_MAQUINA = {
    Runtime:     { etiqueta: 'Produciendo', descripcion: 'La maquina esta corriendo',        confirmado: true },
    Downtime:    { etiqueta: 'Parada',      descripcion: 'Detenida',                         confirmado: true },
    'No Signal': { etiqueta: 'Sin señal',   descripcion: 'El MES no recibe datos de la maquina; NO significa que este parada', confirmado: true },
};

// --- tipos de paro ----------------------------------------------------------
// mes_failures.type. Esto si es vocabulario de la planta, no invento.
const TIPOS_DE_PARO = {
    'Paro NO programado': { planeado: false, confirmado: true },
    'Paro programado':    { planeado: true,  confirmado: true },
};

/**
 * Merma.
 *
 * mes_work_execution guarda cantidades (ready, scrap, reject) pero NO el
 * motivo. Por eso no existe la tool de "top razones de merma": no hay dato,
 * no es que falte programarla. Es la pregunta 2 al cliente.
 */
const MERMA = {
    definicion: 'merma = scrap + reject',
    porcentaje: 'merma / (ready + scrap + reject) * 100',
    // ready promedia 1.0 por registro: cada fila de work_execution es un
    // contenedor/caja, no una cantidad de piezas.
    unidad: 'cajas o contenedores registrados, no piezas',
    confirmado: false,
};

/**
 * Turno.
 *
 * mes_work_execution NO tiene columna de turno; se calcula por la hora local de
 * execution_date contra mes_shifts (ver assets/db/vistas_bot.sql). La base
 * corre en UTC y mes_shifts guarda hora de pared local de Mexico.
 */
/**
 * La zona de las plantas. Las doce organizaciones estan en Mexico.
 *
 * Vive AQUI, y no repetida en cada archivo, porque este proyecto ya se ha
 * tropezado tres veces con la misma piedra: la base corre en UTC y las plantas
 * no. Los turnos (ETAPA 2), el periodo de los reportes programados y la fecha
 * de "hoy" que se le dice al modelo se calcularon en UTC alguna vez, y las tres
 * corrian el dia. Una constante compartida no arregla la aritmetica, pero
 * impide que una copia se quede atras cuando la otra cambia.
 */
const ZONA = 'America/Mexico_City';

/** "2026-08-25" en hora de la planta, no en UTC. `en-CA` da el formato ISO. */
function hoyEnLaPlanta(ahora = new Date()) {
    return ahora.toLocaleDateString('en-CA', { timeZone: ZONA });
}

const TURNO = {
    fuente: 'calculado por hora local contra mes_shifts, no grabado',
    zonaHoraria: ZONA,
    advertencia: 'Solo las organizaciones 2 y 4 tienen turnos configurados; en las demas el turno sale vacio.',
    confirmado: true,
};

/**
 * OEE.
 *
 * mes_kpis existe con availability, performance, quality, mtbf, mttr, mtta,
 * pero esta VACIA en produccion. El bot NO debe calcular OEE por su cuenta:
 * faltan el tiempo planeado de produccion y el ciclo ideal.
 */
const OEE = {
    disponible: false,
    motivo: 'La tabla mes_kpis existe pero no tiene ni una fila. Nadie la esta poblando.',
    confirmado: true,
};

/**
 * Lo que se le mete al system prompt. Solo vocabulario y advertencias: NADA de
 * seguridad. El alcance no se pide por favor en un prompt, se inyecta en el SQL
 * (plan 3.4, capa 5).
 */
function comoTexto() {
    const lista = (obj, campo) => Object.entries(obj)
        .map(([k, v]) => `  - "${k}": ${v.etiqueta} — ${v[campo] || v.descripcion}`)
        .join('\n');

    return `VOCABULARIO DE LA PLANTA (usalo, no lo inventes):

Estados de orden de trabajo:
${lista(ESTADOS_ORDEN, 'descripcion')}

Estados de alerta/paro:
${lista(ESTADOS_ALERTA, 'descripcion')}

Estados de maquina:
${lista(ESTADOS_MAQUINA, 'descripcion')}

Tipos de paro: ${Object.keys(TIPOS_DE_PARO).join(' | ')}

Merma: ${MERMA.definicion}. Porcentaje: ${MERMA.porcentaje}.
  La unidad es ${MERMA.unidad}.
  NO existe el motivo de la merma en la base: si te lo preguntan, dilo.

Turno: ${TURNO.fuente}. ${TURNO.advertencia}

OEE: no disponible. ${OEE.motivo}
  Si te preguntan por OEE, dilo tal cual. NO lo estimes con otros datos.

Cosas que NO estan en esta base y hay que decir que no estan:
  - consumo de materiales (vive en Oracle Fusion, no aqui)
  - motivo o razon de la merma
  - OEE, disponibilidad, rendimiento, calidad, MTBF, MTTR

Lo marcado abajo esta SIN CONFIRMAR por la operacion. Si tu respuesta depende
de ello, avisa en una linea:
${[...Object.entries(ESTADOS_ORDEN), ...Object.entries(ESTADOS_ALERTA)]
        .filter(([, v]) => !v.confirmado)
        .map(([k]) => `  - significado exacto de "${k}"`)
        .join('\n')}`;
}

module.exports = {
    ESTADOS_ORDEN,
    ESTADOS_ALERTA,
    ESTADOS_MAQUINA,
    TIPOS_DE_PARO,
    MERMA,
    TURNO,
    OEE,
    ZONA,
    hoyEnLaPlanta,
    comoTexto,
};
