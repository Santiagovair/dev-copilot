# Dev Copilot

Mod para Claude: panel de uso de tokens con filtros y recomendaciones, router de agentes por calidad-precio, guardia contra comandos peligrosos y verificación automática de TypeScript.

## Instalación

En una terminal con Claude Code:

```
/plugin install dev-copilot --marketplace Santiagovair/dev-copilot
```

Desde un shell: `claude plugin install dev-copilot --marketplace Santiagovair/dev-copilot`

## Uso

- `/copiloto`: abre el panel (tokens por Hoy / 7 días / 30 días / Todo, costo estimado, recomendaciones).
- `/copiloto check`: corre `tsc --noEmit` a mano.
- `/copiloto router on|off`: activa o apaga el router de agentes.

Los precios del panel son de lista aproximados: el costo es una estimación.
