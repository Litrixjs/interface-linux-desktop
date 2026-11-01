/* Controles reais do sistema para a janela de Configurações (Ubuntu/Debian).
   Tudo roda com execFile (sem shell → sem injeção de comandos), de forma assíncrona e com timeout,
   e cada rota devolve mensagens de erro amigáveis (comando ausente, sem permissão, falha do comando). */
import {execFile} from 'node:child_process';

const ENV = () => ({...process.env, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', DISPLAY: process.env.DISPLAY || ':0'}); /* saída estável (inglês) para o parsing */
const SESSION = () => process.env.XDG_SESSION_TYPE || (process.env.WAYLAND_DISPLAY ? 'wayland' : process.env.DISPLAY ? 'x11' : 'desconhecida');

/* Executa um comando sem travar o servidor. missing = executável não instalado. */
export const sh = (cmd, args = [], {timeout = 8000, maxBuffer = 4e6} = {}) => new Promise(resolve =>
  execFile(cmd, args, {timeout, maxBuffer, env: ENV()}, (error, stdout, stderr) =>
    resolve({ok: !error, cmd, stdout: String(stdout || ''), stderr: String(stderr || ''), code: error?.code ?? 0, missing: error?.code === 'ENOENT', timedOut: !!error?.killed})));

const firstLine = s => (String(s).split('\n').map(l => l.trim()).filter(Boolean)[0] || '').replace(/^error:\s*/i, '');
const PERM = /not authorized|insufficient privileges|permission denied|access denied|polkit|not permitted|authorization/i;
/* Converte falha de comando em {status, error, message} legível. */
export function explain(r, action = 'executar a ação') {
  if (r.missing) return {status: 501, error: 'not_installed', message: `O comando "${r.cmd}" não está instalado neste sistema.`};
  if (r.timedOut) return {status: 504, error: 'timeout', message: `Tempo esgotado ao ${action}.`};
  const msg = firstLine(r.stderr) || firstLine(r.stdout);
  if (PERM.test(r.stderr + r.stdout)) return {status: 403, error: 'permission', message: `Sem permissão para ${action}. ${msg}`.trim()};
  if (/cannot open display|can't open display|unable to open display|authorization required/i.test(r.stderr)) return {status: 503, error: 'no_display', message: 'Sem acesso à sessão gráfica (DISPLAY/XAUTHORITY). Inicie o servidor dentro da sessão do desktop.'};
  return {status: 500, error: 'command_failed', message: msg || `Falha ao ${action} (código ${r.code}).`};
}
const fail = (res, r, action) => { const e = explain(r, action); res.status(e.status).json({error: e.error, message: e.message}); };
const bad = (res, message) => res.status(400).json({error: 'bad_request', message});
const unavailable = (res, r, extra = {}) => { const e = explain(r, 'consultar o sistema'); res.json({available: false, reason: e.error, message: e.message, ...extra}); };

/* nmcli -t separa campos por ":" e escapa ":" e "\" dentro dos valores com "\". */
export function splitTerse(line) {
  const out = []; let cur = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\' && i + 1 < line.length) cur += line[++i];
    else if (c === ':') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur); return out;
}

export function prefixToMask(n) {
  const b = Math.min(32, Math.max(0, Number(n) || 0)); let m = b ? (0xffffffff << (32 - b)) >>> 0 : 0;
  return [24, 16, 8, 0].map(s => (m >>> s) & 255).join('.');
}

/* ---------- Wi-Fi ---------- */
export function parseWifi(stdout) {
  const best = new Map();
  for (const line of stdout.split('\n').filter(Boolean)) {
    const [active, ssid, bssid, signal, ...sec] = splitTerse(line);
    if (!ssid) continue; /* redes ocultas */
    const n = {ssid, bssid, signal: Number(signal) || 0, security: sec.join(':').trim() || '', secured: !!sec.join(':').trim() && sec.join(':').trim() !== '--', active: active === 'yes'};
    const prev = best.get(ssid);
    if (!prev || n.active || (!prev.active && n.signal > prev.signal)) best.set(ssid, n);
  }
  return [...best.values()].sort((a, b) => (b.active - a.active) || (b.signal - a.signal));
}

/* ---------- Rede ---------- */
export function parseNetwork(addrJson, routeJson) {
  const routes = (routeJson || []).filter(r => r.dst === 'default');
  const kind = n => /^(en|eth)/.test(n) ? 'ethernet' : /^wl/.test(n) ? 'wifi' : null; /* ignora lo, docker, veth, br-, virbr, tun… */
  return (addrJson || []).filter(i => kind(i.ifname)).map(i => {
    const v4 = (i.addr_info || []).find(a => a.family === 'inet'), v6 = (i.addr_info || []).find(a => a.family === 'inet6' && a.scope === 'global');
    const gw = routes.filter(r => r.dev === i.ifname).sort((a, b) => (a.metric ?? 0) - (b.metric ?? 0))[0]?.gateway || null;
    return {name: i.ifname, type: kind(i.ifname), state: String(i.operstate || '').toLowerCase(), mac: i.address || null,
      ipv4: v4?.local || null, prefix: v4?.prefixlen ?? null, mask: v4 ? prefixToMask(v4.prefixlen) : null, gateway: gw, ipv6: v6?.local || null};
  });
}

/* ---------- Bluetooth ---------- */
const MAC = /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/;
const yes = (txt, key) => new RegExp(`^\\s*${key}:\\s*yes`, 'mi').test(txt);
async function btDevices() {
  const l = await sh('bluetoothctl', ['devices']);
  const list = l.stdout.split('\n').map(x => x.match(/^Device\s+(\S+)\s*(.*)$/)).filter(Boolean).map(m => ({mac: m[1], name: m[2] || m[1]})).filter(d => MAC.test(d.mac)).slice(0, 40);
  return Promise.all(list.map(async d => {
    const i = (await sh('bluetoothctl', ['info', d.mac], {timeout: 4000})).stdout;
    return {...d, paired: yes(i, 'Paired'), connected: yes(i, 'Connected'), trusted: yes(i, 'Trusted'), icon: i.match(/^\s*Icon:\s*(\S+)/m)?.[1] || ''};
  }));
}

/* ---------- Monitores ---------- */
export function parseXrandr(text) {
  const outs = []; let cur = null;
  for (const line of text.split('\n')) {
    const h = line.match(/^(\S+) (connected|disconnected)(?: (primary))?(?: (\d+)x(\d+)\+(-?\d+)\+(-?\d+))?/);
    if (h) { cur = {name: h[1], connected: h[2] === 'connected', primary: !!h[3], geometry: h[4] ? {w: +h[4], h: +h[5], x: +h[6], y: +h[7]} : null, current: null, modes: []}; outs.push(cur); continue; }
    const m = cur && line.match(/^\s+(\d+x\d+[a-z]?)\s+(.+)$/);
    if (m) {
      const rates = [...m[2].matchAll(/(\d+(?:\.\d+)?)([*+]*)/g)].map(x => ({hz: +x[1], current: x[2].includes('*'), preferred: x[2].includes('+')}));
      cur.modes.push({mode: m[1], rates: rates.map(r => r.hz)});
      const c = rates.find(r => r.current); if (c) cur.current = {mode: m[1], hz: c.hz};
    }
  }
  return outs.filter(o => o.connected);
}

/* ---------- Som ---------- */

/* ---------- Energia ---------- */
const PROFILES = ['performance', 'balanced', 'power-saver'];
export function parseXsetQ(text) {
  const dpms = /DPMS is Enabled/i.test(text);
  const off = text.match(/Standby:\s*(\d+)\s+Suspend:\s*(\d+)\s+Off:\s*(\d+)/i);
  const ss = text.match(/timeout:\s*(\d+)/i);
  const offSec = dpms && off ? Number(off[3]) : 0;
  return {dpms, idleMinutes: offSec ? Math.round(offSec / 60) : 0, screensaverSec: ss ? Number(ss[1]) : 0};
}

export function registerSystemRoutes(app) {
  const wrap = fn => async (req, res) => { try { await fn(req, res); } catch (e) { res.status(500).json({error: 'internal', message: e.message}); } };
  const on = req => req.body?.on;

  /* ----- Wi-Fi ----- */
  app.get('/api/sys/wifi', wrap(async (req, res) => {
    const radio = await sh('nmcli', ['radio', 'wifi']);
    if (!radio.ok) return unavailable(res, radio, {enabled: false, networks: []});
    const enabled = /enabled/i.test(radio.stdout);
    const dev = await sh('nmcli', ['-t', '-f', 'TYPE,STATE', 'device']);
    if (dev.ok && !/^wifi:/m.test(dev.stdout)) return res.json({available: false, reason: 'no_adapter', message: 'Nenhum adaptador Wi-Fi encontrado.', enabled, networks: []});
    if (!enabled) return res.json({available: true, enabled, networks: []});
    const r = await sh('nmcli', ['-t', '-f', 'active,ssid,bssid,signal,security', 'dev', 'wifi', 'list', '--rescan', req.query.rescan === '1' ? 'yes' : 'auto'], {timeout: 15000});
    if (!r.ok) return res.json({available: true, enabled, networks: [], warning: explain(r, 'listar redes Wi-Fi').message});
    res.json({available: true, enabled, networks: parseWifi(r.stdout)});
  }));
  app.post('/api/sys/wifi/power', wrap(async (req, res) => {
    if (typeof on(req) !== 'boolean') return bad(res, 'Informe {on: true|false}.');
    const r = await sh('nmcli', ['radio', 'wifi', on(req) ? 'on' : 'off']);
    r.ok ? res.json({ok: true, enabled: on(req)}) : fail(res, r, 'alterar o Wi-Fi');
  }));
  app.post('/api/sys/wifi/connect', wrap(async (req, res) => {
    const ssid = String(req.body?.ssid || ''), password = req.body?.password == null ? '' : String(req.body.password);
    if (!ssid || Buffer.byteLength(ssid) > 32 || ssid.startsWith('-') || /[\0\n\r]/.test(ssid)) return bad(res, 'SSID inválido.');
    if (password && (password.length < 8 || password.length > 63 || /[\0\n\r]/.test(password))) return bad(res, 'A senha WPA deve ter de 8 a 63 caracteres.');
    const r = await sh('nmcli', ['device', 'wifi', 'connect', ssid, ...(password ? ['password', password] : [])], {timeout: 45000});
    if (r.ok) return res.json({ok: true});
    if (/secrets were required|no secrets|wrong password|802\.1X supplicant|authentication/i.test(r.stderr)) return res.status(401).json({error: 'auth', message: 'Senha incorreta ou não informada.'});
    if (/no network with ssid/i.test(r.stderr)) return res.status(404).json({error: 'not_found', message: 'Rede não encontrada. Atualize a lista e tente de novo.'});
    fail(res, r, 'conectar à rede');
  }));
  app.post('/api/sys/wifi/disconnect', wrap(async (req, res) => {
    const dev = await sh('nmcli', ['-t', '-f', 'DEVICE,TYPE,STATE', 'device']);
    const w = dev.stdout.split('\n').map(splitTerse).find(c => c[1] === 'wifi' && c[2] === 'connected');
    if (!w) return res.json({ok: true});
    const r = await sh('nmcli', ['device', 'disconnect', w[0]]);
    r.ok ? res.json({ok: true}) : fail(res, r, 'desconectar do Wi-Fi');
  }));

  /* ----- Rede ----- */
  app.get('/api/sys/network', wrap(async (_req, res) => {
    const [a, r] = await Promise.all([sh('ip', ['-j', 'addr']), sh('ip', ['-j', 'route'])]);
    if (!a.ok) return unavailable(res, a, {interfaces: []});
    let aj, rj; try { aj = JSON.parse(a.stdout); rj = r.ok ? JSON.parse(r.stdout) : []; } catch { return res.json({available: false, reason: 'parse', message: 'Resposta inesperada do comando ip (é necessário o iproute2 com suporte a -j).', interfaces: []}); }
    const conns = await sh('nmcli', ['-t', '-f', 'DEVICE,NAME', 'connection', 'show', '--active']);
    const names = new Map(conns.ok ? conns.stdout.split('\n').filter(Boolean).map(splitTerse) : []);
    res.json({available: true, interfaces: parseNetwork(aj, rj).map(i => ({...i, connection: names.get(i.name) || null}))});
  }));

  /* ----- Bluetooth ----- */
  app.get('/api/sys/bluetooth', wrap(async (_req, res) => {
    const s = await sh('bluetoothctl', ['show']);
    if (/no default controller/i.test(s.stdout + s.stderr)) return res.json({available: false, reason: 'no_adapter', message: 'Nenhum adaptador Bluetooth encontrado.', powered: false, devices: []});
    if (!s.ok) return unavailable(res, s, {powered: false, devices: []});
    const powered = yes(s.stdout, 'Powered');
    res.json({available: true, powered, discovering: yes(s.stdout, 'Discovering'), devices: powered ? await btDevices() : []});
  }));
  app.post('/api/sys/bluetooth/power', wrap(async (req, res) => {
    if (typeof on(req) !== 'boolean') return bad(res, 'Informe {on: true|false}.');
    const r = await sh('bluetoothctl', ['power', on(req) ? 'on' : 'off']);
    if (r.ok && !/fail/i.test(r.stdout)) return res.json({ok: true});
    if (/blocked/i.test(r.stdout + r.stderr)) return res.status(409).json({error: 'blocked', message: 'Bluetooth bloqueado por software/hardware. Tente: rfkill unblock bluetooth'});
    fail(res, r.ok ? {...r, ok: false, stderr: r.stdout} : r, 'alterar o Bluetooth');
  }));
  app.post('/api/sys/bluetooth/scan', wrap(async (_req, res) => {
    const r = await sh('bluetoothctl', ['--timeout', '6', 'scan', 'on'], {timeout: 12000});
    if (r.missing) return fail(res, r, 'procurar dispositivos');
    res.json({ok: true, devices: await btDevices()});
  }));
  app.post('/api/sys/bluetooth/device', wrap(async (req, res) => {
    const mac = String(req.body?.mac || ''), action = String(req.body?.action || '');
    if (!MAC.test(mac)) return bad(res, 'Endereço Bluetooth inválido.');
    if (!['connect', 'disconnect', 'pair', 'remove'].includes(action)) return bad(res, 'Ação inválida.');
    const steps = action === 'pair' ? [['pair', mac], ['trust', mac], ['connect', mac]] : [[action, mac]];
    for (const st of steps) {
      const r = await sh('bluetoothctl', st, {timeout: 30000});
      const out = r.stdout + r.stderr;
      if (!r.ok || /Failed to|not available|org\.bluez\.Error/i.test(out)) {
        const m = out.match(/(Failed to [^\n]*|org\.bluez\.Error\.[^\n]*)/i)?.[1];
        return r.missing || !m ? fail(res, r, 'executar a ação no dispositivo') : res.status(500).json({error: 'command_failed', message: m.replace(/org\.bluez\.Error\./i, '')});
      }
    }
    res.json({ok: true});
  }));

  /* ----- Monitores ----- */
  const displays = async () => { const r = await sh('xrandr', ['--query']); return r.ok ? {ok: true, list: parseXrandr(r.stdout)} : {ok: false, r}; };
  app.get('/api/sys/displays', wrap(async (_req, res) => {
    const d = await displays();
    if (!d.ok) return unavailable(res, d.r, {session: SESSION(), outputs: []});
    res.json({available: true, session: SESSION(), outputs: d.list});
  }));
  app.post('/api/sys/displays/apply', wrap(async (req, res) => {
    const d = await displays(); if (!d.ok) return fail(res, d.r, 'ler os monitores');
    const out = d.list.find(o => o.name === req.body?.output); if (!out) return bad(res, 'Monitor desconhecido.');
    const mode = out.modes.find(m => m.mode === req.body?.mode); if (!mode) return bad(res, 'Resolução não suportada por este monitor.');
    const hz = req.body?.hz == null ? null : Number(req.body.hz); if (hz !== null && !mode.rates.includes(hz)) return bad(res, 'Taxa de atualização não suportada nesta resolução.');
    const r = await sh('xrandr', ['--output', out.name, '--mode', mode.mode, ...(hz !== null ? ['--rate', String(hz)] : [])]);
    r.ok ? res.json({ok: true, previous: out.current}) : fail(res, r, 'aplicar a resolução');
  }));

  /* ----- Som (PipeWire/wpctl; fallback ALSA/amixer) ----- */
  const parseWpctlStatus = (text, kind) => {
    const section = kind === 'input' ? 'Sources' : 'Sinks';
    const lines = String(text || '').split(/\r?\n/);
    let active = false;
    const out = [];
    for (const raw of lines) {
      if (/^(Video|Settings)\b/.test(raw)) break; /* câmeras (Video › Sources) não são microfones */
      if (/^\s*(?:├─|└─)?\s*Sinks:\s*$/i.test(raw)) { active = section === 'Sinks'; continue; }
      if (/^\s*(?:├─|└─)?\s*Sources:\s*$/i.test(raw)) { active = section === 'Sources'; continue; }
      if (/^\s*(?:├─|└─)?\s*(?:Devices|Filters|Streams|Sink endpoints|Source endpoints):\s*$/i.test(raw)) { active = false; continue; }
      if (!active) continue;
      const line = raw.replace(/^[\s│├└─]+/, '');
      const m = line.match(/^(\*)?\s*(\d+)\.\s+(.+?)\s*$/);
      if (!m) continue;
      const name = m[3].replace(/\s+\[vol:\s*[^\]]+\]\s*$/i, '').trim();
      if (!name) continue;
      out.push({id: Number(m[2]), name, description: name, default: !!m[1]});
    }
    return out;
  };

  const parseWpctlVolume = text => {
    const m = String(text || '').match(/Volume:\s*([0-9]*\.?[0-9]+)/i);
    return m ? Math.round(Number(m[1]) * 100) : null;
  };

  const readWpctl = async () => {
    const status = await sh('wpctl', ['status', '-n']);
    if (!status.ok) return {r: status};
    const outputs = parseWpctlStatus(status.stdout, 'output');
    const inputs = parseWpctlStatus(status.stdout, 'input');
    const enrich = async list => Promise.all(list.map(async d => {
      const v = await sh('wpctl', ['get-volume', String(d.id)]);
      return {...d, volume: parseWpctlVolume(v.stdout), mute: /\[MUTED\]/i.test(v.stdout)};
    }));
    return {outputs: await enrich(outputs), inputs: await enrich(inputs)};
  };

  const parseAmixerControl = (text, kind) => {
    const percent = String(text || '').match(/(?:Playback|Capture)[^\n]*?\[(\d+)%\]/i)?.[1];
    const mute = String(text || '').match(/(?:Playback|Capture)[^\n]*?\[(on|off)\]/i)?.[1];
    return {volume: percent == null ? null : Number(percent), mute: mute ? mute.toLowerCase() === 'off' : false};
  };

  const readAmixer = async () => {
    const controls = await sh('amixer', ['scontrols']);
    if (!controls.ok) return {r: controls};
    const names = [...String(controls.stdout).matchAll(/Simple mixer control '([^']+)'/g)].map(m => m[1]);
    const outputName = names.find(n => /master|speaker|headphone/i.test(n)) || names.find(n => !/capture|mic|input/i.test(n)) || names[0];
    const inputName = names.find(n => /capture|mic|input/i.test(n));
    const read = async (name, kind) => {
      if (!name) return null;
      const r = await sh('amixer', ['sget', name]);
      if (!r.ok) return null;
      const p = parseAmixerControl(r.stdout, kind);
      return {name, description: name, volume: p.volume, mute: p.mute, default: true, control: name};
    };
    const outputs = await read(outputName, 'output');
    const inputs = await read(inputName, 'input');
    if (!outputs && !inputs) return {r: controls};
    return {outputs: outputs ? [outputs] : [], inputs: inputs ? [inputs] : []};
  };

  const audio = async () => {
    const wp = await readWpctl();
    if (!wp.r && (wp.outputs.length || wp.inputs.length)) return wp;
    const alsa = await readAmixer();
    if (!alsa.r) return alsa;
    return {r: wp.r};
  };

  app.get('/api/sys/sound', wrap(async (_req, res) => {
    const a = await audio(); if (a.r) return unavailable(res, a.r, {outputs: [], inputs: []});
    res.json({available: true, ...a});
  }));

  app.post('/api/sys/sound/volume', wrap(async (req, res) => {
    const {value, delta} = req.body || {};
    let arg;
    if (Number.isFinite(value)) arg = `${Math.min(150, Math.max(0, Math.round(value)))}%`;
    else if (Number.isFinite(delta)) { const d = Math.min(50, Math.max(-50, Math.round(delta))); arg = `${Math.abs(d)}%${d >= 0 ? '+' : '-'}`; } /* wpctl e amixer: sufixo (5%+), não prefixo como no pactl */
    else return bad(res, 'Informe {value} ou {delta}.');
    const wp = await sh('wpctl', ['set-volume', '@DEFAULT_AUDIO_SINK@', arg]);
    if (wp.ok) return res.json({ok: true});
    const am = await sh('amixer', ['sset', 'Master', arg]);
    am.ok ? res.json({ok: true, fallback: 'amixer'}) : fail(res, wp, 'ajustar o volume');
  }));

  app.post('/api/sys/sound/mute', wrap(async (req, res) => {
    const kind = req.body?.kind === 'input' ? 'input' : 'output';
    const target = kind === 'input' ? '@DEFAULT_AUDIO_SOURCE@' : '@DEFAULT_AUDIO_SINK@';
    const wp = await sh('wpctl', ['set-mute', target, 'toggle']);
    if (wp.ok) return res.json({ok: true});
    const control = kind === 'input' ? 'Capture' : 'Master';
    const am = await sh('amixer', ['sset', control, 'toggle']);
    am.ok ? res.json({ok: true, fallback: 'amixer'}) : fail(res, wp, 'alternar o mudo');
  }));

  app.post('/api/sys/sound/default', wrap(async (req, res) => {
    const kind = req.body?.kind === 'input' ? 'input' : 'output';
    const name = String(req.body?.name || '');
    const a = await audio();
    if (a.r) return fail(res, a.r, 'listar dispositivos de áudio');
    const list = kind === 'input' ? a.inputs : a.outputs;
    const device = list.find(d => d.name === name);
    if (!device) return bad(res, 'Dispositivo desconhecido.');
    if (device.id == null) {
      return res.status(501).json({ok: false, error: 'default_not_supported', message: 'A troca de dispositivo padrão não está disponível pelo fallback ALSA.'});
    }
    const wp = await sh('wpctl', ['set-default', String(device.id)]);
    wp.ok ? res.json({ok: true}) : fail(res, wp, 'trocar o dispositivo de áudio');
  }));

  /* ----- Energia ----- */
  app.get('/api/sys/energy', wrap(async (_req, res) => {
    const [cur, list, xs] = await Promise.all([sh('powerprofilesctl', ['get']), sh('powerprofilesctl', ['list']), sh('xset', ['q'])]);
    const profiles = list.ok ? [...list.stdout.matchAll(/^[* ]\s*([a-z-]+):/gm)].map(m => m[1]).filter(p => PROFILES.includes(p)) : [];
    res.json({available: true, session: SESSION(),
      profile: cur.ok ? {current: cur.stdout.trim(), available: profiles.length ? profiles : PROFILES} : {current: null, available: [], message: explain(cur, 'ler o perfil de energia').message},
      screen: xs.ok ? {supported: true, ...parseXsetQ(xs.stdout)} : {supported: false, message: explain(xs, 'consultar a tela').message}});
  }));
  app.post('/api/sys/energy/profile', wrap(async (req, res) => {
    const p = String(req.body?.profile || ''); if (!PROFILES.includes(p)) return bad(res, 'Perfil inválido.');
    const r = await sh('powerprofilesctl', ['set', p]);
    r.ok ? res.json({ok: true}) : fail(res, r, 'trocar o perfil de energia');
  }));
  app.post('/api/sys/energy/screen-off', wrap(async (_req, res) => {
    const r = await sh('xset', ['dpms', 'force', 'off']);
    r.ok ? res.json({ok: true}) : fail(res, r, 'desligar o monitor');
  }));
  app.post('/api/sys/energy/idle', wrap(async (req, res) => {
    const m = Number(req.body?.minutes); if (!Number.isInteger(m) || m < 0 || m > 240) return bad(res, 'Informe minutos entre 0 (nunca) e 240.');
    const steps = m === 0 ? [['s', 'off'], ['-dpms']] : [['s', String(m * 60), String(m * 60)], ['+dpms'], ['dpms', '0', '0', String(m * 60)]];
    for (const a of steps) { const r = await sh('xset', a); if (!r.ok) return fail(res, r, 'configurar o tempo de ociosidade'); }
    const q = await sh('xset', ['q']);
    res.json({ok: true, ...(q.ok ? parseXsetQ(q.stdout) : {idleMinutes: m})});
  }));
}
