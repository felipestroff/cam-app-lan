# Cam App (LAN MVP)

Projeto inicial para visualizar cameras em LAN (sem login) com WebRTC direto entre celular e viewer, sem app de terceiros.

## Arquitetura basica
- Celular abre `publish.html` e vira a camera
- Viewer abre `index.html` e recebe o stream via WebRTC
- Um servidor simples (`serve-web.ps1`) faz o signaling entre os dois

## Requisitos
- Windows 10/11
- PowerShell
- Chrome/Edge no celular e no PC

## Passos rapidos
1) Suba o servidor (static + signaling)
```powershell
.\scripts\serve-web.ps1 -Root .\web -Port 5173 -HostName +
```
Abra no navegador: `http://SEU_IP_LOCAL:5173` (ex.: `http://192.168.1.6:5173`)

2) No celular, abra o publisher
- URL: `http://SEU_IP_LOCAL:5173/publish.html` (ex.: `http://192.168.1.6:5173/publish.html`)
- Signal Base URL: `http://SEU_IP_LOCAL:5173` (ex.: `http://192.168.1.6:5173`)
- Path: `cam1`
- Clique em **Iniciar**

3) No PC (viewer)
- Abra `http://SEU_IP_LOCAL:5173` (ex.: `http://192.168.1.6:5173`)
- Signal Base URL: `http://SEU_IP_LOCAL:5173` (ex.: `http://192.168.1.6:5173`)
- Clique em **Conectar**
- Opcional: clique em **Gravar** para salvar um `.webm` no PC

4) Cadastre cameras
- Edite `web/cameras.json` com seus nomes e paths (ex.: `cam1`)

## Notas importantes
- Camera no navegador exige HTTPS. Para dev local no Chrome Android:
  - Acesse `chrome://flags/#unsafely-treat-insecure-origin-as-secure`
  - Adicione `http://SEU_IP_LOCAL:5173` (ex.: `http://192.168.1.6:5173`) e reinicie o navegador
- WebRTC direto funciona melhor em LAN. Um path = uma camera ativa.
- Se o viewer nao conectar, permita o navegador no firewall do Windows.
- Gravacao em MP4 depende do navegador. Se falhar, use WebM.

## Proximos passos (quando for evoluir)
- Backend com cadastro e login
- Descoberta automatica de cameras na LAN
- App Android proprio com CameraX e WebRTC direto
