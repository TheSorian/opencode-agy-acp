# opencode-agy-acp

Plugin oficial para **OpenCode v2** que conecta con el servidor **Agent Client Protocol (`agy acp --stdio`)** de Google Antigravity, permitiéndote elegir los modelos de `agy` y su nivel de esfuerzo (`low`, `medium`, `high`, `xhigh`) directamente desde OpenCode sin ningún proxy externo ni llamadas a endpoints no documentados.

## Características

- **100% oficial:** lanza y habla exclusivamente con `agy acp --stdio` por JSON-RPC 2.0.
- **Sin demonio externo:** corre dentro del propio proceso de OpenCode (`127.0.0.1:18799`) y se detiene automáticamente al cerrar OpenCode.
- **Selector de esfuerzo nativo:** agrupa los 27 modelos en **11 modelos base** usando `variants` de OpenCode (`low`, `medium`, `high`, `xhigh`).
- **Streaming + razonamiento:** soporta `agent_message_chunk` y `agent_thought_chunk`.
- **Sesiones persistentes:** reutiliza la sesión de ACP entre turnos de la misma conversación y soporta cambio de modelo/esfuerzo sobre la marcha.

## Requisitos

1. [Antigravity CLI (`agy`)](https://antigravity.google) instalada, autenticada y en el `PATH` (prueba con `agy models`).
2. **OpenCode v2** (`opencode --version`).

## Instalación rápida

### 1. Instalar el plugin

**Opción A — Directo desde GitHub (recomendado):**
```bash
opencode plugin add github:TheSorian/opencode-agy-acp
```

**Opción B — Copia manual (Linux / macOS):**
```bash
mkdir -p ~/.config/opencode/plugins
curl -fsSL https://raw.githubusercontent.com/TheSorian/opencode-agy-acp/main/index.ts \
  -o ~/.config/opencode/plugins/agy-acp.ts
```

**Opción B — Copia manual (Windows PowerShell):**
```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.config\opencode\plugins" | Out-Null
Invoke-WebRequest "https://raw.githubusercontent.com/TheSorian/opencode-agy-acp/main/index.ts" `
  -OutFile "$env:USERPROFILE\.config\opencode\plugins\agy-acp.ts"
Invoke-WebRequest "https://raw.githubusercontent.com/TheSorian/opencode-agy-acp/main/agy-acp-worker.mjs" `
  -OutFile "$env:USERPROFILE\.config\opencode\agy-acp-worker.mjs"
```

> **Nota para Windows (`agy-acp-worker.mjs`):**  
> En Windows, cuando `opencode.exe` (Bun) lanza `agy acp --stdio` directamente como subproceso hijo, `agy.exe` se queda bloqueado en la llamada `authenticate` (`Sign-in timed out`).  
> Para evitarlo, el plugin se conecta por TCP (`127.0.0.1:18796`) a [`agy-acp-worker.mjs`](./agy-acp-worker.mjs), un pequeño worker Node que ejecuta `agy acp --stdio` fuera del árbol de procesos de `opencode.exe`.  
> Puedes dejarlo arrancando automáticamente al iniciar sesión en Windows con:
> ```powershell
> $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -WindowStyle Hidden -Command `"Start-Process -WindowStyle Hidden node '$env:USERPROFILE\.config\opencode\agy-acp-worker.mjs'`""
> $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
> $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
> Register-ScheduledTask -TaskName "agy-acp-worker" -Action $action -Trigger $trigger -Settings $settings -Force
> Start-ScheduledTask -TaskName "agy-acp-worker"
> ```

### 2. Añadir el proveedor en `opencode.jsonc`

Copia el bloque `agy` de [`opencode.provider.jsonc`](./opencode.provider.jsonc) dentro de `"providers"` en tu `~/.config/opencode/opencode.jsonc`.

### 3. Reiniciar OpenCode y probar

```bash
opencode service restart
opencode run --model "agy/gemini-3.8-flash#low" "Di solo: OK"
```

También puedes comprobar el estado del puente interno con:
```bash
curl http://127.0.0.1:18799/health
```

## Variables de entorno opcionales

| Variable | Valor por defecto | Descripción |
| --- | --- | --- |
| `AGY_ACP_PORT` | `18799` | Puerto local en `127.0.0.1` para el puente interno del plugin |
| `AGY_ACP_WORKER_PORT` | `18796` | Puerto TCP local en `127.0.0.1` para `agy-acp-worker.mjs` |
| `AGY_BIN` | `agy` | Ruta o nombre del binario de Antigravity CLI |
| `AGY_ACP_AUTO_APPROVE` | `false` | Si es `true`, aprueba automáticamente las solicitudes de permiso de `agy acp` (por defecto se rechazan por seguridad) |

## Notas técnicas

- **Handshake ACP:** tras `initialize`, el plugin invoca `authenticate` automáticamente usando el primer método devuelto en `authMethods` (por ejemplo `oauth-personal`), evitando el error `-32000: Authentication required`.
- **Mensajes `system`:** al iniciar una sesión nueva se incluyen los mensajes con rol `system` antes del historial para respetar instrucciones del sistema y plantillas de OpenCode.
- **Compactación (`compaction`):** si usas OpenChamber/OpenCode con sesiones largas, puedes asignar un modelo ligero en `opencode.jsonc` bajo `"agent": { "compaction": { "model": "..." } }` para evitar que la compactación use el agente completo.

## Licencia

MIT
