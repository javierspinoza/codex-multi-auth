# Comandos frecuentes de codex-multi-auth

## Para comenzar

```bash
codex-multi-auth login                   # Iniciar sesión o abrir el panel de cuentas
codex-multi-auth login --account 1       # Renovar el acceso de la misma cuenta 1
codex-multi-auth login --replace-account 9 # Reemplazar el usuario de la cuenta 9 conservando su número
codex-multi-auth login --api             # Configurar claves API y sus modelos (opcional)
codex-multi-auth list                    # Consultar cuotas en vivo, correos y estado de rotación
codex-multi-auth list --hola             # Enviar hola a cada cuenta, en orden, con GPT-6 Luna
codex-multi-auth limits --json            # Consultar cuotas estructuradas en vivo
codex-multi-auth resets list              # Consultar créditos de reinicio en vivo
codex-multi-auth status                  # Consultar el diagnóstico detallado
codex-multi-auth switch 1                # Usar y fijar la cuenta 1
codex-multi-auth unpin                   # Volver a la selección automática
codex-multi-auth best --live             # Elegir y activar la cuenta recomendada
codex-multi-auth forecast --live         # Recomendar una cuenta sin cambiarla
codex-multi-auth check accounts          # Comprobar autenticación y cuota
codex-multi-auth check capabilities      # Actualizar modelos y capacidades disponibles
codex-multi-auth rotation status         # Consultar rotación (activa por defecto)
mcodex                                  # Iniciar Codex con el gestor
mcodex resume                           # Retomar una conversación anterior
mcodex --monitor                        # Refrescar la lista de cuentas; requiere watch
codex-multi-auth --help                  # Ver la ayuda
```

Cambia `1` por el número mostrado en `list`. Para añadir otra cuenta, abre `login` y elige **Add New Account**. `switch` fija una cuenta; `unpin` permite rotar de nuevo y `best` elimina la fijación al activar la recomendada.

La tabla se ordena por cuota restante de 5 horas, de mayor a menor; en empate, por cuota semanal. Conserva los números originales de las cuentas. Toda la fila aparece verde si queda desde 50% de cuota semanal, amarilla desde 30% hasta menos de 50% y roja por debajo de 30% mientras quede cuota; con 0% o `N/D` semanal conserva su color habitual. El pie muestra la rotación y, en modo secuencial activo, la cuenta compartida que dirige el tráfico. La selección guardada se puede consultar en `status` o `list --verbose`; una fijación suspende el cambio automático.

`ÚLTIMA SOLICITUD` muestra cuándo el proxy envió por última vez una solicitud de chat o imagen con cada cuenta, en hora local (`DD/MM HH:mm:ss`). El pie identifica la cuenta del envío más reciente. La selección guardada no garantiza qué cuenta usa un chat: con la estrategia `hybrid` los chats pueden usar cuentas distintas; con `sequential` siguen la cuenta activa hasta que la rotación deba cambiarla. Este registro reúne actividad de varios procesos del proxy, excluye consultas de cuota y modelos, y puede tardar alrededor de un segundo en actualizarse. `—` significa que no hay registro. No identifica cada conversación ni confirma que siga respondiendo; las solicitudes que no pasan por el proxy no aparecen. En `list --json`, cada cuenta conserva el campo `lastInferenceRequestAt` (milisegundos desde Unix epoch o `null`).

`list` consulta las cuotas en cada ejecución. Si una cuenta no se pudo consultar, muestra `N/D` en lugar de una cuota guardada. `N/D` tampoco equivale a 0% ni a cuota ilimitada. Cuando solo se informa la cuota semanal, la rotación evalúa esa ventana. Si se informa un límite de 5 horas y está agotado, la cuenta puede quedar bloqueada aunque conserve cuota semanal; la ausencia de esa ventana no equivale a agotamiento. La hora de reinicio indica cuándo recupera cuota.

Para concentrar el consumo en una sola cuenta, usa `schedulingStrategy: "sequential"`. Los proyectos que comparten el mismo pool usan una selección común, incluso con varios procesos del proxy. La prioridad es el día de renovación semanal más próximo, en hora local; el reinicio de 5 horas determina disponibilidad, no ese orden. Dentro del mismo día se mantiene la cuenta actual mientras siga disponible; al cambiar, se elige la hora de renovación semanal más temprana de ese día. Si ninguna cuenta de ese día tiene cuota, pasa al siguiente día disponible. En cada solicitud revisa los últimos datos y los reinicios: si se recupera una cuenta de un día anterior, vuelve a ese grupo. Si no hay fechas semanales informadas, conserva el recorrido por números del pool. `list` muestra `Estrategia: secuencial · cuenta compartida` y la regla de prioridad.

Los bloqueos temporales se comparten para que otra terminal respete un fallo reciente. Se reconsideran al terminar la espera o cuando un dato de cuota más reciente confirma recuperación; un dato de cuota no elimina bloqueos por fallos de red o del servidor. La selección usa los registros de cuota disponibles, actualizados por `list` y las respuestas del proxy; no consulta todas las cuentas por red en cada mensaje.

Los umbrales se guardan en `pluginConfig` mediante `preemptiveQuotaRemainingPercent5h` y `preemptiveQuotaRemainingPercent7d`; por ejemplo, ambos en `2` para reservar el 2%. Se evalúan las ventanas informadas más recientemente: si hay solo cuota semanal, se usa solo esa cuota, sin conservar un antiguo límite de 5 horas. Si están presentes ambas, cualquiera de ellas puede provocar el cambio. Reabre las sesiones de Codex para cargar cambios en la estrategia o los umbrales.

`list --hola` envía exactamente **hola** a cada cuenta OAuth guardada con **GPT-6 Luna** (`gpt-6-luna`), en orden de número. Incluye las cuentas deshabilitadas para rotación y usa el workspace seleccionado de cada una. Muestra las respuestas en la terminal y continúa si una cuenta falla. Renueva las credenciales caducadas, conserva la cuenta activa y las fijaciones, y consume cuota real. Cada saludo inicia una conversación independiente; no se guarda en el historial de la app. Puedes usar `list --hola --json` para obtener los resultados y el resumen en JSON.

## Sesión caducada y cambio de correo

Si caducó el acceso, el gestor intenta renovarlo automáticamente. Para comprobarlo o volver a autenticarte si la renovación falla:

```bash
codex-multi-auth check accounts          # Comprobar cuentas y renovar accesos caducados
codex-multi-auth login --account 1       # Si requiere login: entrar con la misma cuenta guardada
```

`login --account 1` exige la identidad guardada: si entras con otra cuenta de OpenAI, rechaza el cambio y conserva las credenciales anteriores. Volver a iniciar sesión no recupera una cuota agotada.

Si dejaste de usar una cuenta y quieres añadir otra con distinto correo:

```bash
codex-multi-auth account pause 1         # Apartar la cuenta anterior de la rotación
codex-multi-auth login                   # Elegir Add New Account y entrar con el nuevo correo
codex-multi-auth list                    # Consultar el número asignado a la nueva cuenta
codex-multi-auth unpin                   # Quitar una fijación anterior y permitir la rotación
```

Si decides recuperar la cuenta anterior, usa `codex-multi-auth account unpause 1`.

Para reemplazar una cuenta con otro correo conservando exactamente su número:

```bash
codex-multi-auth login --replace-account 9
```

Inicia sesión con el nuevo usuario de ChatGPT. La cuenta se reemplaza después de completar el login; cancelar o fallar conserva la anterior. Las demás cuentas mantienen sus números. Se conserva la posición seleccionada y su fijación, y una cuenta deshabilitada sigue deshabilitada. La nueva identidad recibe sus propias credenciales, espacios de trabajo y datos de cuota; las políticas y el historial del usuario anterior no se transfieren. Si el nuevo usuario ya existe en otra posición, el cambio se rechaza. Puedes añadir `--device-auth` para iniciar sesión desde otra máquina.

Eliminar una cuenta desde el panel sí puede cambiar los números: `login` → **Saved Accounts** → cuenta → `D` → confirmar; después consulta `list`. Si el navegador entra automáticamente con el correo anterior, cambia de cuenta en la pantalla de inicio de sesión.

## Revisar problemas y consumo

```bash
codex-multi-auth doctor                  # Diagnosticar almacenamiento y cuentas
codex-multi-auth fix --live --dry-run     # Previsualizar reparaciones con comprobación en vivo
codex-multi-auth fix --live               # Aplicar reparaciones
codex-multi-auth verify-flagged           # Comprobar cuentas problemáticas y restaurar las sanas
codex-multi-auth why-selected            # Explicar qué cuenta elegiría la rotación
codex-multi-auth usage --since 7d         # Consultar el consumo registrado de los últimos 7 días
```

## Qué hace cada opción del panel

| Opción | Para qué sirve |
| --- | --- |
| **Add New Account** | Iniciar sesión para añadir otra cuenta. |
| **Run Health Check** | Comprobar sesiones y cuotas, renovar credenciales si hace falta y actualizar modelos y créditos de reinicio. |
| **Pick Best Account** | Comparar cuentas y mostrar la recomendación. En v2.19.1 ejecuta `forecast --live`; para activarla usa `best --live`. |
| **Auto-Repair Issues** | Ejecutar `fix --live`: renovar credenciales y corregir problemas; puede deshabilitar cuentas con fallos graves. |
| **API credentials and models** | Añadir o gestionar claves API, prioridad y modelos visibles. Es opcional para cuentas con login de ChatGPT. |
| **Settings** | Ajustar apariencia, tema, visualización de cuotas y comportamiento del gestor. `Q` cancela sin guardar. |
| **Refresh All Accounts** | Forzar la renovación de credenciales de todas las cuentas y volver a comprobarlas. No reinicia las cuotas. |
| **Check Problem Accounts** | Revisar las cuentas apartadas por errores y devolver las saludables al pool. Equivale a `verify-flagged`. |
| **Saved Accounts** | Abrir el detalle de una cuenta para seleccionarla, reautenticarla, habilitarla/deshabilitarla o eliminarla. |
| **Delete All Accounts** | Borrar cuentas y credenciales API del gestor después de confirmar. |

`Fetching account limits... [1/2]` muestra el progreso de la consulta de cuotas. `[current]` señala la cuenta seleccionada; `[active]`, la cuenta actual sin bloqueos conocidos; `[ok]`, otra cuenta habilitada sin bloqueos conocidos. Estos estados no sustituyen una comprobación en vivo.

**Teclado:** flechas para moverte, `Enter` para abrir, `/` para buscar, `1–9` para cambiar de cuenta y `Q` para volver. En el detalle: `S` selecciona, `R` reautentica, `E` habilita/deshabilita y `D` elimina.

[Referencia completa de comandos](docs/reference/commands.md).
