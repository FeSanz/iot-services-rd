const express = require('express');
const router = express.Router();
const authenticateToken = require('../../middleware/authenticateToken');
const pool = require('../../database/pool');

// 📌 Devuelve la campaña especificada
router.get('/campaign/:campaign_id', authenticateToken, async (req, res) => {
    const { campaign_id } = req.params;

    try {
        // 1. Obtener la campaña con el conteo de órdenes
        const campaignResult = await pool.query(
            `SELECT c.*, 
                    COALESCE(COUNT(w.work_order_id), 0) AS coils
             FROM mes_campaigns c
             LEFT JOIN mes_work_orders w ON w.campaign_id = c.campaign_id
             WHERE c.campaign_id = $1
             GROUP BY c.campaign_id`,
            [campaign_id]
        );

        if (campaignResult.rows.length === 0) {
            return res.status(404).json({ errorsExistFlag: true, message: 'Campaña no encontrada' });
        }

        const campaign = campaignResult.rows[0];

        // 2. Obtener órdenes relacionadas con info de items y machines
        const workOrdersResult = await pool.query(
            `SELECT w.work_order_id,
                    w.organization_id,
                    w.machine_id,
                    w.lot_number as selectedlot,
                    m.name AS machine_name,
                    w.item_id,
                    i.number AS item_number,
                    i.description AS item_description,
                    i.uom,
                    w.work_definition_id,
                    w.sequence,
                    w.work_order_number,
                    w.planned_quantity,
                    w.completed_quantity,
                    w.status,
                    w.start_date,
                    w.end_date,
                    w.type
             FROM mes_work_orders w
             LEFT JOIN mes_items i ON w.item_id = i.item_id
             LEFT JOIN mes_machines m ON w.machine_id = m.machine_id
             WHERE w.campaign_id = $1
             ORDER BY w.sequence`,
            [campaign_id]
        );

        // si no hay órdenes, retorna []
        campaign.work_orders = workOrdersResult.rows || [];

        res.json(campaign);
    } catch (error) {
        console.error('Error al obtener campaña:', error);
        res.status(404).json({ errorsExistFlag: true, message: 'Error al obtener campaña' });
    }
});


// 📌 Listar campañas filtradas por organization_id
router.get('/campaigns/:work_center_id', authenticateToken, async (req, res) => {

    const { work_center_id } = req.params;
    if (!work_center_id) {
        return res.status(404).json({ errorsExistFlag: true, message: 'Falta el parámetro work_center_id' });
    }
    try {
        const result = await pool.query(
            `SELECT c.*,
                    COALESCE(COUNT(w.work_order_id), 0) AS coils
             FROM mes_campaigns c
             LEFT JOIN mes_work_orders w ON w.campaign_id = c.campaign_id
             WHERE c.work_center_id = $1
             GROUP BY c.campaign_id
             ORDER BY c.last_update DESC`,
            [work_center_id]
        );

        res.json({ errorsExistFlag: false, items: result.rows });
    } catch (error) {
        console.error('Error al obtener campañas:', error);
        res.status(404).json({ errorsExistFlag: true, message: 'Error al obtener campañas' });
    }
});

// 📌 Órdenes de trabajo sin campaña por organización y centro de trabajo
router.get('/work-orders/without-campaign/:organization_id/:work_center_id', authenticateToken, async (req, res) => {
    const { organization_id, work_center_id } = req.params;

    if (!organization_id || !work_center_id) {
        return res.status(404).json({ errorsExistFlag: true, message: 'Faltan parámetros: organization_id y work_center_id' });
    }

    try {
        const result = await pool.query(
            `SELECT w.work_order_id,
                    w.organization_id,
                    w.machine_id,
                    m.name AS machine_name,
                    m.work_center_id,
                    w.item_id,
                    i.number AS item_number,
                    i.description AS item_description,
                    i.uom,
                    w.work_definition_id,
                    w.sequence,
                    w.work_order_number,
                    w.planned_quantity,
                    w.completed_quantity,
                    w.status,
                    w.start_date,
                    w.end_date,
                    w.type
             FROM mes_work_orders w
             INNER JOIN mes_machines m ON w.machine_id = m.machine_id
             INNER JOIN mes_work_centers wc ON m.work_center_id = wc.work_center_id
             LEFT JOIN mes_items i ON w.item_id = i.item_id
             WHERE w.campaign_id IS NULL
               AND w.organization_id = $1
               AND wc.work_center_id = $2
               AND w.status = 'UNRELEASED'
             ORDER BY w.work_order_id DESC`,
            [organization_id, work_center_id]
        );

        res.json({
            errorsExistFlag: false,
            items: result.rows
        });
    } catch (error) {
        console.error('Error al obtener órdenes sin campaña:', error);
        res.status(404).json({ errorsExistFlag: true, message: 'Error al obtener órdenes sin campaña' });
    }
});


// 📌 Crear campaña
router.post('/campaigns', authenticateToken, async (req, res) => {
    const { code, name, description, start_date, end_date, work_center_id, organization_id, status_telegram } = req.body;    
    const client = await pool.connect();

    if (!organization_id) {
        return res.status(400).json({ errorsExistFlag: true, message: 'organization_id es requerido' });
    }

    try {
        const result = await client.query(
            `INSERT INTO mes_campaigns 
             (organization_id, code, name, description, start_date, end_date, work_center_id, status_telegram)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             RETURNING campaign_id`,
            [organization_id, code, name, description, start_date, end_date, work_center_id, status_telegram]
        );

        res.status(201).json({
            errorsExistFlag: false,
            message: 'OK',
            campaign_id: result.rows[0].campaign_id
        });

    } catch (error) {
        console.error('Error al crear campaña:', error);
        res.status(404).json({ errorsExistFlag: true, message: 'Error al crear campaña' });
    } finally {
        client.release();
    }
});

// 📌 Actualizar campaña
router.put('/campaigns/:id', authenticateToken, async (req, res) => {
    const { id } = req.params;
    const { code, name, description, start_date, started_date, end_date } = req.body;

    try {
        const result = await pool.query(
            `UPDATE mes_campaigns
             SET code = $1, name = $2, description = $3, start_date = $4, started_date = $5, end_date = $6
             WHERE campaign_id = $7
             RETURNING campaign_id`,
            [code, name, description, start_date, started_date, end_date, id]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ errorsExistFlag: true, message: 'Campaña no encontrada' });
        }

        res.json({ errorsExistFlag: false, message: 'OK', campaign_id: result.rows[0].campaign_id });
    } catch (error) {
        console.error('Error al actualizar campaña:', error);
        res.status(404).json({ errorsExistFlag: true, message: 'Error al actualizar campaña' });
    }
});

// 📌 Eliminar campaña
router.delete('/campaigns/:id', authenticateToken, async (req, res) => {
    const { id } = req.params;

    try {
        const result = await pool.query(`DELETE FROM mes_campaigns WHERE campaign_id = $1`, [id]);

        if (result.rowCount === 0) {
            return res.status(404).json({ errorsExistFlag: true, message: 'Campaña no encontrada' });
        }

        res.json({ errorsExistFlag: false, message: 'Ok' });
    } catch (error) {
        console.error('Error al eliminar campaña:', error);
        res.status(404).json({ errorsExistFlag: true, message: 'Error al eliminar campaña' });
    }
});



////////////////////WORK ORDERS /////////////////////
router.get('/work-orders/without-campaign/:work_center_id', authenticateToken, async (req, res) => {
    const { work_center_id } = req.params;

    try {
        const result = await pool.query(
            `SELECT w.work_order_id,
                    w.organization_id,
                    w.work_center_id,
                    w.machine_id,
                    m.name AS machine_name,
                    w.item_id,
                    i.number AS item_number,
                    i.description AS item_description,
                    i.uom,
                    w.work_definition_id,
                    w.sequence,
                    w.work_order_number,
                    w.planned_quantity,
                    w.completed_quantity,
                    w.status,
                    w.start_date,
                    w.end_date,
                    w.type
             FROM mes_work_orders w
             LEFT JOIN mes_items i ON w.item_id = i.item_id
             LEFT JOIN mes_machines m ON w.machine_id = m.machine_id
             WHERE w.campaign_id IS NULL
               AND w.work_center_id = $1
               AND w.status = 'UNRELEASED'
             ORDER BY w.work_order_id DESC`,
            [work_center_id]
        );

        res.json({
            errorsExistFlag: false,
            items: result.rows
        });
    } catch (error) {
        console.error('Error al obtener órdenes sin campaña:', error);
        return res.status(404).json({ errorsExistFlag: true, message: 'Error al obtener órdenes sin campaña' });
    }
});

// 📌 Actualiza el lot_number de una work order
router.put('/work-orders/update-lot/:work_order_id', authenticateToken, async (req, res) => {
    const { work_order_id } = req.params;
    const { lot_number } = req.body;
    if (!lot_number) {
        return res.status(404).json({ errorsExistFlag: true, message: 'Debe proporcionar lot_number' });
    }

    const client = await pool.connect();
    try {
        const result = await client.query(
            `UPDATE mes_work_orders
             SET lot_number = $1
             WHERE work_order_id = $2
             RETURNING work_order_id, lot_number`,
            [lot_number, work_order_id]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ errorsExistFlag: true, message: 'Work order no encontrada' });
        }

        res.json({
            errorsExistFlag: false,
            message: 'Lot actualizado correctamente',
            item: result.rows[0]
        });
    } catch (error) {
        console.error('Error al actualizar lot_number:', error);
        res.status(404).json({ errorsExistFlag: true, message: 'Error al actualizar lot_number' });
    } finally {
        client.release();
    }
});


router.put('/work-orders/assign-campaign', authenticateToken, async (req, res) => {
    const { campaign_id, work_orders } = req.body;
    // work_orders: [{ work_order_id: 1, sequence: 10 }, { work_order_id: 2, sequence: 20 }]

    if (!campaign_id || !Array.isArray(work_orders) || work_orders.length === 0) {
        return res.status(404).json({ errorsExistFlag: true, message: 'Campaign_id y work_orders son requeridos' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        for (const wo of work_orders) {
            if (!wo.work_order_id || wo.sequence == null) {
                await client.query('ROLLBACK');
                return res.status(400).json({ errorsExistFlag: false, message: 'Cada work_order necesita work_order_id y sequence' });
            }

            await client.query(
                `UPDATE mes_work_orders
                 SET campaign_id = $1, sequence = $2
                 WHERE work_order_id = $3`,
                [campaign_id, wo.sequence, wo.work_order_id]
            );
        }

        await client.query('COMMIT');

        res.json({
            errorsExistFlag: false,
            message: 'Ok',
            campaign_id,
            updated: work_orders.length
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error al asignar órdenes a campaña:', error);
        res.status(404).json({ errorsExistFlag: true, message: 'Error al asignar órdenes a campaña' });
    } finally {
        client.release();
    }
});

// PUT /work-orders/update-sequence
router.put('/work-orders/update-sequence', authenticateToken, async (req, res) => {
    const { workOrders } = req.body;
    if (!Array.isArray(workOrders) || workOrders.length === 0) {
        return res.status(404).json({ errorsExistFlag: true, message: 'Debe enviar al menos un work order con su secuencia' });
    }
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        for (const wo of workOrders) {
            if (!wo.work_order_id || wo.sequence == null) {
                await client.query('ROLLBACK');
                return res.status(400).json({ errorsExistFlag: true, message: 'Cada work order necesita work_order_id y sequence' });
            }
            await client.query(
                `UPDATE mes_work_orders
                 SET sequence = $1
                 WHERE work_order_id = $2`,
                [wo.sequence, wo.work_order_id]
            );
        }
        await client.query('COMMIT');
        res.json({
            errorsExistFlag: true,
            message: 'Ok',
            updated: workOrders.length
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error al actualizar secuencias:', error);
        res.status(500).json({
            errorsExistFlag: true, message: 'Error al actualizar secuencias de work orders'
        });
    } finally {
        client.release();
    }
});
// Quitar campaña y secuencia de una orden
router.delete('/work-orders/unassign/:ids', authenticateToken, async (req, res) => {
    const { ids } = req.params;

    if (!ids) {
        return res.status(400).json({ errorsExistFlag: true, message: 'Debe enviar al menos un work_order_id' });
    }

    // Convertir la cadena "41,43,44" en un array de números
    const work_order_ids = ids.split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id));

    if (work_order_ids.length === 0) {
        return res.status(400).json({ errorsExistFlag: true, message: 'No se encontraron IDs válidos' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const result = await client.query(
            `UPDATE mes_work_orders
             SET campaign_id = NULL, lot_number = NULL, sequence = NULL
             WHERE work_order_id = ANY($1::bigint[])
             RETURNING work_order_id`,
            [work_order_ids]
        );

        await client.query('COMMIT');

        if (result.rowCount === 0) {
            return res.status(404).json({ errorsExistFlag: true, message: 'Ninguna work order fue encontrada' });
        }

        res.json({
            errorsExistFlag: false,
            message: 'OK',
            work_order_ids: result.rows.map(r => r.work_order_id)
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error al desasignar órdenes:', error);
        res.status(404).json({ errorsExistFlag: true, message: 'Error al desasignar órdenes' });
    } finally {
        client.release();
    }
});


module.exports = router;