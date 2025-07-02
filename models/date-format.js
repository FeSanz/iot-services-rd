
// Convierte una fecha en formato ISO 8601 a timestamp de PostgreSQL
const ISOToTimestamp = (isoString) => {
    if (!isoString || isoString.trim() === '') return null;
    const date = new Date(isoString);
    return date.toISOString().replace('T', ' ').substring(0, 19);
};

// Convierte una fecha de PostgreSQL a formato ISO
const TimestampToISO = (pgTimestamp) => {
    if (!pgTimestamp) return null;
    const date = new Date(pgTimestamp);
    return date.toISOString();
};

//Obtiene la fecha actual en formato PostgreSQL
const CurrentTimestamp = () => {
    const now = new Date();
    return now.toISOString().replace('T', ' ').substring(0, 19);
};

//Valida si una fecha está en formato ISO válido
const IsValidISODate = (isoString) => {
    if (!isoString) return false;
    const date = new Date(isoString);
    return !isNaN(date.getTime());
};

module.exports = {
    ISOToTimestamp,
    TimestampToISO,
    CurrentTimestamp,
    IsValidISODate
};