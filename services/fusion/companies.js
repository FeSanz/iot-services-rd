const express = require('express');
const router = express.Router();
const pool = require('../../database/pool');
const authenticateToken = require('../../middleware/authenticateToken');
const { selectFromDB, selectByParamsFromDB } = require("../../models/sql-execute");

//Insertar compañía
router.post('/companies', async (req, res) => {
    const { Name, Description, EnabledFlag } = req.body;        
    try {        
        const companyExist = await pool.query('SELECT COUNT(*) AS existCompany FROM MES_COMPANIES WHERE UPPER(name) = UPPER($1)', [Name]);
        
        if (parseInt(companyExist.rows[0].existcompany) > 0 ){
            return res.status(201).json({
            errorsExistFlag: true,
            message: "Los datos proporcionados ya existen"            
        });
        }
        const result = await pool.query(
            `INSERT INTO MES_COMPANIES(company_id, name, description, enabled_flag
            ) VALUES(nextval('mes_companies_company_id_seq'), $1, $2, $3)
        RETURNING company_id `,
            [Name, Description, EnabledFlag]
        );
        res.status(201).json({
            errorsExistFlag: false,
            message: "OK",
            result: result.rows[0]
        });
    } catch (err) {
        console.error('Error al crear compañía', err);
        await pool.query(`ROLLBACK`);
        res.status(500).json({
            errorsExistFlag: true,
            message: "Error",
        });
    }
});



//Exportar el router
module.exports = router;