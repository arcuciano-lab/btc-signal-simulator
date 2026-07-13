# BTC Signal Barometer

Dashboard minimalista de análisis técnico para BTC/USDT en 5m, 15m, 1h y 4h. Combina RSI, MACD, volumen, Bandas de Bollinger, EMA 50 y EMA 200 en una puntuación Long/Short y ejecuta trades simulados cuando existe una señal extrema con consenso multitemporal.

## Abrir la app

Necesitas Node.js 20 o posterior.

```bash
npm start
```

Abre `http://localhost:4173`. No requiere claves: consulta únicamente velas públicas de Binance.

## Validar

```bash
npm test
```

El simulador comienza con 1.000 USDT, guarda el diario de trades en el navegador y ajusta gradualmente los pesos después de cada resultado. Es educativo, no representa una cuenta real ni garantiza resultados futuros.

## Versión 2.3

- Velas japonesas con brillo neón, EMA 50/200 y Bandas de Bollinger.
- Paneles activables de volumen, RSI y MACD.
- Vista de trading ampliada con 48, 72 o 120 velas, eje de precios y referencias horarias.
- Contornos reforzados y banner de noticias ampliado para mejorar la lectura.
- Nueva identidad SimpleTrading con logotipo BTC rojo/verde integrado en el hero.
- Posición simulada dibujada con entrada, objetivo, stop y zonas de riesgo/beneficio.
- Banner de contexto con BTC, WTI, macroeconomía, geopolítica y publicaciones políticas relevantes.
- Fuentes externas aisladas: si una falla, la señal técnica y el resto del panel continúan funcionando.

## Publicar gratis en Render

1. Crea un repositorio en GitHub y sube estos archivos a la raíz.
2. En Render selecciona **New → Blueprint** y conecta el repositorio.
3. Render leerá `render.yaml`. Revisa el plan **Free** y pulsa **Deploy Blueprint**.
4. Al terminar recibirás una dirección pública `https://...onrender.com`.

La instancia gratuita puede dormirse después de un periodo sin visitas. El diario y el aprendizaje se almacenan en `localStorage`, por lo que pertenecen a cada navegador y no se comparten entre dispositivos o visitantes.
