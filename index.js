const express = require('express');
const path = require('path');
const mysql = require('mysql2/promise');
const winston = require('winston');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3008;

// Logger setup using Winston
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.json(),
    transports: [
        new winston.transports.Console(),
        new winston.transports.File({ filename: 'combined.log' })
    ]
});

// Create a MySQL connection pool
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// Middleware
app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Routes
app.get('/', (req, res) => res.render('index'));
app.get('/about', (req, res) => res.render('about'));
app.get('/current-activity', (req, res) => res.render('current-activity'));
app.get('/contact', (req, res) => res.render('contact'));

// Route to create the traffic stats page
app.get('/traffic-stats', async (req, res) => {
    try {
        // Example pseudo-code: replace with your actual DB calls
        const [websites] = await db.query('SELECT id, name FROM websites ORDER BY name');
        const [servers] = await db.query('SELECT id, location FROM servers ORDER BY location');
        
        // For years and months, you might do something like:
        const [yearResults] = await db.query('SELECT DISTINCT year FROM summary ORDER BY year');
        const years = yearResults.map(row => row.year);

        const [monthResults] = await db.query('SELECT DISTINCT month FROM summary ORDER BY month');
        const months = monthResults.map(row => row.month);

        // Render the stats page
        res.render('traffic-stats', {
            websites: websites,
            servers: servers,
            years: years,
            months: months,
            selectedYear: 2024,   // Preselected value
            selectedMonth: 12     // Preselected value
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
});

app.listen(PORT, () => {
    console.log(`Primary site running at http://localhost:${PORT}`);
});
