// public/map-logic.js

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

    // Add the tile layer (the map background). This syntax is correct.
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);

    const sparqlEndpoint = 'https://query.bahaidata.org/proxy/sparql';
    const sparqlQuery = `
        SELECT ?item ?itemLabel ?coords ?bahaipedia_link ?bahaimedia_link WHERE {
          ?item wdt:P20 ?coords.
          OPTIONAL { ?bahaipedia_link schema:about ?item; schema:isPartOf <https://bahaipedia.org/>. }
          OPTIONAL { ?bahaimedia_link schema:about ?item; schema:isPartOf <https://bahai.media/>. }
          SERVICE wikibase:label { bd:serviceParam wikibase:language "[AUTO_LANGUAGE],en". }
        }
    `;

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
            
            // --- THIS SECTION IS NOW FIXED ---
            // It safely checks if each link exists before trying to add it to the popup.
            let popupContent = `<b>${item.itemLabel?.value || 'No label'}</b>`;
            if (item.bahaipedia_link?.value) {
                popupContent += `<br><a href="${item.bahaipedia_link.value}" target="_blank">Bahaipedia Article</a>`;
            }
            if (item.bahaimedia_link?.value) {
                popupContent += `<br><a href="${item.bahaimedia_link.value}" target="_blank">Bahai.media Category</a>`;
            }
            // --- END OF FIX ---

            const marker = L.marker([lat, lon], { icon: customIcon })
                .addTo(map)
                .bindPopup(popupContent);

            // Check if this marker's QID matches the one from the URL and open its popup.
            const currentQID = item.item.value.split('/').pop();
            if (currentQID === targetQID) {
                marker.openPopup();
            }
        });
    })
    .catch(error => console.error('Error fetching or processing SPARQL data:', error));
});

// --- Helper functions for icons 
const iconOptions = { iconSize: [70, 90], iconAnchor: [35, 90], popupAnchor: [0, -90] };

const bahaipediaIcon = L.icon({ iconUrl: 'https://file.bahai.media/8/80/Pedia-Map-Icon.png', ...iconOptions });
const bahaimediaIcon = L.icon({ iconUrl: 'https://file.bahai.media/b/b4/Media-Map-Icon.png', ...iconOptions });
const bothIcon = L.icon({ iconUrl: 'https://file.bahai.media/7/76/PediaMedia-Map-Icon.png', ...iconOptions });
const defaultIcon = L.icon({ iconUrl: 'https://file.bahai.media/9/95/Default-Map-Icon.png', ...iconOptions });

// --- Helper function to choose an icon based on sitelinks ---
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
