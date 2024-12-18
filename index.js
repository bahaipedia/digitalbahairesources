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
app.use('/js', express.static(path.join(__dirname, 'node_modules/chart.js/dist')));
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
        // Fetch websites, excluding legacy/defunct sites, and ordering them
        const [websites] = await pool.query(`
            SELECT id, name
            FROM websites
            WHERE name NOT IN ('fr.bahai.works', 'bahaiconcordance.org') -- Exclude legacy/defunct sites
            ORDER BY 
                (FIELD(name, 'bahaipedia.org', 'bahai.works', 'bahai.media', 'bahai9.com', 'bahai.quest') > 0) DESC,
                FIELD(name, 'bahaipedia.org', 'bahai.works', 'bahai.media', 'bahai9.com', 'bahai.quest'),
                name ASC;
        `);
        const [servers] = await pool.query('SELECT id, location FROM servers ORDER BY location');
        
        // Map server names with transformations and custom ordering
        const serverNameMapping = {
            usa: 'United States',
            singapore: 'Singapore',
            frankfurt: 'Frankfurt',
            saopaulo: 'São Paulo'
        };
        const transformedServers = servers
            .map(server => ({
                id: server.id,
                location: serverNameMapping[server.location.toLowerCase()] || server.location
            }))
            .sort((a, b) => {
                const customOrder = ['United States', 'Singapore', 'Frankfurt', 'São Paulo'];
                return customOrder.indexOf(a.location) - customOrder.indexOf(b.location);
            });
        
        // For years and months, you might do something like:
        const [yearResults] = await pool.query('SELECT DISTINCT year FROM summary ORDER BY year');
        const years = yearResults.map(row => row.year);

        const [monthResults] = await pool.query('SELECT DISTINCT month FROM summary ORDER BY month');
        const months = monthResults.map(row => row.month);

        // Render the stats page
        res.render('traffic-stats', {
            websites: websites,
            servers: transformedServers,
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

// API route to fetch "daily history" stats dynamically
app.get('/api/daily-history', async (req, res) => {
    const { website_id, server_id, year, month } = req.query;

    try {
        const query = `
            SELECT 
                day,
                COALESCE(SUM(number_of_visits), 0) AS number_of_visits,
                COALESCE(SUM(pages), 0) AS pages,
                COALESCE(SUM(hits), 0) AS hits,
                COALESCE(SUM(bandwidth), 0) AS bandwidth
            FROM summary
            WHERE 
                day > 0 AND -- Exclude day 0
                (? IS NULL OR website_id = ?) AND 
                (? IS NULL OR server_id = ?) AND
                year = ? AND 
                month = ?
            GROUP BY day
            ORDER BY day;
        `;

        const totalsQuery = `
            SELECT 
                COALESCE(SUM(number_of_visits), 0) AS number_of_visits,
                COALESCE(SUM(pages), 0) AS pages,
                COALESCE(SUM(hits), 0) AS hits,
                COALESCE(SUM(bandwidth), 0) AS bandwidth
            FROM summary
            WHERE 
                day > 0 AND -- Exclude day 0
                (? IS NULL OR website_id = ?) AND 
                (? IS NULL OR server_id = ?) AND
                year = ? AND 
                month = ?;
        `;

        const [dailyResults] = await pool.query(query, [
            website_id === 'null' ? null : website_id, 
            website_id === 'null' ? null : website_id,
            server_id === 'null' ? null : server_id, 
            server_id === 'null' ? null : server_id,
            year, month
        ]);

        const [totalsResult] = await pool.query(totalsQuery, [
            website_id === 'null' ? null : website_id, 
            website_id === 'null' ? null : website_id,
            server_id === 'null' ? null : server_id, 
            server_id === 'null' ? null : server_id,
            year, month
        ]);

        const totals = totalsResult[0] || {
            number_of_visits: 0,
            pages: 0,
            hits: 0,
            bandwidth: 0
        };

        res.json({ daily: dailyResults, totals });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error fetching daily history.' });
    }
});

// API route to build "charts" in the summary stats area
app.get('/api/chart-data', async (req, res) => {
    const { metric } = req.query;

    try {
        const websiteQuery = `
            SELECT 
                name AS label, 
                COALESCE(SUM(
                    CASE 
                        WHEN day = 0 AND ? = 'unique_visitors' THEN ${metric}
                        WHEN day > 0 AND ? != 'unique_visitors' THEN ${metric}
                        ELSE 0
                    END
                ), 0) AS value
            FROM summary
            JOIN websites ON summary.website_id = websites.id
            GROUP BY name
            ORDER BY value DESC;
        `;

        const serverQuery = `
            SELECT 
                location AS label, 
                COALESCE(SUM(
                    CASE 
                        WHEN day = 0 AND ? = 'unique_visitors' THEN ${metric}
                        WHEN day > 0 AND ? != 'unique_visitors' THEN ${metric}
                        ELSE 0
                    END
                ), 0) AS value
            FROM summary
            JOIN servers ON summary.server_id = servers.id
            GROUP BY location
            ORDER BY value DESC;
        `;

        const [allWebsiteData] = await pool.query(websiteQuery, [metric, metric]);
        const [serverData] = await pool.query(serverQuery, [metric, metric]);

        // Sort and calculate top 5 + "Other"
        const sortedWebsiteData = allWebsiteData.sort((a, b) => b.value - a.value);
        const topFive = sortedWebsiteData.slice(0, 5);
        const otherTotal = sortedWebsiteData.slice(5).reduce((acc, row) => acc + (Number(row.value) || 0), 0);

        if (otherTotal > 0) {
            topFive.push({ label: 'Other', value: otherTotal });
        }

        res.json({
            website: topFive,
            server: serverData
        });
    } catch (err) {
        console.error('Error fetching chart data:', err);
        res.status(500).send('Server Error');
    }
});

/* Route to build traffic-stats/urls page and get top 10 urls */
app.get('/traffic-stats/urls', async (req, res) => {
    try {
        // Fetch websites and servers for dropdowns
        const [websites] = await pool.query(`
            SELECT id, name
            FROM websites
            WHERE name NOT IN ('fr.bahai.works', 'bahaiconcordance.org')
            ORDER BY 
                (FIELD(name, 'bahaipedia.org', 'bahai.works', 'bahai.media', 'bahai9.com', 'bahai.quest') > 0) DESC,
                FIELD(name, 'bahaipedia.org', 'bahai.works', 'bahai.media', 'bahai9.com', 'bahai.quest'),
                name ASC;
        `);

        const [servers] = await pool.query('SELECT id, location FROM servers ORDER BY location');
        const serverNameMapping = {
            usa: 'United States',
            singapore: 'Singapore',
            frankfurt: 'Frankfurt',
            saopaulo: 'São Paulo'
        };
        const transformedServers = servers.map(server => ({
            id: server.id,
            location: serverNameMapping[server.location.toLowerCase()] || server.location
        }));

        const [yearResults] = await pool.query('SELECT DISTINCT year FROM website_url_stats ORDER BY year');
        const years = yearResults.map(row => row.year);

        const [monthResults] = await pool.query('SELECT DISTINCT month FROM website_url_stats ORDER BY month');
        const months = monthResults.map(row => row.month);

        // Render the initial page
        res.render('traffic-stats-urls', {
            websites,
            servers: transformedServers,
            years,
            months,
            selectedYear: 2024,
            selectedMonth: 11
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
});

// Serve the dynamic data for URLs
app.get('/api/traffic-stats/urls', async (req, res) => {
    try {
        const { website_id, server_id, year, month } = req.query;

        // Base query
        let query = `
            SELECT 
                ${website_id === 'null' ? 'w.name AS website_name,' : ''}
                wu.url,
                SUM(wus.hits) AS total_hits
                ${website_id !== 'null' ? ', SUM(wus.entry_count) AS total_entry, SUM(wus.exit_count) AS total_exit' : ''}
            FROM website_url_stats wus
            JOIN website_url wu ON wus.website_url_id = wu.id
            JOIN websites w ON wu.website_id = w.id
            WHERE w.name NOT IN ('fr.bahai.works', 'bahaiconcordance.org')
              AND (? IS NULL OR wu.website_id = ?)
              AND (? IS NULL OR wus.server_id = ?)
              AND wus.year = ? AND wus.month = ?
        `;

        // Add grouping and ordering
        query += `
            GROUP BY ${website_id === 'null' ? 'w.name, ' : ''}wu.url
            ORDER BY total_hits DESC
        `;

        // Add limits
        if (website_id === 'null') {
            query += ' LIMIT 25'; // Top 25 URLs for "all" websites
        } else {
            query += ' LIMIT 200'; // Top 200 URLs for a specific website
        }

        // Parameters
        const params = [
            website_id === 'null' ? null : website_id,
            website_id === 'null' ? null : website_id,
            server_id === 'null' ? null : server_id,
            server_id === 'null' ? null : server_id,
            year,
            month
        ];

        const [results] = await pool.query(query, params);
        res.json(results);
    } catch (err) {
        console.error(err);
        res.status(500).send('Error fetching URL stats.');
    }
});

// Route to render the pageview-analysis page
app.get('/pageview-analysis', async (req, res) => {
    try {
        // Fetch websites, excluding legacy/defunct sites, and ordering them
        const [websites] = await pool.query(`
            SELECT id, name
            FROM websites
            WHERE name NOT IN ('fr.bahai.works', 'bahaiconcordance.org')
            ORDER BY
                (FIELD(name, 'bahaipedia.org', 'bahai.works', 'bahai.media', 'bahai9.com', 'bahai.quest') > 0) DESC,
                FIELD(name, 'bahaipedia.org', 'bahai.works', 'bahai.media', 'bahai9.com', 'bahai.quest'),
                name ASC;
        `);

        // Set default website (e.g., bahaipedia.org)
        const defaultWebsite = websites.find(w => w.name === 'bahaipedia.org') || websites[0];

        // Prepare months and years for date selectors
        const currentDate = new Date();
        const currentYear = currentDate.getFullYear();
        const currentMonth = currentDate.getMonth() + 1;

        const months = [];
        for (let m = 1; m <= 12; m++) {
            months.push(m);
        }

        const years = [];
        for (let y = currentYear - 5; y <= currentYear; y++) {
            years.push(y);
        }

        // Render the pageview-analysis page
        res.render('pageview-analysis', {
            websites: websites,
            defaultWebsiteId: defaultWebsite.id,
            months: months,
            years: years,
            selectedFromMonth: currentMonth,
            selectedFromYear: currentYear - 1,
            selectedToMonth: currentMonth,
            selectedToYear: currentYear
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
});

// API route to fetch titles for autocomplete
app.get('/api/search-titles', async (req, res) => {
    const { term, website_id } = req.query;
    try {
        const [results] = await pool.query(`
            SELECT DISTINCT url
            FROM website_url
            WHERE website_id = ?
              AND url LIKE CONCAT('%', ?, '%')
            ORDER BY
              CASE
                WHEN url LIKE CONCAT(?, '%') THEN 0  -- Titles starting with the term
                WHEN url LIKE CONCAT('% ', ?, '%') THEN 1  -- Titles where term starts after a space
                ELSE 2  -- Other matches
              END
            LIMIT 10
        `, [website_id, term, term, term]);

        res.json(results.map(row => row.url));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error fetching titles.' });
    }
});

// API route to fetch hits data for selected titles over the past 12 months
app.get('/api/pageview-data', async (req, res) => {
    const { website_id, titles, from_year, from_month, to_year, to_month } = req.query;
    const titlesArray = titles.split(',');

    try {
        // Calculate date boundaries
        const fromDate = `${from_year}${from_month.padStart(2, '0')}`;
        const toDate = `${to_year}${to_month.padStart(2, '0')}`;

        const [results] = await pool.query(`
            SELECT wu.url, wus.year, wus.month, SUM(wus.hits) as hits
            FROM website_url_stats wus
            JOIN website_url wu ON wus.website_url_id = wu.id
            WHERE wu.website_id = ? AND wu.url IN (?)
                AND CONCAT(wus.year, LPAD(wus.month, 2, '0')) BETWEEN ? AND ?
            GROUP BY wu.url, wus.year, wus.month
            ORDER BY wu.url, wus.year, wus.month
        `, [website_id, titlesArray, fromDate, toDate]);

       results.forEach(row => {
            row.hits = Number(row.hits);
        });

        res.json(results);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error fetching hits data.' });
    }
});

app.listen(PORT, () => {
    console.log(`Primary site running at http://localhost:${PORT}`);
});
