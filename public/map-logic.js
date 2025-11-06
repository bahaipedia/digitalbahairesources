document.addEventListener('DOMContentLoaded', () => {
    // Check for URL Parameters to center the map on a specific point.
    const urlParams = new URLSearchParams(window.location.search);
    const targetLat = parseFloat(urlParams.get('lat'));
    const targetLon = parseFloat(urlParams.get('lon'));
    const targetZoom = parseInt(urlParams.get('zoom'), 10) || 17; // Default to a close zoom
    const targetQID = urlParams.get('qid');

    // Use URL params if they exist, otherwise use the default view.
    const initialView = (targetLat && targetLon) ? [targetLat, targetLon] : [32.818, 34.988];
    const initialZoom = (targetLat && targetLon) ? targetZoom : 10;

    const map = L.map('map').setView(initialView, initialZoom);
    
    // Layer group to hold all markers, so we can clear them easily.
    const markersLayer = L.layerGroup().addTo(map);

    map.on('moveend', function() {
        const center = map.getCenter();
        const zoom = map.getZoom();
        const urlParams = new URLSearchParams(window.location.search);
        urlParams.set('lat', center.lat.toFixed(5));
        urlParams.set('lon', center.lng.toFixed(5));
        urlParams.set('zoom', zoom);
        const newUrl = `${window.location.pathname}?${urlParams.toString()}`;
        window.history.replaceState({}, '', newUrl);
    });
    
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);

    const sparqlEndpoint = 'https://query.bahaidata.org/proxy/sparql';
    
    // Base SPARQL query with a placeholder for filters.
    const baseSparqlQuery = `
        SELECT ?item ?itemLabel ?coords ?bahaipedia_link ?bahaimedia_link WHERE {
          ?item wdt:P20 ?coords.
          /* FILTER_PLACEHOLDER */
          OPTIONAL { ?bahaipedia_link schema:about ?item; schema:isPartOf <https://bahaipedia.org/>. }
          OPTIONAL { ?bahaimedia_link schema:about ?item; schema:isPartOf <https://bahai.media/>. }
          SERVICE wikibase:label { bd:serviceParam wikibase:language "[AUTO_LANGUAGE],en". }
        }
    `;

    // --- Main function to fetch and draw markers ---
    // This can be called anytime we need to refresh the map data.
    function fetchAndDrawMarkers(sparqlQuery) {
        // Clear existing markers before drawing new ones.
        markersLayer.clearLayers();
        
        // Display a loading message or spinner can be added here.

        fetch(sparqlEndpoint, {
            method: 'POST',
            headers: {
                'Accept': 'application/sparql-results+json',
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
            },
            body: 'query=' + encodeURIComponent(sparqlQuery)
        })
        .then(response => response.json())
        .then(data => {
            const items = data.results.bindings;
            
            items.forEach(item => {
                const coordsString = item.coords?.value;
                if (!coordsString) return;

                const match = coordsString.match(/Point\(([-\d\.]+) ([-\d\.]+)\)/);
                if (!match) return;

                const lon = parseFloat(match[1]);
                const lat = parseFloat(match[2]);

                const customIcon = getIconForSitelinks(item);
                
                let popupContent = `<b>${item.itemLabel?.value || 'No label'}</b>`;
                if (item.bahaipedia_link?.value) {
                    popupContent += `<br><a href="${item.bahaipedia_link.value}" target="_blank">Bahaipedia Article</a>`;
                }
                if (item.bahaimedia_link?.value) {
                    popupContent += `<br><a href="${item.bahaimedia_link.value}" target="_blank">Bahai.media Category</a>`;
                }

                const marker = L.marker([lat, lon], { icon: customIcon })
                    .bindPopup(popupContent);
                
                markersLayer.addLayer(marker);

                // Check if this marker's QID matches the one from the URL and open its popup.
                const currentQID = item.item.value.split('/').pop();
                if (currentQID === targetQID) {
                    marker.openPopup();
                }
            });
        })
        .catch(error => {
            console.error('Error fetching or processing SPARQL data:', error);
            alert("An error occurred while fetching data. The SPARQL query might be invalid. Check the console for details.");
        });
    }

    // --- Configuration for filters ---
    // Add or remove items here. Key is the QID, value is the display label.
    const filterConfig = {
        'Q6828': 'continental House of Worship',
        'Q6835': 'national House of Worship',
        'Q6841': 'local House of Worship'
    };
    
    // --- Custom Leaflet Control for Legend, Filters, and Query Editor ---
    const MapControl = L.Control.extend({
        onAdd: function(map) {
            const container = L.DomUtil.create('div', 'map-controls');
            L.DomEvent.disableClickPropagation(container); // Prevents map clicks when interacting with the control

            // 1. Legend Section (expanded by default)
            const legendDetails = L.DomUtil.create('details', '', container);
            legendDetails.open = true;
            const legendSummary = L.DomUtil.create('summary', '', legendDetails);
            legendSummary.innerText = 'Legend';
            const legendContent = L.DomUtil.create('div', '', legendDetails);
            
            const legendItems = [
                { icon: bothIcon, text: 'Bahaipedia & Bahai.media' },
                { icon: bahaipediaIcon, text: 'Bahaipedia only' },
                { icon: bahaimediaIcon, text: 'Bahai.media only' },
                { icon: defaultIcon, text: 'No specific links' }
            ];
            
            legendItems.forEach(item => {
                const legendItem = L.DomUtil.create('div', 'legend-item', legendContent);
                legendItem.innerHTML = `<img src="${item.icon.options.iconUrl}"><span>${item.text}</span>`;
            });

            // 2. Filter Section (expanded by default)
            const filterDetails = L.DomUtil.create('details', '', container);
            filterDetails.open = true;
            const filterSummary = L.DomUtil.create('summary', '', filterDetails);
            filterSummary.innerText = 'Filter';
            const filterContent = L.DomUtil.create('div', '', filterDetails);
            filterContent.innerHTML = '<label>Show items matching:</label>';

            const filterCheckboxes = L.DomUtil.create('div', '', filterContent);
            Object.entries(filterConfig).forEach(([qid, label]) => {
                const checkboxItem = L.DomUtil.create('div', 'filter-item', filterCheckboxes);
                checkboxItem.innerHTML = `<label><input type="checkbox" value="${qid}"> ${label}</label>`;
            });

            filterCheckboxes.addEventListener('change', () => {
                const checked = filterCheckboxes.querySelectorAll('input:checked');
                let filterClause = '';
                if (checked.length > 0) {
                    const qids = Array.from(checked).map(cb => `wd:${cb.value}`).join(' ');
                    filterClause = `?item wdt:P12 ?class. VALUES ?class { ${qids} }`;
                }
                const newQuery = baseSparqlQuery.replace('/* FILTER_PLACEHOLDER */', filterClause);
                document.getElementById('sparql-query-textarea').value = newQuery; // Update custom query box
                fetchAndDrawMarkers(newQuery);
            });


            // 3. Custom SPARQL Query Section (collapsed by default)
            const queryDetails = L.DomUtil.create('details', '', container);
            const querySummary = L.DomUtil.create('summary', '', queryDetails);
            querySummary.innerText = 'Custom SPARQL Query';
            const queryContent = L.DomUtil.create('div', '', queryDetails);

            const queryTextarea = L.DomUtil.create('textarea', '', queryContent);
            queryTextarea.id = 'sparql-query-textarea';
            queryTextarea.value = baseSparqlQuery.replace('/* FILTER_PLACEHOLDER */', '').trim();

            const queryButton = L.DomUtil.create('button', '', queryContent);
            queryButton.innerText = 'Run Query';
            queryButton.onclick = () => {
                fetchAndDrawMarkers(queryTextarea.value);
            };

            return container;
        }
    });

    // Add the new control to the top right of the map
    new MapControl({ position: 'topright' }).addTo(map);

    // Initial data load
    const initialQuery = baseSparqlQuery.replace('/* FILTER_PLACEHOLDER */', '').trim();
    fetchAndDrawMarkers(initialQuery);
});


// --- Helper functions for icons (unchanged)
const iconOptions = { iconSize: [70, 90], iconAnchor: [35, 90], popupAnchor: [0, -90] };

const bahaipediaIcon = L.icon({ iconUrl: 'https://file.bahai.media/8/80/Pedia-Map-Icon.png', ...iconOptions });
const bahaimediaIcon = L.icon({ iconUrl: 'https://file.bahai.media/b/b4/Media-Map-Icon.png', ...iconOptions });
const bothIcon = L.icon({ iconUrl: 'https://file.bahai.media/7/76/PediaMedia-Map-Icon.png', ...iconOptions });
const defaultIcon = L.icon({ iconUrl: 'https://file.bahai.media/9/95/Default-Map-Icon.png', ...iconOptions });

function getIconForSitelinks(item) {
    const hasBahaipedia = item.bahaipedia_link?.value;
    const hasBahaimedia = item.bahaimedia_link?.value;

    if (hasBahaipedia && hasBahaimedia) {
        return bothIcon;
    } else if (hasBahaipedia) {
        return bahaipediaIcon;
    } else if (hasBahaimedia) {
        return bahaimediaIcon;
    } else {
        return defaultIcon;
    }
}
