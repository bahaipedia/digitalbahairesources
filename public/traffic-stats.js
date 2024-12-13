/* Build the summary header */
document.addEventListener('DOMContentLoaded', () => {
    const monthSelect = document.getElementById('month-select');
    const yearSelect = document.getElementById('year-select');
    const summaryMonth = document.getElementById('summary-month');
    const summaryYear = document.getElementById('summary-year');

    const monthNames = [
        "January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December"
    ];

    const updateSummaryHeading = () => {
        const selectedMonth = monthSelect.value;
        const selectedYear = yearSelect.value;

        summaryMonth.textContent = monthNames[selectedMonth - 1];
        summaryYear.textContent = selectedYear;
    };

    // Attach event listeners
    monthSelect.addEventListener('change', updateSummaryHeading);
    yearSelect.addEventListener('change', updateSummaryHeading);

    // Initial update on page load
    updateSummaryHeading();
});

/* Build Summary table */
document.addEventListener('DOMContentLoaded', () => {
    const websiteSelect = document.getElementById('website-select');
    const serverSelect = document.getElementById('server-select');
    const yearSelect = document.getElementById('year-select');
    const monthSelect = document.getElementById('month-select');
    const tableBody = document.querySelector('table tbody');

    const fetchData = async () => {
        const params = new URLSearchParams({
            website_id: websiteSelect.value !== 'all' ? websiteSelect.value : null,
            server_id: serverSelect.value !== 'all' ? serverSelect.value : null,
            year: yearSelect.value,
            month: monthSelect.value
        });

        try {
            const response = await fetch(`/api/traffic-stats?${params}`);
            const data = await response.json();

            // Check if data is valid
            if (data && Object.keys(data).length > 0) {
                tableBody.innerHTML = `
                    <tr>
                        <td>${new Date(year, row.month - 1).toLocaleString('default', { month: 'short', year: 'numeric' })}</td>
                        <td>${Number(row.unique_visitors).toLocaleString()}</td>
                        <td>${Number(row.number_of_visits).toLocaleString()}</td>
                        <td>${Number(row.pages).toLocaleString()}</td>
                        <td>${Number(row.hits).toLocaleString()}</td>
                        <td>${(Number(row.bandwidth) / 1024 / 1024 / 1024).toFixed(2)} GB</td>
                    </tr>
                `;
            } else {
                tableBody.innerHTML = `
                    <tr>
                        <td colspan="5">No data available for the selected filters.</td>
                    </tr>
                `;
            }
        } catch (err) {
            console.error('Error fetching data:', err);
            tableBody.innerHTML = `
                <tr>
                    <td colspan="5">Error loading data. Please try again later.</td>
                </tr>
            `;
        }
    };

    // Add event listeners to dropdowns
    [websiteSelect, serverSelect, yearSelect, monthSelect].forEach(select => {
        select.addEventListener('change', fetchData);
    });

    // Fetch data on page load
    fetchData();
});

/* Build summary pie charts */
document.addEventListener('DOMContentLoaded', () => {
    const metricSelect = document.getElementById('metric-select');
    const websiteChartCanvas = document.getElementById('website-chart');
    const serverChartCanvas = document.getElementById('server-chart');

    let websiteChart;
    let serverChart;

    // Fetch chart data and update charts
    const fetchChartData = async () => {
        const metric = metricSelect.value; // Get selected metric
        const params = new URLSearchParams({ metric });

        try {
            const response = await fetch(`/api/chart-data?${params}`);
            const data = await response.json();

            // Update the charts with live data
            websiteChart = updateChart(websiteChart, websiteChartCanvas, data.website, `Top 5 Websites (${metric})`);
            serverChart = updateChart(serverChart, serverChartCanvas, data.server, `All Servers (${metric})`);
        } catch (err) {
            console.error('Error fetching chart data:', err);
        }
    };

    // Update a chart with the provided data
    const updateChart = (chart, canvas, chartData, title) => {
        if (chart) chart.destroy(); // Destroy existing chart

        if (!chartData || chartData.length === 0) {
            canvas.parentElement.innerHTML = `<p>No data available for ${title}</p>`;
            return null;
        }

        return new Chart(canvas, {
            type: 'pie',
            data: {
                labels: chartData.map(item => item.label), 
                datasets: [{
                    data: chartData.map(item => Number(item.value) || 0),
                    backgroundColor: ['#FF6384', '#36A2EB', '#FFCE56', '#4BC0C0', '#9966FF', '#C9CBCF']
                }]
            },
            options: {
                responsive: false, 
                maintainAspectRatio: false, 
                plugins: {
                    legend: { position: 'bottom' },
                    title: { display: true, text: title }
                },
                layout: {
                    padding: 10
                }
            }
        });
    };

    // Event listener for metric dropdown change
    metricSelect.addEventListener('change', fetchChartData);

    // Initial Fetch
    fetchChartData();
});

/* Build monthly traffic header */
document.addEventListener('DOMContentLoaded', () => {
    const yearSelect = document.getElementById('year-select');
    const monthlyHistoryYear = document.getElementById('monthly-history-year');

    const updateMonthlyHistoryHeading = () => {
        const selectedYear = yearSelect.value;
        monthlyHistoryYear.textContent = selectedYear;
    };

    // Attach event listener to the year dropdown
    yearSelect.addEventListener('change', updateMonthlyHistoryHeading);

    // Initial update on page load
    updateMonthlyHistoryHeading();
});

/* Build monthly traffic table */
document.addEventListener('DOMContentLoaded', () => {
    const websiteSelect = document.getElementById('website-select');
    const serverSelect = document.getElementById('server-select');
    const yearSelect = document.getElementById('year-select');
    const monthlyTableBody = document.querySelector('#monthly-history .monthly-history-table tbody');

    const fetchMonthlyHistory = async () => {
        const year = yearSelect.value;
        const websiteParam = websiteSelect.value !== 'all' ? websiteSelect.value : null;
        const serverParam = serverSelect.value !== 'all' ? serverSelect.value : null;

        try {
            const response = await fetch(
                `/api/monthly-history?year=${year}&website_id=${websiteParam}&server_id=${serverParam}`
            );
            const { monthly, totals } = await response.json();

            if (monthly && monthly.length > 0) {
                const rows = monthly.map(row => `
                    <tr>
                        <td>${new Date(year, row.month - 1).toLocaleString('default', { month: 'short', year: 'numeric' })}</td>
                        <td>${Number(row.unique_visitors).toLocaleString()}</td>
                        <td>${Number(row.total_visits).toLocaleString()}</td>
                        <td>${Number(row.total_pages).toLocaleString()}</td>
                        <td>${Number(row.total_hits).toLocaleString()}</td>
                        <td>${(Number(row.total_bandwidth) / 1024 / 1024 / 1024).toFixed(2)} GB</td>
                    </tr>
                `).join('');

                const totalRow = `
                    <tr class="totals-row">
                        <td>Total</td>
                        <td>${Number(totals.unique_visitors).toLocaleString()}</td>
                        <td>${Number(totals.total_visits).toLocaleString()}</td>
                        <td>${Number(totals.total_pages).toLocaleString()}</td>
                        <td>${Number(totals.total_hits).toLocaleString()}</td>
                        <td>${(Number(totals.total_bandwidth) / 1024 / 1024 / 1024).toFixed(2)} GB</td>
                    </tr>
                `;

                monthlyTableBody.innerHTML = rows + totalRow;
            } else {
                monthlyTableBody.innerHTML = `
                    <tr>
                        <td colspan="6">No data available for the selected filters.</td>
                    </tr>
                `;
            }
        } catch (err) {
            console.error('Error fetching monthly history:', err);
            monthlyTableBody.innerHTML = `
                <tr>
                    <td colspan="6">Error loading data. Please try again later.</td>
                </tr>
            `;
        }
    };

    // Fetch monthly history on changes to website, server, and year
    websiteSelect.addEventListener('change', fetchMonthlyHistory);
    serverSelect.addEventListener('change', fetchMonthlyHistory);
    yearSelect.addEventListener('change', fetchMonthlyHistory);

    // Initial fetch
    fetchMonthlyHistory();
});
