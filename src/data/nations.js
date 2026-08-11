/*
 * Playable powers.  Each nation is seeded from its capital's real-world
 * coordinates; worldgen grows its territory outward from the province that
 * lands closest to that point.
 *
 * `region` selects the syllable set used to name its provinces.
 * `reach` is how many provinces the nation starts with; the rest of the map
 * is left unclaimed for the powers to race for.
 */
(function (global) {
  'use strict';

  var NATIONS = [
    { id: 'usa', name: 'United States', adj: 'American', capital: 'Washington', lat: 38.9, lon: -77.0, color: '#3f7fd6', region: 'anglo', reach: 9, aggression: 0.55 },
    { id: 'can', name: 'Canada', adj: 'Canadian', capital: 'Ottawa', lat: 45.4, lon: -75.7, color: '#d94f4f', region: 'anglo', reach: 5, aggression: 0.30 },
    { id: 'mex', name: 'Mexico', adj: 'Mexican', capital: 'Mexico City', lat: 19.4, lon: -99.1, color: '#4fae7a', region: 'iberian', reach: 3, aggression: 0.40 },
    { id: 'bra', name: 'Brazil', adj: 'Brazilian', capital: 'Brasilia', lat: -15.8, lon: -47.9, color: '#3fb14f', region: 'iberian', reach: 6, aggression: 0.40 },
    { id: 'arg', name: 'Argentina', adj: 'Argentine', capital: 'Buenos Aires', lat: -34.6, lon: -58.4, color: '#6fc6dc', region: 'iberian', reach: 4, aggression: 0.42 },
    { id: 'col', name: 'Colombia', adj: 'Colombian', capital: 'Bogota', lat: 4.7, lon: -74.1, color: '#e0c04a', region: 'iberian', reach: 2, aggression: 0.38 },
    { id: 'gbr', name: 'United Kingdom', adj: 'British', capital: 'London', lat: 51.5, lon: -0.13, color: '#8f5fd0', region: 'anglo', reach: 2, aggression: 0.50 },
    { id: 'fra', name: 'France', adj: 'French', capital: 'Paris', lat: 48.9, lon: 2.35, color: '#4a6fd6', region: 'latin', reach: 3, aggression: 0.48 },
    { id: 'ger', name: 'Germany', adj: 'German', capital: 'Berlin', lat: 52.5, lon: 13.4, color: '#8e8e8e', region: 'germanic', reach: 3, aggression: 0.55 },
    { id: 'esp', name: 'Spain', adj: 'Spanish', capital: 'Madrid', lat: 40.4, lon: -3.7, color: '#e08a3c', region: 'iberian', reach: 2, aggression: 0.40 },
    { id: 'ita', name: 'Italy', adj: 'Italian', capital: 'Rome', lat: 41.9, lon: 12.5, color: '#5fc08a', region: 'latin', reach: 2, aggression: 0.45 },
    { id: 'pol', name: 'Poland', adj: 'Polish', capital: 'Warsaw', lat: 52.2, lon: 21.0, color: '#d05f8a', region: 'slavic', reach: 2, aggression: 0.42 },
    { id: 'ukr', name: 'Ukraine', adj: 'Ukrainian', capital: 'Kyiv', lat: 50.5, lon: 30.5, color: '#e0d24a', region: 'slavic', reach: 3, aggression: 0.45 },
    { id: 'rus', name: 'Russia', adj: 'Russian', capital: 'Moscow', lat: 55.8, lon: 37.6, color: '#c0453f', region: 'slavic', reach: 10, aggression: 0.62 },
    { id: 'tur', name: 'Turkey', adj: 'Turkish', capital: 'Ankara', lat: 39.9, lon: 32.9, color: '#e05f5f', region: 'turkic', reach: 3, aggression: 0.52 },
    { id: 'egy', name: 'Egypt', adj: 'Egyptian', capital: 'Cairo', lat: 30.0, lon: 31.2, color: '#c9a24a', region: 'arabic', reach: 3, aggression: 0.45 },
    { id: 'nga', name: 'Nigeria', adj: 'Nigerian', capital: 'Abuja', lat: 9.1, lon: 7.5, color: '#4fbf9f', region: 'african', reach: 3, aggression: 0.40 },
    { id: 'eth', name: 'Ethiopia', adj: 'Ethiopian', capital: 'Addis Ababa', lat: 9.0, lon: 38.7, color: '#7fbf4f', region: 'african', reach: 2, aggression: 0.38 },
    { id: 'zaf', name: 'South Africa', adj: 'South African', capital: 'Pretoria', lat: -25.7, lon: 28.2, color: '#4f9fbf', region: 'african', reach: 3, aggression: 0.36 },
    { id: 'sau', name: 'Saudi Arabia', adj: 'Saudi', capital: 'Riyadh', lat: 24.7, lon: 46.7, color: '#3f9f6f', region: 'arabic', reach: 3, aggression: 0.44 },
    { id: 'irn', name: 'Iran', adj: 'Iranian', capital: 'Tehran', lat: 35.7, lon: 51.4, color: '#9fc04a', region: 'persian', reach: 4, aggression: 0.55 },
    { id: 'ind', name: 'India', adj: 'Indian', capital: 'New Delhi', lat: 28.6, lon: 77.2, color: '#e09a3c', region: 'indic', reach: 6, aggression: 0.45 },
    { id: 'pak', name: 'Pakistan', adj: 'Pakistani', capital: 'Islamabad', lat: 33.7, lon: 73.1, color: '#3f8f5f', region: 'indic', reach: 3, aggression: 0.50 },
    { id: 'chn', name: 'China', adj: 'Chinese', capital: 'Beijing', lat: 39.9, lon: 116.4, color: '#d0453f', region: 'sinic', reach: 9, aggression: 0.58 },
    { id: 'mng', name: 'Mongolia', adj: 'Mongolian', capital: 'Ulaanbaatar', lat: 47.9, lon: 106.9, color: '#c96f3c', region: 'turkic', reach: 3, aggression: 0.40 },
    { id: 'jpn', name: 'Japan', adj: 'Japanese', capital: 'Tokyo', lat: 35.7, lon: 139.7, color: '#e3567f', region: 'japonic', reach: 2, aggression: 0.50 },
    { id: 'kor', name: 'Korea', adj: 'Korean', capital: 'Seoul', lat: 37.6, lon: 127.0, color: '#5f8fe0', region: 'japonic', reach: 2, aggression: 0.45 },
    { id: 'idn', name: 'Indonesia', adj: 'Indonesian', capital: 'Jakarta', lat: -6.2, lon: 106.8, color: '#bf4f9f', region: 'malay', reach: 5, aggression: 0.40 },
    { id: 'aus', name: 'Australia', adj: 'Australian', capital: 'Canberra', lat: -35.3, lon: 149.1, color: '#dfae4f', region: 'anglo', reach: 5, aggression: 0.34 },
    { id: 'kaz', name: 'Kazakhstan', adj: 'Kazakh', capital: 'Astana', lat: 51.2, lon: 71.4, color: '#4fc0c0', region: 'turkic', reach: 4, aggression: 0.38 }
  ];

  /* Syllables used to invent province names with a regional flavour. */
  var SYLLABLES = {
    anglo: { a: ['New', 'North', 'Port', 'Fort', 'Green', 'King', 'West', 'Spring', 'Red', 'Black'], b: ['field', 'ford', 'wood', 'ton', 'burg', 'stone', 'haven', 'dale', 'bridge', 'shire'] },
    latin: { a: ['Mont', 'Ville', 'Bel', 'Cast', 'Ver', 'Sal', 'Ora', 'Pia', 'Riv', 'Ter'], b: ['ane', 'igny', 'anza', 'ello', 'ona', 'iers', 'ago', 'esse', 'ino', 'arre'] },
    iberian: { a: ['San', 'Villa', 'Puerto', 'Rio', 'Val', 'Alta', 'Cerro', 'Nova', 'Sierra', 'Campo'], b: ['dena', 'mara', 'lucia', 'vera', 'nejo', 'blanca', 'grande', 'tera', 'santo', 'reira'] },
    germanic: { a: ['Ober', 'Nieder', 'Neu', 'Alt', 'Frei', 'Schwarz', 'Hohen', 'Wald', 'Stein', 'Rhein'], b: ['berg', 'burg', 'feld', 'heim', 'stadt', 'bruck', 'walde', 'furt', 'thal', 'hafen'] },
    slavic: { a: ['Novo', 'Bela', 'Krasno', 'Staro', 'Zele', 'Vyso', 'Cherno', 'Ozer', 'Kamen', 'Volo'] , b: ['grad', 'sk', 'vka', 'nice', 'ovo', 'polye', 'insk', 'ryn', 'ava', 'chin'] },
    turkic: { a: ['Kara', 'Ak', 'Kizil', 'Altan', 'Bay', 'Ulan', 'Sary', 'Tar', 'Bulgan', 'Kher'], b: ['bulak', 'tau', 'gan', 'kent', 'baatar', 'sai', 'aral', 'khan', 'gol', 'shir'] },
    arabic: { a: ['Al', 'Bir', 'Wadi', 'Ras', 'Dar', 'Ain', 'Umm', 'Qasr', 'Beni', 'Sidi'], b: ['fayd', 'hara', 'rish', 'zahra', 'salim', 'nour', 'kabir', 'jadid', 'wan', 'medina'] },
    persian: { a: ['Shahr', 'Bandar', 'Gol', 'Nish', 'Kerman', 'Zar', 'Fir', 'Amol', 'Sar', 'Khor'] , b: ['abad', 'estan', 'shahr', 'poor', 'gan', 'rud', 'kuh', 'dasht', 'zar', 'meh'] },
    indic: { a: ['Nava', 'Rama', 'Chandra', 'Deva', 'Raja', 'Sura', 'Hima', 'Vijaya', 'Gaya', 'Kotta'], b: ['pur', 'nagar', 'garh', 'bad', 'palli', 'kot', 'sthan', 'gaon', 'mandi', 'pura'] },
    sinic: { a: ['Xin', 'Bei', 'Nan', 'Dong', 'Hai', 'Jin', 'Long', 'Chang', 'Yun', 'Qing'], b: ['zhou', 'yang', 'shan', 'ling', 'ping', 'hai', 'cheng', 'jiang', 'feng', 'kou'] },
    japonic: { a: ['Kita', 'Higa', 'Naga', 'Yama', 'Shira', 'Aki', 'Toyo', 'Kuro', 'Matsu', 'Hana'], b: ['moto', 'saki', 'gawa', 'hama', 'oka', 'shima', 'tani', 'mura', 'jo', 'no'] },
    malay: { a: ['Kota', 'Tanjung', 'Bukit', 'Kuala', 'Pulau', 'Sungai', 'Batu', 'Padang', 'Muara', 'Teluk'], b: ['raya', 'sari', 'jaya', 'baru', 'indah', 'putih', 'lima', 'wangi', 'agung', 'permai'] },
    african: { a: ['Ndola', 'Kiga', 'Bam', 'Zan', 'Oyo', 'Tim', 'Lu', 'Mba', 'Kwa', 'Gon'], b: ['bala', 'zuri', 'toro', 'gwe', 'sana', 'buktu', 'anda', 'zira', 'nyi', 'dara'] }
  };

  var SEA_PREFIX = ['Coral', 'Iron', 'Silver', 'Storm', 'Ash', 'Cobalt', 'Amber', 'Grey', 'Deep', 'North', 'South', 'Azure', 'Black', 'Pale', 'Broken'];
  var SEA_SUFFIX = ['Sea', 'Basin', 'Straits', 'Deep', 'Reach', 'Sound', 'Gulf', 'Waters', 'Passage', 'Shelf'];

  global.SWW = global.SWW || {};
  global.SWW.NationData = { NATIONS: NATIONS, SYLLABLES: SYLLABLES, SEA_PREFIX: SEA_PREFIX, SEA_SUFFIX: SEA_SUFFIX };
})(typeof globalThis !== 'undefined' ? globalThis : this);
