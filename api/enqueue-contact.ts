import type { VercelRequest, VercelResponse } from '@vercel/node';
import dotenv from 'dotenv';
import { Pool } from 'pg';
import { DateTime } from 'luxon';
dotenv.config();

// Conexión a PostgreSQL usando DATABASE_URL en .env TEST(NOT TEST BUT JUST FORCING A GIT CHANGE SO I CAN PUSH
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// 🌍 FUNCIÓN PARA OBTENER TIMEZONE (CON CACHE EN DB)
async function getLocationTimezone(locationId: string, apiKey: string, client: any): Promise<string> {
  // 🔥 STEP 1: Buscar en cache DB primero
  const cachedResult = await client.query(
    'SELECT timezone FROM location_custom_fields WHERE location_id = $1 LIMIT 1',
    [locationId]
  );

  if (cachedResult.rows.length > 0 && cachedResult.rows[0].timezone) {
    return cachedResult.rows[0].timezone;
  }

  // 🔥 STEP 2: Si no está en cache, fetch DIRECTO de GHL API v1 (igual que custom fields)
  console.log(`⚠️ Timezone no encontrado en cache para location ${locationId}, consultando GHL API v1...`);
  
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
      throw new Error(`API response not ok: ${response.status}`);
    }

    const data = await response.json();
    const timezone = data.timezone || data.business?.timezone;

    if (!timezone) {
      throw new Error('No timezone found in location data');
    }

    // 🔥 STEP 3: Guardar en cache para próxima vez
    await client.query(
      'UPDATE location_custom_fields SET timezone = $1 WHERE location_id = $2',
      [timezone, locationId]
    );

    console.log(`✅ Timezone ${timezone} obtenido y guardado en cache para location ${locationId}`);
    return timezone;

  } catch (error) {
    console.error(`❌ Error obteniendo timezone para location ${locationId}:`, error);
    return 'America/New_York'; // Fallback conservative
  }
}

// 🌍 BUSINESS HOURS ADJUSTMENT (PRESERVA SEQUENTIAL ORDER - FIX DEFINITIVO)
function smartBusinessHoursAdjustment(scheduledTime: Date, timezone: string): Date {
  const dt = DateTime.fromJSDate(scheduledTime).setZone(timezone);
  
  const BUSINESS_START = 8;  // 8 AM
  const BUSINESS_END = 20;   // 8 PM
  
  // ✅ SI ESTÁ EN BUSINESS HOURS (8AM-8PM ANY DAY) - NO TOCAR NADA (PRESERVAR SEQUENTIAL)
  if (dt.hour >= BUSINESS_START && dt.hour < BUSINESS_END) {
    return scheduledTime; // PRESERVAR TIMESTAMP ORIGINAL - NOW WORKS 7 DAYS A WEEK
  }
  
  let adjustedDt: DateTime;
  
  if (dt.hour < BUSINESS_START) {
    // Antes de 8 AM - SOLO cambiar la hora a 8:00:00.000 EXACTO
    adjustedDt = dt.set({ hour: BUSINESS_START, minute: 0, second: 0, millisecond: 0 });
  } else {
    // Después de 8 PM - mover al siguiente día 8:00:00.000 AM EXACTO (FIX CRÍTICO)
    adjustedDt = dt.plus({ days: 1 }).set({ 
      hour: BUSINESS_START, minute: 0, second: 0, millisecond: 0
    });
  }
  
  // Convertir de vuelta a UTC JavaScript Date
  return adjustedDt.toUTC().toJSDate();
}

// Función para convertir locationId a BigInt
function locationIdToBigInt(locationId: string): bigint {
  let hash = 0n;
  for (let i = 0; i < locationId.length; i++) {
    hash = (hash * 31n + BigInt(locationId.charCodeAt(i))) & 0x7fffffffffffffffn;
  }
  return hash;
}

function normalizePayload(body: any): any {
  console.log('🔍 DEBUGGING normalizePayload - body keys:', Object.keys(body));
  console.log('🔍 body.contact_id:', body.contact_id);
  console.log('🔍 body.customData?.api_key:', body.customData?.api_key);
  console.log('🔍 body.location?.id:', body.location?.id);
  
  // FORMATO 3: Legacy payload con muchos campos y datos clave anidados
  if (body.contact_id && body.customData?.api_key && body.location?.id) {
    console.log('✅ Legacy payload detectado. Normalizando a una estructura limpia...');
    const result = {
      contact_id: body.contact_id,
      location: body.location, // el objeto de location está bien como está
      workflow: body.workflow || { id: 'noworkflow' }, // asegurar que workflow exista
      customData: { TimeFrame: body.customData.TimeFrame }, // aislar solo el TimeFrame
      api_key: body.customData.api_key, // subir api_key al nivel superior
    };
    console.log('🔍 Legacy normalized result:', JSON.stringify(result, null, 2));
    return result;
  }

  console.log('🔍 Checking for extras format...');
  console.log('🔍 body.extras:', !!body.extras);
  console.log('🔍 body.meta?.key:', body.meta?.key);

  // FORMATO 1: Viene con "extras" y "meta.key" - Custom Action de GHL
  if (body.extras && (body.meta?.key === "humanizer_drip" || body.meta?.key === "humanizer_v1")) {
    console.log('Payload de GHL Custom Action detectado. Normalizando...');
    // FORMATO 1.1: Nuevo formato mixto (data + extras) - Con isMarketplaceAction
    if (body.data && body.isMarketplaceAction) {
      // Extraer TimeFrame y API key de data, y el resto de extras
      return {
        contact_id: body.extras.contactId,
        location: { id: body.extras.locationId },
        workflow: { id: body.extras.workflowId || 'noworkflow' },
        customData: { TimeFrame: body.data.TimeFrame },
        api_key: body.data.apiKey, // Extraer API key de data
      };
    }
    
    // FORMATO 1.2: Formato con todo en extras (original de Custom Action)
    const { contactId, locationId, workflowId, TimeFrame, apiKey } = body.extras;
    return {
      contact_id: contactId,
      location: { id: locationId },
      workflow: { id: workflowId || 'noworkflow' },
      customData: { TimeFrame },
      api_key: apiKey || body.data?.apiKey, // Buscar en extras o data
    };
  }
  
  // FORMATO 2: Formato original directo (no necesita cambios)
  console.log('🔍 Payload directo detectado. No se necesita normalización.');
  console.log('🔍 Direct payload result keys:', Object.keys(body));
  return body;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Sólo POST, chavo.' });
  }

  try {
    console.log('🧠 Webhook recibido:\n', JSON.stringify(req.body, null, 2));

    const normalizedBody = normalizePayload(req.body);
    
    console.log('🔥 AFTER NORMALIZATION - normalizedBody:', JSON.stringify(normalizedBody, null, 2));

    const contactId = normalizedBody.contact_id as string;
    const locationId = normalizedBody?.location?.id as string;
    const workflowId = normalizedBody?.workflow?.id as string || 'noworkflow';
    const timeframe = normalizedBody?.customData?.TimeFrame as string;
    const apiKey = normalizedBody?.api_key as string;

    console.log('🔥 EXTRACTED VALUES:');
    console.log('  contactId:', contactId);
    console.log('  locationId:', locationId);
    console.log('  workflowId:', workflowId);
    console.log('  timeframe:', timeframe);
    console.log('  apiKey:', apiKey ? 'EXISTS' : 'MISSING');

    if (!contactId || !locationId || !timeframe || !apiKey) {
      console.log('❌ MISSING DATA ERROR - returning 400');
      return res.status(400).json({ error: 'Faltan datos (contactId, locationId, TimeFrame o apiKey)' });
    }

    // Parsear "min to max"
    const match = timeframe.match(/(\d+(?:\.\d+)?)\s*to\s*(\d+(?:\.\d+)?)/i);
    if (!match) {
      return res.status(400).json({ error: 'TimeFrame mal formado, usa "60 to 300"' });
    }
    const min = parseFloat(match[1]);
    const max = parseFloat(match[2]);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // 🔥 Lock para este locationId
      const lockId = locationIdToBigInt(locationId);
      await client.query('SELECT pg_advisory_xact_lock($1)', [lockId]);

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
        // Buscar en GHL usando la API key del contacto
        const ghRes = await fetch(
          `https://rest.gohighlevel.com/v1/custom-fields/`,
          {
            headers: {
              Authorization: `Bearer ${apiKey}`,  // Usar la API key del contacto
            },
          }
        );
        
        if (!ghRes.ok) {
          await client.query('ROLLBACK');
          return res.status(500).json({ 
            error: 'Error al obtener campos personalizados de GHL', 
            details: await ghRes.text() 
          });
        }
        
        const fieldsPayload = await ghRes.json();
        const allFields = fieldsPayload.customFields || []; // La API v1 devuelve { customFields: [...] }
        const timerField = allFields.find((f: any) => 
          f.name?.toLowerCase() === 'timerdone' || 
          f.name?.toLowerCase() === 'timer done'
        );
        
        if (!timerField) {
          await client.query('ROLLBACK');
          return res.status(500).json({ error: 'Custom field "timerdone" no encontrado en GHL' });
        }
        
        customFieldId = timerField.id;

        await client.query(
          `INSERT INTO location_custom_fields (location_id, timerdone_custom_field_id, created_at)
           VALUES ($1, $2, NOW())
           ON CONFLICT (location_id) DO NOTHING`,
          [locationId, customFieldId]
        );
      }

      // 🔥 Leer el último run_at para este locationId Y workflowId
      let lastRunAt = new Date();
      const lastResult = await client.query(
        'SELECT run_at FROM sequential_queue WHERE location_id = $1 AND workflow_id = $2 ORDER BY run_at DESC LIMIT 1',
        [locationId, workflowId]
      );
      if (lastResult.rows.length > 0) {
        lastRunAt = new Date(lastResult.rows[0].run_at);
      }

      const now = new Date();
      if (lastRunAt < now) {
        lastRunAt = now;
      }

      // 🔥 Elegir un delay aleatorio (ALGORITMO ORIGINAL - NO CAMBIA)
      const delaySeconds = Math.floor(Math.random() * (max - min + 1)) + Math.floor(min);
      const newRunAt = new Date(lastRunAt.getTime() + delaySeconds * 1000);

      // 🌍 BUSINESS HOURS SAFEGUARD - IMPLEMENTACIÓN FINAL CON API REAL Y LUXON
      const locationTimezone = await getLocationTimezone(locationId, apiKey, client);
      const adjustedRunAt = smartBusinessHoursAdjustment(newRunAt, locationTimezone);

      // Log only if adjustment occurred
      if (adjustedRunAt.getTime() !== newRunAt.getTime()) {
        console.log(`⏰ Business hours adjustment for ${locationId} (${locationTimezone}):`);
        console.log(`   Original: ${newRunAt.toISOString()}`);
        console.log(`   Adjusted: ${adjustedRunAt.toISOString()}`);
      }

      // 🔥 Insertar en sequential_queue con workflowId y apiKey (usando adjustedRunAt)
      await client.query(
        `INSERT INTO sequential_queue
          (contact_id, location_id, workflow_id, delay_seconds, custom_field_id, run_at, api_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [contactId, locationId, workflowId, delaySeconds, customFieldId, adjustedRunAt, apiKey]
      );

      await client.query('COMMIT');

      // defer publishing to the scheduler; handler only writes to Postgres
      return res.status(200).json({
        success: true,
        runAt: adjustedRunAt.toISOString(),
        timezone: locationTimezone,
        adjusted: adjustedRunAt.getTime() !== newRunAt.getTime()
      });
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('🔥 ERROR ENCOLANDO:', error.stack || error.message || error);
      return res.status(500).json({ error: 'Error interno del servidor' });
    } finally {
      client.release();
    }
  } catch (err: any) {
    console.error('🔥 ERROR GENERAL:', err.stack || err.message || err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}
