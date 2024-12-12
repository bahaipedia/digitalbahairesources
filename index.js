const express = require('express');
const path = require('path');
const mysql = require('mysql2/promise');
const winston = require('winston');
const dotenv = require('dotenv');

dotenv.config();

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
app.get('/api/traffic-stats', async (req, res) => {
    const { website_id, year, month } = req.query;

    try {
        let query;
        let params;

        // Combine data for bahaiconcordance.org and bahai.quest
        if (website_id === '12') {
            query = `
                SELECT 
                    SUM(CASE WHEN day = 0 THEN unique_visitors ELSE 0 END) AS unique_visitors,
                    SUM(number_of_visits) AS total_visits,
                    SUM(pages) AS total_pages,
                    SUM(hits) AS total_hits,
                    SUM(bandwidth) AS total_bandwidth
                FROM summary
                WHERE website_id IN (12, 3) AND year = ? AND month = ?;
            `;
            params = [year, month];
        } else {
            query = `
                SELECT 
                    SUM(CASE WHEN day = 0 THEN unique_visitors ELSE 0 END) AS unique_visitors,
                    SUM(number_of_visits) AS total_visits,
                    SUM(pages) AS total_pages,
                    SUM(hits) AS total_hits,
                    SUM(bandwidth) AS total_bandwidth
                FROM summary
                WHERE website_id = ? AND year = ? AND month = ?;
            `;
            params = [website_id, year, month];
        }

        const [results] = await pool.query(query, params);
        res.json(results[0] || {});
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error fetching traffic stats.' });
    }
});

// API route to fetch "summary" stats dynamically
app.get('/api/traffic-stats', async (req, res) => {
    const { website_id, server_id, year, month } = req.query;

    try {
        const query = `
            SELECT 
                SUM(CASE WHEN day = 0 THEN unique_visitors ELSE 0 END) AS unique_visitors,
                SUM(number_of_visits) AS total_visits,
                SUM(pages) AS total_pages,
                SUM(hits) AS total_hits,
                SUM(bandwidth) AS total_bandwidth
            FROM summary
            WHERE 
                (? IS NULL OR website_id = ?) AND 
                (? IS NULL OR server_id = ?) AND 
                year = ? AND 
                month = ?;
        `;

        const [results] = await pool.query(query, [
            website_id === 'null' ? null : website_id, 
            website_id === 'null' ? null : website_id,
            server_id === 'null' ? null : server_id, 
            server_id === 'null' ? null : server_id,
            year, month
        ]);

        res.json(results[0] || {});
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error fetching traffic stats.' });
    }
});

// API route to fetch filtered "monthly traffic" stats
app.get('/api/monthly-history', async (req, res) => {
    const { website_id, server_id, year } = req.query;

    try {
        const query = `
            SELECT 
                month,
                COALESCE(SUM(CASE WHEN day = 0 THEN unique_visitors ELSE 0 END), 0) AS unique_visitors,
                COALESCE(SUM(number_of_visits), 0) AS total_visits,
                COALESCE(SUM(pages), 0) AS total_pages,
                COALESCE(SUM(hits), 0) AS total_hits,
                COALESCE(SUM(bandwidth), 0) AS total_bandwidth
            FROM summary
            WHERE 
                (? IS NULL OR website_id = ?) AND 
                (? IS NULL OR server_id = ?) AND
                year = ?
            GROUP BY month
            ORDER BY month;
        `;

        const [monthlyResults] = await pool.query(query, [
            website_id === 'null' ? null : website_id, 
            website_id === 'null' ? null : website_id,
            server_id === 'null' ? null : server_id, 
            server_id === 'null' ? null : server_id,
            year
        ]);

        // Ensure all values are properly summed without null or invalid data
        const totals = monthlyResults.reduce(
            (acc, row) => {
                acc.unique_visitors += Number(row.unique_visitors) || 0;
                acc.total_visits += Number(row.total_visits) || 0;
                acc.total_pages += Number(row.total_pages) || 0;
                acc.total_hits += Number(row.total_hits) || 0;
                acc.total_bandwidth += Number(row.total_bandwidth) || 0;
                return acc;
            },
            { unique_visitors: 0, total_visits: 0, total_pages: 0, total_hits: 0, total_bandwidth: 0 }
        );

        res.json({ monthly: monthlyResults, totals });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error fetching monthly history.' });
    }
});

app.listen(PORT, () => {
    console.log(`Primary site running at http://localhost:${PORT}`);
});
