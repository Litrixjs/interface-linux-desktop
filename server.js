import express from 'express';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import {fileURLToPath} from 'node:url';
import {spawn, exec, execFile} from 'node:child_process';
import {WebSocketServer} from 'ws';
import {registerSystemRoutes} from './server/system.js';
import {registerBrowserRoutes} from './server/browser.js';
import {registerWindowRoutes} from './server/windows.js';
import {registerSystemAppRoutes} from './server/system-apps.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const HOST = '127.0.0.1';
const VERSION = (() => { try { return JSON.parse(fsSync.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version || '0.0.0'; } catch { return '0.0.0'; } })(); /* única fonte da versão */
const DIST = path.join(__dirname, 'dist');
const home = os.homedir();

/* Preferências da própria Interface: JSON simples por usuário.
   Não depende de GNOME/KDE/XFCE e não altera configurações globais do sistema. */
const interfaceConfigDir = path.join(home, '.config', 'interface-linux-desktop');
const interfaceConfigFile = path.join(interfaceConfigDir, 'settings.json');
const DEFAULT_INTERFACE_SETTINGS = Object.freeze({
  animations: true,
  dynamicDock: true,
  notifications: true,
  desktopIcons: true,
  visualEffects: true
});
async function readInterfaceSettings() {
  try {
    const raw = await fs.readFile(interfaceConfigFile, 'utf8');
    const parsed = JSON.parse(raw);
    return {...DEFAULT_INTERFACE_SETTINGS, ...parsed};
  } catch {
    return {...DEFAULT_INTERFACE_SETTINGS};
  }
}
async function writeInterfaceSettings(value) {
  const next = {};
  for (const key of Object.keys(DEFAULT_INTERFACE_SETTINGS)) {
    if (typeof value?.[key] === 'boolean') next[key] = value[key];
  }
  const merged = {...DEFAULT_INTERFACE_SETTINGS, ...next};
  await fs.mkdir(interfaceConfigDir, {recursive: true});
  await fs.writeFile(interfaceConfigFile, JSON.stringify(merged, null, 2) + '\\n', 'utf8');
  return merged;
}

/* node-pty é um módulo nativo: se a compilação falhar, o resto do desktop continua funcionando. */
let pty = null;
try { pty = (await import('node-pty')).default; }
catch (e) { console.warn('[aviso] node-pty indisponível — o Terminal ficará desativado.\n        Instale: sudo apt install build-essential python3 make g++ && npm run setup:terminal\n        Motivo:', e.message); }

/* systeminformation: dados reais de hardware. Se não estiver instalado, só /api/hardware-info fica indisponível. */
let si = null;
try { si = (await import('systeminformation')).default; }
catch (e) { console.warn('[aviso] systeminformation indisponível — /api/hardware-info responderá 503.\n        Instale: npm install\n        Motivo:', e.message); }

/* ---------- Segurança: só aceita Host/Origin locais (bloqueia DNS rebinding e CSWSH) ---------- */
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const hostAllowed = h => ALLOWED_HOSTS.has(String(h || '').toLowerCase());
const originAllowed = o => { if (!o) return true; try { return hostAllowed(new URL(o).host); } catch { return false; } };

const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  if (!hostAllowed(req.headers.host)) return res.status(403).json({error: 'forbidden_host'});
  if (req.method !== 'GET' && req.method !== 'HEAD' && !originAllowed(req.headers.origin)) return res.status(403).json({error: 'forbidden_origin'});
  next();
});
/* Cabeçalhos: DENY impede que outro site (ou o próprio Chrome embutido) coloque o desktop/terminal dentro de um iframe. */
app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use(express.json({limit: '1mb'}));

/* ---------- Helpers ---------- */
const safePath = (p = '/') => path.resolve(p === '~' || p.startsWith('~/') ? path.join(home, p.slice(1)) : p);
const run = (cmd, args = [], {timeout = 8000, maxBuffer = 2e6} = {}) => new Promise(resolve =>
  execFile(cmd, args, {timeout, maxBuffer}, (error, stdout, stderr) =>
    resolve({ok: !error, stdout: String(stdout || ''), stderr: String(stderr || ''), code: error?.code ?? 0})));

const BIN_DIRS = [...new Set([...(process.env.PATH || '').split(path.delimiter), '/usr/local/bin', '/usr/bin', '/bin', '/snap/bin', '/var/lib/flatpak/exports/bin', path.join(home, '.local/bin')].filter(Boolean))];
/* Procura um executável no PATH sem passar por shell (evita injeção de comandos). */
const findBin = name => {
  if (!/^[\w.+-]+$/.test(name)) return null;
  for (const d of BIN_DIRS) {
    const f = path.join(d, name);
    try { fsSync.accessSync(f, fsSync.constants.X_OK); if (fsSync.statSync(f).isFile()) return f; } catch {}
  }
  return null;
};
/* Inicia um processo desacoplado; o handler de 'error' evita derrubar o servidor se o spawn falhar. */
const launch = (cmd, args = []) => {
  try { const c = spawn(cmd, args, {detached: true, stdio: 'ignore'}); c.on('error', () => {}); c.unref(); return true; }
  catch { return false; }
};
const errStatus = e => (e.code === 'ENOENT' || e.code === 'ENOTDIR') ? 404 : (e.code === 'EACCES' || e.code === 'EPERM') ? 403 : 500;

const APP_DIRS = ['/usr/share/applications', '/usr/local/share/applications', '/var/lib/snapd/desktop/applications', '/var/lib/flatpak/exports/share/applications',
  path.join(home, '.local/share/flatpak/exports/share/applications'), path.join(home, '.local/share/applications')]; /* o último (usuário) sobrescreve os anteriores */
const desktopEntry = t => {
  const i = t.search(/^\[Desktop Entry\]/m); if (i < 0) return '';
  const out = [];
  for (const l of t.slice(i).split('\n').slice(1)) { if (l.startsWith('[')) break; out.push(l); }
  return out.join('\n');
};
const entryKey = (body, k) => body.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]?.trim();
const findDesktopFile = id => {
  if (!/^[\w.+@-]+\.desktop$/.test(id)) return null;
  for (const d of [...APP_DIRS].reverse()) { const f = path.join(d, id); if (fsSync.existsSync(f)) return f; }
  return null;
};

/* ---------- Filesystem ---------- */
const MAX_PREVIEW = 512 * 1024;
app.get('/api/fs', async (req, res) => {
  try {
    const raw = String(req.query.path || '');
    const p = safePath(raw || home);
    const st = await fs.stat(p);
    if (st.isFile()) {
      let content = null;
      if (st.size <= MAX_PREVIEW) { const buf = await fs.readFile(p).catch(() => null); if (buf && !buf.includes(0)) content = buf.toString('utf8'); }
      return res.json({type: 'file', path: p, name: path.basename(p), size: st.size, mtime: st.mtimeMs, content});
    }
    const entries = await fs.readdir(p, {withFileTypes: true});
    const out = await Promise.all(entries.map(async e => {
      const s = await fs.stat(path.join(p, e.name)).catch(() => null); /* stat segue symlinks → pastas via link continuam navegáveis */
      const isDir = s ? s.isDirectory() : e.isDirectory();
      return {name: e.name, type: isDir ? 'dir' : 'file', size: s?.size ?? 0, mtime: s?.mtimeMs ?? 0, ext: path.extname(e.name).toLowerCase()};
    }));
    out.sort((a, b) => (a.type === b.type ? 0 : a.type === 'dir' ? -1 : 1) || a.name.localeCompare(b.name, 'pt-BR'));
    res.json({type: 'dir', path: p, entries: out});
  } catch (e) { res.status(errStatus(e)).json({error: e.code || 'error', message: e.message}); }
});

const SKIP_DIRS = new Set(['node_modules', 'snap', 'proc', 'sys']);
/* Cada raiz tem seu próprio orçamento (limite/itens/tempo). Antes o orçamento era global: a home (varrida primeiro)
   esgotava tudo e os aplicativos .desktop nunca apareciam na busca do Launcher. */
async function searchRoot(root, depth, {limit, maxVisit, ms}, q) {
  const out = []; let visited = 0; const deadline = Date.now() + ms;
  const stop = () => out.length >= limit || visited > maxVisit || Date.now() > deadline;
  async function walk(dir, d) {
    if (stop()) return;
    let ents; try { ents = await fs.readdir(dir, {withFileTypes: true}); } catch { return; }
    for (const e of ents) {
      if (stop()) return;
      visited++;
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name), isDir = e.isDirectory();
      if (e.name.toLowerCase().includes(q)) out.push({type: isDir ? 'folder' : 'file', name: e.name, path: full});
      if (isDir && d > 0 && !SKIP_DIRS.has(e.name)) await walk(full, d - 1);
    }
  }
  await walk(root, depth);
  return out;
}
app.get('/api/search', async (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  if (!q) return res.json([]);
  const budget = {limit: 30, maxVisit: 3000, ms: 800};
  const appHits = (await Promise.all(APP_DIRS.map(d => searchRoot(d, 0, budget, q)))).flat();
  const seen = new Set(), apps = appHits.filter(r => !seen.has(r.name) && seen.add(r.name)); /* mesmo .desktop em /usr e ~/.local aparecia 2x */
  const files = await searchRoot(home, 3, {limit: 60, maxVisit: 15000, ms: 2000}, q);
  const rank = r => r.name.toLowerCase().startsWith(q) ? 0 : 1;
  res.json([...apps.slice(0, 20), ...files].sort((a, b) => rank(a) - rank(b)).slice(0, 80));
});

/* ---------- Sistema ---------- */
let gpuCache = null;
const getGpus = async () => {
  if (gpuCache) return gpuCache;
  const r = await run('sh', ['-c', "lspci 2>/dev/null | grep -Ei 'vga|3d|display' | head -20"]);
  return (gpuCache = r.stdout.split('\n').filter(Boolean));
};
app.get('/api/system', async (_req, res) => {
  const mem = os.totalmem(), free = os.freemem(), cpus = os.cpus();
  const [gpus, disks] = await Promise.all([getGpus(), run('df', ['-h', '-x', 'tmpfs', '-x', 'devtmpfs', '-x', 'squashfs', '-x', 'overlay'])]);
  res.json({hostname: os.hostname(), platform: os.platform(), release: os.release(), arch: os.arch(), cpu: cpus[0]?.model || 'unknown', cores: cpus.length,
    ram: {total: mem, free, used: mem - free}, load: os.loadavg(), gpus, disks: disks.stdout});
});

/* Hardware real via systeminformation. CPU/GPU/SO não mudam em execução → cache; RAM e disco são lidos a cada chamada.
   Cada bloco é independente (allSettled): se um falhar, os demais continuam e o campo vem como null. */
let staticHw = null;
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms).unref())]);
/* systeminformation costuma errar a VRAM de placas AMD (lê as regiões PCI do lspci). O driver amdgpu informa o valor exato no sysfs. */
const sysfsVram = busAddress => {
  let b = String(busAddress || '').toLowerCase();
  if (!/^([0-9a-f]{4}:)?[0-9a-f]{2}:[0-9a-f]{2}\.[0-7]$/.test(b)) return null;
  if (b.length === 7) b = '0000:' + b;
  try { const n = Number(fsSync.readFileSync(`/sys/bus/pci/devices/${b}/mem_info_vram_total`, 'utf8').trim()); return Number.isFinite(n) && n > 0 ? n : null; } catch { return null; }
};
const getStaticHw = async () => {
  if (staticHw) return staticHw;
  const [cpu, gfx, osi] = await Promise.allSettled([si.cpu(), withTimeout(si.graphics(), 10000), si.osInfo()]);
  const out = {
    cpu: cpu.status === 'fulfilled' ? {model: [cpu.value.manufacturer, cpu.value.brand].filter(Boolean).join(' ') || null, cores: cpu.value.cores ?? null,
      physicalCores: cpu.value.physicalCores ?? null, speedGHz: cpu.value.speed || null} : null,
    gpus: gfx.status === 'fulfilled' ? (gfx.value.controllers || []).map(c => ({model: c.model || null, vendor: c.vendor || null,
      vramBytes: sysfsVram(c.busAddress) ?? (Number.isFinite(c.vram) && c.vram > 0 ? c.vram * 1024 * 1024 : null)})) : null, /* fallback: systeminformation informa a VRAM em MB */
    os: osi.status === 'fulfilled' ? {distro: osi.value.distro || null, release: osi.value.release || null, kernel: osi.value.kernel || null,
      arch: osi.value.arch || null, hostname: osi.value.hostname || null} : null,
  };
  if (out.cpu && out.gpus && out.os) staticHw = out; /* só guarda em cache se tudo deu certo */
  return out;
};
app.get('/api/hardware-info', async (_req, res) => {
  if (!si) return res.status(503).json({error: 'systeminformation_unavailable', message: 'Biblioteca systeminformation não instalada. Rode: npm install'});
  try {
    const [hw, mem, fsz] = await Promise.all([getStaticHw(), si.mem().catch(() => null), si.fsSize().catch(() => null)]);
    const ram = mem && mem.total ? {total: mem.total, used: mem.active, available: mem.available, percent: +(mem.active / mem.total * 100).toFixed(1)} : null;
    /* Só o disco principal (montado em "/"): ignora /boot/efi, snaps, AppImages (/tmp/.mount_*) e demais montagens. */
    const root = fsz?.find(d => d.mount === '/' && d.size > 0);
    const disk = root ? {fs: root.fs, type: root.type, mount: root.mount, size: root.size, used: root.used, percent: +(root.used / root.size * 100).toFixed(1)} /* used/size: bate com os números exibidos (o "use" do df desconta blocos reservados) */ : null;
    res.json({cpu: hw.cpu, ram, gpus: hw.gpus, os: hw.os, disk});
  } catch (e) { res.status(500).json({error: 'hardware_error', message: e.message}); }
});

/* ---------- Apps / Store ---------- */
app.get('/api/apps', async (_req, res) => {
  const apps = new Map(); /* diretórios mais específicos (usuário) sobrescrevem os do sistema */
  for (const dir of APP_DIRS) {
    let files = []; try { files = await fs.readdir(dir); } catch { continue; }
    for (const f of files.filter(x => x.endsWith('.desktop'))) {
      try {
        const body = desktopEntry(await fs.readFile(path.join(dir, f), 'utf8'));
        const type = entryKey(body, 'Type');
        if ((type && type !== 'Application') || entryKey(body, 'NoDisplay') === 'true' || entryKey(body, 'Hidden') === 'true') { apps.delete(f); continue; }
        apps.set(f, {id: f, name: entryKey(body, 'Name') || f.replace(/\.desktop$/, ''), exec: (entryKey(body, 'Exec') || '').replace(/%[a-zA-Z%]/g, m => m === '%%' ? '%' : '').replace(/\s+/g, ' ').trim(), icon: entryKey(body, 'Icon') || '', desktop: f, dir});
      } catch {}
    }
  }
  res.json([...apps.values()].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')));
});

/* Abre apps .desktop / flatpak / snap (grade de Atividades e Dock dinâmica). */
app.post('/api/launch', (req, res) => {
  const kind = String(req.body?.kind || ''), id = String(req.body?.id || '');
  if (kind === 'desktop') {
    const f = findDesktopFile(id);
    if (!f) return res.status(404).json({ok: false, error: 'not_found'});
    const gio = findBin('gio'); if (gio) { launch(gio, ['launch', f]); return res.json({ok: true, command: 'gio launch'}); }
    const gtk = findBin('gtk-launch'); if (gtk) { launch(gtk, [id.replace(/\.desktop$/, '')]); return res.json({ok: true, command: 'gtk-launch'}); }
    return res.status(501).json({ok: false, error: 'no_launcher', message: 'Instale libglib2.0-bin (gio) ou libgtk-3-bin (gtk-launch).'});
  }
  if ((kind === 'flatpak' || kind === 'snap') && /^[\w.-]+$/.test(id)) {
    const b = findBin(kind);
    if (b) { launch(b, ['run', id]); return res.json({ok: true, command: `${kind} run`}); }
    return res.status(404).json({ok: false, error: 'not_installed', message: `${kind} não encontrado.`});
  }
  res.status(400).json({ok: false, error: 'bad_request'});
});

/* ---------- Ícones dos aplicativos (/api/app-icon) ----------
   Resolve o ícone de um .desktop (ou de um nome de tema/Flatpak) nos diretórios de temas do Linux.
   Segurança: `id` precisa ser um .desktop existente em APP_DIRS (o caminho absoluto do campo Icon só é aceito vindo dele);
   `name` só aceita [\w.+-] (sem "/" → sem path traversal); só serve .png/.svg de até 2 MB. */
const ICON_ROOTS = ['/usr/share/icons', '/usr/local/share/icons', path.join(home, '.local/share/icons'), path.join(home, '.icons'),
  '/var/lib/flatpak/exports/share/icons', path.join(home, '.local/share/flatpak/exports/share/icons')];
const ICON_SIZES = ['scalable', '512x512', '256x256', '128x128', '96x96', '64x64', '48x48', '32x32'];
const PIXMAP_DIRS = ['/usr/share/pixmaps', '/usr/local/share/pixmaps'];
let iconThemes = null; const iconCache = new Map();
const themeList = () => {
  if (iconThemes) return iconThemes;
  const found = new Set(['hicolor', 'Yaru', 'Adwaita', 'Papirus', 'breeze', 'gnome']);
  for (const r of ICON_ROOTS) { try { for (const d of fsSync.readdirSync(r)) if (!d.startsWith('.') && fsSync.statSync(path.join(r, d)).isDirectory()) found.add(d); } catch {} }
  return (iconThemes = [...found].slice(0, 40));
};
const isFile = f => { try { const st = fsSync.statSync(f); return st.isFile() && st.size > 0 && st.size <= 2 * 1024 * 1024; } catch { return false; } };
const findIcon = name => {
  if (iconCache.has(name)) return iconCache.get(name);
  let hit = null;
  outer: for (const size of ICON_SIZES) for (const root of ICON_ROOTS) for (const theme of themeList()) {
    const ext = size === 'scalable' ? 'svg' : 'png', f = path.join(root, theme, size, 'apps', `${name}.${ext}`);
    if (isFile(f)) { hit = f; break outer; }
  }
  if (!hit) for (const d of PIXMAP_DIRS) for (const ext of ['svg', 'png']) { const f = path.join(d, `${name}.${ext}`); if (!hit && isFile(f)) hit = f; }
  if (iconCache.size > 1500) iconCache.clear();
  iconCache.set(name, hit); return hit;
};
app.get('/api/app-icon', (req, res) => {
  const id = String(req.query.id || ''), name = String(req.query.name || '');
  let icon = name, fromDesktop = false;
  if (id) {
    const f = findDesktopFile(id); if (!f) return res.status(404).end();
    try { icon = entryKey(desktopEntry(fsSync.readFileSync(f, 'utf8')), 'Icon') || ''; fromDesktop = true; } catch { return res.status(404).end(); }
  }
  let file = null;
  if (fromDesktop && path.isAbsolute(icon)) file = /\.(png|svg)$/i.test(icon) && isFile(icon) ? icon : null;
  else if (/^[\w.+-]{1,120}$/.test(icon)) file = findIcon(icon);
  if (!file) return res.status(404).end();
  res.setHeader('Cache-Control', 'public, max-age=86400'); /* sobrepõe o no-store de /api: ícones quase nunca mudam */
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox"); /* SVG aberto direto não executa script */
  res.sendFile(file, {dotfiles: 'allow'}, err => { if (err && !res.headersSent) res.status(404).end(); });
});

/* Abre o Chrome/Chromium (agora com a URL pedida). Não executa mais nomes arbitrários vindos do cliente. */
app.post('/api/open-app', (req, res) => {
  const url = String(req.body?.url || '');
  const args = /^https?:\/\//i.test(url) ? [url] : [];
  for (const c of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    const b = findBin(c);
    if (b) { launch(b, args); return res.json({ok: true, command: c}); }
  }
  res.status(404).json({ok: false, error: 'browser_not_found', message: 'Chrome/Chromium não encontrado.'});
});

app.get('/api/browser-default', async (_req, res) => { const r = await run('xdg-settings', ['get', 'default-web-browser']); res.json({value: r.stdout.trim(), ok: r.ok}); });
app.post('/api/browser-default', async (req, res) => {
  const desktop = String(req.body?.desktop || 'google-chrome.desktop');
  if (!/^[\w.+@-]+\.desktop$/.test(desktop)) return res.status(400).json({ok: false, stderr: 'Nome de .desktop inválido.'});
  const r = await run('xdg-settings', ['set', 'default-web-browser', desktop]);
  res.json({ok: r.ok, stdout: r.stdout, stderr: r.stderr});
});
app.post('/api/notify', async (req, res) => {
  const title = String(req.body?.title || 'Interface').slice(0, 120), body = String(req.body?.body || '').slice(0, 400);
  res.json(await run('notify-send', ['--', title, body]));
});
app.get('/api/health', (_req, res) => res.json({ok: true, version: VERSION, terminal: !!pty}));

/* ---------- Nautilus nativo ---------- */
const shellQuote = value => `"${String(value).replace(/([\\"$`])/g, '\\$1')}"`;
app.post('/api/system/open-nautilus', (req, res) => {
  const requested = typeof req.body?.path === 'string' && req.body.path.trim() ? req.body.path.trim() : home;
  const target = safePath(requested);
  if (!fsSync.existsSync(target)) return res.status(404).json({ok: false, error: 'path_not_found', message: 'Caminho não encontrado.'});
  const command = `command -v nautilus >/dev/null 2>&1 || exit 127; nautilus ${shellQuote(target)} > /dev/null 2>&1 &`;
  exec(command, {cwd: home, env: process.env}, error => {
    if (error) return res.status(404).json({ok: false, error: 'nautilus_not_found', message: 'Nautilus não está instalado neste sistema.'});
    res.json({ok: true, path: target});
  });
});

/* ---------- Configurações reais: Wi-Fi, rede, Bluetooth, monitores, som, energia (server/system.js) ---------- */
registerSystemRoutes(app);
registerBrowserRoutes(app, {findBin});
registerWindowRoutes(app, {findDesktopFile, desktopEntry, entryKey, fsSync});
registerSystemAppRoutes(app, {findBin, findDesktopFile});

/* ---------- Frontend ---------- */
app.use('/api', (_req, res) => res.status(404).json({error: 'not_found'})); /* antes: rotas /api inexistentes devolviam o index.html */
if (!fsSync.existsSync(path.join(DIST, 'index.html'))) console.warn('[aviso] dist/index.html não encontrado. Rode "npm run build" antes de iniciar.');
app.get('/api/interface-settings', async (_req, res) => {
  try { res.json(await readInterfaceSettings()); }
  catch (e) { res.status(500).json({error: 'settings_read_failed', message: e.message}); }
});
app.post('/api/interface-settings', async (req, res) => {
  try { res.json({ok: true, settings: await writeInterfaceSettings(req.body || {})}); }
  catch (e) { res.status(500).json({error: 'settings_write_failed', message: e.message}); }
});

app.use(express.static(DIST));
app.get('*', (_req, res) => {
  const f = path.join(DIST, 'index.html');
  fsSync.existsSync(f) ? res.sendFile(f) : res.status(503).type('text/plain').send('Frontend não compilado. Execute: npm run build');
});
app.use((err, _req, res, _next) => res.status(err.status || 500).json({error: err.type || 'error', message: err.message}));

const server = app.listen(PORT, HOST, () => console.log(`Interface ${VERSION} em http://${HOST}:${PORT}`));
server.on('error', e => { console.error(e.code === 'EADDRINUSE' ? `Porta ${PORT} já está em uso. Feche a outra instância ou use PORT=3001 npm start.` : e.message); process.exit(1); });

/* ---------- Terminal PTY ---------- */
const wss = new WebSocketServer({server, path: '/ws/terminal', maxPayload: 1 << 20,
  verifyClient: ({req}) => hostAllowed(req.headers.host) && originAllowed(req.headers.origin)}); /* sem isto, qualquer site aberto no navegador conseguia abrir um shell */
const sessions = new Set();
const int = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.floor(Number(v)) || lo));

wss.on('connection', ws => {
  const send = o => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
  ws.on('error', () => {});
  if (!pty) { send({type: 'error', message: 'node-pty não está instalado/compilado neste sistema. Veja o aviso no console do servidor.'}); return ws.close(); }
  let term;
  try {
    const env = {...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor'}; delete env.NODE_ENV; delete env.INIT_CWD; for (const k of Object.keys(env)) if (k.startsWith('npm_')) delete env[k]; /* o shell herdava dezenas de variáveis do npm */
    term = pty.spawn(process.env.SHELL || '/bin/bash', ['-l'], {name: 'xterm-256color', cols: 100, rows: 30, cwd: home, env});
  } catch (e) { send({type: 'error', message: `Falha ao iniciar o shell: ${e.message}`}); return ws.close(); }
  sessions.add(term);
  term.onData(d => send({type: 'data', data: d}));
  term.onExit(e => { send({type: 'exit', code: e.exitCode}); sessions.delete(term); try { ws.close(); } catch {} });
  ws.on('message', m => {
    try {
      const x = JSON.parse(m);
      if (x.type === 'input' && typeof x.data === 'string') term.write(x.data);
      else if (x.type === 'resize') term.resize(int(x.cols, 2, 500), int(x.rows, 1, 200));
    } catch {}
  });
  ws.on('close', () => { try { term.kill(); } catch {} sessions.delete(term); });
});

const shutdown = () => { for (const t of sessions) { try { t.kill(); } catch {} } process.exit(0); };
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
