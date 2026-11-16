const express = require('express');
const axios = require('axios');
const path = require('path');
const mysql = require('mysql2/promise');
const { Pool: PgPool, types: pgTypes } = require('pg');
const winston = require('winston');
const dotenv = require('dotenv');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const semver = require('semver');
const { exec, spawn } = require('child_process');

// For the Baha'i Text Annotation Chrome Extension, routes starting ~ line 700
const MIN_CLIENT_VERSION = '2.5.1';

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
// Dedicated pool for RAG Metadata (PostgreSQL `anvar` via least-privilege `extension_api`)
// Parse PostgreSQL BIGINT (OID 20, e.g. library.articles.source_page_id) as JS numbers to match Chrome Extension expectations
pgTypes.setTypeParser(20, (val) => (val === null ? null : parseInt(val, 10)));

const metadataPool = new PgPool({
    host: process.env.PG_HOST || '127.0.0.1',
    port: parseInt(process.env.PG_PORT || '5432', 10),
    user: process.env.PG_USER_META,
    password: process.env.PG_PASSWORD_META,
    database: process.env.PG_DB_META,
    max: 10
});

// Normalize connected_anchors elements to strings so PostgreSQL `jsonb ?| text[]` matches via GIN index
const normalizeConnectedAnchors = (anchors) => {
    if (anchors === null || anchors === undefined) return null;
    const parsed = typeof anchors === 'string' ? JSON.parse(anchors) : anchors;
    if (!Array.isArray(parsed)) return null;
    return JSON.stringify(parsed.map(String));
};
// Pool for MediaWiki Images
const mediaPool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER_MEDIA,
    password: process.env.DB_PASSWORD_MEDIA,
    database: process.env.DB_NAME_MEDIA,
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
    // --- STEP 1: Version Check ---
    // If header is missing, default to '0.0.0'
    const clientVersion = req.get('X-Client-Version') || '0.0.0';

    // Validate format (semver.valid returns null if string is garbage)
    const validClientVersion = semver.valid(clientVersion) ? clientVersion : '0.0.0';

    if (semver.lt(validClientVersion, MIN_CLIENT_VERSION)) {
        return res.status(426).json({ 
            error: "Upgrade Required",
            message: `Your extension version (${clientVersion}) is outdated. Please update to ${MIN_CLIENT_VERSION} or higher.`
        });
    }

    // --- STEP 2: Token Verification ---
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

// Helper to calculate MediaWiki S3 URL
function getMediaWikiS3Url(filename) {
    // Standardize spaces to underscores
    const safeName = filename.replace(/ /g, '_');
    // Calculate MD5
    const hash = crypto.createHash('md5').update(safeName).digest('hex');
    const p1 = hash.substring(0, 1);
    const p2 = hash.substring(0, 2);
    // Construct URL (Adjust domain if using a specific regional bucket for the manifest)
    return `https://file.bahai.media/${p1}/${p2}/${encodeURIComponent(safeName)}`;
}

// Routes
app.get('/', (req, res) => res.render('index'));
app.get('/about', (req, res) => res.render('about'));
app.get('/chrome-extension', (req, res) => res.render('chrome-extension'));
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

// Route to render the Media Downloader Page
app.get('/database-dumps/media', (req, res) => {
    res.render('media-dumps');
});
// 1. Search Categories (for the "Type to find..." box)
app.get('/api/media/search-categories', async (req, res) => {
    const query = req.query.q;
    if (!query || query.length < 2) return res.json([]);

    try {
        const sql = `
            SELECT page_title 
            FROM page 
            WHERE page_namespace = 14 
            AND page_title LIKE ? 
            ORDER BY page_title ASC 
            LIMIT 50
        `;
        // Search for "Query%" (starts with)
        const [rows] = await mediaPool.execute(sql, [query.replace(/ /g, '_') + '%']);
        
        const results = rows.map(r => r.page_title.toString('utf8').replace(/_/g, ' '));
        res.json(results);
    } catch (err) {
        logger.error("Search error:", err);
        res.status(500).json({ error: "Search failed" });
    }
});

// 2. Get Subcategories (Lazy Loading)
app.get('/api/media/subcategories', async (req, res) => {
    const parent = req.query.parent;
    if (!parent) return res.json([]);

    try {
        const sql = `
            SELECT p.page_title
            FROM page p
            JOIN categorylinks cl ON p.page_id = cl.cl_from
            WHERE cl.cl_to = ? 
            AND p.page_namespace = 14
            ORDER BY p.page_title ASC
        `;
        const [rows] = await mediaPool.execute(sql, [parent.replace(/ /g, '_')]);
        
        const children = rows.map(r => r.page_title.toString('utf8').replace(/_/g, ' '));
        res.json(children);
    } catch (err) {
        logger.error("Subcategory fetch error:", err);
        res.status(500).json({ error: "Fetch failed" });
    }
});

// 3. Generate Manifest (Accepts Array of Categories)
app.post('/api/media/generate-manifest', async (req, res) => {
    // Expecting an array now: { categories: ["Abdu'l-Bahá", "Temples"] }
    const rootCategories = req.body.categories;
    
    if (!rootCategories || !Array.isArray(rootCategories) || rootCategories.length === 0) {
        return res.status(400).json({ error: 'At least one category is required' });
    }

    try {
        // Prepare placeholders for IN clause
        const placeholders = rootCategories.map(() => '?').join(',');
        const safeCategories = rootCategories.map(c => c.replace(/ /g, '_'));

        const query = `
            WITH RECURSIVE CategoryTree AS (
                -- Anchor: Select ALL selected root categories
                -- CAST to CHAR(1024) to prevent "Data too long" errors on deep folder paths
                SELECT page_title AS category_name, page_id, CAST(page_title AS CHAR(1024)) AS tree_path, 0 AS depth
                FROM page 
                WHERE page_title IN (${placeholders}) AND page_namespace = 14
                
                UNION DISTINCT
                
                -- Recursive: Subcategories
                SELECT p.page_title, p.page_id, CONCAT(ct.tree_path, '/', CAST(p.page_title AS CHAR(255))), ct.depth + 1
                FROM page p
                INNER JOIN categorylinks cl ON p.page_id = cl.cl_from
                INNER JOIN CategoryTree ct ON cl.cl_to = ct.category_name
                WHERE p.page_namespace = 14 AND ct.depth < 15
            )
            SELECT 
                ct.tree_path AS folder,
                p.page_title AS filename,
                img.img_size AS size,
                img.img_sha1 AS sha1
            FROM CategoryTree ct
            INNER JOIN categorylinks cl ON cl.cl_to = ct.category_name
            INNER JOIN page p ON p.page_id = cl.cl_from
            INNER JOIN image img ON img.img_name = p.page_title
            WHERE p.page_namespace = 6;
        `;

        const [rows] = await mediaPool.execute(query, safeCategories);

        if (rows.length === 0) {
            return res.json({ count: 0, files: [] });
        }

        const manifest = rows.map(row => {
            const folderStr = row.folder.toString('utf8');
            const filenameStr = row.filename.toString('utf8');
            const hashStr = Buffer.isBuffer(row.sha1) ? row.sha1.toString('utf8') : row.sha1;

            const cleanFolder = folderStr.replace(/_/g, ' ');
            const cleanFilename = filenameStr.replace(/_/g, ' ');
            
            return {
                url: getMediaWikiS3Url(filenameStr),
                path: `${cleanFolder}/${cleanFilename}`, // Files will be organized by their specific sub-folder
                size: row.size,
                hash: hashStr
            };
        });

        res.json({
            count: manifest.length,
            root_category: rootCategories.join(', '),
            files: manifest
        });

    } catch (err) {
        logger.error("Error generating media manifest:", err);
        res.status(500).json({ error: 'Database error generating manifest.' });
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

// Since /auth/verify-session is public (no token), it needs its own lightweight middleware
const requireClientVersion = (req, res, next) => {
    const clientVersion = req.get('X-Client-Version') || '0.0.0';
    const validClientVersion = semver.valid(clientVersion) ? clientVersion : '0.0.0';

    if (semver.lt(validClientVersion, MIN_CLIENT_VERSION)) {
        return res.status(426).json({ 
            error: "Upgrade Required",
            message: `Your extension version (${clientVersion}) is outdated. Please update to ${MIN_CLIENT_VERSION} or higher.`
        });
    }
    next();
};

// AUTH HANDSHAKE: Exchange Wiki Session Cookie for API JWT
app.post('/auth/verify-session', requireClientVersion, async (req, res) => {
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

            // A. Upsert User in your DB & Get Internal ID
            const { rows: userRows } = await metadataPool.query(
                `INSERT INTO knowledge.api_users (mw_user_id, mw_username, role)
                 VALUES ($1, $2, 'user')
                 ON CONFLICT (mw_user_id) DO UPDATE SET mw_username = EXCLUDED.mw_username
                 RETURNING id, role`,
                [mwUserId, mwUserName]
            );
            
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
app.get('/api/tags', authenticateExtension, async (req, res) => {
    // 1. Extract 'limit' from query params
    const { search, limit } = req.query;
    const userId = req.user.uid; 

    if (!search) {
        return res.json([]);
    }

    // 2. Parse limit to an integer, default to 10 if missing or invalid
    const queryLimit = parseInt(limit) || 10;

    try {
        // 3. Use '$1/$2/$3' for the ILIKE and LIMIT clauses
        const query = `
            SELECT id, label 
            FROM knowledge.defined_tags 
            WHERE label ILIKE $1 
            AND created_by = $2
            LIMIT $3
        `;
        
        // 4. Pass 'queryLimit' as the third parameter
        const { rows } = await metadataPool.query(query, [`%${search}%`, userId, queryLimit]);
        
        res.json(rows);
    } catch (err) {
        console.error("[API] Tag Search Error:", err);
        res.status(500).json({ error: "Database error" });
    }
});

// GET /api/tags/tree
// Returns the full hierarchy of defined tags
// Accepts ?scope=mine to filter by user
app.get('/api/tags/tree', authenticateExtension, async (req, res) => {
    const format = req.query.format;
    const userId = req.user.uid;

    try {
        // ALWAYS filter by the current user. "View Example" (official tags) is removed.
        const query = `
            SELECT id, label, parent_id, description, created_by, (is_official)::int AS is_official 
            FROM knowledge.defined_tags 
            WHERE created_by = $1 
            ORDER BY label ASC
        `;

        const { rows } = await metadataPool.query(query, [userId]);

        // If Flat List is requested, return rows directly
        if (format === 'flat') {
            return res.json(rows);
        }

        // Build Tree
        const buildTree = (items, parentId = null) => {
            return items
                .filter(item => item.parent_id === parentId)
                .map(item => ({
                    ...item,
                    children: buildTree(items, item.id)
                }));
        };

        res.json(buildTree(rows, null));
        
    } catch (err) {
        console.error("[API] Tag Tree Error:", err);
        res.status(500).json({ error: "Database error" });
    }
});

// POST /api/tags
// Create a new Personal Tag
app.post('/api/tags', authenticateExtension, async (req, res) => {
    const { label, is_official } = req.body;
    const userId = req.user.uid; 
    const userRole = req.user.role;

    if (!label || typeof label !== 'string' || label.trim() === '') {
        return res.status(400).json({ error: "Label is required" });
    }

    const cleanLabel = label.trim();

    // Security: Only admins can create official tags. 
    // If a normal user tries, force it to false (Private).
    const officialFlag = Boolean(is_official && userRole === 'admin');

    try {
        // 1. Try to insert
        const query = `
            INSERT INTO knowledge.defined_tags (label, created_by, is_official) 
            VALUES ($1, $2, $3)
            RETURNING id, label, is_official
        `;
        
        const { rows } = await metadataPool.query(query, [cleanLabel, userId, officialFlag]);
        
        res.json(rows[0]);

    } catch (err) {
        // 2. Handle Duplicates (Race condition or re-adding existing)
        if (err.code === '23505') {
            // Fetch the existing tag ID for this user so the UI can select it
            const { rows } = await metadataPool.query(
                "SELECT id, label, is_official FROM knowledge.defined_tags WHERE label = $1 AND created_by = $2", 
                [cleanLabel, userId]
            );
            
            if (rows.length > 0) {
                return res.json(rows[0]);
            }
        }

        console.error("[API] Create Tag Error:", err);
        res.status(500).json({ error: "Database error" });
    }
});

// [NEW] PUT /api/tags/hierarchy
// Batch updates parent_ids after Drag and Drop
app.put('/api/tags/hierarchy', authenticateExtension, async (req, res) => {
    const { updates } = req.body; // Expects [{ id: 1, parent_id: 5 }, { id: 2, parent_id: null }]
    const userId = req.user.uid;

    if (!Array.isArray(updates) || updates.length === 0) return res.json({ success: true });

    const client = await metadataPool.connect();
    try {
        await client.query('BEGIN');

        for (const update of updates) {
            // Security: Ensure user owns the tag they are moving
            // Note: We aren't checking if the *new parent* belongs to them here for speed, 
            // but the foreign key constraint or frontend logic should handle cycles/validity.
            await client.query(
                "UPDATE knowledge.defined_tags SET parent_id = $1 WHERE id = $2 AND created_by = $3",
                [update.parent_id, update.id, userId]
            );
        }

        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err);
        res.status(500).json({ error: "Failed to save hierarchy" });
    } finally {
        client.release();
    }
});

// PUT /api/tags/:id
// Rename a specific tag
app.put('/api/tags/:id', authenticateExtension, async (req, res) => {
    const tagId = req.params.id;
    const { label } = req.body;
    const userId = req.user.uid;

    if (!label || typeof label !== 'string' || !label.trim()) {
        return res.status(400).json({ error: "Valid label is required" });
    }

    try {
        const query = "UPDATE knowledge.defined_tags SET label = $1 WHERE id = $2 AND created_by = $3";
        const result = await metadataPool.query(query, [label.trim(), tagId, userId]);

        if (result.rowCount === 0) {
            return res.status(404).json({ error: "Tag not found or unauthorized" });
        }

        res.json({ success: true });
    } catch (err) {
        // Handle duplicate labels if your schema enforces unique (label, created_by)
        if (err.code === '23505') {
            return res.status(409).json({ error: "A tag with this name already exists." });
        }
        console.error(err);
        res.status(500).json({ error: "Database error" });
    }
});

// GET LOGICAL UNITS (Read Path - Updated for Hybrid Permissions)
app.get('/api/units', authenticateExtension, async (req, res) => {
    const { source_code, source_page_id, tag_id, limit } = req.query;
    const currentUserId = req.user.uid;
    const currentUserRole = req.user.role;

    if ((!source_code || !source_page_id) && !tag_id) {
        return res.status(400).json({ error: "Must provide source_code+source_page_id OR tag_id" });
    }

    try {
        let query = `
            SELECT 
                u.id, 
                a.source_code,
                a.source_page_id,
                a.title,
                u.article_id, 
                u.start_char_index, 
                u.end_char_index, 
                u.text_content, 
                u.connected_anchors,
                u.author, 
                u.unit_type,
                (u.broken_index)::int AS broken_index,
                u.created_by
            FROM knowledge.logical_units u
            JOIN library.articles a ON u.article_id = a.id
        `;

        const params = [];

        // SCENARIO A: Fetch by Page
        if (source_code && source_page_id) {
            // PERMISSION FIX: 
            // 1. If type is 'user_highlight', MUST match currentUserId
            // 2. All other types (metadata) are visible to everyone
            params.push(source_code, source_page_id, currentUserId);
            query += ` 
                WHERE a.source_code = $1 
                AND a.source_page_id = $2 
                AND (u.unit_type != 'user_highlight' OR u.created_by = $3)
            `;
        } 
        // SCENARIO B: Fetch by Tag
        else if (tag_id) {
            // NOTE: Tags are strictly personal in your system, so we keep the strict check here.
            // If you later add "Public Official Tags", you would relax this logic similar to above.
            params.push(tag_id, currentUserId);
            query += ` 
                JOIN knowledge.unit_tags ut ON u.id = ut.unit_id 
                WHERE ut.tag_id = $1 AND u.created_by = $2
            `;
        }

        if (limit) {
            params.push(parseInt(limit, 10));
            query += ` LIMIT $${params.length}`;
        }

        const { rows } = await metadataPool.query(query, params);

        const unitsWithPermissions = rows.map(unit => ({
            ...unit,
            connected_anchors: (typeof unit.connected_anchors === 'string') 
                ? JSON.parse(unit.connected_anchors) 
                : (unit.connected_anchors || []),
            // Frontend uses this to show/hide "Delete" buttons
            can_delete: (unit.created_by === currentUserId) || (currentUserRole === 'admin')
        }));

        res.json(unitsWithPermissions);

    } catch (err) {
        console.error("[API] Fetch Units Error:", err);
        res.status(500).json({ error: "Database error" });
    }
});

// BATCH GET LOGICAL UNITS (Read Path for 'lib' fragments)
// Endpoint: POST /api/units/batch
app.post('/api/units/batch', authenticateExtension, async (req, res) => {
    const { source_code, source_page_ids } = req.body;
    const currentUserId = req.user.uid;
    const currentUserRole = req.user.role;

    if (!source_code || !Array.isArray(source_page_ids) || source_page_ids.length === 0) {
        return res.status(400).json({ error: "Invalid input" });
    }

    try {
        let query = `
            SELECT 
                u.id, 
                a.source_code,
                a.source_page_id,
                a.title,
                u.article_id, 
                u.start_char_index, 
                u.end_char_index, 
                u.text_content, 
                u.connected_anchors,
                u.author, 
                u.unit_type,
                (u.broken_index)::int AS broken_index,
                u.created_by
            FROM knowledge.logical_units u
            JOIN library.articles a ON u.article_id = a.id
            WHERE a.source_code = $1 
        `;

        // [FIX] Updated Params: Code, UserID, UserRole
        const params = [source_code, currentUserId, currentUserRole];

        // [FIX] Hybrid Permission Logic
        // 1. Show if it's NOT a user_highlight (Public Data like Tablets)
        // 2. OR if I created it
        // 3. OR if I am an Admin (I can see everyone's private highlights)
        query += `
            AND (
                u.unit_type != 'user_highlight' 
                OR u.created_by = $2
                OR $3 = 'admin'
            )
        `;

        // --- BRANCHING LOGIC (JSONB vs BIGINT[]) ---
        if (source_code === 'lib') {
            // STRATEGY A: BAHAI.ORG (JSONB Anchors Only)
            // We search purely for overlap between the requested IDs (strings) and stored anchors via GIN index
            query += ` AND u.connected_anchors ?| $4::text[]`;
            params.push(source_page_ids.map(String)); // Pass ["0555...", "0556..."] as text[]
        } else {
            // STRATEGY B: MEDIAWIKI (Integer IDs Only)
            // Standard Page ID lookup for wikis
            query += ` AND a.source_page_id = ANY($4::bigint[])`;
            
            // Ensure inputs are integers for safety
            params.push(source_page_ids.map(id => parseInt(id, 10)).filter(n => !Number.isNaN(n)));
        }

        const { rows } = await metadataPool.query(query, params);

        const unitsWithPermissions = rows.map(unit => ({
            ...unit,
            connected_anchors: (typeof unit.connected_anchors === 'string') 
                ? JSON.parse(unit.connected_anchors) 
                : (unit.connected_anchors || []),
            can_delete: (unit.created_by === currentUserId) || (req.user.role === 'admin')
        }));
        
        console.log(`[API] Batch requested ${source_page_ids.length} IDs for '${source_code}' -> Returned ${rows.length} units.`);

        res.json({ units: unitsWithPermissions });

    } catch (err) {
        console.error("[API] Batch Fetch Units Error:", err);
        res.status(500).json({ error: "Database error", details: err.message });
    }
});

// BATCH REALIGN (The Healer Endpoint)
app.patch('/api/units/batch_realign', authenticateExtension, async (req, res) => {
    const { updates } = req.body; 
    
    if (!updates || !Array.isArray(updates) || updates.length === 0) {
        return res.status(400).json({ error: "No updates provided" });
    }

    let client;
    try {
        client = await metadataPool.connect();
        await client.query('BEGIN');

        for (const update of updates) {
            if (update.broken_index) {
                await client.query(
                    "UPDATE knowledge.logical_units SET broken_index = TRUE WHERE id = $1",
                    [update.id]
                );
            } else {
                // Ensure JSON format with string-normalized anchor IDs
                const anchors = normalizeConnectedAnchors(update.connected_anchors);

                await client.query(
                    `UPDATE knowledge.logical_units 
                     SET start_char_index = $1, end_char_index = $2, text_content = $3, connected_anchors = $4::jsonb, broken_index = FALSE 
                     WHERE id = $5`,
                    [
                        update.start_char_index, 
                        update.end_char_index,
                        update.text_content,
                        anchors, // [UPDATE]
                        update.id
                    ]
                );
            }
        }

        await client.query('COMMIT');
        console.log(`[Healer] Processed ${updates.length} adjustments.`);
        res.json({ success: true });

    } catch (err) {
        if (client) await client.query('ROLLBACK');
        console.error("[API] Realign Error:", err);
        res.status(500).json({ error: "Batch update failed" });
    } finally {
        if (client) client.release();
    }
});

// GET /api/units/:id/tags
// Fetch tags for a specific unit (for the Edit form)
app.get('/api/units/:id/tags', authenticateExtension, async (req, res) => {
    try {
        const { rows } = await metadataPool.query(
            `SELECT t.id, t.label, (t.is_official)::int AS is_official 
             FROM knowledge.defined_tags t
             JOIN knowledge.unit_tags ut ON t.id = ut.tag_id
             WHERE ut.unit_id = $1`,
            [req.params.id]
        );
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: "Db error" });
    }
});

// PUT /api/units/:id/tags
// Update tags for a unit
app.put('/api/units/:id/tags', authenticateExtension, async (req, res) => {
    const unitId = parseInt(req.params.id, 10);
    const { tags } = req.body; // Array of tag IDs
    const userId = req.user.uid;

    let client;
    try {
        // 1. Verify Ownership (or Admin)
        const { rows: unit } = await metadataPool.query("SELECT created_by FROM knowledge.logical_units WHERE id = $1", [unitId]);
        if (unit.length === 0) return res.status(404).json({ error: "Unit not found" });
        
        if (unit[0].created_by !== userId && req.user.role !== 'admin') {
            return res.status(403).json({ error: "Unauthorized" });
        }

        client = await metadataPool.connect();
        await client.query('BEGIN');

        // 2. Wipe existing tags
        await client.query("DELETE FROM knowledge.unit_tags WHERE unit_id = $1", [unitId]);

        // 3. Insert new tags
        if (tags && tags.length > 0) {
            const tagIds = tags.map(tagId => parseInt(tagId, 10));
            await client.query(
                `INSERT INTO knowledge.unit_tags (unit_id, tag_id)
                 SELECT $1, unnest($2::int[])
                 ON CONFLICT DO NOTHING`,
                [unitId, tagIds]
            );
        }

        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        if (client) await client.query('ROLLBACK');
        console.error(err);
        res.status(500).json({ error: "Update failed" });
    } finally {
        if (client) client.release();
    }
});

// PUT /api/units/:id
// Update unit details (Used by the Repair Tool to fix broken highlights)
app.put('/api/units/:id', authenticateExtension, async (req, res) => {
    const unitId = parseInt(req.params.id, 10);
    const { 
        start_char_index, 
        end_char_index, 
        text_content, 
        author,
        unit_type,
        broken_index,
        connected_anchors,
        tags // Optional array of tag IDs
    } = req.body;
    const userId = req.user.uid;

    let client;
    try {
        client = await metadataPool.connect();
        await client.query('BEGIN');

        // 1. Verify Ownership
        const { rows: unit } = await client.query("SELECT created_by FROM knowledge.logical_units WHERE id = $1", [unitId]);
        if (unit.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: "Unit not found" });
        }
        
        if (unit[0].created_by !== userId && req.user.role !== 'admin') {
            await client.query('ROLLBACK');
            return res.status(403).json({ error: "Unauthorized" });
        }

        // 2. Build Dynamic Update Query
        const fields = [];
        const values = [];

        if (start_char_index !== undefined) { values.push(start_char_index); fields.push(`start_char_index = $${values.length}`); }
        if (end_char_index !== undefined)   { values.push(end_char_index);   fields.push(`end_char_index = $${values.length}`); }
        if (text_content !== undefined)     { values.push(text_content);     fields.push(`text_content = $${values.length}`); }
        if (author !== undefined)           { values.push(author);           fields.push(`author = $${values.length}`); }
        if (unit_type !== undefined)        { values.push(unit_type);        fields.push(`unit_type = $${values.length}`); }
        if (broken_index !== undefined)     { values.push(Boolean(broken_index)); fields.push(`broken_index = $${values.length}`); }
        
        if (connected_anchors !== undefined) { 
            values.push(normalizeConnectedAnchors(connected_anchors));
            fields.push(`connected_anchors = $${values.length}::jsonb`); 
        }

        if (fields.length > 0) {
            values.push(unitId);
            const sql = `UPDATE knowledge.logical_units SET ${fields.join(', ')} WHERE id = $${values.length}`;
            await client.query(sql, values);
        }

        // 3. Handle Tags (If provided)
        if (tags && Array.isArray(tags)) {
            // A. Wipe existing tags for this unit
            await client.query("DELETE FROM knowledge.unit_tags WHERE unit_id = $1", [unitId]);

            // B. Insert new tags
            if (tags.length > 0) {
                const tagIds = tags.map(tagId => parseInt(tagId, 10));
                await client.query(
                    `INSERT INTO knowledge.unit_tags (unit_id, tag_id)
                     SELECT $1, unnest($2::int[])
                     ON CONFLICT DO NOTHING`,
                    [unitId, tagIds]
                );
            }
        }

        await client.query('COMMIT');
        res.json({ success: true });

    } catch (err) {
        if (client) await client.query('ROLLBACK');
        console.error("Unit update error:", err);
        res.status(500).json({ error: "Update failed" });
    } finally {
        if (client) client.release();
    }
});

// DELETE /api/units/:id
app.delete('/api/units/:id', authenticateExtension, async (req, res) => {
    const unitId = req.params.id;
    const userId = req.user.uid;

    try {
        const { rows: unit } = await metadataPool.query("SELECT created_by FROM knowledge.logical_units WHERE id = $1", [unitId]);
        if (unit.length === 0) return res.status(404).json({ error: "Unit not found" });

        if (unit[0].created_by !== userId && req.user.role !== 'admin') {
            return res.status(403).json({ error: "Unauthorized" });
        }

        // logical_units has a CASCADE delete on unit_tags usually, 
        // but let's delete strictly.
        await metadataPool.query("DELETE FROM knowledge.unit_tags WHERE unit_id = $1", [unitId]);
        await metadataPool.query("DELETE FROM knowledge.logical_units WHERE id = $1", [unitId]);

        res.json({ success: true, message: "Unit deleted" });
    } catch (err) {
        console.error("Delete Error:", err);
        res.status(500).json({ error: "Delete failed" });
    }
});

// CONTRIBUTE LOGICAL UNIT
app.post('/api/contribute/unit', authenticateExtension, async (req, res) => {
    const { 
        source_code, 
        source_page_id, 
        start_char_index, 
        end_char_index, 
        text_content, 
        author, 
        unit_type, 
        tags,
        connected_anchors // [UPDATE] New Field
    } = req.body;

    const payloadTitle = req.body.title || (req.body.context && req.body.context.title);

    if (!payloadTitle || typeof payloadTitle !== 'string' || payloadTitle.trim() === '') {
        return res.status(400).json({ error: "Missing Title." });
    }

    if (!source_code || !source_page_id || !text_content) {
        return res.status(400).json({ error: "Missing required fields." });
    }

    const userId = req.user.uid; 
    const anchorsJson = normalizeConnectedAnchors(connected_anchors);

    let client;
    try {
        client = await metadataPool.connect();
        await client.query('BEGIN');

        // A. Resolve Article ID (using ON CONFLICT DO NOTHING so extension_api only needs SELECT + INSERT)
        const { rows: articleRows } = await client.query(
            "SELECT id FROM library.articles WHERE source_code = $1 AND source_page_id = $2",
            [source_code, source_page_id]
        );

        let articleId;
        if (articleRows.length > 0) {
            articleId = articleRows[0].id;
        } else {
            const { rows: insertedArticles } = await client.query(
                `INSERT INTO library.articles (source_code, source_page_id, title, latest_rev_id, is_active) 
                 VALUES ($1, $2, $3, 0, TRUE)
                 ON CONFLICT (source_code, source_page_id) DO NOTHING
                 RETURNING id`,
                [source_code, source_page_id, payloadTitle]
            );
            if (insertedArticles.length > 0) {
                articleId = insertedArticles[0].id;
            } else {
                const { rows: retryRows } = await client.query(
                    "SELECT id FROM library.articles WHERE source_code = $1 AND source_page_id = $2",
                    [source_code, source_page_id]
                );
                articleId = retryRows[0].id;
            }
        }

        // B. Insert Logical Unit [UPDATE] Added connected_anchors
        const { rows: unitRows } = await client.query(
            `INSERT INTO knowledge.logical_units 
            (article_id, start_char_index, end_char_index, text_content, connected_anchors, author, unit_type, rag_indexed, created_by) 
            VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, FALSE, $8)
            RETURNING id`,
            [articleId, start_char_index, end_char_index, text_content, anchorsJson, author, unit_type, userId]
        );
        
        const unitId = unitRows[0].id;

        // C. Link Tags
        if (tags && Array.isArray(tags) && tags.length > 0) {
            for (const tag of tags) {
                let tagId = tag;

                // 1. Check if it's a new string tag (e.g. "Justice")
                if (typeof tag === 'string') {
                    // Check if it exists already
                    const { rows: existing } = await client.query(
                        "SELECT id FROM knowledge.defined_tags WHERE label = $1 AND created_by = $2",
                        [tag, userId]
                    );
                    
                    if (existing.length > 0) {
                        tagId = existing[0].id;
                    } else {
                        // Create it
                        const { rows: newTag } = await client.query(
                            `INSERT INTO knowledge.defined_tags (label, created_by, is_official)
                             VALUES ($1, $2, FALSE)
                             ON CONFLICT (label, created_by) DO UPDATE SET label = EXCLUDED.label
                             RETURNING id`,
                            [tag, userId]
                        );
                        tagId = newTag[0].id;
                    }
                }

                // 2. Link the Tag to the Unit
                await client.query(
                    `INSERT INTO knowledge.unit_tags (unit_id, tag_id)
                     VALUES ($1, $2)
                     ON CONFLICT DO NOTHING`,
                    [unitId, tagId]
                );
            }
        }

        await client.query('COMMIT');

        res.status(201).json({
            success: true,
            unit_id: unitId,
            parent_article_id: articleId
        });

    } catch (err) {
        if (client) await client.query('ROLLBACK');
        console.error("Contribution Error:", err);
        res.status(500).json({ error: "Database transaction failed", details: err.message });
    } finally {
        if (client) client.release();
    }
});

// GET /api/relationships
// Returns all relationships where the Subject OR Object is on the requested page
app.get('/api/relationships', authenticateExtension, async (req, res) => {
    const { source_code, source_page_id } = req.query;

    if (!source_code || !source_page_id) {
        return res.status(400).json({ error: "Missing source context" });
    }

    try {
        const query = `
            SELECT 
                r.subject_unit_id,
                r.object_unit_id,
                r.relationship_type,
                r.weight,
                r.created_by,
                
                -- Expand Subject Info
                s.text_content as subject_text,
                s.unit_type as subject_type,
                a_s.source_page_id as subject_page_id,
                a_s.source_code as subject_source_code,
                a_s.title as subject_page_title,

                -- Expand Object Info
                o.text_content as object_text,
                o.unit_type as object_type,
                a_o.source_page_id as object_page_id,
                a_o.source_code as object_source_code,
                a_o.title as object_page_title

            FROM knowledge.unit_relationships r
            JOIN knowledge.logical_units s ON r.subject_unit_id = s.id
            JOIN library.articles a_s ON s.article_id = a_s.id
            JOIN knowledge.logical_units o ON r.object_unit_id = o.id
            JOIN library.articles a_o ON o.article_id = a_o.id

            WHERE 
                (a_s.source_code = $1 AND a_s.source_page_id = $2)
                OR 
                (a_o.source_code = $1 AND a_o.source_page_id = $2)
        `;
        
        const { rows } = await metadataPool.query(query, [source_code, source_page_id]);

        const rowsWithPermissions = rows.map(r => ({
            ...r,
            can_delete: (r.created_by === req.user.uid) || (req.user.role === 'admin')
        }));

        res.json(rowsWithPermissions);

    } catch (err) {
        console.error("[API] Get Relationships Error:", err);
        res.status(500).json({ error: "Database error" });
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
        // Use ON CONFLICT DO NOTHING to prevent crashing on duplicate links
        const query = `
            INSERT INTO knowledge.unit_relationships 
            (subject_unit_id, object_unit_id, relationship_type, created_by)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (subject_unit_id, object_unit_id) DO NOTHING
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
            FROM knowledge.canonical_questions
            WHERE answer_unit_id = $1
        `;

        const { rows } = await metadataPool.query(query, [answer_unit_id]);
        
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
            INSERT INTO knowledge.canonical_questions 
            (question_text, answer_unit_id, source_book, created_by)
            VALUES ($1, $2, $3, $4)
            RETURNING id
        `;
        
        const { rows } = await metadataPool.query(query, [question_text, answer_unit_id, source_book || 'Unknown', userId]);
        
        res.status(201).json({ success: true, id: rows[0].id });

    } catch (err) {
        console.error("[API] Q&A Error:", err);
        res.status(500).json({ error: "Database error" });
    }
});

// [NEW] DELETE /api/tags/:id
// Handles the "Uncategorized" logic
app.delete('/api/tags/:id', authenticateExtension, async (req, res) => {
    const tagId = req.params.id;
    const userId = req.user.uid;
    const { move_units_to_uncategorized } = req.body; // Boolean

    const client = await metadataPool.connect();
    try {
        await client.query('BEGIN');

        // 1. Verify Ownership & Children
        const { rows: tagRows } = await client.query("SELECT id FROM knowledge.defined_tags WHERE id = $1 AND created_by = $2", [tagId, userId]);
        if (tagRows.length === 0) throw new Error("Tag not found or unauthorized");

        const { rows: childRows } = await client.query("SELECT id FROM knowledge.defined_tags WHERE parent_id = $1", [tagId]);
        if (childRows.length > 0) {
            throw new Error("Cannot delete tag with children. Please move or delete child tags first.");
        }

        // 2. Handle Units
        if (move_units_to_uncategorized) {
            // Find or Create "Uncategorized" tag
            let uncategId;
            const { rows: uRows } = await client.query("SELECT id FROM knowledge.defined_tags WHERE label = 'Uncategorized' AND created_by = $1", [userId]);
            
            if (uRows.length > 0) {
                uncategId = uRows[0].id;
            } else {
                const { rows: ins } = await client.query(
                    "INSERT INTO knowledge.defined_tags (label, created_by, is_official) VALUES ('Uncategorized', $1, FALSE) RETURNING id",
                    [userId]
                );
                uncategId = ins[0].id;
            }

            // Move unit links safely without colliding if a unit already had 'Uncategorized'
            await client.query(
                `INSERT INTO knowledge.unit_tags (unit_id, tag_id)
                 SELECT unit_id, $1 FROM knowledge.unit_tags WHERE tag_id = $2
                 ON CONFLICT DO NOTHING`,
                [uncategId, tagId]
            );
            await client.query("DELETE FROM knowledge.unit_tags WHERE tag_id = $1", [tagId]);
        } else {
            // Delete unit links (Cascade usually handles this, but let's be explicit)
            await client.query("DELETE FROM knowledge.unit_tags WHERE tag_id = $1", [tagId]);
        }

        // 3. Delete the Tag
        await client.query("DELETE FROM knowledge.defined_tags WHERE id = $1", [tagId]);

        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(400).json({ error: err.message });
    } finally {
        client.release();
    }
});

// DELETE KNOWLEDGE UNIT (With Partner Cleanup)
app.delete('/api/contribute/unit/:id', authenticateExtension, async (req, res) => {
    const unitId = parseInt(req.params.id, 10);
    const userId = req.user.uid;
    const userRole = req.user.role;

    if (isNaN(unitId)) return res.status(400).json({ error: "Invalid ID" });

    let client;
    try {
        client = await metadataPool.connect();
        await client.query('BEGIN');

        // 1. Fetch Unit to check ownership & type
        const { rows: units } = await client.query("SELECT * FROM knowledge.logical_units WHERE id = $1", [unitId]);
        
        if (units.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: "Unit not found" });
        }
        
        const unitToDelete = units[0];

        // 2. Strict Permission Check (Backend Enforcement)
        if (unitToDelete.created_by !== userId && userRole !== 'admin') {
            await client.query('ROLLBACK');
            return res.status(403).json({ error: "Unauthorized. You can only delete your own contributions." });
        }

        // 3. Identify Partner (For Link Tab)
        // If this unit is part of a relationship (link_subject/link_object), we often want to delete the partner too
        // so we don't leave a dangling "half-link".
        let partnerId = null;
        if (unitToDelete.unit_type === 'link_subject' || unitToDelete.unit_type === 'link_object') {
            const { rows: rels } = await client.query(`
                SELECT subject_unit_id, object_unit_id 
                FROM knowledge.unit_relationships 
                WHERE subject_unit_id = $1 OR object_unit_id = $2
            `, [unitId, unitId]);

            if (rels.length > 0) {
                const r = rels[0];
                partnerId = (Number(r.subject_unit_id) === unitId) ? r.object_unit_id : r.subject_unit_id;
            }
        }

        // 4. Delete the Target Unit
        // (Cascading Foreign Keys will automatically remove the row from unit_relationships)
        await client.query("DELETE FROM knowledge.logical_units WHERE id = $1", [unitId]);

        // 5. Delete Partner (If applicable and it's also a link node)
        if (partnerId) {
            const { rows: pRows } = await client.query("SELECT unit_type FROM knowledge.logical_units WHERE id = $1", [partnerId]);
            if (pRows.length > 0) {
                const pType = pRows[0].unit_type;
                // Only auto-delete the partner if it is strictly a link node. 
                // Do NOT auto-delete if the partner is a 'tablet' or 'user_highlight' that was linked to.
                if (pType === 'link_subject' || pType === 'link_object') {
                    await client.query("DELETE FROM knowledge.logical_units WHERE id = $1", [partnerId]);
                }
            }
        }

        await client.query('COMMIT');
        res.json({ success: true });

    } catch (err) {
        if (client) await client.query('ROLLBACK');
        console.error("Delete Error:", err);
        res.status(500).json({ error: "Database error" });
    } finally {
        if (client) client.release();
    }
});

// ==================================================================
// IMAGE AUTO-ANNOTATION (MTCNN + GEMINI)
// ==================================================================
app.options('/api/auto-annotate', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', 'https://bahai.media');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.sendStatus(204);
});

app.post('/api/auto-annotate', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', 'https://bahai.media');

    const { image_url, caption } = req.body;
    if (!image_url) {
        return res.status(400).json({ error: 'image_url is required' });
    }

    // Point to your Python executable (update to your venv path if needed, e.g. '/path/to/venv/bin/python')
    const pythonBin = process.env.PYTHON_BIN || 'python3';
    const workerPath = path.join(__dirname, 'annotate_worker.py');

    const py = spawn(pythonBin, [workerPath], {
        env: { ...process.env } // Passes GEMINI_API_KEY from .env to Python
    });

    let stdoutData = '';
    let stderrData = '';

    py.stdout.on('data', (chunk) => { stdoutData += chunk.toString(); });
    py.stderr.on('data', (chunk) => { stderrData += chunk.toString(); });

    py.on('close', (code) => {
        if (code !== 0) {
            logger.error(`[AutoAnnotate] Python exited with ${code}: ${stderrData}`);
            return res.status(500).json({ error: 'Annotation worker failed', details: stderrData });
        }

        const match = stdoutData.match(/___JSON_START___([\s\S]*?)___JSON_END___/);
        if (!match) {
            logger.error(`[AutoAnnotate] Invalid output: ${stdoutData}`);
            return res.status(500).json({ error: 'Invalid response from worker' });
        }

        try {
            const parsed = JSON.parse(match[1]);
            res.json(parsed);
        } catch (err) {
            res.status(500).json({ error: 'Failed to parse worker JSON' });
        }
    });

    py.stdin.write(JSON.stringify({ image_url, caption: caption || '' }));
    py.stdin.end();
});

// END //
app.listen(PORT, () => {
    console.log(`Primary site running at http://localhost:${PORT}`);
});
