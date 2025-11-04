// public/map-logic.js

document.addEventListener('DOMContentLoaded', () => {
    const map = L.map('map').setView([32.818, 34.988], 10);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);

    const sparqlEndpoint = 'https://query.bahaidata.org/proxy/sparql';
    const sparqlQuery = `
        SELECT ?item ?itemLabel ?coords ?bahaipedia_link ?bahaimedia_link WHERE {
          ?item wdt:P20 ?coords.
          OPTIONAL {
            ?bahaipedia_link schema:about ?item; schema:isPartOf <https://bahaipedia.org/>.
          }
          OPTIONAL {
            ?bahaimedia_link schema:about ?item; schema:isPartOf <https://bahai.media/>.
          }
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

            // *** CHANGED: Use the new logic to get an icon based on the item's sitelinks ***
            const customIcon = getIconForSitelinks(item);
            
            let popupContent = `<b>${item.itemLabel?.value || 'No label'}</b>`;
            if (item.bahaipedia_link?.value) {
                popupContent += `<br><a href="${item.bahaipedia_link.value}" target="_blank">Bahaipedia Article</a>`;
            }
            if (item.bahaimedia_link?.value) {
                popupContent += `<br><a href="${item.bahaimedia_link.value}" target="_blank">Bahai.media Category</a>`;
            }

            L.marker([lat, lon], { icon: customIcon })
                .addTo(map)
                .bindPopup(popupContent);
        });
    })
    .catch(error => console.error('Error fetching or processing SPARQL data:', error));
});

// --- NEW: Define all the icon objects ---
// Ensure the iconUrl paths match the files you created.
// Using a consistent size and anchor point makes the map look clean.
const iconOptions = { iconSize: [70, 90], iconAnchor: [35, 90], popupAnchor: [0, -90] };

const bahaipediaIcon = L.icon({ iconUrl: 'https://file.bahai.media/8/80/Pedia-Map-Icon.png', ...iconOptions });
const bahaimediaIcon = L.icon({ iconUrl: 'https://file.bahai.media/b/b4/Media-Map-Icon.png', ...iconOptions });
const bothIcon = L.icon({ iconUrl: '../images/map-icons/PediaMedia-Map-Icon-smaller.png', ...iconOptions });
const defaultIcon = L.icon({ iconUrl: 'https://file.bahai.media/9/95/Default-Map-Icon.png', ...iconOptions });

// --- NEW: Helper function to choose an icon based on sitelinks ---
// This function replaces the old getIconForType function.
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
