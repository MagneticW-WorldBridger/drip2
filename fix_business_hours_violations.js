import { Pool } from 'pg';
import { DateTime } from 'luxon';
import dotenv from 'dotenv';

dotenv.config();

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

// 🔥 CONEXIÓN A LA BASE DE DATOS
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

console.log('🚀 INICIANDO REPARACIÓN MASIVA DE BUSINESS HOURS VIOLATIONS');
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

// 🔥 PASO 1: IDENTIFICAR VIOLATIONS (SUBSET PEQUEÑO PARA PRUEBA)
async function findViolations(limit = 10) {
  const client = await pool.connect();
  try {
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
    
    // Mostrar algunos ejemplos
    if (result.rows.length > 0) {
      console.log('\n🔍 EJEMPLOS DE VIOLATIONS:');
      result.rows.slice(0, 3).forEach((row, i) => {
        console.log(`  ${i + 1}. Location: ${row.location_id}`);
        console.log(`     Run at: ${row.run_at.toISOString()} (hour ${row.local_hour} in ${row.timezone})`);
        console.log(`     Delay: ${row.delay_seconds} seconds`);
      });
    }
    
    return result.rows;
  } finally {
    client.release();
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
    console.log(`\n🔨 Procesando grupo: ${groupKey}`);
    
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
      
      console.log(`  📝 ID ${row.id}: ${row.run_at.toISOString()} → ${adjustedTime.toISOString()}`);
      
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

// 🔥 PASO 3: ENCONTRAR BASE TIME PARA UN GRUPO
async function findBaseTimeForGroup(locationId, workflowId) {
  const client = await pool.connect();
  try {
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
      console.log(`  📍 Base time: último mensaje válido en ${result.rows[0].run_at.toISOString()}`);
      return result.rows[0].run_at;
    } else {
      // Si no hay mensajes válidos, usar NOW
      const now = new Date();
      console.log(`  📍 Base time: NOW (no hay mensajes válidos anteriores) ${now.toISOString()}`);
      return now;
    }
  } finally {
    client.release();
  }
}

// 🔥 PASO 4: APLICAR LAS REPARACIONES (CON CONFIRMACIÓN)
async function applyRepairs(repairs, dryRun = true) {
  console.log(`\n💾 PASO 3: ${dryRun ? 'SIMULANDO' : 'APLICANDO'} ${repairs.length} reparaciones`);
  
  if (dryRun) {
    console.log('🟡 DRY RUN - No se van a hacer cambios reales');
    repairs.slice(0, 5).forEach((repair, i) => {
      console.log(`  ${i + 1}. ID ${repair.id}: ${repair.oldRunAt.toISOString()} → ${repair.newRunAt.toISOString()}`);
    });
    return;
  }
  
  const client = await pool.connect();
  try {
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
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Error aplicando reparaciones:', error);
    throw error;
  } finally {
    client.release();
  }
}

// 🔥 FUNCIÓN PRINCIPAL CON PROGRESO
async function main() {
  let totalProcessed = 0;
  let batchCount = 0;
  
  try {
    // Obtener total de violations al inicio
    const totalViolations = await getTotalViolations();
    console.log(`\n📊 TOTAL DE VIOLATIONS ENCONTRADAS: ${totalViolations}`);
    
    while (true) {
      batchCount++;
      console.log(`\n🔄 ===== LOTE ${batchCount} =====`);
      
      // PASO 1: Procesar lotes de 500
      const violations = await findViolations(500);
      
      if (violations.length === 0) {
        console.log('🎉 ¡YA NO HAY MÁS VIOLATIONS! Terminamos.');
        break;
      }
      
      // PASO 2: Calcular reparaciones
      const repairs = await repairViolations(violations);
      
      // PASO 3: Aplicar reparaciones (sin dry run para procesar rápido)
      console.log(`\n🔥 APLICANDO ${repairs.length} reparaciones...`);
      await applyRepairs(repairs, false);
      
      totalProcessed += repairs.length;
      const remainingViolations = await getTotalViolations();
      
      console.log(`\n📈 PROGRESO:`);
      console.log(`   ✅ Procesados en este lote: ${repairs.length}`);
      console.log(`   ✅ Total procesados: ${totalProcessed}`);
      console.log(`   ⏳ Violations restantes: ${remainingViolations}`);
      console.log(`   📊 Progreso: ${((totalViolations - remainingViolations) / totalViolations * 100).toFixed(1)}%`);
      
      // Si el lote fue menor a 500, probablemente estamos cerca del final
      if (violations.length < 500) {
        console.log('⚠️ Lote pequeño detectado, probablemente terminando pronto...');
      }
    }
    
    console.log(`\n🎉 ¡REPARACIÓN COMPLETADA!`);
    console.log(`   📊 Total de mensajes reparados: ${totalProcessed}`);
    console.log(`   📦 Lotes procesados: ${batchCount}`);
    
  } catch (error) {
    console.error('❌ ERROR GENERAL:', error);
  } finally {
    await pool.end();
  }
}

// Ejecutar el script
main(); 