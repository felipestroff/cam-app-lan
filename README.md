# Cam App (LAN MVP)

Projeto inicial para visualizar cameras em LAN (sem login) com WebRTC direto entre o dispositivo e viewer, sem app de terceiros.

## Arquitetura basica
- Dispositivo abre `publish.html` e vira a camera
- Viewer abre `index.html` e recebe o stream via WebRTC
- Um servidor simples (`serve-web.ps1`) faz o signaling entre os dois

## Requisitos
- Windows 10/11
- PowerShell
- Node.js (para discovery ONVIF e gerar config do MediaMTX)
- MediaMTX (para cameras IP)
- Chrome/Edge no dispositivo e no viewer

## Passos rapidos
1) Suba o servidor (static + signaling)
  - PowerShell (Administrador):
  ```powershell
  .\scripts\serve-web.ps1 -Root .\web -Port 5173 -HostName +
  ```
  - Opcional: defina a pasta de gravacoes recebidas do viewer:
  ```powershell
  .\scripts\serve-web.ps1 -Root .\web -Port 5173 -HostName + -RecordingsDir .\recordings
  ```
Abra no navegador: `http://SEU_IP_LOCAL:5173` (ex.: `http://192.168.1.6:5173`)

2) No dispositivo, abra o publisher
- URL: `http://SEU_IP_LOCAL:5173/publish.html` (ex.: `http://192.168.1.6:5173/publish.html`)
- Signal Base URL: `http://SEU_IP_LOCAL:5173` (ex.: `http://192.168.1.6:5173`)
- Nome da camera: opcional
- Path: `cam1` (se deixar vazio, usa um identificador unico)
- Clique em **Iniciar**

3) No viewer
- Abra `http://SEU_IP_LOCAL:5173` (ex.: `http://192.168.1.6:5173`)
- Signal Base URL e Media Base URL sao configuradas na pagina admin e ficam somente leitura aqui.
- Clique em **Conectar**
- Opcional: marque **Salvar gravacoes no servidor** para enviar os arquivos para o PC (`recordings/`).
- Opcional: clique em **Gravar** e escolha o formato para salvar no PC
- Opcional: ative **Deteccao de movimento** na camera conectada para gravar automaticamente.
- Use o botao **Audio** para ouvir uma camera por vez.

4) Cameras na lista
- As cameras aparecem automaticamente quando o publisher inicia.
- No viewer, clique no nome da camera para editar o **Apelido** localmente.

## Admin (configuracoes do servidor)
- Abra `http://SEU_IP_LOCAL:5173/admin.html` no servidor.
- Configure Signal Base URL e Media Base URL (o viewer usa esses valores e os campos ficam somente leitura).
- Configure a pasta de gravacoes (caminho absoluto ou relativo ao projeto).
- Ajuste: forcar HTTPS, logs detalhados, formato/ nome padrao de gravacao e parametros da gravacao automatica.
- Consulte o status do MediaMTX e abra os logs pela pagina admin.
- As configuracoes ficam salvas em `server-config.json` no servidor (nao usa localStorage).

## Deteccao de movimento e gravacao
- A deteccao roda no viewer (browser) analisando o video recebido.
- Ajuste **Sensibilidade** e **Parar apos** em cada camera conectada.
- Quando detecta movimento, inicia gravacao automatica e para apos alguns segundos sem movimento.
- Com **Salvar gravacoes no servidor**, os arquivos sao enviados para `recordings/` no servidor (configuravel com `-RecordingsDir`).
- Sem essa opcao, o browser baixa o arquivo localmente.

5) Descobrir cameras IP
- Ative ONVIF/RTSP na camera (no painel do fabricante) e defina usuario/senha.
- Garanta o `mediamtx.exe` dentro de `mediamtx/` (veja a secao abaixo).
- Rode o discovery (Node.js) para gerar `web/ip-cameras.json`:
  ```powershell
  node .\scripts\onvif-discover.js --watch
  ```
- Configure as URLs RTSP (copie o `id` do `ip-cameras.json`):
  ```powershell
  Copy-Item .\scripts\ip-cameras-rtsp.sample.json .\scripts\ip-cameras-rtsp.json
  ```
- Para descobrir o RTSP via ONVIF usando a conta da camera:
  ```powershell
  node .\scripts\onvif-rtsp.js --id SEU_ID --user SEU_USUARIO --pass SUA_SENHA
  ```
- Ou para todas as cameras descobertas:
  ```powershell
  node .\scripts\onvif-rtsp.js --all --user SEU_USUARIO --pass SUA_SENHA
  ```
- Edite `scripts/ip-cameras-rtsp.json` se quiser ajustar manualmente o `rtspUrl`.
- Sempre reinicie o MediaMTX depois de mudar o `ip-cameras-rtsp.json`:
  ```powershell
  .\scripts\mediamtx.ps1 restart
  ```
- Exemplos comuns:
  - Intelbras: `rtsp://usuario:senha@IP:554/cam/realmonitor?channel=1&subtype=0`
  - Tapo: `rtsp://usuario:senha@IP:554/stream1`
- Inicie o MediaMTX automaticamente (gera config e sobe o serviço):
  ```powershell
  .\scripts\mediamtx.ps1 start
  ```
- Para parar:
  ```powershell
  .\scripts\mediamtx.ps1 stop
  ```
- No viewer, clique em **Assistir** para abrir a camera IP via WHEP.

## HTTPS local (sem flags no Android)
- Gere e instale um certificado self-signed (Administrador):
  ```powershell
  .\scripts\https-setup.ps1 -Port 5173 -IpAddress SEU_IP_LOCAL
  ```
- Suba o servidor com HTTPS:
  ```powershell
  .\scripts\serve-web.ps1 -Root .\web -Port 5173 -HostName + -Scheme https
  ```
- Acesse com `https://SEU_IP_LOCAL:5173` e ajuste o Signal Base URL para `https://SEU_IP_LOCAL:5173`.
- O navegador pode exibir um aviso de site nao seguro na primeira vez.
- Se o Chrome mostrar o aviso, toque em **Avancado** e **Prosseguir**.
- Se usar IP cameras via MediaMTX, o viewer em HTTPS pode bloquear `http://SEU_IP:8889` (mixed content).
  - Opcao simples: use o viewer em HTTP para IP cameras.
  - Opcao completa: configure o MediaMTX para HTTPS e use `https://SEU_IP:8889`.

## MediaMTX (instalacao no Windows)
- Baixe a versao Windows (zip) em `https://github.com/bluenviron/mediamtx/releases`.
- Extraia o arquivo e copie o `mediamtx.exe` para `mediamtx/` (ex.: `C:\dev\cam-app\mediamtx\mediamtx.exe`).
- O script `.\scripts\mediamtx.ps1 start` gera automaticamente o `mediamtx/mediamtx.yml`.
- Para atualizar a configuracao depois de editar RTSP, rode `.\scripts\mediamtx.ps1 restart`.
- A pagina `http://SEU_IP_LOCAL:8889` pode retornar 404 e isso e esperado (o viewer usa WHEP via `/whep/...`).

## Notas importantes
- Camera no navegador exige HTTPS. Para dev local no Chrome Android:
  - Acesse `chrome://flags/#unsafely-treat-insecure-origin-as-secure`
  - Adicione `http://SEU_IP_LOCAL:5173` (ex.: `http://192.168.1.6:5173`) e reinicie o navegador
- WebRTC direto funciona melhor em LAN. Um path = uma camera ativa.
- No servidor, libere a porta TCP 5173 no Firewall do Windows (entrada) ou crie regra para o PowerShell/`serve-web.ps1`.
  - PowerShell (Administrador):
    ```powershell
    New-NetFirewallRule -DisplayName "Cam App LAN 5173" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 5173
    ```
- Gravacao no servidor usa `POST /recordings` e grava em `recordings/` (configuravel com `-RecordingsDir`).
- Se a descoberta ONVIF nao achar cameras, libere UDP 3702 no firewall (entrada/saida).
- Para assistir cameras IP via MediaMTX, libere TCP 8889.
- Gravacao em MP4 depende do navegador. Se falhar, use WebM.
- Logs do MediaMTX ficam em `logs/mediamtx.log` e `logs/mediamtx.err.log`.

## Proximos passos (quando for evoluir)
- Backend com cadastro e login
- App Android proprio com CameraX e WebRTC direto
