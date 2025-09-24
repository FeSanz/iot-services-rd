const pool = require("../database/pool");

async function selectFromDB(sqlQuery) {
    try {
        const result = await pool.query(sqlQuery);

        return {
                errorsExistFlag: false,
                message: 'OK',
                totalResults: result.rows.length,
                items: result.rows
        };
    } catch (error) {
        console.error('Error al obtener datos: ', error);

        return {
                errorsExistFlag: true,
                message: 'Error al obtener datos: ' + error.message,
                totalResults: 0,
                items: null
        };
    }
}

async function selectByParamsFromDB(sqlQuery, params = []) {
    try {
        const result = await pool.query(sqlQuery, params);

        if (result.rows.length === 0) {
            return {
                    errorsExistFlag: false,
                    message: 'Registros no encontrados en MES',
                    totalResults: 0,
                    items: null
            };
        }

        return {
                errorsExistFlag: false,
                message: 'OK',
                totalResults: result.rows.length,
                items: result.rows
        };
    } catch (error) {
        console.error('Error al obtener datos: ', error);

        return {
                errorsExistFlag: true,
                message: 'Error al obtener datos: ' + error.message,
                totalResults: 0,
                items: null
        };
    }
}

module.exports = { selectFromDB,  selectByParamsFromDB };