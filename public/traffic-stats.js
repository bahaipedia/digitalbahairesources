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

            // Update table with the fetched data
            tableBody.innerHTML = `
                <tr>
                    <td>${data.unique_visitors || 'N/A'}</td>
                    <td>${data.total_visits || 0}</td>
                    <td>${data.total_pages || 0}</td>
                    <td>${data.total_hits || 0}</td>
                    <td>${(data.total_bandwidth / 1024 / 1024).toFixed(2) || 0} MB</td>
                </tr>
            `;
        } catch (err) {
            console.error('Error fetching data:', err);
        }
    };

    // Add event listeners to dropdowns
    [websiteSelect, serverSelect, yearSelect, monthSelect].forEach(select => {
        select.addEventListener('change', fetchData);
    });

    // Fetch data on page load
    fetchData();
});
