/**
 * Cuantas cosas del asistente corren a la vez EN ESTA INSTANCIA.
 *
 * Vivia dentro de router.js, pero el programador de reportes tambien consume la
 * maquina --consultas, PDF y, en cuanto entre la narrativa, una llamada al
 * LLM-- y desde router.js no lo podia usar sin un ciclo de imports
 * (router -> programador -> router). Un cupo que solo cuenta una de las dos
 * puertas no es un cupo: es una estadistica.
 *
 * En memoria del proceso a proposito: con varias instancias cada una se cuida
 * sola, que es justo lo que se quiere aqui. No hace falta Redis para esto.
 * ponytail: contador en memoria; si algun dia hay que coordinar entre
 * instancias, entonces si un store compartido.
 *
 * El limite por compañia existe para que un cliente entusiasmado no se lleve
 * todos los lugares y deje a los demas esperando.
 */
const MAX_A_LA_VEZ = Number(process.env.AI_MAX_CONCURRENT || 4);
const MAX_POR_COMPANIA = Number(process.env.AI_MAX_CONCURRENT_PER_COMPANY || 2);

let enCurso = 0;
const enCursoPorCompania = new Map();

function anotar(companyId) {
    enCurso++;
    enCursoPorCompania.set(companyId, (enCursoPorCompania.get(companyId) || 0) + 1);
}

/** Pide un lugar. Si no hay, lanza un 429 con el motivo. Para lo que pide alguien. */
function tomarLugar(companyId) {
    const deLaCompania = enCursoPorCompania.get(companyId) || 0;
    if (enCurso >= MAX_A_LA_VEZ) {
        throw Object.assign(new Error('El asistente esta atendiendo a otras personas. Intenta en unos segundos.'), { status: 429 });
    }
    if (deLaCompania >= MAX_POR_COMPANIA) {
        throw Object.assign(new Error('Ya hay varias preguntas en curso de tu empresa. Intenta en unos segundos.'), { status: 429 });
    }
    anotar(companyId);
}

/**
 * Ocupa un lugar SIN rechazar. Para el trabajo de fondo -- hoy, los reportes
 * programados.
 *
 * No se le aplica el tope a proposito: si el reporte del lunes a las 7 se cayera
 * porque en ese momento habia cuatro personas preguntando, el correo no sale y
 * nadie se entera hasta que alguien lo echa de menos. Lo que si hace es CONTAR,
 * y por eso mientras corre el programado el chat ve la instancia mas ocupada y
 * puede devolver 429 -- que es el comportamiento que se queria.
 */
function ocuparLugar(companyId) {
    anotar(companyId);
    let suelto = false;
    return () => {
        if (suelto) return;   // soltar dos veces descuadraria el contador
        suelto = true;
        soltarLugar(companyId);
    };
}

function soltarLugar(companyId) {
    enCurso = Math.max(0, enCurso - 1);
    const quedan = (enCursoPorCompania.get(companyId) || 1) - 1;
    if (quedan <= 0) enCursoPorCompania.delete(companyId);
    else enCursoPorCompania.set(companyId, quedan);
}

/**
 * Cuantas cosas hay corriendo ahora mismo. Para ops y, sobre todo, para poder
 * PROBAR que algo se ejecuta dentro del cupo y no fuera: sin esto, "la llamada
 * al LLM cuenta para el cupo" solo se puede comprobar leyendo el codigo, y eso
 * no es una prueba.
 */
const enCurso_ = () => enCurso;

module.exports = { tomarLugar, soltarLugar, ocuparLugar, enCurso: enCurso_,
                   MAX_A_LA_VEZ, MAX_POR_COMPANIA };
