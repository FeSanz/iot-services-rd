require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;

/*app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'DELETE', 'PUT', 'OPTIONS'],
    allowedHeaders: ['Content-Type']
}));

app.options('*', cors());
app.use(express.json());*/

app.use(cors({
    origin: ['http://localhost:8100', 'http://localhost:8101', 'https://mes-r495.onrender.com'],
    credentials: true
}));

app.use(cors());
app.use(express.json());

app.use('/api', require('./services/iot/auth'));
app.use('/api', require('./services/iot/users'));

app.use('/api', require('./services/iot/machines'));
app.use('/api', require('./services/iot/sensor_data'));
app.use('/api', require('./services/iot/sensors'));

app.use('/api', require('./services/iot/alerts'));
app.use('/api', require('./services/iot/failtures'));
app.use('/api', require('./services/iot/notifications'));

app.use('/api', require('./services/iot/dashboards'));
app.use('/api', require('./services/iot/dashboardGroups'));

app.use('/api', require('./services/fusion/integrations'));
app.use('/api', require('./services/fusion/organizations'));
app.use('/api', require('./services/fusion/resources'));
app.use('/api', require('./services/fusion/items'));
app.use('/api', require('./services/fusion/shifts'));
app.use('/api', require('./services/fusion/work_orders'));
app.use('/api', require('./services/fusion/companies.js'));

app.use('/api', require('./services/fusion/work_execution'));
app.use('/api', require('./services/fusion/dispatch_orders') );

const { initWebSocket } = require('./services/websocket/websocket');

app.get('/', (req, res) => {
    res.send('Condor MES IIoT Services ');
});

const server = app.listen(port, () => {
    console.log(`Servidor corriendo en puerto ${port}`);
});

initWebSocket(server);
