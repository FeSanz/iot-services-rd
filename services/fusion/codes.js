const express = require('express');
const router = express.Router();
const pool = require('../../database/pool');
const {selectFromDB, selectByParamsFromDB} = require("../../models/sql-execute");
const authenticateToken = require('../../middleware/authenticateToken');

//Obtener todas los registros
router.get('/codes', authenticateToken, async (req, res) => {

    const sqlQuery = `SELECT COD.ID AS "Id", COD.CODE AS "Code", COM.NAME AS "Company", COD.ENABLED_FLAG AS "EnabledFlag",
                                    COD.USED_DATE AS "UsedDate", COD.CREATED_DATE AS "CreatedDate"
                             FROM MES_VERIFICATION_CODES COD
							 LEFT JOIN MES_COMPANIES COM
							 ON COD.COMPANY_ID = COM.COMPANY_ID
                             ORDER BY CODE ASC`;

    const result = await selectFromDB(sqlQuery);
    const statusCode = result.errorsExistFlag ? 500 : 200;
    res.status(statusCode).json(result);
});


//validar si existe código
router.get('/codes/:code', authenticateToken, async (req, res) => {    
    const Code = req.params.code;    

    const checkResult = await pool.query(`SELECT code as num FROM MES_VERIFICATION_CODES WHERE code = $1`, [Code]);                          

    if (checkResult.rows.length === 0) {
        return res.status(200).json({
            errorsExistFlag: true,
            message: 'Registro no encontrado',
            totalResults: 0
        });
    }
        
    const statusCode = checkResult.errorsExistFlag ? 500 : 200;
    res.status(statusCode).json(checkResult);
});

router.get('/verifyCode/:code', authenticateToken, async (req, res) => {    
    const Code = req.params.code;    

    const checkResult = await pool.query(`SELECT code as num FROM MES_VERIFICATION_CODES WHERE code = $1 and enabled_flag = 'Y'`, [Code]);                          

    if (checkResult.rows.length === 0) {
        return res.status(200).json({
            errorsExistFlag: true,
            message: 'Registro no encontrado',
            totalResults: 0
        });
    }
        
    const statusCode = checkResult.errorsExistFlag ? 500 : 200;
    res.status(statusCode).json(checkResult);
});

//Insertar multiples datos
router.post('/codes', authenticateToken, async (req, res) => {
    try {        
        const payload = req.body.items;

        if (!payload || payload.length === 0) {
            return res.status(400).json({
                errorsExistFlag: true,
                message: 'No se proporcionaron datos',
                totalResults: 0
            });
        }

        // Obtener códigos recibidos
        const codesReceived = payload.map((element) => element.Code);
        
        // Verificar códigos existentes - CORREGIDO
        const placeholdersCodes = codesReceived.map((_, index) => `$${index + 1}`).join(',');
        const codesExistResult = await pool.query(
            `SELECT CODE FROM MES_VERIFICATION_CODES WHERE CODE IN (${placeholdersCodes})`,
            codesReceived
        );
        
        const codesExisting = new Set(codesExistResult.rows.map(row => row.code)); // 'code' en minúsculas

        // Filtrar códigos nuevos
        const codesNew = payload.filter(element => !codesExisting.has(element.Code));

        if (codesNew.length === 0) {
            return res.status(200).json({
                errorsExistFlag: false,
                message: 'Todos los códigos proporcionados ya existen',
                totalResults: 0
            });
        }
        
        const values = [];
        const placeholders = codesNew.map((element, index) => {
            const base = index * 3;
            values.push(element.Code, 'Y', null);
            return `($${base + 1}, $${base + 2}, $${base + 3}, CURRENT_TIMESTAMP)`;
        }).join(', ');

        await pool.query(`
            INSERT INTO MES_VERIFICATION_CODES (CODE, ENABLED_FLAG, USED_DATE, CREATED_DATE)
            VALUES ${placeholders}
        `, values);

        res.status(201).json({
            errorsExistFlag: false,
            message: `Registrado exitosamente [${codesNew.length}]`,
            totalResults: codesNew.length,
        });

    } catch (error) {
        console.error('Error al insertar dato:', error);
        res.status(500).json({
            errorsExistFlag: true,
            message: 'Error al insertar dato: ' + error.message,
            totalResults: 0
        });
    }
});


//deshabilitar código
router.put('/codes/:code', authenticateToken, async (req, res) => {
    const Code = req.params.code;
    try {     
        // Preparar actualización              

        await pool.query(`
            UPDATE MES_VERIFICATION_CODES SET used_date = CURRENT_TIMESTAMP, enabled_flag = $2
            WHERE code = $1`,[Code, 'N']
        );

        res.status(201).json({
            errorsExistFlag: false,
            message: `Código actualizado exitosamente`,
            totalResults: 0,
        });

    } catch (error) {
        console.error('Error al actualizar datos:', error);
        res.status(500).json({
            errorsExistFlag: true,
            message: 'Error al actualizar datos: ' + error.message,
            totalResults: 0
        });
    }
});

//Asignar compañía que usó el código 
router.put('/codes/:code/:companyId', authenticateToken, async (req, res) => {
    const Code = req.params.code;
    const CompanyId = req.params.companyId;

    try {       

        // Preparar actualización              

        await pool.query(`
            UPDATE MES_VERIFICATION_CODES SET company_id = $2
            WHERE code = $1`,[Code, CompanyId]
        );

        res.status(201).json({
            errorsExistFlag: false,
            message: `Código actualizado exitosamente`,
            totalResults: 0,
        });

    } catch (error) {
        console.error('Error al actualizar datos:', error);
        res.status(500).json({
            errorsExistFlag: true,
            message: 'Error al actualizar datos: ' + error.message,
            totalResults: 0
        });
    }
});


//Eliminar múltiples registros
router.delete('/codes', authenticateToken, async (req, res) => {
    try {
        const codesId = req.body.items.map(item => item.Id);
        const placeholders = codesId.map((_, index) => `$${index + 1}`).join(', ');

        // Verificar si el registro existe
        const checkResult = await pool.query(`SELECT ID FROM MES_VERIFICATION_CODES WHERE ID in (${placeholders})`, codesId);

        if (checkResult.rows.length === 0) {
            return res.status(404).json({
                errorsExistFlag: true,
                message: 'Registros no encontrados',
                totalResults: 0
            });
        }
        
        await pool.query(`DELETE FROM MES_VERIFICATION_CODES WHERE ID in (${placeholders})`, codesId);

        res.json({
            errorsExistFlag: false,
            message: 'Eliminación exitosa',
            totalResults: 0
        });

    } catch (error) {
        console.error('Error al eliminar : ', error);

        // Manejar error de constraint de foreign key
        if (error.code === '23503') {
            return res.status(409).json({
                errorsExistFlag: true,
                message: 'No se puede eliminar porque está siendo utilizado por otros registros',
                totalResults: 0
            });
        }

        res.status(500).json({
            errorsExistFlag: true,
            message: 'Error al eliminar: ' + error.message,
            totalResults: 0
        });
    }
});


//Exportar el router
module.exports = router;