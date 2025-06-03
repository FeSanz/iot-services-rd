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

app.use(cors());
app.use(express.json());

//app.use('/api', require('./services/fusion/organizations'));

/*try {
    console.log('Intentando cargar organizations router...');
    const orgsRouter = require('./services/fusion/organizations');
    console.log('Router cargado exitosamente');
    app.use('/api', orgsRouter);
    console.log('Router montado en /api');
} catch (error) {
    console.error('Error cargando organizations router:', error);
}*/

app.get('/', (req, res) => {
    res.send('Hello World');
});

app.listen(port, () => {
    console.log(`Servidor corriendo en puerto ${port}`);
});

/*const server = app.listen(port, () => {
    console.log(`API REST escuchando en http://localhost:${port}`);
});*/

