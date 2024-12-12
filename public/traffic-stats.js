/* Build the Summary header */
document.addEventListener('DOMContentLoaded', () => {
    const monthSelect = document.getElementById('month-select');
    const yearSelect = document.getElementById('year-select');
    const summaryHeading = document.querySelector('#traffic-summary h2');

    const updateSummaryHeading = () => {
        const monthNames = [
            "January", "February", "March", "April", "May", "June",
            "July", "August", "September", "October", "November", "December"
        ];
        const selectedMonth = monthSelect.value;
        const selectedYear = yearSelect.value;

        const monthName = monthNames[selectedMonth - 1];
        summaryHeading.textContent = `Summary for ${monthName}, ${selectedYear}`;
    };

    // Attach event listeners to dropdowns
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
                        <td>${Number(data.unique_visitors)?.toLocaleString() || 'N/A'}</td>
                        <td>${Number(data.total_visits)?.toLocaleString() || 0}</td>
                        <td>${Number(data.total_pages)?.toLocaleString() || 0}</td>
                        <td>${Number(data.total_hits)?.toLocaleString() || 0}</td>
                        <td>${(Number(data.total_bandwidth) / 1024 / 1024).toFixed(2).toLocaleString()} MB</td>
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
            const data = await response.json();

            if (data && data.length > 0) {
                monthlyTableBody.innerHTML = data.map(row => `
                    <tr>
                        <td>${new Date(year, row.month - 1).toLocaleString('default', { month: 'short', year: 'numeric' })}</td>
                        <td>${Number(row.unique_visitors).toLocaleString()}</td>
                        <td>${Number(row.total_visits).toLocaleString()}</td>
                        <td>${Number(row.total_pages).toLocaleString()}</td>
                        <td>${Number(row.total_hits).toLocaleString()}</td>
                        <td>${(Number(row.total_bandwidth) / 1024 / 1024 / 1024).toFixed(2)} GB</td>
                    </tr>
                `).join('');
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
