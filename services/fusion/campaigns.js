const express = require('express');
const router = express.Router();
const authenticateToken = require('../../middleware/authenticateToken');
const pool = require('../../database/pool');


// 📌 Listar campañas filtradas por organization_id
router.get('/campaigns/:organization_id', authenticateToken, async (req, res) => {
    const { organization_id } = req.params;

    try {
        const result = await pool.query(
            `SELECT c.*,
                    COALESCE(COUNT(w.work_order_id), 0) AS coils
             FROM mes_campaign c
             LEFT JOIN mes_work_orders w ON w.campaign_id = c.campaign_id
             WHERE c.organization_id = $1
             GROUP BY c.campaign_id
             ORDER BY c.last_update DESC`,
            [organization_id]
        );

        res.json({ items: result.rows });
    } catch (error) {
        console.error('Error al obtener campañas:', error);
        res.status(500).json({ error: 'Error al obtener campañas' });
    }
});

// 📌 Devuelve la campaña especificada
router.get('/campaign/:campaign_id', authenticateToken, async (req, res) => {
    const { campaign_id } = req.params;

    try {
        // 1. Obtener la campaña con el conteo de órdenes
        const campaignResult = await pool.query(
            `SELECT c.*, 
                    COALESCE(COUNT(w.work_order_id), 0) AS coils
             FROM mes_campaign c
             LEFT JOIN mes_work_orders w ON w.campaign_id = c.campaign_id
             WHERE c.campaign_id = $1
             GROUP BY c.campaign_id`,
            [campaign_id]
        );

        if (campaignResult.rows.length === 0) {
            return res.status(404).json({ error: 'Campaña no encontrada' });
        }

        const campaign = campaignResult.rows[0];

        // 2. Obtener órdenes relacionadas con info de items y machines
        const workOrdersResult = await pool.query(
            `SELECT w.work_order_id,
                    w.organization_id,
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
             WHERE w.campaign_id = $1
             ORDER BY w.sequence ASC`,
            [campaign_id]
        );

        // si no hay órdenes, retorna []
        campaign.work_orders = workOrdersResult.rows || [];

        res.json(campaign);
    } catch (error) {
        console.error('Error al obtener campaña:', error);
        res.status(500).json({ error: 'Error al obtener campaña' });
    }
});


// 📌 Crear campaña
router.post('/campaigns', authenticateToken, async (req, res) => {
    const { organization_id, code, name, description, start_date, end_date, status_telegram, enabled_flag } = req.body;
    const client = await pool.connect();

    if (!organization_id) {
        return res.status(400).json({ error: 'organization_id es requerido' });
    }

    try {
        const result = await client.query(
            `INSERT INTO mes_campaign 
             (organization_id, code, name, description, start_date, end_date, last_update, status_telegram, enabled_flag)
             VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7, $8)
             RETURNING campaign_id`,
            [organization_id, code, name, description, start_date, end_date, status_telegram, enabled_flag || 'Y']
        );

        res.status(201).json({
            errorsExistFlag: false,
            message: 'OK',
            campaign_id: result.rows[0].campaign_id
        });

    } catch (error) {
        console.error('Error al crear campaña:', error);
        res.status(500).json({ error: 'Error al crear campaña' });
    } finally {
        client.release();
    }
});

// 📌 Actualizar campaña
router.put('/campaigns/:id', authenticateToken, async (req, res) => {
    const { id } = req.params;
    const { code, name, description, start_date, started_date, end_date, status_telegram, enabled_flag } = req.body;

    try {
        const result = await pool.query(
            `UPDATE mes_campaign
             SET code = $1, name = $2, description = $3, start_date = $4, started_date = $5, end_date = $6,
                 last_update = NOW(), status_telegram = $7, enabled_flag = $8
             WHERE campaign_id = $9
             RETURNING campaign_id`,
            [code, name, description, start_date, started_date, end_date, status_telegram, enabled_flag, id]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Campaña no encontrada' });
        }

        res.json({ message: 'Campaña actualizada', campaign_id: result.rows[0].campaign_id });
    } catch (error) {
        console.error('Error al actualizar campaña:', error);
        res.status(500).json({ error: 'Error al actualizar campaña' });
    }
});

// 📌 Eliminar campaña
router.delete('/campaigns/:id', authenticateToken, async (req, res) => {
    const { id } = req.params;

    try {
        const result = await pool.query(`DELETE FROM mes_campaign WHERE campaign_id = $1`, [id]);

        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Campaña no encontrada' });
        }

        res.json({ message: 'Campaña eliminada' });
    } catch (error) {
        console.error('Error al eliminar campaña:', error);
        res.status(500).json({ error: 'Error al eliminar campaña' });
    }
});



////////////////////WORK ORDERS /////////////////////
router.get('/work-orders/without-campaign/:organization_id', authenticateToken, async (req, res) => {
    const { organization_id } = req.params;

    try {
        const result = await pool.query(
            `SELECT w.work_order_id,
                    w.organization_id,
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
               AND w.organization_id = $1
             ORDER BY w.work_order_id DESC`,
            [organization_id]
        );

        res.json({
            errorsExistFlag: false, items: result.rows
        });
    } catch (error) {
        console.error('Error al obtener órdenes sin campaña:', error);
        res.status(500).json({ error: 'Error al obtener órdenes sin campaña' });
    }
});


router.put('/work-orders/assign-campaign', authenticateToken, async (req, res) => {
    const { campaign_id, work_orders } = req.body;
    // work_orders: [{ work_order_id: 1, sequence: 10 }, { work_order_id: 2, sequence: 20 }]

    if (!campaign_id || !Array.isArray(work_orders) || work_orders.length === 0) {
        return res.status(400).json({ error: 'Campaign_id y work_orders son requeridos' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        for (const wo of work_orders) {
            if (!wo.work_order_id || wo.sequence == null) {
                await client.query('ROLLBACK');
                return res.status(400).json({ error: 'Cada work_order necesita work_order_id y sequence' });
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
            message: 'Órdenes asignadas correctamente',
            campaign_id,
            updated: work_orders.length
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error al asignar órdenes a campaña:', error);
        res.status(500).json({ error: 'Error al asignar órdenes a campaña' });
    } finally {
        client.release();
    }
});


// PUT /work-orders/update-sequence
router.put('/work-orders/update-sequence', authenticateToken, async (req, res) => {
    const { workOrders } = req.body;
    // workOrders: [{ work_order_id: 1, sequence: 10 }, { work_order_id: 2, sequence: 20 }, ...]

    if (!Array.isArray(workOrders) || workOrders.length === 0) {
        return res.status(400).json({ error: 'Debe enviar al menos un work order con su secuencia' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        for (const wo of workOrders) {
            if (!wo.work_order_id || wo.sequence == null) {
                await client.query('ROLLBACK');
                return res.status(400).json({ errorsExistFlag: false, message: 'Cada work order necesita work_order_id y sequence' });
            }
            await client.query(
                `UPDATE mes_work_orders
                 SET sequence = $1
                 WHERE work_order_id = $2`,
                [wo.sequence, wo.id]
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

module.exports = router;