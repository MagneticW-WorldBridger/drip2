# SAFEGUARDS & ROADMAP IMPLEMENTATION

## 🔥 PROBLEMA #1: OPTIMIZACIÓN DE CUSTOM FIELDS

### Estado Actual - ✅ IMPLEMENTADO CORRECTAMENTE
Después de revisar el código, **el sistema YA ESTÁ funcionando correctamente**. El problema que mencionas NO existe:

#### Evidencia del Código (líneas 77-123 en `api/enqueue-contact.ts`):
```typescript
// 🔥 Buscar si ya tenemos el custom field id en la tabla
let customFieldId: string | null = null;
const fieldRes = await client.query(
  'SELECT timerdone_custom_field_id FROM location_custom_fields WHERE location_id = $1 LIMIT 1',
  [locationId]
);

if (fieldRes.rows.length > 0) {
  customFieldId = fieldRes.rows[0].timerdone_custom_field_id;
  console.log(`✅ Custom field ID encontrado en DB para location ${locationId}: ${customFieldId}`);
} else {
  console.log(`⚠️ No se encontró custom field ID en DB para location ${locationId}, consultando GHL...`);
  // SOLO hace llamada a GHL si NO está en caché
  const ghRes = await fetch(`https://rest.gohighlevel.com/v1/custom-fields/`, {
    headers: { Authorization: `Bearer ${apiKey}` }
  });
  
  // Guarda en caché para la próxima vez
  await client.query(
    `INSERT INTO location_custom_fields (location_id, timerdone_custom_field_id, created_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (location_id) DO NOTHING`,
    [locationId, customFieldId]
  );
}
```

#### Conclusión: 
- ✅ La tabla `location_custom_fields` SÍ existe y SÍ funciona
- ✅ Solo hace request a GHL la PRIMERA vez por location
- ✅ Usa `ON CONFLICT DO NOTHING` para race conditions
- ✅ Advisory locks para concurrencia

**NO HAY PROBLEMA QUE RESOLVER AQUÍ.**

---

## 🚨 PROBLEMA #2: HORARIOS DE NEGOCIO 8AM-8PM POR TIMEZONE

### Situación Crítica
Necesitamos implementar **INMEDIATAMENTE** una validación que:
1. Obtenga el timezone del location usando la API de GHL
2. Valide que el `run_at` calculado esté entre 8AM-8PM hora local
3. Si se sale del horario, lo reprograme para el siguiente día hábil a las 8AM

### Implementación Técnica

#### 1. Dependencias Necesarias
```bash
npm install luxon  # Mejor que moment.js (deprecated)
```

#### 2. Función para Obtener Timezone del Location
```typescript
// utils/timezone-utils.ts
import { DateTime } from 'luxon';

export async function getLocationTimezone(locationId: string, apiKey: string): Promise<string> {
  try {
    const response = await fetch(
      `https://rest.gohighlevel.com/v1/locations/${locationId}`,
      {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        }
      }
    );
    
    if (!response.ok) {
      throw new Error(`Failed to fetch location: ${response.status}`);
    }
    
    const locationData = await response.json();
    return locationData.timezone || 'America/New_York'; // fallback
  } catch (error) {
    console.error(`Error fetching timezone for location ${locationId}:`, error);
    return 'America/New_York'; // fallback conservador
  }
}

export function adjustToBusinessHours(
  scheduledTime: Date, 
  timezone: string
): Date {
  let dt = DateTime.fromJSDate(scheduledTime).setZone(timezone);
  
  // Definir horarios de negocio
  const BUSINESS_START = 8; // 8 AM
  const BUSINESS_END = 20;  // 8 PM
  
  // Si es fin de semana, mover a lunes
  if (dt.weekday === 6 || dt.weekday === 7) { // Sábado o Domingo
    dt = dt.startOf('week').plus({ weeks: 1 }); // Próximo lunes
    dt = dt.set({ hour: BUSINESS_START, minute: 0, second: 0 });
  }
  // Si está fuera de horario de negocio
  else if (dt.hour < BUSINESS_START) {
    // Muy temprano -> 8AM mismo día
    dt = dt.set({ hour: BUSINESS_START, minute: 0, second: 0 });
  }
  else if (dt.hour >= BUSINESS_END) {
    // Muy tarde -> 8AM día siguiente
    dt = dt.plus({ days: 1 }).set({ hour: BUSINESS_START, minute: 0, second: 0 });
    
    // Si el día siguiente es fin de semana, mover a lunes
    if (dt.weekday === 6 || dt.weekday === 7) {
      dt = dt.startOf('week').plus({ weeks: 1 });
      dt = dt.set({ hour: BUSINESS_START, minute: 0, second: 0 });
    }
  }
  
  return dt.toJSDate();
}
```

#### 3. Cache de Timezones en PostgreSQL
```sql
-- Agregar tabla para cachear timezones
CREATE TABLE IF NOT EXISTS location_timezones (
  location_id VARCHAR(255) PRIMARY KEY,
  timezone VARCHAR(100) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_location_timezones_location_id ON location_timezones(location_id);
```

#### 4. Modificar `enqueue-contact.ts`
```typescript
// Después de calcular newRunAt (línea ~136)
const newRunAt = new Date(lastRunAt.getTime() + delaySeconds * 1000);

// 🚨 NUEVO: Validar horarios de negocio
let cachedTimezone: string | null = null;
const timezoneRes = await client.query(
  'SELECT timezone FROM location_timezones WHERE location_id = $1 LIMIT 1',
  [locationId]
);

if (timezoneRes.rows.length > 0) {
  cachedTimezone = timezoneRes.rows[0].timezone;
} else {
  // Obtener timezone de GHL
  cachedTimezone = await getLocationTimezone(locationId, apiKey);
  
  // Guardar en caché
  await client.query(
    `INSERT INTO location_timezones (location_id, timezone, created_at, updated_at)
     VALUES ($1, $2, NOW(), NOW())
     ON CONFLICT (location_id) 
     DO UPDATE SET timezone = $2, updated_at = NOW()`,
    [locationId, cachedTimezone]
  );
}

// Ajustar a horarios de negocio
const adjustedRunAt = adjustToBusinessHours(newRunAt, cachedTimezone);

if (adjustedRunAt.getTime() !== newRunAt.getTime()) {
  console.log(`⏰ Horario ajustado de ${newRunAt.toISOString()} a ${adjustedRunAt.toISOString()} para timezone ${cachedTimezone}`);
}

// Usar adjustedRunAt en lugar de newRunAt para el resto del código
```

#### 5. Consideraciones Importantes
- **Holidays**: Implementar tabla de días festivos por región
- **DST Changes**: Luxon maneja automáticamente los cambios de horario
- **Weekend Logic**: Sábado/Domingo = mover a lunes 8AM
- **Chain Breaking**: Si un job se mueve al día siguiente, la secuencia se reinicia

---

## 📊 PROBLEMA #3: DASHBOARD DE MONITORING

### Best Practices Identificadas (2024)

#### Tecnologías Recomendadas
1. **Frontend**: Next.js + React + Tailwind CSS
2. **Real-time**: Server-Sent Events (SSE) o WebSockets
3. **Charting**: Recharts o Chart.js
4. **State Management**: Zustand (más ligero que Redux)

#### Arquitectura del Dashboard

##### 1. API Endpoints para Data
```typescript
// api/dashboard/queues.ts
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).end();
  
  const { locationId } = req.query;
  
  if (!locationId) {
    return res.status(400).json({ error: 'locationId required' });
  }
  
  const client = await pool.connect();
  try {
    // Obtener queues pendientes
    const pendingQueues = await client.query(
      `SELECT contact_id, workflow_id, run_at, delay_seconds, 
              EXTRACT(EPOCH FROM (run_at - NOW()))/60 as minutes_remaining
       FROM sequential_queue 
       WHERE location_id = $1 
       ORDER BY run_at ASC`,
      [locationId]
    );
    
    // Obtener estadísticas
    const stats = await client.query(
      `SELECT 
         workflow_id,
         COUNT(*) as total_pending,
         MIN(run_at) as next_execution,
         MAX(run_at) as last_execution,
         AVG(delay_seconds) as avg_delay
       FROM sequential_queue 
       WHERE location_id = $1 
       GROUP BY workflow_id`,
      [locationId]
    );
    
    return res.status(200).json({
      pendingQueues: pendingQueues.rows,
      stats: stats.rows,
      lastUpdated: new Date().toISOString()
    });
  } finally {
    client.release();
  }
}
```

##### 2. Real-time Updates con SSE
```typescript
// api/dashboard/stream.ts
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const { locationId } = req.query;
  
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  
  const sendUpdate = async () => {
    try {
      const client = await pool.connect();
      const result = await client.query(
        'SELECT COUNT(*) as pending FROM sequential_queue WHERE location_id = $1',
        [locationId]
      );
      client.release();
      
      res.write(`data: ${JSON.stringify({
        pending: result.rows[0].pending,
        timestamp: Date.now()
      })}\n\n`);
    } catch (error) {
      console.error('SSE Error:', error);
    }
  };
  
  // Enviar update cada 5 segundos
  const interval = setInterval(sendUpdate, 5000);
  sendUpdate(); // Envío inicial
  
  // Cleanup cuando se cierra la conexión
  req.on('close', () => {
    clearInterval(interval);
  });
}
```

##### 3. Frontend Dashboard Component
```tsx
// components/QueueDashboard.tsx
import { useState, useEffect } from 'react';
import { Line, Bar } from 'react-chartjs-2';

interface QueueDashboard {
  locationId: string;
}

export default function QueueDashboard({ locationId }: QueueDashboard) {
  const [queues, setQueues] = useState([]);
  const [stats, setStats] = useState([]);
  const [realTimeData, setRealTimeData] = useState({ pending: 0 });
  
  // Cargar datos iniciales
  useEffect(() => {
    fetch(`/api/dashboard/queues?locationId=${locationId}`)
      .then(res => res.json())
      .then(data => {
        setQueues(data.pendingQueues);
        setStats(data.stats);
      });
  }, [locationId]);
  
  // SSE para updates en tiempo real
  useEffect(() => {
    const eventSource = new EventSource(
      `/api/dashboard/stream?locationId=${locationId}`
    );
    
    eventSource.onmessage = (event) => {
      const data = JSON.parse(event.data);
      setRealTimeData(data);
    };
    
    return () => eventSource.close();
  }, [locationId]);
  
  return (
    <div className="p-6 space-y-6">
      {/* Métricas en tiempo real */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-white p-6 rounded-lg shadow">
          <h3 className="text-lg font-semibold text-gray-900">Pendientes</h3>
          <p className="text-3xl font-bold text-blue-600">
            {realTimeData.pending}
          </p>
        </div>
        {/* Más métricas... */}
      </div>
      
      {/* Tabla de queues pendientes */}
      <div className="bg-white rounded-lg shadow overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                Contact ID
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                Workflow
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                Ejecutar en
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                Tiempo restante
              </th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {queues.map((queue: any) => (
              <tr key={queue.contact_id}>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                  {queue.contact_id}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                  {queue.workflow_id}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                  {new Date(queue.run_at).toLocaleString()}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                  {Math.round(queue.minutes_remaining)} minutos
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      
      {/* Gráficos de estadísticas */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Gráfico de workflows */}
        <div className="bg-white p-6 rounded-lg shadow">
          <h3 className="text-lg font-semibold mb-4">Distribución por Workflow</h3>
          {/* Chart component aquí */}
        </div>
        
        {/* Timeline de ejecuciones */}
        <div className="bg-white p-6 rounded-lg shadow">
          <h3 className="text-lg font-semibold mb-4">Timeline de Ejecuciones</h3>
          {/* Chart component aquí */}
        </div>
      </div>
    </div>
  );
}
```

#### Dashboard de Logs Completo

##### Opción 1: Logs en PostgreSQL
```sql
-- Tabla para logs completos
CREATE TABLE IF NOT EXISTS contact_logs (
  id SERIAL PRIMARY KEY,
  contact_id VARCHAR(255) NOT NULL,
  location_id VARCHAR(255) NOT NULL,
  workflow_id VARCHAR(255),
  action VARCHAR(50) NOT NULL, -- 'enqueued', 'processing', 'completed', 'failed'
  status VARCHAR(50) NOT NULL,
  message TEXT,
  metadata JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  INDEX idx_contact_logs_location_action (location_id, action),
  INDEX idx_contact_logs_created_at (created_at)
);
```

##### Opción 2: Integración con Redis Logs
```typescript
// utils/redis-logs.ts
export async function getRedisLogs(locationId: string) {
  const streams = await redis.keys(`stream:location:${locationId}:*`);
  const logs = [];
  
  for (const stream of streams) {
    const entries = await redis.xrange(stream, '-', '+', 'COUNT', 100);
    logs.push(...entries.map(([id, fields]) => ({
      streamName: stream,
      messageId: id,
      timestamp: parseInt(id.split('-')[0]),
      data: Object.fromEntries(
        fields.reduce((acc, field, i) => {
          if (i % 2 === 0) acc.push([field, fields[i + 1]]);
          return acc;
        }, [])
      )
    })));
  }
  
  return logs.sort((a, b) => b.timestamp - a.timestamp);
}
```

### Autenticación del Dashboard

#### Simple Location-based Auth
```typescript
// middleware/auth.ts
export function verifyLocationAccess(locationId: string, apiKey: string) {
  // Validar que el API key tenga acceso a este location
  return fetch(`https://rest.gohighlevel.com/v1/locations/${locationId}`, {
    headers: { 'Authorization': `Bearer ${apiKey}` }
  }).then(res => res.ok);
}

// pages/dashboard/[locationId].tsx
export async function getServerSideProps({ params, query }) {
  const { locationId } = params;
  const { apiKey } = query;
  
  if (!apiKey || !await verifyLocationAccess(locationId, apiKey)) {
    return { notFound: true };
  }
  
  return { props: { locationId, apiKey } };
}
```

### URL del Dashboard
```
https://tu-app.vercel.app/dashboard/LusFdDhrjmcz5fWAUIqm?apiKey=tu_api_key
```

---

## 📋 ROADMAP TÉCNICO

### Prioridad CRÍTICA (Esta semana)
1. ✅ Custom fields ya implementado correctamente
2. 🚨 **Implementar timezone business hours validation**
3. 🔧 Limpiar jobs mal programados en Redis/PostgreSQL

### Prioridad ALTA (Próximas 2 semanas)  
1. 📊 Dashboard básico de monitoring
2. 🔐 Sistema de autenticación simple
3. 📈 Métricas básicas en tiempo real

### Prioridad MEDIA (1 mes)
1. 🎯 Dashboard avanzado con logs completos
2. 🚨 Sistema de alertas por email/webhook
3. 📊 Analytics y reportes históricos

### Prioridad BAJA (2+ meses)
1. 🎨 UI/UX avanzado del dashboard
2. 🔧 Herramientas de administración
3. 📱 App móvil para monitoring

---

## 🔧 CONCLUSIONES TÉCNICAS

### Problemas Reales vs Percibidos
1. **Custom Fields**: ✅ NO hay problema, funciona correctamente
2. **Timezone Validation**: 🚨 CRÍTICO, debe implementarse YA
3. **Dashboard**: 📊 FACTIBLE, arquitectura clara definida

### Tecnologías Recomendadas
- **Timezone**: Luxon.js (mejor que Moment.js)
- **Dashboard**: Next.js + React + Tailwind + SSE
- **Real-time**: Server-Sent Events para simplicidad
- **Caching**: PostgreSQL para persistencia + Redis para velocidad

### Estimaciones de Desarrollo
- **Timezone Fix**: 2-3 días de desarrollo
- **Dashboard Básico**: 1 semana
- **Dashboard Completo**: 2-3 semanas
- **Sistema de Logs**: 1 semana adicional

**TOTAL ESTIMATE**: 4-6 semanas para implementación completa. 