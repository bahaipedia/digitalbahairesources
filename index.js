const express = require('express');
const axios = require('axios');
const path = require('path');
const mysql = require('mysql2/promise');
const winston = require('winston');
const dotenv = require('dotenv');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { exec } = require('child_process');

// AWS SDK
const { S3Client, ListObjectsV2Command } = require("@aws-sdk/client-s3");
const { EC2Client, StartInstancesCommand, DescribeInstancesCommand } = require("@aws-sdk/client-ec2");

dotenv.config();

// Configuration
const ec2Client = new EC2Client({ region: "us-east-1" });
const G5_PRIVATE_IP = process.env.G5_PRIVATE_IP;
const G5_INSTANCE_ID = process.env.G5_INSTANCE_ID; 
const JWT_SECRET = process.env.JWT_SECRET;
const AGENT_PORT = 5000;

const app = express();
const PORT = process.env.PORT || 3008;
app.use(express.json());

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
// Dedicated pool for RAG Metadata
const metadataPool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER_META,
    password: process.env.DB_PASSWORD_META,
    database: process.env.DB_NAME_META,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// Middleware
app.use(express.static(path.join(__dirname, 'public')));
app.use('/js', express.static(path.join(__dirname, 'node_modules/chart.js/dist')));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
const authenticateExtension = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'No token provided' });

    const token = authHeader.split(' ')[1]; // Bearer <token>
    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'Invalid token' });
        req.user = user;
        next();
    });
};

// --- S3 Client & Dump Page Configuration ---
const s3Client = new S3Client({ region: "us-east-1" }); 
const S3_BUCKET = "digitalbahairesources";
const S3_BUCKET_URL_PREFIX = `https://digitalbahairesources.s3.amazonaws.com`; 

// This maps the DB name to a "pretty name" for the table
const WIKI_NAMES = {
    "enpedia": "Bahaipedia (English)",
    "depedia": "Bahaipedia (German)",
    "espedia": "Bahaipedia (Spanish)",
    "fapedia": "Bahaipedia (Persian)",
    "frpedia": "Bahaipedia (French)",
    "japedia": "Bahaipedia (Japanese)",
    "ptpedia": "Bahaipedia (Portuguese)",
    "rupedia": "Bahaipedia (Russian)",
    "vipedia": "Bahaipedia (Vietnamese)",
    "zhpedia": "Bahaipedia (Chinese)",
    "deworks": "Bahai.works (German)",
    "enworks": "Bahai.works (English)",
    "bahaimedia": "Bahai.media",
    "enbahai9": "Bahai9",
    "bahaidata": "Bahaidata",
    "bahaiquest": "Bahai.quest",
};

// Helper function to format bytes to KB/MB/GB
function formatBytes(bytes, decimals = 2) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

// Helper function to format "MMYYYY" to "Month Year"
function formatDumpDate(dateStr) {
    const month = dateStr.substring(0, 2);
    const year = dateStr.substring(2, 6);
    // Use 2nd day to avoid any timezone day-rollover issues
    const date = new Date(`${year}-${month}-02`); 
    return date.toLocaleString('default', { month: 'long', year: 'numeric' });
}

// Routes
app.get('/', (req, res) => res.render('index'));
app.get('/about', (req, res) => res.render('about'));
app.get('/current-activity', (req, res) => res.render('current-activity'));
app.get('/contact', (req, res) => res.render('contact'));
app.get('/bahaipedia', (req, res) => res.render('bahaipedia'));
app.get('/bahaiworks', (req, res) => res.render('bahaiworks'));
app.get('/bahaimedia', (req, res) => res.render('bahaimedia'));
app.get('/bahai9', (req, res) => res.render('bahai9'));
app.get('/bahaidata', (req, res) => res.render('bahaidata'));
app.get('/bahaiquest', (req, res) => res.render('bahaiquest'));
app.get('/huququlator', (req, res) => res.render('huququlator'));
app.get('/rbahai', (req, res) => res.render('r-bahai'));
app.get('/privacy-policy', (req, res) => res.render('privacy-policy'));
app.get('/search', (req, res) => { res.render('search');});
app.get('/technology', (req, res) => res.render('technology'));

// Webhook Route
app.post('/webhook', express.json(), (req, res) => {
    const signature = `sha256=${crypto
        .createHmac('sha256', process.env.WEBHOOK_SECRET)
        .update(JSON.stringify(req.body))
        .digest('hex')}`;

    if (req.headers['x-hub-signature-256'] !== signature) {
        return res.status(401).send('Invalid signature');
    }

    const { ref } = req.body;
    if (ref === 'refs/heads/main') {
        exec('git pull', { cwd: path.join(__dirname) }, (error, stdout, stderr) => {
            if (error) {
                console.error(`Error: ${error.message}`);
                return res.status(500).send('Error updating documentation');
            }
            if (stderr) {
                console.error(`Stderr: ${stderr}`);
            }
            console.log(`Stdout: ${stdout}`);
            return res.status(200).send('Documentation updated successfully');
        });
    } else {
        res.status(200).send('No updates for this branch');
    }
});

app.get('/database-dumps', async (req, res) => {
    try {
        const command = new ListObjectsV2Command({
            Bucket: S3_BUCKET,
            Prefix: "", // List all files
        });

        const s3Result = await s3Client.send(command);
        
        // Handle cases where the bucket is empty or no files match
        if (!s3Result.Contents || s3Result.Contents.length === 0) {
            return res.render('database-dumps', {
                dumpsByMonth: {}, // Pass an empty object
            });
        }
        
        const allDumps = s3Result.Contents
            .filter(file => file.Key.endsWith('.xml.gz'))
            .map(file => {
                // Filename is like "092025-pediaen.xml.gz"
                const parts = file.Key.split('.')[0].split('-');
                
                // Handle potential malformed filenames
                if (parts.length < 2) return null; 
                
                const dateStr = parts[0]; // "092025"
                const wikiId = parts[1]; // "pediaen"
                
                // Basic validation
                if (!/^\d{6}$/.test(dateStr) || !wikiId) return null;

                return {
                    key: file.Key,
                    dateStr: dateStr,
                    wikiId: wikiId,
                    prettyName: WIKI_NAMES[wikiId] || wikiId, // Fallback to ID
                    size: formatBytes(file.Size),
                    url: `${S3_BUCKET_URL_PREFIX}/${file.Key}`,
                    lastModified: file.LastModified,
                };
            })
            .filter(dump => dump !== null) // Remove any nulls from malformed names
            // Sort by date (newest first), then by name
            .sort((a, b) => {
                if (a.dateStr > b.dateStr) return -1;
                if (a.dateStr < b.dateStr) return 1;
                if (a.prettyName > b.prettyName) return 1;
                if (a.prettyName < b.prettyName) return -1;
                return 0;
            });

        // Group the dumps by the month/year string
        const dumpsByMonth = allDumps.reduce((acc, dump) => {
            const monthYear = formatDumpDate(dump.dateStr); // "September 2025"
            if (!acc[monthYear]) {
                acc[monthYear] = [];
            }
            acc[monthYear].push(dump);
            return acc;
        }, {});

        res.render('database-dumps', {
            dumpsByMonth: dumpsByMonth
        });

    } catch (err) {
        console.error("Error fetching S3 objects:", err);
        logger.error("Error fetching S3 objects:", err); // Log to Winston
        res.status(500).send('Server Error: Could not load database dumps.');
    }
});

// Route to create an interactive world map
app.get('/map', (req, res) => {
    res.render('map', { 
        title: 'World Map of Content' 
    });
});

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

        // Get the current year and month
        const currentDate = new Date();
        const currentYear = currentDate.getFullYear();
        const currentMonth = currentDate.getMonth() + 1
        
        // Render the stats page
        res.render('traffic-stats', {
            websites: websites,
            servers: transformedServers,
            years: years,
            months: months,
            selectedYear: currentYear,
            selectedMonth: currentMonth
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

        // Get the current year and month
        const currentDate = new Date();
        const currentYear = currentDate.getFullYear();
        const currentMonth = currentDate.getMonth() + 1;

        // Render the initial page
        res.render('traffic-stats-urls', {
            websites,
            servers: transformedServers,
            years,
            months,
            selectedYear: currentYear,
            selectedMonth: currentMonth
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
        const [monthResults] = await pool.query('SELECT DISTINCT month FROM website_url_stats ORDER BY month');
        const months = monthResults.map(row => row.month);
        const [yearResults] = await pool.query('SELECT DISTINCT year FROM website_url_stats ORDER BY year');
        const years = yearResults.map(row => row.year);

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
    
    try {
        // Parse the JSON string back into an array
        const titlesArray = JSON.parse(titles);
        
        // Calculate date boundaries
        const fromDate = `${from_year}${from_month.padStart(2, '0')}`;
        const toDate = `${to_year}${to_month.padStart(2, '0')}`;
        
        // Create placeholders for the IN clause
        const placeholders = titlesArray.map(() => '?').join(',');
        
        const [results] = await pool.query(`
            SELECT wu.url, wus.year, wus.month, SUM(wus.hits) as hits
            FROM website_url_stats wus
            JOIN website_url wu ON wus.website_url_id = wu.id
            WHERE wu.website_id = ? 
            AND wu.url IN (${placeholders})
            AND CONCAT(wus.year, LPAD(wus.month, 2, '0')) BETWEEN ? AND ?
            GROUP BY wu.url, wus.year, wus.month
            ORDER BY wu.url, wus.year, wus.month
        `, [website_id, ...titlesArray, fromDate, toDate]);

        results.forEach(row => {
            row.hits = Number(row.hits);
        });
        
        res.json(results);
    } catch (err) {
        console.error('Error in /api/pageview-data:', err);
        res.status(500).json({ error: 'Error fetching hits data.' });
    }
});

// The Search Logic
app.post('/api/search/query', async (req, res) => {
    const { prompt } = req.body;

    try {
        // 1. Check Instance Status
        const command = new DescribeInstancesCommand({ InstanceIds: [G5_INSTANCE_ID] });
        const data = await ec2Client.send(command);
        const state = data.Reservations[0].Instances[0].State.Name;

        // 2. Scenario: Server is Stopped -> Wake it up
        if (state === 'stopped') {
            console.log("Wake up trigger received. Starting G5...");
            await ec2Client.send(new StartInstancesCommand({ InstanceIds: [G5_INSTANCE_ID] }));
            return res.json({ status: 'booting', message: 'Powering on research server...' });
        }

        // 3. Scenario: Server is Booting -> Tell user to wait
        if (state === 'pending' || state === 'stopping') {
             return res.json({ status: 'booting', message: 'Server initializing services...' });
        }

        // 4. Scenario: Server is Running -> Proxy the Request to Private IP
        if (state === 'running') {
            try {
                // Connect to Python Agent via Private IP
                const agentResponse = await axios.post(`http://${G5_PRIVATE_IP}:${AGENT_PORT}/query`, {
                    query: prompt
                }, { timeout: 120000 }); // 2 minute timeout

                return res.json({ status: 'ready', data: agentResponse.data });
            } catch (error) {
                // Instance is up, but Python script might be loading models
                console.error("Agent connect error:", error.message);
                return res.json({ status: 'booting', message: 'Loading AI models...' });
            }
        }

    } catch (err) {
        console.error("Search Error:", err);
        res.status(500).json({ error: 'System error managing research node.' });
    }
});

// ==================================================================
// RAG & EXTENSION API
// ==================================================================

// AUTH HANDSHAKE: Exchange Wiki Session Cookie for API JWT
app.post('/auth/verify-session', async (req, res) => {
    // CHANGE: Accept credentials instead of cookie
    const { username, bot_password } = req.body;

    if (!username || !bot_password) {
        return res.status(400).json({ error: "Missing credentials" });
    }

    try {
        const mwUrl = "https://bahai.works/api.php";
        
        // 1. GET LOGIN TOKEN
        const tokenRes = await axios.get(mwUrl, {
            params: {
                action: "query",
                meta: "tokens",
                type: "login",
                format: "json"
            }
        });
        
        const loginToken = tokenRes.data.query.tokens.logintoken;
        const cookies = tokenRes.headers['set-cookie'];

        // 2. PERFORM LOGIN
        // MediaWiki requires a POST with url-encoded form data
        const params = new URLSearchParams();
        params.append('action', 'login');
        params.append('lgname', username);
        params.append('lgpassword', bot_password);
        params.append('lgtoken', loginToken);
        params.append('format', 'json');

        const loginRes = await axios.post(mwUrl, params, {
            headers: {
                'Cookie': cookies ? cookies.join('; ') : '' 
            }
        });
        const loginData = loginRes.data.login;

        // 3. CHECK RESULT
        if (loginData.result === "Success") {
            const mwUserId = loginData.lguserid;
            const mwUserName = loginData.lgusername;

            // A. Upsert User in your DB
            await metadataPool.query(
                `INSERT INTO api_users (mw_user_id, mw_username, role) 
                 VALUES (?, ?, 'user') 
                 ON DUPLICATE KEY UPDATE mw_username = VALUES(mw_username)`,
                [mwUserId, mwUserName]
            );

            // B. Get Internal ID
            const [userRows] = await metadataPool.query("SELECT id, role FROM api_users WHERE mw_user_id = ?", [mwUserId]);
            
            // C. Issue JWT
            const token = jwt.sign({ 
                uid: userRows[0].id, 
                mw_id: mwUserId, 
                role: userRows[0].role 
            }, JWT_SECRET, { expiresIn: '30d' });

            return res.json({ token, username: mwUserName, role: userRows[0].role });
        } else {
            // Login failed (Wrong password, throttled, etc.)
            return res.status(401).json({ 
                error: "Login Failed", 
                details: loginData.reason || loginData.result 
            });
        }

    } catch (err) {
        console.error("[Auth] Login Error:", err.message);
        res.status(500).json({ 
            error: "Authentication system error", 
            details: err.message,
            stack: err.stack 
        });
    }
});

/**
 * GET /api/tags
 * Autocomplete endpoint for the RAG Librarian
 * Query Param: ?search=abc
 */
app.get('/api/tags', async (req, res) => {
    const { search } = req.query;

    if (!search) {
        return res.json([]);
    }

    try {
        const query = `
            SELECT id, tag_label AS label 
            FROM defined_tags 
            WHERE label LIKE ? 
            LIMIT 10
        `;
        
        const [rows] = await metadataPool.query(query, [`%${search}%`]);
        
        res.json(rows);
    } catch (err) {
        console.error("[API] Tag Search Error:", err);
        res.status(500).json({ error: "Database error" });
    }
});

// GET /api/tags/tree
// Returns the full hierarchy of defined tags
app.get('/api/tags/tree', async (req, res) => {
    try {
        const [rows] = await metadataPool.query("SELECT id, label, parent_id, description FROM defined_tags ORDER BY label ASC");

        // Helper to nest flat list into tree
        const buildTree = (items, parentId = null) => {
            return items
                .filter(item => item.parent_id === parentId)
                .map(item => ({
                    ...item,
                    children: buildTree(items, item.id)
                }));
        };

        const tree = buildTree(rows);
        res.json(tree);

    } catch (err) {
        console.error("[API] Tag Tree Error:", err);
        res.status(500).json({ error: "Database error" });
    }
});

// GET LOGICAL UNITS (Read Path - Updated for Permissions)
app.get('/api/units', authenticateExtension, async (req, res) => {
    // Now accepts tag_id as an alternative filter
    const { source_code, source_page_id, tag_id, limit } = req.query;
    const currentUserId = req.user.uid;
    const currentUserRole = req.user.role;

    // Validate: Must have EITHER (Page context) OR (Tag context)
    if ((!source_code || !source_page_id) && !tag_id) {
        return res.status(400).json({ error: "Must provide source_code+source_page_id OR tag_id" });
    }

    try {
        let query = `
            SELECT 
                u.id, 
                a.source_code,
                a.source_page_id,
                u.article_id, 
                u.start_char_index, 
                u.end_char_index, 
                u.text_content, 
                u.author, 
                u.unit_type,
                u.created_by
            FROM logical_units u
            JOIN articles a ON u.article_id = a.id
        `;

        const params = [];

        // SCENARIO A: Fetch by Page (Current behavior)
        if (source_code && source_page_id) {
            query += ` WHERE a.source_code = ? AND a.source_page_id = ?`;
            params.push(source_code, source_page_id);
        } 
        // SCENARIO B: Fetch by Tag (Taxonomy Explorer)
        else if (tag_id) {
            query += ` 
                JOIN unit_tags ut ON u.id = ut.unit_id 
                WHERE ut.tag_id = ? 
            `;
            params.push(tag_id);
        }

        // Optional Limit for Taxonomy previews
        if (limit) {
            query += ` LIMIT ?`;
            params.push(parseInt(limit));
        }

        const [rows] = await metadataPool.query(query, params);

        const unitsWithPermissions = rows.map(unit => ({
            ...unit,
            can_delete: (unit.created_by === currentUserId) || (currentUserRole === 'admin')
        }));

        res.json(unitsWithPermissions); // NOTE: Changed return format to Array for consistency with client

    } catch (err) {
        console.error("[API] Fetch Units Error:", err);
        res.status(500).json({ error: "Database error" });
    }
});

// CONTRIBUTE LOGICAL UNIT (Protected)
app.post('/api/contribute/unit', authenticateExtension, async (req, res) => {
    const { 
        source_code, 
        source_page_id, 
        start_char_index, 
        end_char_index, 
        text_content, 
        author, 
        unit_type,
        tags
    } = req.body;

    // Basic Validation
    if (!source_code || !source_page_id || !text_content) {
        return res.status(400).json({ error: "Missing required fields." });
    }

    const userId = req.user.uid; 

    let conn;
    try {
        conn = await metadataPool.getConnection();
        await conn.beginTransaction();

        // A. Resolve Article ID (Get or Create Logic)
        let articleId;
        const [articleRows] = await conn.query(
            "SELECT id FROM articles WHERE source_code = ? AND source_page_id = ?",
            [source_code, source_page_id]
        );

        if (articleRows.length > 0) {
            articleId = articleRows[0].id;
        } else {
            // Stub the article if it doesn't exist yet
            const [result] = await conn.query(
                `INSERT INTO articles 
                (source_code, source_page_id, title, latest_rev_id, is_active) 
                VALUES (?, ?, ?, ?, ?)`,
                [source_code, source_page_id, "Auto-Discovered Page", 0, 1]
            );
            articleId = result.insertId;
        }

        // B. Insert Logical Unit
        const [unitResult] = await conn.query(
            `INSERT INTO logical_units 
            (article_id, start_char_index, end_char_index, text_content, author, unit_type, rag_indexed, created_by) 
            VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
            [articleId, start_char_index, end_char_index, text_content, author, unit_type, userId]
        );
        
        const unitId = unitResult.insertId;

        // --- START NEW TAG LOGIC ---
        if (tags && Array.isArray(tags) && tags.length > 0) {
            for (const tag of tags) {
                let tagId = tag;

                // 1. Check if it's a new string tag (e.g. "Justice")
                if (typeof tag === 'string') {
                    // Check if it exists already
                    const [existing] = await conn.query("SELECT id FROM defined_tags WHERE label = ?", [tag]);
                    
                    if (existing.length > 0) {
                        tagId = existing[0].id;
                    } else {
                        // Create it
                        const [newTag] = await conn.query("INSERT INTO defined_tags (label) VALUES (?)", [tag]);
                        tagId = newTag.insertId;
                    }
                }

                // 2. Link the Tag to the Unit
                await conn.query(
                    `INSERT INTO unit_tags (unit_id, tag_id) VALUES (?, ?)`,
                    [unitId, tagId]
                );
            }
        }

        await conn.commit();

        res.status(201).json({
            success: true,
            unit_id: unitId,
            parent_article_id: articleId
        });

    } catch (err) {
        if (conn) await conn.rollback();
        console.error("Contribution Error:", err);
        res.status(500).json({ error: "Database transaction failed", details: err.message });
    } finally {
        if (conn) conn.release();
    }
});

// POST /api/contribute/relationship
// Connects two existing units (Subject -> Object)
app.post('/api/contribute/relationship', authenticateExtension, async (req, res) => {
    const { subject_unit_id, object_unit_id, relationship_type } = req.body;
    const userId = req.user.uid;

    if (!subject_unit_id || !object_unit_id || !relationship_type) {
        return res.status(400).json({ error: "Missing required IDs or type." });
    }

    if (subject_unit_id === object_unit_id) {
        return res.status(400).json({ error: "Cannot link a unit to itself." });
    }

    try {
        // Use IGNORE to prevent crashing on duplicate links
        const query = `
            INSERT IGNORE INTO unit_relationships 
            (subject_unit_id, object_unit_id, relationship_type, created_by)
            VALUES (?, ?, ?, ?)
        `;
        
        await metadataPool.query(query, [subject_unit_id, object_unit_id, relationship_type, userId]);
        
        res.status(201).json({ success: true, message: "Relationship linked." });

    } catch (err) {
        console.error("[API] Relationship Error:", err);
        res.status(500).json({ error: "Database error" });
    }
});

// GET /api/qa
// Fetches canonical questions. Useful for populating the edit form.
app.get('/api/qa', authenticateExtension, async (req, res) => {
    const { answer_unit_id } = req.query;

    // Basic validation
    if (!answer_unit_id) {
        return res.status(400).json({ error: "Missing required parameter: answer_unit_id" });
    }

    try {
        const query = `
            SELECT 
                id,
                question_text,
                answer_unit_id,
                source_book,
                created_by
            FROM canonical_questions
            WHERE answer_unit_id = ?
        `;

        const [rows] = await metadataPool.query(query, [answer_unit_id]);
        
        // Return array (even if empty) to keep frontend logic simple
        res.json(rows);

    } catch (err) {
        console.error("[API] Fetch QA Error:", err);
        res.status(500).json({ error: "Database error" });
    }
});

// POST /api/contribute/qa
// Creates a Canonical Question linked to an Answer Unit
app.post('/api/contribute/qa', authenticateExtension, async (req, res) => {
    const { question_text, answer_unit_id, source_book } = req.body;
    const userId = req.user.uid;

    if (!question_text || !answer_unit_id) {
        return res.status(400).json({ error: "Missing question or answer ID." });
    }

    try {
        const query = `
            INSERT INTO canonical_questions 
            (question_text, answer_unit_id, source_book, created_by)
            VALUES (?, ?, ?, ?)
        `;
        
        const [result] = await metadataPool.query(query, [question_text, answer_unit_id, source_book || 'Unknown', userId]);
        
        res.status(201).json({ success: true, id: result.insertId });

    } catch (err) {
        console.error("[API] Q&A Error:", err);
        res.status(500).json({ error: "Database error" });
    }
});

/* DELETE logic */
app.delete('/api/units/:id', authenticateExtension, async (req, res) => {
    const unitId = req.params.id;
    const userId = req.user.uid;
    const userRole = req.user.role;

    try {
        // 1. Check ownership
        const [rows] = await metadataPool.query("SELECT created_by FROM logical_units WHERE id = ?", [unitId]);
        
        if (rows.length === 0) {
            return res.status(404).json({ error: "Unit not found" });
        }

        const unit = rows[0];

        // 2. Permission Check
        if (unit.created_by !== userId && userRole !== 'admin') {
            return res.status(403).json({ error: "You do not have permission to delete this unit." });
        }

        // 3. Delete
        await metadataPool.query("DELETE FROM logical_units WHERE id = ?", [unitId]);

        res.json({ success: true, message: "Unit deleted" });

    } catch (err) {
        console.error("Delete Error:", err);
        res.status(500).json({ error: "Database error" });
    }
});

// END //
app.listen(PORT, () => {
    console.log(`Primary site running at http://localhost:${PORT}`);
});
