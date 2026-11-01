/* Controle de janelas de aplicativos NATIVOS (iniciados pela Dock): estado (aberto/ativo/minimizado), foco e minimizar.
   Funciona em sessão X11 com `wmctrl` (listar/focar) + `xdotool` (minimizar) + `xprop` (estado). Em Wayland o sistema não permite
   que um app controle janelas de outros: a rota informa isso (supported:false) e a interface cai no comportamento "relançar". */
import {sh} from './system.js';

const GENERIC = new Set(['env', 'sh', 'bash', 'python', 'python3', 'java', 'gio', 'gtk-launch', 'flatpak', 'snap', 'xdg-open', 'true']);
const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

/* Nomes pelos quais a janela do app pode se identificar (WM_CLASS). entry = {wmclass, exec} lidos do .desktop (se existir). */
export function candidates({kind, id}, entry = {}) {
  const out = new Set(), add = v => { const n = String(v || '').toLowerCase().trim(); if (n.length >= 3 && !GENERIC.has(n)) out.add(n); };
  const base = kind === 'desktop' ? id.replace(/\.desktop$/, '') : id;
  add(base); add(base.split('.').pop());
  add(entry.wmclass);
  const t = String(entry.exec || '').split(/\s+/).filter(Boolean);
  while (t[0] === 'env' || /^\w+=/.test(t[0] || '')) t.shift();
  const bin = (t[0] || '').split('/').pop();
  if (bin === 'flatpak') { const app = t.find((x, i) => i > 0 && /^[A-Za-z0-9_]+(\.[A-Za-z0-9_-]+)+$/.test(x)); if (app) { add(app); add(app.split('.').pop()); } }
  else add(bin);
  return [...out];
}
/* Linha do `wmctrl -lx`: "0x04200003  0 instancia.Classe  host Título" */
export function parseWmctrl(text) {
  return text.split('\n').map(l => l.match(/^(0x[0-9a-f]+)\s+(-?\d+)\s+(\S+)\s+(\S+)\s?(.*)$/i)).filter(Boolean)
    .map(m => ({id: m[1].toLowerCase(), desktop: Number(m[2]), cls: m[3].toLowerCase(), title: m[5]}));
}
export const matches = (win, cands) => cands.some(c => win.cls === c || win.cls.endsWith('.' + c) || norm(win.cls) === norm(c) || norm(win.cls.split('.').pop()) === norm(c));

export function registerWindowRoutes(app, {findDesktopFile, desktopEntry, entryKey, fsSync}) {
  const wrap = fn => async (req, res) => { try { await fn(req, res); } catch (e) { res.status(500).json({error: 'internal', message: e.message}); } };
  const bad = (res, message) => res.status(400).json({error: 'bad_request', message});
  const validApp = a => a && ['desktop', 'flatpak', 'snap'].includes(a.kind) && typeof a.id === 'string' && /^[\w.+@-]{1,160}$/.test(a.id);
  const entryOf = a => {
    if (a.kind !== 'desktop') return {};
    const f = findDesktopFile(a.id); if (!f) return {};
    try { const b = desktopEntry(fsSync.readFileSync(f, 'utf8')); return {wmclass: entryKey(b, 'StartupWMClass'), exec: entryKey(b, 'Exec')}; } catch { return {}; }
  };

  async function capability() {
    const session = process.env.XDG_SESSION_TYPE || (process.env.WAYLAND_DISPLAY ? 'wayland' : process.env.DISPLAY ? 'x11' : 'desconhecida');
    if (session === 'wayland' && process.env.INTERFACE_FORCE_X11 !== '1')
      return {supported: false, session, reason: 'wayland', message: 'Sessão Wayland: o sistema não deixa a interface minimizar/focar janelas de outros apps. Clicar na Dock reabre o app (apps de instância única são trazidos para frente). Para controle completo, entre numa sessão X11.'};
    if (!process.env.DISPLAY) return {supported: false, session, reason: 'no_display', message: 'Sem acesso à sessão gráfica (DISPLAY).'};
    const [wm, xd] = await Promise.all([sh('wmctrl', ['-m']), sh('xdotool', ['version'])]);
    if (wm.missing) return {supported: false, session, reason: 'missing_tool', message: 'Para controlar janelas nativas instale: sudo apt install wmctrl xdotool x11-utils'};
    if (!wm.ok) return {supported: false, session, reason: 'wm_failed', message: 'wmctrl não conseguiu falar com o gerenciador de janelas.'};
    return {supported: true, session, canMinimize: xd.ok};
  }
  const activeId = async () => {
    const x = await sh('xprop', ['-root', '_NET_ACTIVE_WINDOW']);
    const m = x.ok && x.stdout.match(/0x[0-9a-f]+/i); if (m) return m[0].toLowerCase().replace(/^0x0+(?=.)/, '0x');
    const d = await sh('xdotool', ['getactivewindow']); return d.ok && d.stdout.trim() ? '0x' + Number(d.stdout.trim()).toString(16) : null;
  };
  const sameId = (a, b) => a && b && Number(a) === Number(b);
  const isHidden = async w => { const x = await sh('xprop', ['-id', w.id, '_NET_WM_STATE']); return x.ok && /_NET_WM_STATE_HIDDEN/.test(x.stdout); };

  async function snapshot(apps) {
    const cap = await capability(); if (!cap.supported) return {cap};
    const l = await sh('wmctrl', ['-lx']); if (!l.ok) return {cap: {...cap, supported: false, reason: 'wm_failed', message: 'wmctrl falhou ao listar as janelas.'}};
    const wins = parseWmctrl(l.stdout), act = await activeId(), out = {};
    for (const a of apps) {
      const mine = wins.filter(w => matches(w, candidates(a, entryOf(a)))).slice(0, 12);
      const hidden = await Promise.all(mine.map(isHidden));
      out[`${a.kind}:${a.id}`] = {running: mine.length > 0, windows: mine.length, minimized: mine.length > 0 && hidden.every(Boolean), active: mine.some(w => sameId(w.id, act)), _w: mine.map((w, i) => ({...w, hidden: hidden[i]}))};
    }
    return {cap, apps: out};
  }
  const publicApps = apps => Object.fromEntries(Object.entries(apps).map(([k, {_w, ...v}]) => [k, v]));

  app.post('/api/windows/state', wrap(async (req, res) => {
    const apps = (Array.isArray(req.body?.apps) ? req.body.apps : []).filter(validApp).slice(0, 20);
    const s = await snapshot(apps);
    if (!s.cap.supported) return res.json({...s.cap, apps: {}});
    res.json({...s.cap, apps: publicApps(s.apps)});
  }));

  app.post('/api/windows/control', wrap(async (req, res) => {
    const a = req.body; if (!validApp(a)) return bad(res, 'Aplicativo inválido.');
    const action = String(a.action || ''); if (!['focus', 'minimize', 'toggle'].includes(action)) return bad(res, 'Ação inválida.');
    const s = await snapshot([a]);
    if (!s.cap.supported) return res.status(501).json({error: s.cap.reason, message: s.cap.message});
    const st = s.apps[`${a.kind}:${a.id}`];
    if (!st.running) return res.status(404).json({error: 'not_running', message: 'O aplicativo não está aberto.'});
    const doMin = action === 'minimize' || (action === 'toggle' && st.active && !st.minimized);
    if (doMin) {
      if (!s.cap.canMinimize) return res.status(501).json({error: 'missing_tool', message: 'Para minimizar instale: sudo apt install xdotool'});
      for (const w of st._w.filter(w => !w.hidden)) { const r = await sh('xdotool', ['windowminimize', String(Number(w.id))]); if (!r.ok) return res.status(500).json({error: 'command_failed', message: (r.stderr.trim().split('\n')[0]) || 'Falha ao minimizar.'}); }
    } else {
      const target = st._w.find(w => !w.hidden) || st._w[0];
      const r = await sh('wmctrl', ['-i', '-a', target.id]); /* ativa e restaura se estiver minimizada */
      if (!r.ok) return res.status(500).json({error: 'command_failed', message: (r.stderr.trim().split('\n')[0]) || 'Falha ao focar a janela.'});
    }
    const n = await snapshot([a]);
    res.json({ok: true, action: doMin ? 'minimize' : 'focus', state: n.apps ? publicApps(n.apps)[`${a.kind}:${a.id}`] : null});
  }));
}
