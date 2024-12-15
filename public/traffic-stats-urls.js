/* Dynamic h2 */
document.addEventListener('DOMContentLoaded', () => {
    const websiteSelect = document.getElementById('website-select');
    const header = document.querySelector('#urls-highlight h2');

    const updateHeader = () => {
        if (websiteSelect.value === 'all') {
            header.textContent = 'Top 25 URLs (All sites)';
        } else {
            header.textContent = `Top 200 URLs (${websiteSelect.options[websiteSelect.selectedIndex].text})`;
        }
    };

    // Update header on page load and when website selection changes
    updateHeader();
    websiteSelect.addEventListener('change', updateHeader);
});

/* Content area */
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
                        <th class="rank-header">Rank</th>
                        <th>Website</th>
                        <th>URL</th>
                        <th class="hits-header">Hits</th>
                    </tr>
                `;
            } else {
                tableHeader.innerHTML = `
                    <tr>
                        <th class="rank-header">Rank</th>
                        <th>URL</th>
                        <th class="hits-header">Hits</th>
                        <th class="entry-header">Entry</th>
                        <th class="exit-header">Exit</th>
                    </tr>
                `;
            }

            // Update table body with data
            tableBody.innerHTML = '';
            if (data.length > 0) {
                data.forEach((row, index) => {
                    const rank = index + 1; // Calculate rank
                    const formattedUrl = row.url.replace(/_/g, ' '); // Replace underscores with spaces

                    if (websiteSelect.value === 'all') {
                        const websiteName = websiteSelect.options[websiteSelect.selectedIndex].text;
                        tableBody.innerHTML += `
                            <tr>
                                <td class="rank-data">${rank}</td>
                                <td>${row.website_name}</td>
                                <td><a href="https://${row.website_name}/${websiteName === 'bahai9.com' ? 'wiki/' : ''}${row.url}" target="_blank">${formattedUrl}</a></td>
                                <td class="hits-data">${Number(row.total_hits)?.toLocaleString() || 0}</td>
                            </tr>
                        `;
                    } else {
                        tableBody.innerHTML += `
                            <tr>
                                <td class="rank-data">${rank}</td>
                                <td><a href="https://${websiteName}/${websiteName === 'bahai9.com' ? 'wiki/' : ''}${row.url}" target="_blank">${formattedUrl}</a></td>
                                <td class="hits-data">${Number(row.total_hits)?.toLocaleString() || 0}</td>
                                <td class="entry-data">${Number(row.total_entry)?.toLocaleString() || 0}</td>
                                <td class="exit-data">${Number(row.total_exit)?.toLocaleString() || 0}</td>
                            </tr>
                        `;
                    }
                });
            } else {
                tableBody.innerHTML = `
                    <tr>
                        <td colspan="${websiteSelect.value === 'all' ? 4 : 5}">No data available for the selected filters.</td>
                    </tr>
                `;
            }
        } catch (err) {
            console.error('Error fetching data:', err);
            tableBody.innerHTML = `
                <tr>
                    <td colspan="${websiteSelect.value === 'all' ? 4 : 5}">Error loading data. Please try again later.</td>
                </tr>
            `;
        }
    };

    [websiteSelect, serverSelect, yearSelect, monthSelect].forEach(select => {
        select.addEventListener('change', fetchData);
    });

    fetchData();
});
