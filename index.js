const express = require('express');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3008;

// Middleware
app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Routes
app.get('/', (req, res) => res.render('index'));
app.get('/about', (req, res) => res.render('about'));
app.get('/projects', (req, res) => res.render('projects'));
app.get('/contact', (req, res) => res.render('contact'));

app.listen(PORT, () => {
    console.log(`Primary site running at http://localhost:${PORT}`);
});
