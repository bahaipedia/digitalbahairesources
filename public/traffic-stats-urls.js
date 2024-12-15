/* Top URLs page */
document.addEventListener('DOMContentLoaded', () => {
    const websiteSelect = document.getElementById('website-select');
    const serverSelect = document.getElementById('server-select');
    const yearSelect = document.getElementById('year-select');
    const monthSelect = document.getElementById('month-select');
    const tableHeader = document.querySelector('#urls-table-header');
    const tableBody = document.querySelector('#urls-table-body');

    const fetchData = async () => {
        const params = new URLSearchParams({
            website_id: websiteSelect.value !== 'all' ? websiteSelect.value : null,
            server_id: serverSelect.value !== 'all' ? serverSelect.value : null,
            year: yearSelect.value,
            month: monthSelect.value
        });

        try {
            const response = await fetch(`/api/traffic-stats/urls?${params}`);
            const data = await response.json();

            // Update table header dynamically
            if (websiteSelect.value === 'all') {
                tableHeader.innerHTML = `
                    <tr>
                        <th>Website</th>
                        <th>URL</th>
                        <th>Hits</th>
                    </tr>
                `;
            } else {
                tableHeader.innerHTML = `
                    <tr>
                        <th>URL</th>
                        <th>Hits</th>
                        <th>Entry</th>
                        <th>Exit</th>
                    </tr>
                `;
            }

            // Update table body with data
            tableBody.innerHTML = '';
            if (data.length > 0) {
                data.forEach(row => {
                    if (websiteSelect.value === 'all') {
                        // Display Website, URL, Hits
                        tableBody.innerHTML += `
                            <tr>
                                <td>${row.website_name}</td>
                                <td>${row.url}</td>
                                <td>${Number(row.total_hits)?.toLocaleString() || 0}</td>
                            </tr>
                        `;
                    } else {
                        // Display URL, Hits, Entry, Exit
                        tableBody.innerHTML += `
                            <tr>
                                <td>${row.url}</td>
                                <td>${Number(row.total_hits)?.toLocaleString() || 0}</td>
                                <td>${Number(row.total_entry)?.toLocaleString() || 0}</td>
                                <td>${Number(row.total_exit)?.toLocaleString() || 0}</td>
                            </tr>
                        `;
                    }
                });
            } else {
                tableBody.innerHTML = `
                    <tr>
                        <td colspan="${websiteSelect.value === 'all' ? 3 : 4}">No data available for the selected filters.</td>
                    </tr>
                `;
            }
        } catch (err) {
            console.error('Error fetching data:', err);
            tableBody.innerHTML = `
                <tr>
                    <td colspan="${websiteSelect.value === 'all' ? 3 : 4}">Error loading data. Please try again later.</td>
                </tr>
            `;
        }
    };

    [websiteSelect, serverSelect, yearSelect, monthSelect].forEach(select => {
        select.addEventListener('change', fetchData);
    });

    fetchData();
});
