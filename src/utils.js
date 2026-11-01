/* Utilitários compartilhados entre main.jsx e SystemSettings.jsx.
   (Ficam aqui para evitar import circular: main.jsx é o ponto de entrada e chama createRoot.) */

export const formatBytes = n => {
  if (!Number.isFinite(n) || n < 0) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${i === 0 ? v : +v.toFixed(v >= 10 ? 0 : 1)} ${u[i]}`;
};

/* fetch que lança erro em HTTP != 2xx (antes, respostas de erro eram tratadas como dados válidos). */
export const api = async (url, opts) => {
  const r = await fetch(url, opts);
  let data = null; try { data = await r.json(); } catch {}
  if (!r.ok) throw Object.assign(new Error(data?.message || data?.error || `HTTP ${r.status}`), {status: r.status, data});
  return data;
};
export const post = (url, body) => api(url, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)});

/* Papéis de parede: o visual de cada id está em index.css (.wp-<id>). 'padrao' segue o tema claro/escuro. */
export const WALLPAPERS = [
  {id: 'padrao', name: 'Padrão (segue o tema)'},
  {id: 'azul-laranja', name: 'Abstrato Azul/Laranja'},
  {id: 'ondas', name: 'Ondas Dinâmicas'},
  {id: 'montanha', name: 'Montanha ao Amanhecer'},
  {id: 'minimalista', name: 'Minimalista Escuro'},
];

/* Preferências de interface (tema, papel de parede) persistidas no navegador. */
export const loadPref = (key, fallback) => {
  try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
};
export const savePref = (key, value) => {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* modo privado / quota: ignora */ }
};
