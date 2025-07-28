import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

console.log('🔍 VERIFICANDO LAS REPARACIONES...');

async function verifyRepairs() {
  const client = await pool.connect();
  try {
    const messageIds = [385340, 385341, 385342, 385343, 385344, 385345, 385346, 385347, 385349, 385350];
    
    const query = `
      SELECT 
        sq.id,
        sq.location_id,
        sq.run_at,
        EXTRACT(hour FROM sq.run_at AT TIME ZONE 'America/Los_Angeles') as local_hour,
        EXTRACT(date FROM sq.run_at AT TIME ZONE 'America/Los_Angeles') as local_date
      FROM sequential_queue sq
      WHERE sq.id = ANY($1)
      ORDER BY sq.run_at
    `;
    
    const result = await client.query(query, [messageIds]);
    
    console.log(`\n📊 RESULTADOS (${result.rows.length} mensajes encontrados):`);
    console.log('='.repeat(80));
    
    let allValid = true;
    
    result.rows.forEach((row, i) => {
      const isValid = row.local_hour >= 8 && row.local_hour < 20;
      const status = isValid ? '✅' : '❌';
      
      console.log(`${status} ID ${row.id}: ${row.run_at.toISOString()}`);
      console.log(`   📍 Local time: ${row.local_date} ${row.local_hour}:00 (America/Los_Angeles)`);
      console.log(`   🕐 Status: ${isValid ? 'VÁLIDO (business hours)' : 'VIOLATION'}`);
      console.log('');
      
      if (!isValid) allValid = false;
    });
    
    console.log('='.repeat(80));
    if (allValid) {
      console.log('🎉 ¡ÉXITO! Todos los mensajes están ahora en business hours (8 AM - 8 PM)');
    } else {
      console.log('❌ PROBLEMA: Algunos mensajes siguen teniendo violations');
    }
    
  } finally {
    client.release();
    await pool.end();
  }
}

verifyRepairs().catch(console.error); 