require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors({
    origin: ['http://localhost:8100', 'http://localhost:4200', 'http://localhost:3000'], // Agrega todos tus puertos de desarrollo
    methods: ['GET', 'POST', 'DELETE', 'PUT', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.options('*', cors()); // Para manejar preflight requests
app.use(express.json());

//app.use(cors());
//app.use(express.json());

app.use('/api', require('./services/fusion/organizations'));

app.get('/', (req, res) => {
    res.send('Condor MES IIoT Services ');
});

app.listen(port, () => {
    console.log(`Servidor corriendo en puerto ${port}`);
});
