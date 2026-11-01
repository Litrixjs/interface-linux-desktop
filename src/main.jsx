import {useCallback, useEffect, useMemo, useReducer, useRef, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Search, Folder, TerminalSquare, Store as StoreIcon, Settings as SettingsIcon, Activity, Bell, X, Minus, Maximize2, Monitor as MonitorIcon, HardDrive, Cpu, MemoryStick, FileText, Menu, AppWindow, AlertCircle, Globe, SlidersHorizontal} from 'lucide-react';
import '@xterm/xterm/css/xterm.css';
import {Terminal as XTerminal} from '@xterm/xterm';
import {FitAddon} from '@xterm/addon-fit';
import SystemSettings from './SystemSettings';
import {api, post, formatBytes, WALLPAPERS, loadPref, savePref} from './utils';
import './index.css';

/* ---------- Constantes e utilitários ---------- */
const MENUBAR_H = 34;   /* altura real da barra de menus (CSS .menubar) */
const MAX_BOTTOM = 90;  /* espaço reservado ao Dock quando a janela está maximizada */
const MAX_Z = 5000;     /* abaixo do z-index do Dock (8000) e da barra de menus (9000) */

/* Janelas EMBUTIDAS (reserva): só abrem quando o app nativo não está instalado — ou pelos atalhos "da Interface".
   Os aplicativos de sistema são delegados ao Linux (veja SYSTEM abaixo). */
const APP = {
  terminal: {title: 'Terminal (embutido)', icon: TerminalSquare, size: [820, 500]},
  settings: {title: 'Configurações da Interface', icon: SettingsIcon, size: [900, 620]},
  monitor: {title: 'Monitor (embutido)', icon: Activity, size: [820, 560]},
};
/* Shell/Launcher: cada item dispara o aplicativo NATIVO do Linux em janela própria do sistema (POST /api/system-apps/launch).
   `win` é o id padrão do .desktop usado para casar a janela real e o ícone; o servidor devolve o id realmente instalado. */
const SYSTEM = [
  {id: 'files', title: 'Nautilus', icon: Folder, win: 'org.gnome.Nautilus.desktop', iconName: 'org.gnome.Nautilus'},
  {id: 'terminal', title: 'Terminal', icon: TerminalSquare, embedded: 'terminal', win: 'org.gnome.Terminal.desktop', iconName: 'org.gnome.Terminal'},
  {id: 'software', title: 'Software', icon: StoreIcon, win: 'org.gnome.Software.desktop', iconName: 'org.gnome.Software'},
  {id: 'settings', title: 'Configurações', icon: SettingsIcon, embedded: 'settings', win: 'org.gnome.Settings.desktop', iconName: 'org.gnome.Settings'},
  {id: 'monitor', title: 'Monitor do Sistema', icon: Activity, embedded: 'monitor', win: 'gnome-system-monitor.desktop', iconName: 'org.gnome.SystemMonitor'},
  {id: 'browser', title: 'Navegador', icon: Globe, win: 'firefox.desktop', iconName: 'web-browser'},
];

function trackPointer(onMove) {
  document.body.classList.add('dragging');
  const up = () => {
    document.body.classList.remove('dragging');
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}

/* ---------- Window manager ---------- */
const initial = {wins: {}, z: 20, focus: null, workspace: 1};

function raise(s) {
  let wins = s.wins, z = s.z + 1;
  if (z > MAX_Z) { /* compacta os z-index para as janelas nunca passarem por cima do Dock/menubar */
    wins = {...wins};
    Object.values(s.wins).sort((a, b) => a.z - b.z).forEach((w, i) => { wins[w.id] = {...w, z: 21 + i}; });
    z = 21 + Object.keys(wins).length;
  }
  return {wins, z};
}
const patch = (s, id, p) => ({...s.wins, [id]: {...s.wins[id], ...p}});

function reducer(s, a) {
  switch (a.type) {
    case 'OPEN': {
      const p = s.wins[a.id];
      const n = Object.values(s.wins).filter(w => w.open && w.workspace === s.workspace).length; /* cascata: janelas novas não nascem empilhadas */
      const r = raise(s);
      const [dw, dh] = APP[a.id].size;
      return {...s, z: r.z, focus: a.id, wins: {...r.wins, [a.id]: {id: a.id, open: true, min: false, max: p?.max || false,
        x: p?.x ?? 90 + (n % 8) * 28, y: p?.y ?? 60 + (n % 8) * 28, w: p?.w ?? dw, h: p?.h ?? dh, z: r.z, workspace: s.workspace}}};
    }
    case 'FOCUS': {
      const w = s.wins[a.id]; if (!w) return s;
      if (s.focus === a.id && !w.min) return s; /* já está no topo: não gasta z-index a cada clique */
      const r = raise(s);
      return {...s, z: r.z, focus: a.id, wins: {...r.wins, [a.id]: {...r.wins[a.id], z: r.z, min: false}}};
    }
    case 'CLOSE': return {...s, focus: s.focus === a.id ? null : s.focus, wins: patch(s, a.id, {open: false, min: false})};
    case 'MIN': return {...s, focus: null, wins: patch(s, a.id, {min: true})};
    case 'MAX': return {...s, wins: patch(s, a.id, {max: !s.wins[a.id].max})};
    case 'MOVE': return {...s, wins: patch(s, a.id, {x: a.x, y: a.y})};
    case 'RESIZE': return {...s, wins: patch(s, a.id, {w: Math.max(360, a.w), h: Math.max(240, a.h)})};
    case 'WORK': return {...s, workspace: a.n, focus: null};
    case 'FIT': { /* a tela diminuiu: traz de volta janelas que ficaram fora da área visível */
      let changed = false; const wins = {};
      for (const [id, w] of Object.entries(s.wins)) {
        const x = clamp(w.x, 0, a.w - 120), y = clamp(w.y, MENUBAR_H, a.h - 60);
        if (x !== w.x || y !== w.y) { changed = true; wins[id] = {...w, x, y}; } else wins[id] = w;
      }
      return changed ? {...s, wins} : s;
    }
    default: return s;
  }
}

/* Minimizar: calcula para onde a janela "voa" (ícone dela na Dock) e só então muda o estado; o CSS faz a animação. */
function minimizeWin(dispatch, id) {
  const el = document.querySelector(`[data-win="${id}"]`), dock = document.querySelector(`.dock [data-app="${id}"]`);
  if (el && dock) {
    const a = el.getBoundingClientRect(), b = dock.getBoundingClientRect();
    el.style.setProperty('--min-x', `${Math.round(b.left + b.width / 2 - (a.left + a.width / 2))}px`);
    el.style.setProperty('--min-y', `${Math.round(b.top + b.height / 2 - (a.top + a.height / 2))}px`);
  }
  dispatch({type: 'MIN', id});
}

function Window({id, children, state, dispatch}) {
  const w = state.wins[id];
  if (!w?.open) return null;
  const A = APP[id], Icon = A.icon;
  /* Janelas de outro workspace ficam ocultas (display:none) em vez de desmontadas:
     antes, trocar de workspace destruía o Terminal e matava o shell em execução. */
  const elsewhere = w.workspace !== state.workspace;

  const startDrag = e => {
    if (e.button !== 0 || e.target.closest('button') || w.max) return;
    const ox = e.clientX - w.x, oy = e.clientY - w.y;
    trackPointer(q => dispatch({type: 'MOVE', id, x: clamp(q.clientX - ox, 0, innerWidth - 120), y: clamp(q.clientY - oy, MENUBAR_H, innerHeight - 60)}));
  };
  const startResize = e => {
    e.stopPropagation(); e.preventDefault();
    dispatch({type: 'FOCUS', id});
    const sx = e.clientX, sy = e.clientY, ow = w.w, oh = w.h;
    trackPointer(q => dispatch({type: 'RESIZE', id, w: ow + q.clientX - sx, h: oh + q.clientY - sy}));
  };

  return (
    <section data-win={id} aria-hidden={w.min || elsewhere ? true : undefined} className={`win${w.max ? ' max' : ''}${state.focus === id ? ' focused' : ''}${w.min ? ' min' : ''}${elsewhere ? ' elsewhere' : ''}`}
      style={{left: w.max ? 0 : w.x, top: w.max ? MENUBAR_H : w.y, width: w.max ? '100%' : w.w, height: w.max ? `calc(100% - ${MENUBAR_H + MAX_BOTTOM}px)` : w.h, zIndex: w.z}}
      onPointerDown={() => dispatch({type: 'FOCUS', id})}>
      <header onPointerDown={startDrag} onDoubleClick={e => { if (!e.target.closest('button')) dispatch({type: 'MAX', id}); }}>
        <div className="traffic">
          <button aria-label="Fechar" onClick={() => dispatch({type: 'CLOSE', id})}><X size={11}/></button>
          <button aria-label="Minimizar" title="Minimizar" onClick={() => minimizeWin(dispatch, id)}><Minus size={11}/></button>
          <button aria-label={w.max ? 'Restaurar tamanho' : 'Maximizar'} title={w.max ? 'Restaurar tamanho' : 'Maximizar'} onClick={() => dispatch({type: 'MAX', id})}><Maximize2 size={10}/></button>
        </div>
        <span><Icon size={14}/>{A.title}</span>
      </header>
      <div className="winbody">{children}</div>
      {!w.max && <div className="resize" onPointerDown={startResize}/>}
    </section>
  );
}

/* Ícone de aplicativo Linux (/api/app-icon). Sem ícone no tema → ícone genérico. */
const iconUrl = a => a.kind === 'desktop' ? `/api/app-icon?id=${encodeURIComponent(a.id)}` : `/api/app-icon?name=${encodeURIComponent(a.id)}`;
function AppIcon({app, size = 28}) {
  const [bad, setBad] = useState(false);
  return bad ? <AppWindow size={size}/> : <img src={iconUrl(app)} alt="" width={size} height={size} loading="lazy" draggable={false} onError={() => setBad(true)}/>;
}
/* Ícone de um app de sistema: o do .desktop instalado (ex.: org.gnome.Software) ou, se faltar, o ícone padrão do tema. */
function SysIcon({x, size = 30}) {
  const [bad, setBad] = useState(false), I = x.icon;
  const src = x.iconId ? `/api/app-icon?id=${encodeURIComponent(x.iconId)}` : `/api/app-icon?name=${encodeURIComponent(x.iconName)}`;
  useEffect(() => setBad(false), [src]);
  return bad ? <I size={size - 4}/> : <img src={src} alt="" width={size} height={size} draggable={false} onError={() => setBad(true)}/>;
}

/* Dock: apps de sistema (nativos) + aplicativos Linux iniciados pela grade. Estado vindo de duas fontes:
   a janela REAL (wmctrl/xdotool, em X11: aberto/ativo/minimizado) ou, sem esse suporte, o que foi iniciado nesta sessão.
   Clique: fechado → inicia; aberto → foca; focado → minimiza; minimizado → restaura. Botão direito remove um app extra. */
function Dock({system, wins, focus, workspace, extras, nativeInfo, sessionRunning, onSystem, onExtra, onRemove, dynamicDock = true}) {
  const stateOf = x => nativeInfo.supported ? (nativeInfo.apps[x.key] || {running: false}) : {running: sessionRunning.has(x.key)};
  const hint = (name, st) => st.running ? (st.minimized ? ' — clique para restaurar' : st.active ? ' — clique para minimizar' : ' — clique para focar') : '';
  return (
    <div className="dock">
      {system.map(x => {
        const w = x.embedded ? wins[x.embedded] : null, nat = stateOf(x);
        const emb = !!w?.open;
        const isMin = emb ? w.min : !!nat.minimized, isOpen = emb || !!nat.running;
        const isFocus = emb ? (focus === x.embedded && !w.min && w.workspace === workspace) : !!nat.active;
        return (
          <button key={x.id} data-app={x.embedded || x.id} data-sys={x.id} className={`sys ${!x.available && !x.embedded ? 'missing ' : ''}${isMin ? 'minimized ' : ''}${isFocus ? 'focused' : ''}`}
            title={`${x.title}${!x.available ? ` — não instalado${x.pkg ? ` (sudo apt install ${x.pkg})` : ''}` : hint(x.title, {running: isOpen, minimized: isMin, active: isFocus})}`}
            aria-label={x.title} onClick={() => onSystem(x.id)}>
            <SysIcon x={x}/>{isOpen && <small>{isMin ? '○' : '●'}</small>}
          </button>
        );
      })}
      {dynamicDock && extras.length > 0 && <i className="sep" aria-hidden="true"/>}
      {dynamicDock && extras.map(x => { const st = stateOf(x); return (
        <button key={x.key} data-app={x.key} className={`ext ${st.minimized ? 'minimized ' : ''}${st.active ? 'focused' : ''}`}
          title={`${x.name}${hint(x.name, st)} (botão direito: remover da Dock)`}
          aria-label={x.name} onClick={() => onExtra(x)} onContextMenu={e => { e.preventDefault(); onRemove(x); }}>
          <AppIcon app={x}/>{st.running && <small>{st.minimized ? '○' : '●'}</small>}
        </button>
      ); })}
    </div>
  );
}

/* Relógio isolado: antes o setInterval de 1s re-renderizava o desktop inteiro (Store, Nautilus…) a cada segundo. */
function Clock() {
  const [t, setT] = useState(() => new Date());
  useEffect(() => { const i = setInterval(() => setT(new Date()), 1000); return () => clearInterval(i); }, []);
  return <span>{t.toLocaleDateString('pt-BR', {weekday: 'short', day: '2-digit', month: 'short'})} {t.toLocaleTimeString('pt-BR', {hour: '2-digit', minute: '2-digit'})}</span>;
}

/* ---------- Activities (visão de aplicativos estilo GNOME) ---------- */
function Activities({system, launchSystem, openInterface, openNautilus, launchApp, openUrl, onClose}) {
  const [q, setQ] = useState('');
  const [linux, setLinux] = useState(null); /* null = carregando */
  const [files, setFiles] = useState([]);
  useEffect(() => { let alive = true; api('/api/apps').then(d => alive && setLinux(Array.isArray(d) ? d : [])).catch(() => alive && setLinux([])); return () => { alive = false; }; }, []);
  useEffect(() => {
    const term = q.trim();
    if (!term) { setFiles([]); return; }
    let alive = true; /* arquivos: com atraso; aplicativos: filtro instantâneo, no cliente */
    const t = setTimeout(() => { api('/api/search?q=' + encodeURIComponent(term)).then(x => alive && setFiles(Array.isArray(x) ? x.filter(f => !f.name.endsWith('.desktop')) : [])).catch(() => alive && setFiles([])); }, 180);
    return () => { alive = false; clearTimeout(t); };
  }, [q]);
  useEffect(() => {
    const k = e => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);

  const needle = q.trim().toLowerCase(), term = q.trim();
  const sysItems = system.filter(x => !needle || (x.title + ' ' + x.id).toLowerCase().includes(needle));
  const ifaceMatch = !needle || 'interface aparência papel de parede tema configurações da interface'.includes(needle);
  const taken = new Set(system.map(x => x.winId)); /* o mesmo app não aparece duas vezes (nativo de sistema × lista de .desktop) */
  const sys = (linux || []).filter(a => !taken.has(a.id) && (!needle || (a.name + ' ' + a.id.replace(/\.desktop$/, '')).toLowerCase().includes(needle)));
  const pickSystem = id => { launchSystem(id); onClose(); };
  const pickLinux = a => { launchApp({kind: 'desktop', id: a.id, name: a.name}); onClose(); };
  const pickFile = x => { openNautilus(x.type === 'folder' ? x.path : parentOf(x.path)); onClose(); };
  const webSearch = () => { openUrl('https://duckduckgo.com/?q=' + encodeURIComponent(term)); onClose(); }; /* navegador padrão do sistema */
  const onKey = e => {
    if (e.key !== 'Enter') return;
    if (sysItems[0]) pickSystem(sysItems[0].id); else if (ifaceMatch && needle) { openInterface(); onClose(); }
    else if (sys[0]) pickLinux(sys[0]); else if (files[0]) pickFile(files[0]); else if (term) webSearch();
  };

  return (
    <div className="activities" role="dialog" aria-label="Atividades" onMouseDown={e => { if (!e.target.closest('button, input')) onClose(); }}>
      <div className="act-search"><Search size={18}/><input autoFocus value={q} onChange={e => setQ(e.target.value)} onKeyDown={onKey} placeholder="Digite para buscar aplicativos, arquivos e pastas" aria-label="Buscar"/><kbd>Esc</kbd></div>
      <div className="act-grid">
        {sysItems.map(x => <button key={x.id} className="act-app" title={x.available ? x.title : `${x.title} — não instalado (sudo apt install ${x.pkg})`} onClick={() => pickSystem(x.id)}><span className="act-ico"><SysIcon x={x} size={46}/></span><span className="act-name">{x.title}</span></button>)}
        {ifaceMatch && <button className="act-app" onClick={() => { openInterface(); onClose(); }}><span className="act-ico"><SlidersHorizontal size={32}/></span><span className="act-name">Aparência da Interface</span></button>}
        {sys.map(a => <button key={a.id} className="act-app" title={a.exec || a.name} onClick={() => pickLinux(a)}><span className="act-ico"><AppIcon app={{kind: 'desktop', id: a.id}} size={44}/></span><span className="act-name">{a.name}</span></button>)}
      </div>
      {linux === null && <p className="act-hint">Carregando aplicativos…</p>}
      {files.length > 0 && <div className="act-files"><h3>Arquivos e pastas</h3>{files.map(x => <button key={x.path} onClick={() => pickFile(x)}><FileText size={16}/><span>{x.name}</span><small>{x.path}</small></button>)}</div>}
      {term && <div className="act-files"><h3>Web</h3><button onClick={webSearch}><Globe size={16}/><span>Pesquisar “{term}” no navegador do sistema</span><small>abre o navegador padrão em uma janela separada</small></button></div>}
    </div>
  );
}

/* ---------- Terminal ---------- */
function Terminal() {
  const ref = useRef(null);
  const [gen, setGen] = useState(0); /* incrementar = abrir uma nova sessão de shell */
  useEffect(() => {
    const el = ref.current; let disposed = false, ended = false;
    const t = new XTerminal({cursorBlink: true, fontSize: 13, scrollback: 5000, fontFamily: 'ui-monospace, "SF Mono", Menlo, "DejaVu Sans Mono", "Ubuntu Mono", monospace', theme: {background: '#080a0f'}});
    const fit = new FitAddon();
    t.loadAddon(fit); t.open(el);
    /* Com a janela minimizada/oculta o tamanho é 0: não ajustar, senão o PTY recebia um tamanho minúsculo. */
    const visible = () => el.clientWidth > 0 && el.clientHeight > 0;
    const doFit = () => { if (visible()) { try { fit.fit(); } catch {} } };
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const s = new WebSocket(`${proto}://${location.host}/ws/terminal`);
    const sendResize = () => { if (s.readyState === 1) s.send(JSON.stringify({type: 'resize', cols: t.cols, rows: t.rows})); };
    s.onopen = () => { doFit(); sendResize(); t.focus(); }; /* o resize inicial era enviado antes da conexão abrir e se perdia */
    s.onmessage = e => {
      let x; try { x = JSON.parse(e.data); } catch { return; }
      if (x.type === 'data') t.write(x.data);
      else if (x.type === 'exit') { ended = true; t.write(`\r\n[processo terminou${x.code != null ? ' · código ' + x.code : ''} — pressione Enter para abrir um novo shell]\r\n`); }
      else if (x.type === 'error') t.write(`\r\n\x1b[31m${x.message}\x1b[0m\r\n`);
    };
    s.onclose = () => { if (!disposed && !ended) { ended = true; t.write('\r\n[conexão encerrada — pressione Enter para reconectar]\r\n'); } };
    s.onerror = () => { if (!disposed && !ended) t.write('\r\n[erro de conexão com o servidor do terminal]\r\n'); };
    const d = t.onData(data => {
      if (s.readyState === 1) s.send(JSON.stringify({type: 'input', data}));
      else if (ended && data.includes('\r')) setGen(g => g + 1); /* antes, depois de `exit` o Terminal ficava morto até fechar a janela */
    });
    const ro = new ResizeObserver(() => { if (!visible()) return; doFit(); sendResize(); });
    ro.observe(el);
    const timer = setTimeout(doFit, 50);
    return () => { disposed = true; clearTimeout(timer); ro.disconnect(); d.dispose(); s.close(); t.dispose(); };
  }, [gen]);
  return <div ref={ref} className="terminal"/>;
}

/* ---------- Monitor ---------- */
function SystemMonitor() {
  const ref = useRef(null);
  const [sys, setSys] = useState(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    let alive = true;
    /* janela minimizada / em outro workspace (display:none → offsetParent nulo) ou aba em segundo plano: não consulta */
    const load = () => { if (document.hidden || !ref.current?.offsetParent || ref.current.closest('.win.min')) return; api('/api/system').then(x => { if (alive) { setSys(x); setErr(false); } }).catch(() => alive && setErr(true)); };
    load();
    const t = setInterval(load, 3000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  return (
    <div className="monitor" ref={ref}>
      <h2>Monitor do Sistema</h2>
      {!sys && !err && <p className="hint">Carregando…</p>}
      {err && <p className="hint">Sem resposta do servidor.</p>}
      {sys && (
        <div className="metrics">
          <div><Cpu/><b>CPU</b><span>{sys.cores} núcleos · carga {sys.load?.map(n => n.toFixed(2)).join(' / ')}</span></div>
          <div><MemoryStick/><b>RAM</b><span>{formatBytes(sys.ram.used)} / {formatBytes(sys.ram.total)}</span></div>
          <div><MonitorIcon/><b>GPU</b><span>{sys.gpus?.join(' · ') || 'Nenhuma GPU reportada pelo lspci'}</span></div>
          <div><HardDrive/><b>Discos</b><pre>{sys.disks}</pre></div>
        </div>
      )}
    </div>
  );
}

/* Dock persistida: valida o formato (localStorage pode ter sido editado) */
const loadDock = () => {
  const v = loadPref('ui.dockapps', []);
  return (Array.isArray(v) ? v : []).filter(x => x && ['desktop', 'flatpak', 'snap'].includes(x.kind) && typeof x.id === 'string' && /^[\w.+@-]{1,160}$/.test(x.id) && typeof x.name === 'string')
    .slice(-12).map(x => ({key: `${x.kind}:${x.id}`, kind: x.kind, id: x.id, name: x.name.slice(0, 80)}));
};

/* ---------- Desktop ---------- */
function App() {
  const [s, dispatch] = useReducer(reducer, initial);
  const [launch, setLaunch] = useState(false);
  const [dark, setDark] = useState(() => loadPref('ui.dark', true) !== false);
  const [wallpaper, setWallpaper] = useState(() => { const v = loadPref('ui.wallpaper', 'padrao'); return WALLPAPERS.some(w => w.id === v) ? v : 'padrao'; });
  const [customWp, setCustomWp] = useState(null); /* {url, name}: imagem escolhida pelo usuário (blob local, só vale nesta sessão) */
  const [notif, setNotif] = useState(null);
  const [interfaceSettings, setInterfaceSettings] = useState(() => ({
    animations: true, dynamicDock: true, notifications: true, desktopIcons: true, visualEffects: true
  }));

  useEffect(() => {
    const load = () => api('/api/interface-settings').then(x => setInterfaceSettings(v => ({...v, ...(x || {})}))).catch(() => {});
    load();
    const changed = e => setInterfaceSettings(v => ({...v, ...(e.detail || {})}));
    window.addEventListener('interface-settings-changed', changed);
    return () => window.removeEventListener('interface-settings-changed', changed);
  }, []);

  const notify = useCallback(n => {
    if (!interfaceSettings.notifications) return;
    setNotif({...n, id: Date.now()});
  }, [interfaceSettings.notifications]);
  const closeLauncher = useCallback(() => setLaunch(false), []);
  const openNautilus = useCallback(path => post('/api/system/open-nautilus', {path}).catch(e => notify({title: 'Nautilus', body: e.message})), [notify]);
  /* URLs abrem no navegador PADRÃO do sistema (xdg-open / gio open), numa janela/aba nativa: nada é carregado dentro desta interface. */
  const openUrl = useCallback(url => post('/api/open-url', {url}).catch(e => notify({title: 'Navegador', body: e.message})), [notify]);
  const open = useCallback(id => dispatch({type: 'OPEN', id}), []); /* janelas embutidas */

  /* Apps de sistema: o servidor diz qual .desktop/executável está realmente instalado (e qual ícone usar). */
  const [sysList, setSysList] = useState({});
  useEffect(() => { api('/api/system-apps').then(l => setSysList(Object.fromEntries(l.map(x => [x.id, x])))).catch(() => {}); }, []);
  const system = useMemo(() => SYSTEM.map(d => { const i = sysList[d.id] || {}; const winId = i.winId || d.win;
    return {...d, available: i.available !== false, winId, iconId: i.iconId || null, iconName: i.iconName || d.iconName, pkg: i.pkg, key: `desktop:${winId}`}; }), [sysList]);

  const [dockApps, setDockApps] = useState(loadDock);
  const [running, setRunning] = useState(() => new Set()); /* iniciados nesta sessão (usado quando o sistema não permite ver as janelas) */
  /* Inicia um app Linux (.desktop / Flatpak / Snap) e o fixa na Dock sem duplicar. Devolve true/false. */
  const launchApp = useCallback(async ({kind, id, name}) => {
    try { await post('/api/launch', {kind, id}); }
    catch (e) { notify({title: 'Interface', body: `Falha ao abrir ${name || id}: ${e.message}`}); return false; }
    const key = `${kind}:${id}`;
    setDockApps(l => l.some(x => x.key === key) ? l : [...l, {key, kind, id, name: name || id}].slice(-12));
    setRunning(r => new Set(r).add(key));
    return true;
  }, [notify]);
  const removeDock = useCallback(x => { setDockApps(l => l.filter(y => y.key !== x.key)); setRunning(r => { const n = new Set(r); n.delete(x.key); return n; }); }, []);
  useEffect(() => { savePref('ui.dockapps', dockApps); }, [dockApps]);

  /* Estado das janelas NATIVAS (aberto/ativo/minimizado) vindo do servidor. Sem suporte (Wayland, sem wmctrl) consulta raramente. */
  const [nativeInfo, setNativeInfo] = useState({supported: false, apps: {}});
  const nativeRef = useRef(nativeInfo); nativeRef.current = nativeInfo;
  const hinted = useRef(false);
  const refreshNative = useCallback(() => post('/api/windows/state', {apps: [...dockApps.map(({kind, id}) => ({kind, id})), ...system.map(x => ({kind: 'desktop', id: x.winId}))]})
    .then(d => setNativeInfo({supported: !!d.supported, apps: d.apps || {}, message: d.message, reason: d.reason, canMinimize: d.canMinimize})).catch(() => {}), [dockApps, system]);
  useEffect(() => {
    let alive = true, t;
    const tick = async () => {
      if (!document.hidden) await refreshNative();
      if (alive) t = setTimeout(tick, nativeRef.current.supported ? 2500 : 20000);
    };
    tick();
    return () => { alive = false; clearTimeout(t); };
  }, [refreshNative]);
  const hintOnce = useCallback(() => { const i = nativeRef.current; if (!i.supported && i.message && !hinted.current) { hinted.current = true; notify({title: 'Janelas nativas', body: i.message}); } }, [notify]);

  /* Controla uma janela nativa (alterna foco/minimizar/restaurar); se não estiver aberta, inicia. */
  const controlNative = useCallback(async x => {
    const info = nativeRef.current;
    if (info.supported && info.apps[x.key]?.running) {
      try { await post('/api/windows/control', {kind: x.kind, id: x.id, action: 'toggle'}); }
      catch (e) { notify({title: x.name, body: e.message}); }
      return refreshNative();
    }
    hintOnce();
    const ok = await launchApp(x); if (ok) setTimeout(refreshNative, 1200);
  }, [notify, launchApp, refreshNative, hintOnce]);

  /* Abre um app de SISTEMA nativo. Se não estiver instalado (ou falhar) e houver versão embutida, abre a embutida; senão mostra como instalar. */
  const launchSystem = useCallback(async id => {
    const x = system.find(y => y.id === id); if (!x) return false;
    hintOnce();
    try { await post('/api/system-apps/launch', {id}); }
    catch (e) {
      if (x.embedded) { notify({title: x.title, body: `${e.message} Abrindo a versão embutida.`}); dispatch({type: 'OPEN', id: x.embedded}); }
      else notify({title: x.title, body: e.message});
      return false;
    }
    setRunning(r => new Set(r).add(x.key)); setTimeout(refreshNative, 1200);
    return true;
  }, [system, notify, refreshNative, hintOnce]);
  /* Clique na Dock: janela embutida aberta → foca/minimiza/restaura; janela nativa aberta → controla pelo servidor; senão abre o nativo. */
  const dockSystem = useCallback(id => {
    const x = system.find(y => y.id === id); if (!x) return;
    const w = x.embedded ? s.wins[x.embedded] : null;
    if (w?.open) {
      if (w.min || w.workspace !== s.workspace) dispatch({type: 'OPEN', id: x.embedded});
      else if (s.focus === x.embedded) minimizeWin(dispatch, x.embedded);
      else dispatch({type: 'FOCUS', id: x.embedded});
      return;
    }
    if (nativeRef.current.supported && nativeRef.current.apps[x.key]?.running) return controlNative({kind: 'desktop', id: x.winId, key: x.key, name: x.title});
    launchSystem(id);
  }, [system, s.wins, s.workspace, s.focus, controlNative, launchSystem]);
  /* Super/Meta sozinho abre e fecha as Atividades (combinações como Super+tecla são ignoradas). */
  useEffect(() => {
    let pure = false;
    const isSuper = e => e.key === 'Meta' || e.key === 'OS';
    const dn = e => { if (isSuper(e)) { if (!e.repeat) pure = true; } else pure = false; };
    const up = e => { if (isSuper(e) && pure) { pure = false; setLaunch(v => !v); } };
    const reset = () => { pure = false; };
    window.addEventListener('keydown', dn, true); window.addEventListener('keyup', up, true); window.addEventListener('blur', reset);
    return () => { window.removeEventListener('keydown', dn, true); window.removeEventListener('keyup', up, true); window.removeEventListener('blur', reset); };
  }, []);

  /* Papel de parede personalizado: URL local (URL.createObjectURL), aplicada na hora, sem enviar nem gravar nada em disco. */
  const pickWallpaper = useCallback(file => {
    if (!file || !file.type.startsWith('image/')) { notify({title: 'Interface', body: 'Selecione um arquivo de imagem válido.'}); return; }
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => {
      setCustomWp({url, name: file.name}); /* a URL anterior é liberada pelo efeito de limpeza abaixo */
      setWallpaper('custom');
    };
    img.onerror = () => { URL.revokeObjectURL(url); notify({title: 'Interface', body: 'Não foi possível carregar essa imagem.'}); };
    img.src = url;
  }, [notify]);
  useEffect(() => () => { if (customWp) URL.revokeObjectURL(customWp.url); }, [customWp]);

  useEffect(() => {
    const fit = () => dispatch({type: 'FIT', w: innerWidth, h: innerHeight});
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);
  useEffect(() => { savePref('ui.dark', dark); }, [dark]);
  useEffect(() => { savePref('ui.wallpaper', wallpaper); }, [wallpaper]);
  useEffect(() => { if (!notif) return; const t = setTimeout(() => setNotif(null), 6000); return () => clearTimeout(t); }, [notif]);

  const content = {
    terminal: <Terminal/>,
    settings: <SystemSettings dark={dark} setDark={setDark} wallpaper={wallpaper} setWallpaper={setWallpaper} customWallpaper={customWp} onPickImage={pickWallpaper}/>,
    monitor: <SystemMonitor/>,
  };

  return (
    <div className={`desktop ${dark ? 'dark' : 'light'}${wallpaper !== 'padrao' ? ` wp-${wallpaper}` : ''}${interfaceSettings.animations ? '' : ' no-animations'}${interfaceSettings.visualEffects ? '' : ' no-effects'}`}
      style={wallpaper === 'custom' && customWp ? {backgroundImage: `url("${customWp.url}")`, backgroundSize: 'cover', backgroundPosition: 'center', backgroundRepeat: 'no-repeat'} : undefined}>
      <header className="menubar">
        <div className="brand">
          <button aria-label="Atividades" title="Atividades (Super)" onClick={() => setLaunch(v => !v)}><Menu size={16}/></button>
          <b>{s.focus && s.wins[s.focus]?.open ? APP[s.focus].title : 'Interface'}</b><span>Arquivo</span><span>Editar</span><span>Janela</span>
        </div>
        <div className="right">
          <button aria-label="Configurações da Interface" title="Aparência e ajustes da Interface" onClick={() => open('settings')}><SlidersHorizontal size={15}/></button>
          <button aria-label="Notificações" onClick={() => notify({title: 'Interface', body: 'Notificações do desktop ativas.'})}><Bell size={15}/></button>
          <button aria-label="Buscar" onClick={() => setLaunch(true)}><Search size={15}/></button>
          <Clock/>
        </div>
      </header>
      {interfaceSettings.desktopIcons && <div className="desktopicons">
        <button onDoubleClick={() => launchSystem('files')}><Folder/><span>Nautilus</span></button>
        <button onDoubleClick={() => launchSystem('software')}><StoreIcon/><span>Software</span></button>
      </div>}
      <main>{Object.keys(APP).map(id => <Window key={id} id={id} state={s} dispatch={dispatch}>{content[id]}</Window>)}</main>
      <div className="workspacebar">
        {[1, 2, 3, 4].map(n => <button className={s.workspace === n ? 'active' : ''} onClick={() => dispatch({type: 'WORK', n})} key={n}>{n}</button>)}
        <span>Workspaces</span>
      </div>
      <Dock system={system} wins={s.wins} focus={s.focus} workspace={s.workspace} extras={dockApps} nativeInfo={nativeInfo} sessionRunning={running} onSystem={dockSystem} onExtra={controlNative} onRemove={removeDock} dynamicDock={interfaceSettings.dynamicDock}/>
      {launch && <Activities system={system} launchSystem={launchSystem} openInterface={() => open('settings')} openNautilus={openNautilus} launchApp={launchApp} openUrl={openUrl} onClose={closeLauncher}/>}
      {notif && <div className="toast"><AlertCircle/><div><b>{notif.title}</b><span>{notif.body}</span></div><button aria-label="Fechar" onClick={() => setNotif(null)}><X size={14}/></button></div>}
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App/>);
