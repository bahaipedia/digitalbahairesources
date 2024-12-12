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
