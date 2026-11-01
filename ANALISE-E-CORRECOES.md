# Interface 0.0.1.5 — análise e correções

Escopo: `server.js`, `src/main.jsx`, `src/index.css`, `index.html`, `package.json`.
Gravidade: 🔴 crítica/segurança · 🟠 funcionalidade quebrada · 🟡 comportamento incorreto · ⚪ polimento.

## Segurança
| # | Problema | Correção |
|---|----------|----------|
| 🔴 1 | **WebSocket do Terminal sem checar Origin**: qualquer site aberto no navegador podia abrir `ws://127.0.0.1:3000/ws/terminal` e executar comandos no seu usuário (Cross-Site WebSocket Hijacking). | `verifyClient` aceita só Host/Origin locais. |
| 🔴 2 | **Injeção de comando** em `/api/open-app`: o nome vinha do cliente e ia para `sh -lc "command -v <nome>"`. | Busca no PATH feita em Node (sem shell); a rota só abre Chrome/Chromium e não aceita nomes arbitrários. |
| 🔴 3 | **DNS rebinding / POST cross-site** nas rotas `/api/*` (leitura de arquivos, spawn de apps). | Middleware valida `Host` e, em POST, `Origin`. |
| 🟠 4 | Iframe do Chrome aceitava `javascript:`/`data:` (sandbox com `allow-same-origin` → rodava na origem do desktop, com acesso ao terminal). | Só `http(s)` é aceito. |
| ⚪ 5 | `xdg-settings`/`notify-send` recebiam argumentos sem validação. | Validação do nome `.desktop` e `--` antes dos argumentos do `notify-send`. |

## Servidor
- 🟠 `spawn` sem handler de `error` → servidor caía se o executável falhasse. Corrigido.
- 🟠 `import pty from 'node-pty'` no topo: se a compilação nativa falhasse, **o servidor inteiro não subia**. Agora é import dinâmico; o resto funciona e o Terminal mostra a causa.
- 🟠 Symlinks para pastas apareciam como arquivo (`Dirent.isDirectory()`) e não abriam. Agora usa `stat`.
- 🟡 Busca (`/api/search`) só descia 1 nível dentro da home (a condição `dir===home` impedia a recursão). Agora recursiva (prof. 3, limite de tempo/itens).
- 🟡 Erros de permissão eram sempre 404; agora 403/404/500. Rotas `/api` inexistentes devolviam o `index.html`; agora JSON 404.
- 🟡 `apt-cache pkgnames` + `slice(0,300)`: só 300 pacotes sem ordem eram pesquisáveis, e o `maxBuffer` de 2 MB podia estourar. Nova rota `/api/store/apt?q=` pesquisa de verdade no servidor.
- 🟡 Flatpak/Snap chegavam como linha crua (com TAB). Agora objetos `{id,name,version}`.
- 🟡 `.desktop`: lia chaves de qualquer seção (`[Desktop Action]`), ignorava `Hidden`/`Type`, não deduplicava. `df` listava dezenas de loops `squashfs` do snap. GPU (`lspci`) rodava a cada 3 s.
- ⚪ Redimensionar o PTY aceitava qualquer número; `NODE_ENV=production` vazava para o shell; sem tratamento de `EADDRINUSE`/SIGINT; `dist` ausente gerava erro confuso.
- 🟠 **Novo** `/api/launch`: o botão "Abrir" da Store não fazia nada. Agora abre `.desktop` (via `gio launch`/`gtk-launch`), flatpak e snap.

## Interface (React)
- 🟠 **Nautilus**: "avançar" fazia o mesmo que "voltar" (ambos iam para a pasta pai). Agora há histórico real + botão "subir". Erros (sem permissão/não encontrado) são exibidos. Pastas aparecem antes dos arquivos.
- 🟠 **Terminal**: o primeiro `resize` era enviado antes do WebSocket abrir (PTY ficava 100×30). Janela minimizada/oculta mandava tamanho minúsculo para o PTY. `setTimeout` não era cancelado. Sem mensagem de queda de conexão.
- 🟠 **Workspaces**: trocar de workspace **desmontava** o Terminal e matava o shell. Agora a janela só fica oculta.
- 🟠 **Launcher**: `Esc` não fazia nada (apesar do `<kbd>Esc</kbd>`); clicar em resultado não abria o Nautilus na pasta; arquivos `.desktop` não abriam; respostas antigas da busca podiam sobrescrever as novas; Enter não executava. Corrigidos.
- 🟠 **Chrome**: página inicial `google.com` nunca carrega em iframe (X-Frame-Options); "Abrir no Chrome" não passava a URL digitada; URL sem `https://` não era normalizada. Agora há página inicial local explicativa, normalização e envio da URL.
- 🟠 **Arrastar/redimensionar** travava ao passar sobre o iframe do Chrome. Janela podia ir para baixo da barra de menus (clamp 28 px, barra tem 34 px) e para fora da tela. Maximizada cobria 11 px do Dock.
- 🟡 **Dock**: o indicador "●" aparecia sempre no Chrome e nunca nos demais; agora indica apps abertos.
- 🟡 `formatBytes` só tinha B/KB (RAM aparecia como `16777216.0 KB`). Agora até TB.
- 🟡 Relógio com `setInterval` no `App` re-renderizava o desktop inteiro a cada segundo. Isolado em `<Clock/>`.
- 🟡 Settings: "consultando..." eterno se `xdg-settings` faltasse; mostrava Chrome como padrão mesmo quando o comando falhava.
- 🟡 Store "Instalar" (APT) só disparava `notify-send` (invisível se ausente). Agora copia `sudo apt install <pacote>`, abre o Terminal e mostra aviso na tela.
- 🟡 Janelas novas nasciam todas na mesma posição (agora em cascata); `z-index` crescia sem limite e podia passar por cima do Dock/menu (agora é compactado); toast nunca sumia (agora 6 s).
- ⚪ CSS: card do launcher esticava até o rodapé (`align-items`); modo claro com chips/botões/workspaces ilegíveis; `color-scheme` fixo em dark; tabela do `df` quebrava; imports não usados; `index.css.bak` e pastas vazias removidos.

## Mudanças de comportamento que você pode notar
- "Discos" no Nautilus agora aponta para `/media` (onde o Ubuntu monta pendrives/HDs) em vez de `/mnt`.
- APT na Store só lista pacotes após digitar 2+ letras.

## Novidades da 0.0.1.5
- Duplo clique em arquivo no Nautilus mostra pré-visualização de texto (≤ 512 KB).
- A barra de menus mostra o nome do app em foco.
- Configurações mostra se o Terminal (node-pty) está ativo; novo script `npm run setup:terminal`.
- Menus "Arquivo/Editar/Janela" continuam apenas decorativos.

## Como foi validado
- `node --check server.js` e compilação do JSX com esbuild.
- Teste no Chromium (33 verificações) com a UI real e API simulada: Nautilus (histórico/erros), workspaces sem matar o Terminal, resize inicial do PTY, launcher (Esc/clique fora/abrir pasta/.desktop), arrastar/maximizar, Store, Settings, Monitor, bloqueio de `javascript:`.
- Teste das rotas do servidor (Host/Origin, WebSocket `verifyClient`, symlinks, busca, parsing de `.desktop`, validações de `launch`/`open-app`/`apt`).
- **Não foi possível** rodar `npm install`/`vite build` com as dependências reais (`express`, `node-pty`, `lucide-react`, `@xterm/*`) por falta de rede no ambiente de análise; nos testes `lucide-react` e `xterm` foram substituídos por stubs e `express` por um simulador. Rode `npm install && npm run build` aí para a confirmação final.

---

# Rodada 2 — revisão da 0.0.1.5 com `SystemSettings.jsx`

| # | Gravidade | Problema | Correção |
|---|-----------|----------|----------|
| 1 | 🔴 | **Tela em branco.** `main.jsx` usa `useState/useEffect/useReducer/useRef/useCallback`, mas o `import … from 'react'` não existia (a linha 1 passou a ser o import do `SystemSettings`). O `vite build` **passa sem avisar** e o erro só aparece no navegador: `ReferenceError: useReducer is not defined`. O `dist/` que veio no zip tinha o mesmo defeito. | Import dos hooks restaurado; `dist/` recompilado. |
| 2 | 🟠 | `SystemSettings.jsx` usava classes **Tailwind** (`flex`, `rounded-xl`, `bg-white/5`, `animate-in`…), mas o projeto não tem Tailwind: a janela ficava sem estilo. | Reescrito com CSS próprio (`.ss-*` em `index.css`), que funciona nos temas claro e escuro. |
| 3 | 🟠 | `SystemSettings` ignorava as props `dark/setDark`: os botões Claro/Escuro mudavam só um estado local e **não alteravam o desktop**. | Usa `dark/setDark` de verdade. |
| 4 | 🟠 | Regressão: a janela nova removeu da Settings antiga o status do **node-pty**, a **versão** e o **navegador padrão** (e a função `Settings` ficou como código morto). | Voltaram na aba **Geral**, junto com dados reais de `/api/system` (host, CPU, RAM, GPU, discos). Código morto removido. |
| 5 | 🟡 | `SidebarItem`, `WifiTab` e `AppearanceTab` eram declarados **dentro** do componente: a cada mudança de estado o React remontava a aba inteira. | Movidos para fora do componente principal. |
| 6 | 🟡 | Papéis de parede: cartões com `cursor-pointer` sem `onClick` (`setWallpapers` nunca usado). Botões "Conectar", "Adicionar imagem" e "Encerrar sessão" sem ação; "Conectar" só aparecia no hover (inacessível por teclado/toque). | Papel de parede realmente aplicado ao desktop; tema e papel de parede **persistem** (localStorage, com validação). Botões sem função ficaram desativados com explicação; aba Wi-Fi marcada como "dados de demonstração". |
| 7 | 🟡 | `/api/search`: o limite e o prazo eram globais; a home (varrida primeiro) esgotava tudo e os **apps `.desktop` nunca apareciam** no Launcher. Também listava o mesmo `.desktop` duas vezes. | Orçamento por raiz (apps primeiro) e deduplicação. |
| 8 | ⚪ | `safePath`: `~foo` era tratado como `~/foo`. | Só `~` e `~/…` expandem. |
| 9 | ⚪ | Duplo clique nos botões do semáforo também disparava o "maximizar" do cabeçalho. `normalizeUrl` deixava passar `ftp://`, `ws://`… | Corrigido. |

**Validação desta rodada:** build real com as dependências do seu `node_modules` (Vite 5.4.21) + 20 verificações no Chromium headless (render, estilo das Configurações, tema, papel de parede, persistência, aba Geral, Launcher/Esc/busca `.desktop`, Nautilus, Monitor, bloqueio de `ftp://`) e comparação servidor antigo × novo para a busca. O `node-pty` não pôde ser carregado no ambiente de teste (binário compilado para a sua máquina), então o Terminal foi verificado só até o aviso de indisponibilidade.


---

# Rodada 3 — revisão da 0.0.1.7 → entrega 0.0.1.9

| # | Gravidade | Problema | Correção |
|---|-----------|----------|----------|
| 1 | 🔴 | **Electron: `loadFile(dist/index.html)`** carregava o desktop via `file://`; sem servidor, todas as chamadas `/api/*` e o WebSocket do Terminal falhavam. | Janela carrega `http://127.0.0.1:PORT` depois de esperar `/api/health` do servidor. Se a porta estiver ocupada ou o servidor falhar, mostra um erro claro. |
| 2 | 🔴 | **Electron: `nodeIntegration: true` + `contextIsolation: false`** — qualquer XSS viraria execução de código na máquina. | `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`; links externos abrem no navegador do sistema. |
| 3 | 🟠 | `package.json` apontava `"main": "main.js"`, mas o arquivo estava em `src/main.js` (`electron .` não iniciava). `electron-builder` não empacotava o arquivo e faltava `author` (exigido para `.deb`). | Arquivo movido para `electron/main.js`; `main`, `files`, `asarUnpack` (node-pty) e `author` ajustados; scripts `electron` e `start:electron`. |
| 4 | 🟠 | Electron: `app.stop ? app.quit() : app.quit()`, servidor só encerrado em `window-all-closed` (ficava órfão ao sair por outro caminho), sem instância única, sem tratamento de falha do servidor. | `before-quit` encerra o servidor; trava de instância única; em desenvolvimento o servidor roda no Node do sistema (mesmo ABI do `npm run setup:terminal`), empacotado usa o runtime do Electron. |
| 5 | 🟠 | **Terminal ficava morto** depois que o shell terminava (`exit`) ou a conexão caía: só fechando a janela. | **Enter** abre uma nova sessão; o servidor fecha o WebSocket quando o shell termina. |
| 6 | 🟡 | O shell do Terminal herdava dezenas de variáveis `npm_*` / `INIT_CWD` do `npm run dev`. | Removidas do ambiente do PTY. |
| 7 | 🟡 | VRAM de GPU AMD vinha errada do `systeminformation` (lê regiões PCI do `lspci`). | Usa `mem_info_vram_total` do sysfs (driver amdgpu) quando disponível; senão mantém o valor da biblioteca. `si.graphics()` agora tem timeout de 10 s. |
| 8 | 🟡 | Porcentagem do disco vinha do `use` do `df` (desconta blocos reservados) e não batia com "X em uso de Y". | `percent = used / size`. |
| 9 | 🟡 | Versão duplicada (constante no `server.js` + `package.json`) — já tinha ficado fora de sincronia. | `server.js` lê a versão do `package.json`. |
| 10 | 🟡 | Sem cabeçalhos de segurança: o desktop (e o Terminal) podiam ser embutidos em iframe por outro site. | `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store` em `/api`. |
| 11 | 🟡 | Chrome embutido aceitava abrir `localhost:3000` (o próprio desktop dentro dele). | Bloqueado com aviso (`localhost`, `127.0.0.1` e `[::1]` são tratados como o mesmo host). |
| 12 | 🟡 | App Store mostrava `firefox %u` (códigos de campo do `.desktop`). | Códigos `%U`, `%f`… removidos. Falha em `/api/store` agora mostra aviso em vez de lista vazia silenciosa. |
| 13 | 🟡 | Monitor do Sistema consultava `/api/system` (e rodava `df`) a cada 3 s mesmo minimizado, em outro workspace ou com a aba em segundo plano; sem indicador de carregamento. | Só consulta quando visível; mostra "Carregando…". |
| 14 | 🟡 | Ao encolher a janela do navegador/Electron, janelas ficavam fora da tela, inalcançáveis. | Evento `resize` reposiciona as janelas na área visível. |
| 15 | ⚪ | `key={i}` nos resultados do Launcher; `BUILD-FIX.txt` / `STYLE-FIX.txt` desatualizados (0.0.1.4). | `key` estável; arquivos removidos (histórico está neste documento). |

**Validação desta rodada:** build real (Vite 5.4.21) com o seu `node_modules`; testes do servidor (versão, cabeçalhos, Host/Origin inválidos, WebSocket com Origin falsa → 401, parsing de `.desktop`, `/api/hardware-info`); 14 verificações no Chromium headless (render, Monitor sem polling oculto, Terminal + reconexão, Chrome embutido, reposicionamento de janelas, Configurações → Geral, Store, console sem erros).

**Não foi possível validar aqui:** o Terminal com `node-pty` real (binário nativo da sua máquina), a leitura de VRAM via sysfs numa GPU AMD real e todo o fluxo Electron (`electron`/`electron-builder` não estão no seu `node_modules` e o ambiente de análise não tem rede). O `package-lock.json` ainda não inclui `electron`/`electron-builder`: rode `npm install` para atualizá-lo.


---

# Rodada 4 — 0.0.2.0: Configurações reais

**Backend (`server/system.js`, registrado em `server.js`)**
- Tudo com `execFile` (sem shell → sem injeção), assíncrono, com timeout e `LC_ALL=C.UTF-8` para a saída ser estável.
- Erros viram mensagens legíveis: comando ausente (501), sem permissão/polkit (403), sem acesso ao `DISPLAY` (503), timeout (504), falha do comando (500).
- Entradas validadas: SSID (≤ 32 bytes, sem `-` inicial), senha WPA (8–63), MAC Bluetooth, monitor/resolução/taxa **conferidos contra o que o próprio `xrandr` listou**, dispositivos de áudio conferidos contra o `wpctl (fallback amixer)`, perfis fixos, minutos 0–240.
- `nmcli -t`: parser trata `\:` (BSSID e SSIDs com dois-pontos); redes duplicadas (vários BSSIDs) são unificadas e redes ocultas ignoradas.
- Rede: `ip -j addr` + `ip -j route` (IP, máscara calculada do prefixo, gateway por interface; ignora lo/docker/veth/br-).
- Som: `wpctl (fallback amixer) -f json`; entradas "Monitor of…" são filtradas.

**Interface (`SystemSettings.jsx`)** — mesmo visual (classes `.ss-*`, tema claro/escuro, cantos arredondados). Hooks `useLoad`/`useAction` dão carregamento, atualização periódica (pausada com a aba oculta), erro amigável e botões desativados enquanto a ação roda. Resolução: depois de aplicar, aparece "Manter estas configurações?" com contagem de 15 s e **reversão automática**. Slider de volume com debounce.

**Limites conhecidos**
- Senha do Wi-Fi vai como argumento do `nmcli` (como pedido); em máquina multiusuário ela é visível por instantes no `ps`.
- `xrandr`/`xset` em Wayland têm efeito limitado. Bluetooth: `pair` pode exigir confirmação de PIN que a CLI não responde sozinha.
- Alguns hardwares não expõem os três perfis do `powerprofilesctl`; os indisponíveis ficam desativados.

**Validação:** 20 verificações de UI no Chromium com binários simulados de `nmcli`, `bluetoothctl`, `xrandr`, `wpctl (fallback amixer)`, `powerprofilesctl` e `xset` (conectar com senha certa/errada, falha de Bluetooth, reversão de resolução, slider, perfis, ociosidade, estado "comando ausente"), testes das rotas por `curl` e teste unitário dos parsers de rede/`nmcli`; regressão das 14 verificações da 0.0.1.9. **Não testado em hardware real** (Wi-Fi, Bluetooth, GPU, PipeWire da sua máquina) — os comandos reais podem ter pequenas variações de saída entre versões.


---

# Rodada 6 — 0.0.2.2: Atividades e Dock dinâmica
Implementado sobre o `interface021.zip` enviado (0.0.2.1). Detalhes e decisões de segurança no `README.md` (seção 0.0.2.2).
**Validação:** `vite build` real; 28 verificações automáticas (endpoint de ícones: PNG/SVG, caminho absoluto, `/etc/passwd`, traversal, `name` absoluto; interface no Chromium: botão, Esc, Super, Super+tecla, busca, ícone real carregado, lançamento via `gio` simulado, Dock sem duplicar, persistência ao recarregar, App Store → Dock, botão direito remove, console sem erros) e 14 verificações de regressão.
**Não testado:** ícones e `.desktop` reais de outras distros/temas (o teste usou temas e apps de exemplo, mais os do sistema de análise), Flatpak/Snap reais e a captura da tecla Super num GNOME de verdade.


---

# Rodada 7 — 0.0.2.3
- `server/browser.js`: verificação de iframe (X-Frame-Options/CSP) com proteção SSRF e abertura no navegador nativo (`xdg-open` → `gio open`).
- `server/windows.js`: estado e controle de janelas nativas (wmctrl/xdotool/xprop), com identificação do app por `StartupWMClass`, id do `.desktop` e executável.
- Interface: painel de site bloqueado, Dock com abrir/focar/minimizar/restaurar, animações de janela, indicadores ●/○.
- Correção durante os testes: o cache da verificação passou a separar o modo "permitir local" (só usado em testes) do modo normal.
**Validação:** `vite build`; 30 testes dos módulos novos (IPs privados, políticas de frame, redirecionamentos, timeout, SSRF, parser do wmctrl); 22 testes de rotas com binários simulados (`xdg-open`, `gio`, `wmctrl`, `xdotool`, `xprop`, incluindo Wayland e ferramentas ausentes); 30 testes no Chromium (Dock, animações, nativos, navegador, Wayland); regressão 28 + 14.
**Não testado:** sites reais da internet (sem rede aqui; os cabeçalhos foram simulados com servidores locais), `xdg-open`/navegador reais, e `wmctrl`/`xdotool` num X11 real — o comportamento de minimizar varia entre gerenciadores de janela.


---

# Rodada 8 — 0.0.2.4: Shell/Launcher
**Mudanças:** `server/system-apps.js` (apps de sistema nativos), App Store e navegador embutidos removidos (componentes, rotas `/api/store*` e `/api/browser/probe`, CSS), Dock e Atividades reescritas, `APP_DIRS` agora inclui Snap e Flatpak, `setup-environment.sh`, `server/browser.js` reduzido à abertura de URLs no navegador do sistema.

**Correções no código de som herdado da 0.0.2.1** (`server/system.js`), achadas ao testar com um `wpctl` simulado:
- Volume relativo era enviado como `+5%`/`-5%`; `wpctl` e `amixer` esperam `5%+`/`5%-` (o comando falhava e caía no fallback).
- A seção **Video** do `wpctl status` era lida como Sources, e a câmera aparecia na lista de microfones; "Sink/Source endpoints" também encerram a lista agora.

**Nota sobre o pedido:** o título pedia 0.0.2.4, mas o item 5 dizia `package.json` → `0.0.2.3`. Usei **0.0.2.4**.

**Validação:** `vite build`; 29 testes das rotas novas (resolução dos 6 apps, ícones, lançamento via `gio` simulado, fallback para executável, não instalado, ids inválidos, rotas removidas, estado/controle de janelas); 34 testes no Chromium (Dock, Atividades, Wayland, nada instalado/reservas embutidas, ausência de iframe); regressão: Configurações embutidas 20, Atividades/Dock extras 27; `setup-environment.sh` com `apt` simulado (`--dry-run`, `--yes --minimal`, opção inválida).
**Não testado:** instalação real de pacotes (o ambiente de análise não tem `apt` com rede), os apps GNOME reais, `wmctrl`/`xdotool` em X11 real, `xdg-settings` com navegador real.
## 0.0.2.6 — Correção de compilação Vite/esbuild

- Corrigido o erro de sintaxe em `src/main.jsx` no `className` do componente `Desktop`.
- Removida a crase duplicada após `no-effects`; a expressão JSX agora termina corretamente em `` `}``.
- Atualizada a versão do projeto para `0.0.2.6` em `package.json`, `package-lock.json` e documentação.
- Validação obrigatória executada com `npx vite build`; a compilação deve terminar sem erros de Vite/esbuild.

