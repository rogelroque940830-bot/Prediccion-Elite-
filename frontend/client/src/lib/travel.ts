// Travel distance calculation for all sports
// Used to penalize visiting teams on long road trips
// Based on ESPN BPI methodology: longer travel = more fatigue

// Haversine formula: distance between two lat/lng coordinates in miles
export function haversineDistance(
  lat1: number, lon1: number,
  lat2: number, lon2: number,
): number {
  const R = 3959; // Earth radius in miles
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// Travel penalty in logit space
// < 500 miles = no penalty (regional)
// 500-1000 miles = small penalty (-0.01)
// 1000-2000 miles = moderate penalty (-0.02)
// 2000+ miles = significant penalty (-0.03) — coast-to-coast
// 2500+ miles = heavy penalty (-0.04) — e.g. SEA to MIA
export function travelPenalty(distanceMiles: number): number {
  if (distanceMiles < 500) return 0;
  if (distanceMiles < 1000) return -0.01;
  if (distanceMiles < 2000) return -0.02;
  if (distanceMiles < 2500) return -0.03;
  return -0.04;
}

// Arena coordinates: { "Team Name": [lat, lng] }
// NBA arenas
export const NBA_ARENAS: Record<string, [number, number]> = {
  "Atlanta Hawks": [33.757, -84.396],
  "Boston Celtics": [42.366, -71.062],
  "Brooklyn Nets": [40.682, -73.975],
  "Charlotte Hornets": [35.225, -80.839],
  "Chicago Bulls": [41.881, -87.674],
  "Cleveland Cavaliers": [41.496, -81.688],
  "Dallas Mavericks": [32.790, -96.810],
  "Denver Nuggets": [39.749, -105.008],
  "Detroit Pistons": [42.341, -83.055],
  "Golden State Warriors": [37.768, -122.388],
  "Houston Rockets": [29.751, -95.362],
  "Indiana Pacers": [39.764, -86.155],
  "LA Clippers": [33.944, -118.267],
  "Los Angeles Clippers": [33.944, -118.267],
  "Los Angeles Lakers": [34.043, -118.267],
  "Memphis Grizzlies": [35.138, -90.051],
  "Miami Heat": [25.781, -80.187],
  "Milwaukee Bucks": [43.045, -87.917],
  "Minnesota Timberwolves": [44.980, -93.276],
  "New Orleans Pelicans": [29.949, -90.082],
  "New York Knicks": [40.751, -73.994],
  "Oklahoma City Thunder": [35.463, -97.515],
  "Orlando Magic": [28.539, -81.384],
  "Philadelphia 76ers": [39.901, -75.172],
  "Phoenix Suns": [33.446, -112.071],
  "Portland Trail Blazers": [45.532, -122.667],
  "Sacramento Kings": [38.580, -121.499],
  "San Antonio Spurs": [29.427, -98.438],
  "Toronto Raptors": [43.643, -79.379],
  "Utah Jazz": [40.768, -111.901],
  "Washington Wizards": [38.898, -77.021],
};

// NHL arenas
export const NHL_ARENAS: Record<string, [number, number]> = {
  "ANA": [33.808, -117.877], "ARI": [33.446, -112.071], "BOS": [42.366, -71.062],
  "BUF": [42.875, -78.876], "CGY": [51.037, -114.052], "CAR": [35.803, -78.722],
  "CHI": [41.881, -87.674], "COL": [39.749, -105.008], "CBJ": [39.969, -83.006],
  "DAL": [32.790, -96.810], "DET": [42.341, -83.055], "EDM": [53.547, -113.498],
  "FLA": [26.158, -80.326], "LAK": [34.043, -118.267], "MIN": [44.945, -93.101],
  "MTL": [45.496, -73.569], "NSH": [36.159, -86.779], "NJD": [40.734, -74.171],
  "NYI": [40.682, -73.975], "NYR": [40.751, -73.994], "OTT": [45.297, -75.928],
  "PHI": [39.901, -75.172], "PIT": [40.440, -79.989], "SJS": [37.333, -121.901],
  "SEA": [47.622, -122.354], "STL": [38.627, -90.203], "TBL": [27.943, -82.452],
  "TOR": [43.643, -79.379], "UTA": [40.768, -111.901], "VAN": [49.278, -123.109],
  "VGK": [36.103, -115.178], "WPG": [49.893, -97.144], "WSH": [38.898, -77.021],
};

// WNBA arenas (by team name) — distancias más cortas que NBA pero relevantes
export const WNBA_ARENAS: Record<string, [number, number]> = {
  "Atlanta Dream": [33.757, -84.396],
  "Chicago Sky": [41.881, -87.674],
  "Connecticut Sun": [41.477, -71.957],
  "Dallas Wings": [32.732, -97.114],
  "Golden State Valkyries": [37.768, -122.388],
  "Indiana Fever": [39.764, -86.155],
  "Las Vegas Aces": [36.103, -115.178],
  "Los Angeles Sparks": [34.043, -118.267],
  "Minnesota Lynx": [44.980, -93.276],
  "New York Liberty": [40.683, -73.975],
  "Phoenix Mercury": [33.446, -112.071],
  "Portland Fire": [45.532, -122.667],
  "Seattle Storm": [47.622, -122.354],
  "Washington Mystics": [38.864, -76.987],
};

// Travel penalty específico WNBA — más leve que NBA porque la temporada es más corta
// y los vuelos comerciales no son tan agotadores como un calendario NBA de 82 juegos.
export function wnbaTravelPenalty(distanceMiles: number): number {
  if (distanceMiles < 500) return 0;
  if (distanceMiles < 1000) return -0.007;
  if (distanceMiles < 2000) return -0.014;
  if (distanceMiles < 2500) return -0.020;
  return -0.028;
}

// MLB arenas (by team name)
export const MLB_ARENAS: Record<string, [number, number]> = {
  "Arizona Diamondbacks": [33.446, -112.071],
  "Atlanta Braves": [33.891, -84.468],
  "Baltimore Orioles": [39.284, -76.622],
  "Boston Red Sox": [42.346, -71.098],
  "Chicago Cubs": [41.948, -87.656],
  "Chicago White Sox": [41.831, -87.634],
  "Cincinnati Reds": [39.097, -84.508],
  "Cleveland Guardians": [41.496, -81.685],
  "Colorado Rockies": [39.756, -104.994],
  "Detroit Tigers": [42.339, -83.049],
  "Houston Astros": [29.757, -95.355],
  "Kansas City Royals": [39.051, -94.480],
  "Los Angeles Angels": [33.800, -117.883],
  "Los Angeles Dodgers": [34.074, -118.240],
  "Miami Marlins": [25.778, -80.220],
  "Milwaukee Brewers": [43.028, -87.971],
  "Minnesota Twins": [44.982, -93.278],
  "New York Mets": [40.757, -73.846],
  "New York Yankees": [40.829, -73.926],
  "Athletics": [38.581, -121.508],
  "Philadelphia Phillies": [39.906, -75.167],
  "Pittsburgh Pirates": [40.447, -80.006],
  "San Diego Padres": [32.707, -117.157],
  "San Francisco Giants": [37.778, -122.389],
  "Seattle Mariners": [47.591, -122.332],
  "St. Louis Cardinals": [38.623, -90.193],
  "Tampa Bay Rays": [27.768, -82.653],
  "Texas Rangers": [32.751, -97.083],
  "Toronto Blue Jays": [43.641, -79.389],
  "Washington Nationals": [38.873, -77.007],
};

// Get travel distance between away team and home team
export function getAwayTravelDistance(
  awayTeam: string,
  homeTeam: string,
  sport: "nba" | "nhl" | "mlb" | "wnba",
): number {
  const arenas = sport === "nba" ? NBA_ARENAS : sport === "nhl" ? NHL_ARENAS : sport === "wnba" ? WNBA_ARENAS : MLB_ARENAS;
  const awayCoords = arenas[awayTeam];
  const homeCoords = arenas[homeTeam];
  if (!awayCoords || !homeCoords) return 0;
  return haversineDistance(awayCoords[0], awayCoords[1], homeCoords[0], homeCoords[1]);
}
