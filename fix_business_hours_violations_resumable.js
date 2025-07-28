import { Pool } from 'pg';
import { DateTime } from 'luxon';
import dotenv from 'dotenv';

dotenv.config();

// 🔥 STARTING FROM BATCH 40 (where it stopped)
const STARTING_BATCH = 40;
const BATCH_SIZE = 500;

// 🔥 MISMA FUNCIÓN QUE YA ESTÁ PROBADA EN api/enqueue-contact.ts
function smartBusinessHoursAdjustment(scheduledTime, timezone) {
  const dt = DateTime.fromJSDate(scheduledTime).setZone(timezone);
  
  const BUSINESS_START = 8;  // 8 AM
  const BUSINESS_END = 20;   // 8 PM
  
  // ✅ SI ESTÁ EN BUSINESS HOURS (8AM-8PM) - NO TOCAR NADA
  if (dt.hour >= BUSINESS_START && dt.hour < BUSINESS_END) {
    return scheduledTime;
  }
  
  let adjustedDt;
  
  if (dt.hour < BUSINESS_START) {
    // Antes de 8 AM - SOLO cambiar la hora a 8:00:00.000 EXACTO
    adjustedDt = dt.set({ hour: BUSINESS_START, minute: 0, second: 0, millisecond: 0 });
  } else {
    // Después de 8 PM - mover al siguiente día 8:00:00.000 AM EXACTO
    adjustedDt = dt.plus({ days: 1 }).set({ 
      hour: BUSINESS_START, minute: 0, second: 0, millisecond: 0
    });
  }
  
  // Convertir de vuelta a UTC JavaScript Date
  return adjustedDt.toUTC().toJSDate();
}

// 🔥 CONEXIÓN CON MEJOR TIMEOUT MANAGEMENT
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 5000,   // 5 segundos timeout
  idleTimeoutMillis: 30000,        // 30 segundos idle
  max: 3,                          // máximo 3 conexiones
});

console.log('🚀 RESUMIENDO REPARACIÓN DESDE LOTE', STARTING_BATCH);
console.log('==========================================================');

// Función para obtener total de violations
async function getTotalViolations() {
  const client = await pool.connect();
  try {
    const query = `
      SELECT COUNT(*) as total
      FROM sequential_queue sq
      LEFT JOIN location_custom_fields lcf ON sq.location_id = lcf.location_id
      WHERE EXTRACT(hour FROM sq.run_at AT TIME ZONE COALESCE(lcf.timezone, 'America/New_York')) < 8 
         OR EXTRACT(hour FROM sq.run_at AT TIME ZONE COALESCE(lcf.timezone, 'America/New_York')) >= 20
    `;
    const result = await client.query(query);
    return parseInt(result.rows[0].total);
  } finally {
    client.release();
  }
}

// 🔥 PASO 1: IDENTIFICAR VIOLATIONS CON MEJOR ERROR HANDLING
async function findViolations(limit = BATCH_SIZE) {
  let client;
  try {
    client = await pool.connect();
    console.log(`\n📊 PASO 1: Buscando violations (limit: ${limit})`);
    
    const query = `
      SELECT 
        sq.id,
        sq.contact_id,
        sq.location_id,
        sq.workflow_id,
        sq.delay_seconds,
        sq.run_at,
        sq.api_key,
        COALESCE(lcf.timezone, 'America/New_York') as timezone,
        EXTRACT(hour FROM sq.run_at AT TIME ZONE COALESCE(lcf.timezone, 'America/New_York')) as local_hour
      FROM sequential_queue sq
      LEFT JOIN location_custom_fields lcf ON sq.location_id = lcf.location_id
      WHERE EXTRACT(hour FROM sq.run_at AT TIME ZONE COALESCE(lcf.timezone, 'America/New_York')) < 8 
         OR EXTRACT(hour FROM sq.run_at AT TIME ZONE COALESCE(lcf.timezone, 'America/New_York')) >= 20
      ORDER BY sq.location_id, sq.workflow_id, sq.run_at
      LIMIT $1
    `;
    
    const result = await client.query(query, [limit]);
    
    console.log(`✅ Encontré ${result.rows.length} violations`);
    
    return result.rows;
  } catch (error) {
    console.error('❌ Error en findViolations:', error.message);
    throw error;
  } finally {
    if (client) client.release();
  }
}

// 🔥 PASO 2: AGRUPAR POR LOCATION + WORKFLOW Y RECALCULAR
async function repairViolations(violations) {
  console.log(`\n🔧 PASO 2: Reparando ${violations.length} violations`);
  
  // Agrupar por location + workflow
  const groups = {};
  violations.forEach(row => {
    const key = `${row.location_id}:${row.workflow_id}`;
    if (!groups[key]) {
      groups[key] = [];
    }
    groups[key].push(row);
  });
  
  console.log(`📦 Agrupé en ${Object.keys(groups).length} grupos (location + workflow)`);
  
  const repairs = [];
  
  for (const [groupKey, groupRows] of Object.entries(groups)) {
    // Ordenar por run_at para mantener secuencia
    groupRows.sort((a, b) => new Date(a.run_at) - new Date(b.run_at));
    
    // Encontrar el último mensaje válido de este grupo (o usar NOW si no hay)
    const baseTime = await findBaseTimeForGroup(groupRows[0].location_id, groupRows[0].workflow_id);
    
    let currentTime = new Date(baseTime);
    
    for (const row of groupRows) {
      // Aplicar el delay original
      currentTime = new Date(currentTime.getTime() + (row.delay_seconds * 1000));
      
      // Aplicar business hours adjustment
      const adjustedTime = smartBusinessHoursAdjustment(currentTime, row.timezone);
      
      repairs.push({
        id: row.id,
        oldRunAt: row.run_at,
        newRunAt: adjustedTime,
        timezone: row.timezone
      });
      
      // Update currentTime para el siguiente mensaje
      currentTime = new Date(adjustedTime);
    }
  }
  
  return repairs;
}

// 🔥 PASO 3: ENCONTRAR BASE TIME PARA UN GRUPO CON TIMEOUT
async function findBaseTimeForGroup(locationId, workflowId) {
  let client;
  try {
    client = await pool.connect();
    
    // Buscar el último mensaje válido (en business hours) de este grupo
    const query = `
      SELECT run_at, timezone
      FROM sequential_queue sq
      LEFT JOIN location_custom_fields lcf ON sq.location_id = lcf.location_id
      WHERE sq.location_id = $1 AND sq.workflow_id = $2
        AND EXTRACT(hour FROM sq.run_at AT TIME ZONE COALESCE(lcf.timezone, 'America/New_York')) >= 8 
        AND EXTRACT(hour FROM sq.run_at AT TIME ZONE COALESCE(lcf.timezone, 'America/New_York')) < 20
      ORDER BY run_at DESC
      LIMIT 1
    `;
    
    const result = await client.query(query, [locationId, workflowId]);
    
    if (result.rows.length > 0) {
      return result.rows[0].run_at;
    } else {
      // Si no hay mensajes válidos, usar NOW
      return new Date();
    }
  } catch (error) {
    console.error('❌ Error en findBaseTimeForGroup:', error.message);
    // En caso de error, usar NOW como fallback
    return new Date();
  } finally {
    if (client) client.release();
  }
}

// 🔥 PASO 4: APLICAR LAS REPARACIONES CON MEJOR ERROR HANDLING
async function applyRepairs(repairs) {
  console.log(`\n💾 PASO 3: APLICANDO ${repairs.length} reparaciones`);
  
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    
    let updated = 0;
    for (const repair of repairs) {
      const result = await client.query(
        'UPDATE sequential_queue SET run_at = $1 WHERE id = $2',
        [repair.newRunAt, repair.id]
      );
      updated += result.rowCount;
    }
    
    await client.query('COMMIT');
    console.log(`✅ Reparé ${updated} mensajes exitosamente`);
    return updated;
    
  } catch (error) {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        console.error('❌ Error en rollback:', rollbackError.message);
      }
    }
    console.error('❌ Error aplicando reparaciones:', error.message);
    throw error;
  } finally {
    if (client) client.release();
  }
}

// 🔥 FUNCIÓN PRINCIPAL CON RETRY Y PROGRESO
async function main() {
  let totalProcessed = STARTING_BATCH * BATCH_SIZE; // Ya procesamos ~20,000
  let batchCount = STARTING_BATCH;
  
  try {
    // Obtener total de violations al inicio
    const totalViolations = await getTotalViolations();
    console.log(`\n📊 VIOLATIONS RESTANTES: ${totalViolations}`);
    console.log(`📊 ESTIMADO YA PROCESADO: ${totalProcessed}`);
    
    while (true) {
      batchCount++;
      console.log(`\n🔄 ===== LOTE ${batchCount} =====`);
      
      let violations;
      let retryCount = 0;
      const maxRetries = 3;
      
      // Retry logic para findViolations
      while (retryCount < maxRetries) {
        try {
          violations = await findViolations(BATCH_SIZE);
          break;
        } catch (error) {
          retryCount++;
          console.error(`❌ Error en lote ${batchCount}, intento ${retryCount}/${maxRetries}:`, error.message);
          
          if (retryCount >= maxRetries) {
            throw error;
          }
          
          // Wait before retry
          console.log(`⏳ Esperando 5 segundos antes del siguiente intento...`);
          await new Promise(resolve => setTimeout(resolve, 5000));
        }
      }
      
      if (violations.length === 0) {
        console.log('🎉 ¡YA NO HAY MÁS VIOLATIONS! Terminamos.');
        break;
      }
      
      // PASO 2: Calcular reparaciones
      const repairs = await repairViolations(violations);
      
      // PASO 3: Aplicar reparaciones con retry
      retryCount = 0;
      let repairCount = 0;
      
      while (retryCount < maxRetries) {
        try {
          repairCount = await applyRepairs(repairs);
          break;
        } catch (error) {
          retryCount++;
          console.error(`❌ Error aplicando reparaciones, intento ${retryCount}/${maxRetries}:`, error.message);
          
          if (retryCount >= maxRetries) {
            throw error;
          }
          
          console.log(`⏳ Esperando 10 segundos antes del siguiente intento...`);
          await new Promise(resolve => setTimeout(resolve, 10000));
        }
      }
      
      totalProcessed += repairCount;
      const remainingViolations = await getTotalViolations();
      
      console.log(`\n📈 PROGRESO:`);
      console.log(`   ✅ Procesados en este lote: ${repairCount}`);
      console.log(`   ✅ Total procesados: ${totalProcessed}`);
      console.log(`   ⏳ Violations restantes: ${remainingViolations}`);
      
      // Si el lote fue menor a BATCH_SIZE, probablemente estamos cerca del final
      if (violations.length < BATCH_SIZE) {
        console.log('⚠️ Lote pequeño detectado, probablemente terminando pronto...');
      }
      
      // Pequeña pausa entre lotes para no sobrecargar
      console.log('⏳ Pausa de 2 segundos...');
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    console.log(`\n🎉 ¡REPARACIÓN COMPLETADA!`);
    console.log(`   📊 Total de mensajes reparados: ${totalProcessed}`);
    console.log(`   📦 Lotes procesados: ${batchCount}`);
    
  } catch (error) {
    console.error(`❌ ERROR FATAL EN LOTE ${batchCount}:`, error.message);
    console.log(`📊 Progreso antes del error: ${totalProcessed} mensajes reparados`);
    console.log(`📝 Para continuar, actualiza STARTING_BATCH a ${batchCount} y ejecuta de nuevo`);
  } finally {
    try {
      await pool.end();
    } catch (poolError) {
      console.error('❌ Error cerrando pool:', poolError.message);
    }
  }
}

// Ejecutar el script
main(); 