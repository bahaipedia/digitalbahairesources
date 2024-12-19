/* Main pageview analysis tool function */
document.addEventListener('DOMContentLoaded', () => {
    const websiteSelect = document.getElementById('website-select');
    const titleInput = document.getElementById('title-input');
    const autocompleteList = document.getElementById('autocomplete-list');
    const chartCanvas = document.getElementById('pageview-chart');
    const selectedTitlesContainer = document.getElementById('selected-titles-container'); // New container for displaying selected titles

    const fromMonthSelect = document.getElementById('from-month-select');
    const fromYearSelect = document.getElementById('from-year-select');
    const toMonthSelect = document.getElementById('to-month-select');
    const toYearSelect = document.getElementById('to-year-select');

    let selectedTitles = [];
    let chart;

    // Fetch and render default data when the page loads
    const fetchAndRenderDefaultData = async () => {
        const defaultWebsiteId = 'bahaipedia.org';
        const defaultTitles = ['Nine Year Plan (2022-2031)']; 
        const currentYear = new Date().getFullYear();
        const currentMonth = new Date().getMonth() + 1;

        // Set default date range to the last 12 months
        fromYearSelect.value = currentYear - 1;
        fromMonthSelect.value = currentMonth;
        toYearSelect.value = currentYear;
        toMonthSelect.value = currentMonth;

        // Set default website and titles
        selectedTitles = defaultTitles;
        displaySelectedTitles(); // Show selected titles
        await renderChart();
    };

    // Function to fetch autocomplete suggestions
    const fetchAutocomplete = async (term) => {
        const params = new URLSearchParams({
            term: term,
            website_id: websiteSelect.value
        });

        const response = await fetch(`/api/search-titles?${params}`);
        return await response.json();
    };

    // Function to fetch hits data for selected titles
    const fetchHitsData = async () => {
        if (selectedTitles.length === 0) return [];

        const params = new URLSearchParams({
            website_id: websiteSelect.value,
            titles: selectedTitles.join(','),
            from_year: fromYearSelect.value,
            from_month: fromMonthSelect.value,
            to_year: toYearSelect.value,
            to_month: toMonthSelect.value
        });

        const response = await fetch(`/api/pageview-data?${params}`);
        return await response.json();
    };

    // Function to render the chart
    const renderChart = async () => {
        const data = await fetchHitsData();

        // Process data into datasets
        const datasets = [];
        const labelsSet = new Set();

        // Organize data by title
        const dataByTitle = {};
        data.forEach(d => {
            const dateLabel = `${d.year}-${String(d.month).padStart(2, '0')}`;
            labelsSet.add(dateLabel);

            if (!dataByTitle[d.url]) dataByTitle[d.url] = {};
            dataByTitle[d.url][dateLabel] = d.hits;
        });

        const labels = Array.from(labelsSet).sort();

        // Create datasets for each title
        Object.keys(dataByTitle).forEach((title, index) => {
            const datasetData = labels.map(label => dataByTitle[title][label] || 0);

            datasets.push({
                label: title,
                data: datasetData,
                fill: false,
                borderColor: getColor(index),
                tension: 0.1
            });
        });

        // Calculate total hits and monthly average
        let totalHits = data.reduce((sum, d) => sum + d.hits, 0);

        // Calculate the number of months in the selected range
        const monthsDiff = (toYearSelect.value - fromYearSelect.value) * 12 + (toMonthSelect.value - fromMonthSelect.value) + 1;
        const monthlyAverage = totalHits / monthsDiff;

        // Update the "Data" table
        document.getElementById('total-pageviews').textContent = totalHits;
        document.getElementById('monthly-average').textContent = monthlyAverage.toFixed(2);

        // Destroy existing chart if it exists
        if (chart) chart.destroy();

        // Render new chart
        chart = new Chart(chartCanvas, {
            type: 'line',
            data: {
                labels: labels,
                datasets: datasets
            },
            options: {
                responsive: true,
                interaction: {
                    mode: 'index',
                    intersect: false
                },
                plugins: {
                    tooltip: {
                        mode: 'index',
                        intersect: false
                    },
                    legend: {
                        display: true
                    }
                },
                scales: {
                    x: {
                        title: {
                            display: true,
                            text: 'Month'
                        }
                    },
                    y: {
                        title: {
                            display: true,
                            text: 'Hits'
                        },
                        beginAtZero: true
                    }
                }
            }
        });

        // Update the details table
        updateDetailsTable(data, monthsDiff);
    };

    // Function to update the details table based on the data
    const updateDetailsTable = (data, monthsDiff) => {
        const tbody = document.querySelector('#details-table tbody');
        tbody.innerHTML = ''; // Clear the table

        const titlesData = {};

        data.forEach(d => {
            if (!titlesData[d.url]) {
                titlesData[d.url] = {
                    hits: 0
                    // Placeholder for future data: edits, editors, size, links
                };
            }
            titlesData[d.url].hits += d.hits;
        });

        Object.keys(titlesData).forEach(title => {
            const info = titlesData[title];
            const row = document.createElement('tr');

            row.innerHTML = `
                <td><a href="https://${websiteSelect.options[websiteSelect.selectedIndex].text}/${encodeURIComponent(title)}" target="_blank">${title}</a></td>
                <td>${info.hits}</td>
                <td>${(info.hits / monthsDiff).toFixed(2)}</td>
                <td></td>
                <td></td>
                <td></td>
                <td></td>
            `;
            tbody.appendChild(row);
        });
    };

    // Function to generate consistent colors
    const getColor = (index) => {
        const colors = ['#FF6384', '#36A2EB', '#FFCE56', '#4BC0C0', '#9966FF', '#FF9F40'];
        return colors[index % colors.length];
    };

    // Display selected titles with remove buttons
    const displaySelectedTitles = () => {
        selectedTitlesContainer.innerHTML = ''; // Clear previous entries

        selectedTitles.forEach(title => {
            const titleItem = document.createElement('div');
            titleItem.textContent = title;

            const removeButton = document.createElement('button');
            removeButton.textContent = 'Remove';
            removeButton.addEventListener('click', () => removeTitle(title));

            titleItem.appendChild(removeButton);
            selectedTitlesContainer.appendChild(titleItem);
        });
    };

    // Add title to the selected list and update chart
    const addTitle = (title) => {
        if (!selectedTitles.includes(title)) {
            selectedTitles.push(title);
            displaySelectedTitles();
            renderChart();
        }
    };

    // Remove title from the selected list and update chart
    const removeTitle = (title) => {
        selectedTitles = selectedTitles.filter(t => t !== title);
        displaySelectedTitles();
        renderChart();
    };

    // Handle autocomplete for title input
    titleInput.addEventListener('input', async () => {
        const term = titleInput.value.trim();
        autocompleteList.innerHTML = '';

        if (term.length > 0) {
            const suggestions = await fetchAutocomplete(term);
            suggestions.forEach(title => {
                const item = document.createElement('li');
                item.textContent = title;
                item.addEventListener('click', () => {
                    addTitle(title);
                    titleInput.value = '';
                    autocompleteList.innerHTML = '';
                });
                autocompleteList.appendChild(item);
            });
        }
    });

    // Handle 'Enter' key press in title input
    titleInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            const title = titleInput.value.trim();
            if (title) {
                addTitle(title);
                titleInput.value = '';
                autocompleteList.innerHTML = '';
            }
            e.preventDefault();
        }
    });

    // Handle website change
    websiteSelect.addEventListener('change', () => {
        selectedTitles = [];
        titleInput.value = '';
        autocompleteList.innerHTML = '';
        if (chart) chart.destroy();
        displaySelectedTitles();

        // Clear the details table
        const tbody = document.querySelector('#details-table tbody');
        if (tbody) {
            tbody.innerHTML = '';
        }   
    });

    // Handle date range selection
    [fromMonthSelect, fromYearSelect, toMonthSelect, toYearSelect].forEach(select => {
        select.addEventListener('change', () => {
            renderChart();
        });
    });

    // Initialize the chart with default data
    fetchAndRenderDefaultData();
});
