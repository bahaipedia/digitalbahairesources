// public/map-logic.js

document.addEventListener('DOMContentLoaded', () => {
    // 1. Initialize the Leaflet Map
    const map = L.map('map').setView([32.818, 34.988], 10); // Center on Haifa initially

    // 2. Add the tile layer (the map background) from OpenStreetMap
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);

    // 3. Define the SPARQL query to get all items with coordinates
    const sparqlEndpoint = 'https://query.bahaidata.org/proxy/sparql';
    const sparqlQuery = `
        SELECT ?item ?itemLabel ?coords ?type ?bahaipedia_link ?bahaimedia_link WHERE {
          ?item wdt:P20 ?coords.
          OPTIONAL { ?item wdt:P31 ?type. }
          OPTIONAL {
            ?bahaipedia_link schema:about ?item;
                            schema:isPartOf <https://bahaipedia.org/>.
          }
          OPTIONAL {
            ?bahaimedia_link schema:about ?item;
                             schema:isPartOf <https://bahai.media/>.
          }
          SERVICE wikibase:label { bd:serviceParam wikibase:language "[AUTO_LANGUAGE],en". }
        }
    `;

    const queryUrl = sparqlEndpoint;

    // 4. Fetch the data from Bahaidata
    fetch(queryUrl, {
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
                // The coordinate format is "Point(LON LAT)"
                const coordsString = item.coords?.value;
                if (!coordsString) return;

                const match = coordsString.match(/Point\(([-\d\.]+) ([-\d\.]+)\)/);
                if (!match) return;

                const lon = parseFloat(match[1]);
                const lat = parseFloat(match[2]);

                // Choose a custom icon based on the item's type (P31)
                const typeQID = item.type?.value.split('/').pop(); // Extracts 'Q202'
                const customIcon = getIconForType(typeQID);
                
                // Build the popup content
                let popupContent = `<b>${item.itemLabel?.value || 'No label'}</b>`;
                if (item.bahaipedia_link?.value) {
                    popupContent += `<br><a href="${item.bahaipedia_link.value}" target="_blank">Bahaipedia Article</a>`;
                }
                if (item.bahaimedia_link?.value) {
                    popupContent += `<br><a href="${item.bahaimedia_link.value}" target="_blank">Bahai.media Category</a>`;
                }

                // Add the marker to the map
                L.marker([lat, lon], { icon: customIcon })
                    .addTo(map)
                    .bindPopup(popupContent);
            });
        })
        .catch(error => console.error('Error fetching or processing SPARQL data:', error));
});


// --- Helper function for Custom Icons ---
// You will need to create these icon images and place them in `public/images/map-icons/`
const houseOfWorshipIcon = L.icon({ iconUrl: '/images/map-icons/house-of-worship.png', iconSize: [32, 32], iconAnchor: [16, 32], popupAnchor: [0, -32] });
const graveSiteIcon = L.icon({ iconUrl: '/images/map-icons/grave-site.png', iconSize: [32, 32], iconAnchor: [16, 32], popupAnchor: [0, -32] });
const defaultIcon = L.icon({ iconUrl: '/images/map-icons/default-pin.png', iconSize: [25, 41], iconAnchor: [12, 41], popupAnchor: [1, -34] }); // Standard Leaflet pin size

function getIconForType(typeQID) {
    switch (typeQID) {
        // IMPORTANT: Replace these with the actual Q-IDs from Bahaidata
        case 'Q_HouseOfWorship': 
            return houseOfWorshipIcon;
        case 'Q_GraveSite':
            return graveSiteIcon;
        default:
            return defaultIcon;
    }
}
