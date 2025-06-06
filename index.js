require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

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
    origin: ['http://localhost:8100', 'http://localhost:4200'],
    credentials: true
}));

app.use(cors());
app.use(express.json());

app.use('/api', require('./services/fusion/organizations'));

app.get('/', (req, res) => {
    res.send('Condor MES IIoT Services ');
});

app.listen(port, () => {
    console.log(`Servidor corriendo en puerto ${port}`);
});

