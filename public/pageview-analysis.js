/* Create pageview analysis tool */
document.addEventListener('DOMContentLoaded', () => {
    const websiteSelect = document.getElementById('website-select');
    const titleInput = document.getElementById('title-input');
    const autocompleteList = document.getElementById('autocomplete-list');
    const chartCanvas = document.getElementById('pageview-chart');

    let selectedTitles = [];
    let chart;

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
            titles: selectedTitles.join(',')
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
    };

    // Function to generate consistent colors
    const getColor = (index) => {
        const colors = ['#FF6384', '#36A2EB', '#FFCE56', '#4BC0C0', '#9966FF', '#FF9F40'];
        return colors[index % colors.length];
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

    // Add title to the selected list and update chart
    const addTitle = (title) => {
        if (!selectedTitles.includes(title)) {
            selectedTitles.push(title);
            renderChart();
        }
    };

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
    });
});